import {
  MARKET_LOT_TTL_MS,
  MARKET_MAX_LOT_UNITS,
  MARKET_MIN_LOT_UNITS,
  corridorOf,
  marketCommission,
  priceWithinBounds,
  type CorridorBounds
} from '../../config/market.js';
import { junkTotal, type JunkId } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { credit, debit, junk, resource, spendSec, type MovementContext } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';
import { isClaimable, lotTotal, type LotState } from './lot.types.js';

/**
 * Домен чёрного рынка (Часть 2): ЧИСТЫЕ ФУНКЦИИ, как весь остальной домен.
 * Ни одна не читает и не пишет стор — порядок записей трёх документов лежит в
 * market/commit.ts, и только там.
 *
 * ХРАНОВИЩЕ ЛОТА — ЭСКРОУ, А НЕ ОБЕЩАНИЕ. При выставлении хлам списывается со склада
 * продавца СРАЗУ и живёт в лоте. Вариант «списываем при продаже» позволяет продать
 * один двигатель пятерым: на момент покупки склад полон, на момент выдачи — пуст, и
 * рынок превращается в очередь жалоб. Эскроу делает объявление физическим: товара
 * нет в наличии — лота нет.
 */

export interface ListingInput {
  junk: JunkId;
  amount: number;
  pricePerUnit: number;
}

export interface CheckedListing {
  junk: JunkId;
  amount: number;
  pricePerUnit: number;
  total: number;
  /** Комиссия рынка при продаже. Сгорает: это сток SEC, а не перевод платформе. */
  commission: number;
  /** Что получит продавец. Витрина обязана показывать это, а не `total`. */
  net: number;
}

/**
 * Проверка объявления: размер лота, коридор цены, наличие хлама.
 *
 * ПОТОЛОК АКТИВНЫХ ЛОТОВ ЗДЕСЬ СОЗНАТЕЛЬНО НЕ ПРОВЕРЯЕТСЯ. Он считается по данным
 * рынка (`LotStore.countActiveBySeller`), а чистая функция их не видит — и любая
 * «проверка» на устаревшем снимке была бы декорацией. Считает commit.ts, у которого
 * есть стор, и на свежем значении.
 *
 * КОРИДОР ПРИХОДИТСЯ СНАРУЖИ (P5), а не читается из конфига. Границы теперь
 * зависят от предложения, и единственный, кто знает текущие, — стор товаров.
 * Чистая функция, полезшая бы в него сама, перестала бы быть чистой.
 *
 * НЕ ПЕРЕДАН — ЗНАЧИТ ЯКОРЬ. Фолбэк на статический коридор оставлен не для
 * красоты: рынок без снапшота товара (первый запрос после поднятия базы) обязан
 * принимать объявления, и вести он должен себя ровно так, как вёл себя до
 * появления динамики. Молчаливый же фолбэк на «пустой рынок = потолок цен»
 * отклонял бы первые объявления витрины, которой ещё нет.
 */
export function checkListing(
  seller: UserAccount,
  input: ListingInput,
  corridor?: CorridorBounds
): CheckedListing {
  const bounds = corridor ?? corridorOf(input.junk);
  if (!bounds) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'Этот вид хлама на рынок не пускается', {
      junk: input.junk
    });
  }
  if (!Number.isInteger(input.amount) || input.amount < MARKET_MIN_LOT_UNITS || input.amount > MARKET_MAX_LOT_UNITS) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'Недопустимый размер лота', {
      amount: input.amount,
      min: MARKET_MIN_LOT_UNITS,
      max: MARKET_MAX_LOT_UNITS
    });
  }
  if (!priceWithinBounds(bounds, input.pricePerUnit)) {
    throw new AppError(ErrorCodes.MARKET_PRICE_OUT_OF_RANGE, 400, 'Цена за единицу вне коридора рынка', {
      junk: input.junk,
      pricePerUnit: input.pricePerUnit,
      minPerUnit: bounds.minPerUnit,
      maxPerUnit: bounds.maxPerUnit
    });
  }

  const held = seller.junk[input.junk] ?? 0;
  if (held < input.amount) {
    throw new AppError(ErrorCodes.INSUFFICIENT_FUNDS, 409, 'Недостаточно хлама для выставления', {
      currency: `junk_${input.junk}`,
      required: input.amount,
      available: held
    });
  }

  const total = lotTotal(input.amount, input.pricePerUnit);
  const commission = marketCommission(total);
  return {
    junk: input.junk,
    amount: input.amount,
    pricePerUnit: input.pricePerUnit,
    total,
    commission,
    net: total - commission
  };
}

/** Новый лот: `pending_escrow` — документа ещё нет в витрине, пока хлам не списан. */
export function buildLot(listing: CheckedListing, sellerId: string, lotId: string, now: Date): LotState {
  return {
    id: lotId,
    sellerId,
    junk: listing.junk,
    amount: listing.amount,
    pricePerUnit: listing.pricePerUnit,
    total: listing.total,
    status: 'pending_escrow',
    buyerId: null,
    purchasedAt: null,
    payoutSettled: false,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + MARKET_LOT_TTL_MS),
    revision: 0
  };
}

/**
 * Эскроу: хлам уходит со склада продавца в лот.
 *
 * Потолок склада здесь ни при чём: списание не может его превысить. Проверка
 * «достаточно ли есть» уже сделана в `checkListing`, а `debit` повторит её на
 * реальном балансе — двойная защита от гонки «проверили и продали дважды».
 */
export function escrowJunk(
  account: UserAccount,
  listing: CheckedListing,
  lotId: string,
  ctx: Omit<MovementContext, 'reason' | 'refType' | 'refId' | 'idempotencyKey'>
): { account: UserAccount; draft: LedgerDraft } {
  const movement = debit(account, junk(listing.junk), listing.amount, {
    ...ctx,
    reason: 'market_list',
    refType: 'lot',
    refId: lotId,
    idempotencyKey: makeIdempotencyKey('market', `${lotId}:escrow`),
    meta: { junk: listing.junk, amount: listing.amount, total: listing.total }
  });
  return { account: movement.account, draft: movement.draft };
}

/**
 * Захват лота покупателем — РЕДУКТОР для `LotStore.transact`.
 *
 * Проверка повторяется внутри: между чтением витриной и этой записью лот мог
 * перехватить кто-то другой, и именно этот повтор делает гонку двух покупателей
 * неразрешимой для них, но разрешённой для системы — второй придёт в отказ, а не
 * заплатит за уже чужой товар.
 */
export function claimLot(lot: LotState, buyerId: string, now: Date): LotState {
  if (!isClaimable(lot, buyerId, now)) {
    if (lot.sellerId === buyerId) {
      throw new AppError(ErrorCodes.MARKET_SELF_PURCHASE, 400, 'Нельзя выкупить собственный лот', {
        lotId: lot.id
      });
    }
    throw new AppError(ErrorCodes.MARKET_LOT_TAKEN, 409, 'Лот уже продан, снят или просрочен', {
      lotId: lot.id,
      status: lot.status
    });
  }
  return {
    ...lot,
    status: 'sold',
    buyerId,
    purchasedAt: now,
    updatedAt: now,
    payoutSettled: false
  };
}

// ─── Покупка: деньги и товар ──────────────────────────────────────────────────

export interface SideEffects {
  account: UserAccount;
  drafts: LedgerDraft[];
}

/**
 * Покупатель платит монетой и получает хлам.
 *
 * ПОТОЛОК СКЛАДА ЗДЕСЬ — ОТКАЗ, А НЕ ТИХИЙ ПРОПУСК, и это осознанное отличие от
 * лута защитника (P0). Там переполнение обязано быть `skipped`: бой уже засчитан
 * атакующему, и ломать его рейтинг и списание складов из-за чужого забитого
 * ящика нельзя. Здесь игрок ЗАПЛАТИЛ: «денег лишили, товар не выдали» — это уже
 * не деградация, а кража, и единственный честный ответ — 409 до единого движения.
 *
 * Порядок «сначала монета, потом товар» выбран не по алфавиту: при падении между
 * шагами у покупателя остаётся товар без денег (худшая из двух потерь для игры с
 * донатом), а reconcile доводит деньги по доказательству захвата лота. Обратный
 * порядок оставил бы покупателя с списанными монетами и без товара — доказывать
 * что он «должен был получить» нечем, лот-то уже продан.
 */
export function settleBuyer(
  buyer: UserAccount,
  lot: LotState,
  now: Date,
  junkCap: number
): SideEffects {
  const current = junkTotal(buyer.junk);
  if (junkCap > 0 && current + lot.amount > junkCap) {
    throw new AppError(ErrorCodes.JUNK_CAP_REACHED, 409, 'Склад хлама переполнен — освободите место до покупки', {
      cap: junkCap,
      current,
      incoming: lot.amount
    });
  }

  const paid = spendSec(buyer, lot.total, {
    ts: now,
    reason: 'market_trade',
    refType: 'lot',
    refId: lot.id,
    idempotencyKey: makeIdempotencyKey('market', `${lot.id}:sec`),
    meta: { junk: lot.junk, amount: lot.amount, total: lot.total, role: 'buyer' }
  });
  const received = credit(paid.account, junk(lot.junk), lot.amount, {
    ts: now,
    reason: 'market_trade',
    refType: 'lot',
    refId: lot.id,
    // Валюта в ключе обязательна (инвариант №1): без `:junk` это движение попало бы
    // под уникальный индекс списания монеты — деньги ушли бы, товар не появился,
    // и в журнале не осталось бы ни строки, объясняющей пропажу.
    idempotencyKey: makeIdempotencyKey('market', `${lot.id}:junk`),
    meta: { junk: lot.junk, amount: lot.amount, role: 'buyer' }
  });

  return { account: received.account, drafts: [paid.draft, received.draft] };
}

/**
 * Продавец получает монету за вычетом комиссии.
 *
 * Комиссия НЕ проводится отдельным движением «−commission»: она сгорает, то есть
 * уходит из обращения, и движение было бы приписано неизвестно кому. Вместо этого
 * в журнале остаётся полная цена лота у покупателя и чистая выплата продавцу —
 * расхождение между этими двумя записями и есть комиссия, и оно проверяемо пост
 * фактум любым аналитиком без второго источника истины.
 */
export function paySeller(seller: UserAccount, lot: LotState, net: number, now: Date): SideEffects {
  const movement = credit(seller, resource('sec'), net, {
    ts: now,
    reason: 'market_payout',
    refType: 'lot',
    refId: lot.id,
    idempotencyKey: makeIdempotencyKey('market', `${lot.id}:payout`),
    meta: { gross: lot.total, commission: lot.total - net, role: 'seller' }
  });
  return { account: movement.account, drafts: [movement.draft] };
}

// ─── Возвраты: снятие лота и истечение срока ──────────────────────────────────

/** Редуктор: эскроу подтверждён журналом — лот выходит в витрину. */
export function activateLot(lot: LotState, now: Date): LotState {
  if (lot.status === 'listed') return lot;
  if (lot.status !== 'pending_escrow') {
    throw new AppError(ErrorCodes.MARKET_LOT_TAKEN, 409, 'Лот уже закрыт и не может выйти в витрину', {
      lotId: lot.id,
      status: lot.status
    });
  }
  return { ...lot, status: 'listed', updatedAt: now };
}

/**
 * Откат захвата: покупатель не смог заплатить или принять товар — лот снова в витрине.
 *
 * Возвращает ровно `listed` с пустым покупателем, а не «предыдущее состояние»:
 * предыдущего состояния у редуктора нет, и CAS-повтор обязан давать тот же результат.
 */
export function unclaimLot(lot: LotState, now: Date): LotState {
  if (lot.status !== 'sold') return lot;
  return { ...lot, status: 'listed', buyerId: null, purchasedAt: null, updatedAt: now };
}

/** Редуктор: лот снят продавцом (или просрочен) и хлам должен вернуться. */
export function releaseLot(lot: LotState, status: 'cancelled' | 'expired', now: Date): LotState {
  // Снять можно и витринный лот, и тот, что завис наполовину: второе — наша недоработка,
  // и держать из-за неё чужой хлам в эскроу бесконечно нельзя.
  if (lot.status !== 'listed' && lot.status !== 'pending_escrow') {
    throw new AppError(ErrorCodes.MARKET_LOT_TAKEN, 409, 'Лот уже продан или закрыт', {
      lotId: lot.id,
      status: lot.status
    });
  }
  return { ...lot, status, updatedAt: now };
}

/**
 * Хлам возвращается продавцу.
 *
 * ПОТОЛОК СКЛАДА ПРИ ВОЗВРАТЕ НАМЕРЕННО НЕ ПРОВЕРЯЕТСЯ. Игрок держал товар в эскроу,
 * лот просрочился, а склад за это время забился рейдами — и если теперь отказаться
 * возвращать «потому что не влезает», мы сожжём его имущество по нашей же процедуре.
 * Переполнение после возврата временно и лечится цехом переработки; потеря — нет.
 * То же правило, что у `refundAsterium`: возврат не обязан вписываться в лимиты,
 * он обязан восстановить положение владельца.
 */
export function returnJunk(seller: UserAccount, lot: LotState, now: Date, reason: 'cancelled' | 'expired'): SideEffects {
  const movement = credit(seller, junk(lot.junk), lot.amount, {
    ts: now,
    reason: 'market_return',
    refType: 'lot',
    refId: lot.id,
    idempotencyKey: makeIdempotencyKey('market', `${lot.id}:return`),
    meta: { junk: lot.junk, amount: lot.amount, reason }
  });
  return { account: movement.account, drafts: [movement.draft] };
}

/** Редуктор: выплата продавцу доведена — лот закрывается полностью. */
export function markPaid(lot: LotState, now: Date): LotState {
  if (lot.status !== 'sold') return lot;
  return { ...lot, payoutSettled: true, updatedAt: now };
}

/** Чистая функция для витрины: что продавец получит с этого лота. */
export function lotNet(lot: LotState): number {
  return lot.total - marketCommission(lot.total);
}
