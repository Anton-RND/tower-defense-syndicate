import { MARKET_FEED_LIMIT, MARKET_MAX_ACTIVE_LOTS } from '../../config/market.js';
import type { EconomyConfig } from '../../config/env.js';
import { junkTotal } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { LedgerStore } from '../ledger/ledger.store.js';
import type { UserAccount } from '../user/user.types.js';
import type { UserStore } from '../user/user.store.js';
import type { LotSoldEvent } from '../notification/notice.types.js';
import type { LotState } from './lot.types.js';
import type { LotStore } from './lot.store.js';
import type { CommodityStore } from './commodity.store.js';
import { commodityBounds } from './commodity.types.js';
import { commodityForListing } from './economy.js';
import {
  activateLot,
  buildLot,
  checkListing,
  claimLot,
  escrowJunk,
  lotNet,
  markPaid,
  paySeller,
  releaseLot,
  returnJunk,
  settleBuyer,
  unclaimLot,
  type ListingInput
} from './service.js';

/**
 * Протоколы чёрного рынка (Часть 2) — операции над ТРЕМЯ документами: лот,
 * покупатель, продавец. Общей транзакции у нас нет ни для двух, ни для трёх, поэтому
 * каждый шаг обязан быть либо завершённым, либо различимо незавершённым.
 *
 * Порядок шагов — часть контракта, и он выведен из того же принципа, что у кланов
 * и рейдов: **потерянная ценность игрока хуже зависшей записи**. Отсюда:
 *
 *  1. Лот вставляется `pending_escrow` и становится видимым ТОЛЬКО после того, как
 *     хлам реально списан. Витрина не имеет права показать товар, которого нет.
 *  2. Покупка: сначала атомарный захват лота (CAS), потом деньги. Захват до денег
 *     означает, что при падении между шагами товар «заморожен» за покупателем, а
 *     не продано дважды; деньги до захвата означали бы списание у двоих и товар у одного.
 *  3. Выплата продавцу — последний шаг, и её отсутствие лечится reconcile-ом по
 *     доказательству списания у покупателя в журнале.
 *
 * Арбитр во всех трёх случаях — `LedgerStore.hasKey`: журнал знает, состоялась ли
 * ценность, а статус документа знает только, что мы про неё думали.
 */

export interface MarketDeps {
  users: UserStore;
  lots: LotStore;
  ledger: LedgerStore;
  /**
   * Снапшоты товаров (P5). Листинг проверяет цену по ТЕКУЩЕМУ коридору, и этот
   * коридор — данные стора, а не константа конфига.
   *
   * Поле обязательное, а не опциональное: опциональное означало бы, что
   * `listLot` умеет работать и без него, и где-нибудь в тесте или в новом хаб-е
   * тихо включился бы якорный коридор вместо рыночного. Ошибка «нет стора» на
   * сборке контекста дешевле, чем рынок, принимающий объявления вне своих границ.
   */
  commodities: CommodityStore;
  idFactory: () => string;
  /** Звонок провала компенсационного шага: сигнал для фоновой помощи, а не тихая потеря. */
  onError?: (error: Error, context: Record<string, unknown>) => void;
  /**
   * Факт «лот продан и продавец получил деньги» (Часть 2, backlog 3).
   *
   * Звонится РОВНО ОДИН РАЗ НА ЛОТ и только тому, кто реально записал выплату в
   * журнал. Вызывать уведомление из маршрута было бы неправильно: маршрут не знает,
   * довелась ли выплата — он знает только, что вернулся ответ `buyLot`. А reconcile
   * доводит деньги молча, без всякого запроса игрока, и пуш обязан уйти тоже там.
   *
   * Колбэк обязан быть быстрым и не бросать: он вызывается ПОСЛЕ того, как деньги
   * разведены, и его падение не имеет права превратить завершённую сделку в ошибку
   * 500. Маршрут кладёт событие в очередь (`outbox.enqueue`) — это синхронная
   * операция над массивом. На всякий случай звонок обёрнут в try/catch ниже.
   */
  onSold?: (event: LotSoldEvent) => void;
}

/**
 * Фиксация движений журнала.
 *
 * Черновик (`LedgerDraft`) — это движение БЕЗ `id`: его порождает чистый домен,
 * который не знает ни про какое хранилище. Запись (`LedgerEntry`) — движение с
 * `id`, и присваивает его ХАБ, владеющий `idFactory`. Тот же порядок, что в
 * clan/commit.ts и http/helpers.ts.
 *
 * Присваивать `id` здесь, а не в домене, — не формальность: `id` записи — часть её
 * первичного ключа в Mongo, и домен, генерирующий его сам, перестал бы быть
 * чистым и стал бы невоспроизводимым в тестах.
 */
async function commitDrafts(
  deps: MarketDeps,
  drafts: LedgerDraft[],
  context: Record<string, unknown>
): Promise<number> {
  if (drafts.length === 0) return 0;
  const written = await deps.ledger.appendMany(drafts.map((draft) => ({ ...draft, id: deps.idFactory() })));
  if (written < drafts.length) {
    // Движение отброшено уникальным ключом: кто-то уже записал ЭТОТ факт. Для рынка
    // это не косметика — именно по числу записанных строк решается, кому принадлежит
    // право объявить продажу (см. `emitSold`), и молчаливый возврат здесь означал бы,
    // что два победителя получили по одному и тому же лоту.
    deps.onError?.(
      new Error(`Журнал рынка: ${drafts.length - written} из ${drafts.length} движений отброшены как дубликаты`),
      { ...context, stage: 'ledger_duplicate' }
    );
  }
  return written;
}

/** Факт продажи для уведомлений: собирается из лота и счёта продавца, без чтения сторов. */
function soldEvent(lot: LotState, seller: UserAccount, buyerId: string | null, net: number, now: Date): LotSoldEvent {
  return {
    lotId: lot.id,
    sellerId: seller.id,
    sellerPlatform: seller.platform,
    sellerSocialId: seller.socialId,
    buyerId,
    junk: lot.junk,
    amount: lot.amount,
    grossSec: lot.total,
    netSec: net,
    at: now
  };
}

/**
 * Объявить продажу.
 *
 * Изолировано намеренно: к этому моменту деньги уже разведены, и падение подписчика
 * (очереди пушей, будущего аналитика) не имеет права превратить завершённую сделку
 * в 500 для покупателя. Провал уведомляем через `onError` — тот же канал, что у
 * остальных компенсационных шагов протокола.
 */
function emitSold(deps: MarketDeps, event: LotSoldEvent, context: Record<string, unknown>): void {
  if (!deps.onSold) return;
  try {
    deps.onSold(event);
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), { ...context, stage: 'on_sold' });
  }
}

function notFound(message: string): AppError {
  return new AppError(ErrorCodes.MARKET_LOT_NOT_FOUND, 404, message);
}

// ─── Выставление лота ─────────────────────────────────────────────────────────

export interface ListResult {
  lot: LotState;
  account: UserAccount;
}

/** Оболочка лота → эскроу хлама → активация витрины. См. шапку файла, пункт 1. */
export async function listLot(
  deps: MarketDeps,
  sellerId: string,
  input: ListingInput,
  now: Date
): Promise<ListResult> {
  const fresh = await deps.users.findById(sellerId);
  if (!fresh) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { sellerId });

  // Дешёвые проверки до вставки: занять слот рынка мусорным объявлением — значит
  // отобрать его у того, кто реально готов торговать.
  //
  // Коридор берётся ПОСЛЕДНИМ зафиксированным, а не пересчитанным прямо сейчас
  // (почему — шапка economy.ts): цена, которую игрок увидел в витрине, и цена, по
  // которой его объявление пропускается, должны быть одной и той же границей.
  const commodity = await commodityForListing(deps, input.junk, now);
  const listing = checkListing(fresh, input, commodityBounds(commodity));
  const active = await deps.lots.countActiveBySeller(sellerId);
  if (active >= MARKET_MAX_ACTIVE_LOTS) {
    throw new AppError(ErrorCodes.MARKET_LOT_LIMIT, 409, 'Достигнут потолок активных лотов', {
      limit: MARKET_MAX_ACTIVE_LOTS,
      active
    });
  }

  const lotId = deps.idFactory();
  await deps.lots.insert(buildLot(listing, sellerId, lotId, now));

  // Шаг 2: эскроу. Хлам уходит со склада продавца в лот.
  const captured: { account: UserAccount; drafts: LedgerDraft[] }[] = [];
  try {
    const account = await deps.users.transact(sellerId, (current) => {
      const escrow = escrowJunk(current, listing, lotId, { ts: now });
      captured.push({ account: escrow.account, drafts: [escrow.draft] });
      return escrow.account;
    });
    await commitDrafts(deps, captured[captured.length - 1]?.drafts ?? [], { lotId, sellerId, stage: 'escrow' });

    // Шаг 3: витрина.
    const lot = await deps.lots.transact(lotId, (current) => activateLot(current, now));
    return { lot, account };
  } catch (error) {
    // Два разных отказа, и оба обязаны возвращать хлам, если он уже ушёл со склада:
    //  - эскроу не состоялся  → лот-оболочка просто снимается;
    //  - эскроу состоялся, а активация упала → лот снимается И хлам возвращается,
    //    иначе чужой товар завис бы в `cancelled` без владельца.
    // Доказательство списания — журнал, а не наша память о `captured`: при ретрое
    // запроса память пуста, а запись в журнале на месте.
    const escrowKey = makeIdempotencyKey('market', `${lotId}:escrow`);
    try {
      await deps.lots.transact(lotId, (current) => releaseLot(current, 'cancelled', now));
      if (await deps.ledger.hasKey(escrowKey)) {
        const shell = await deps.lots.findById(lotId);
        if (shell) {
          const restored = await deps.users.transact(sellerId, (current) => {
            const back = returnJunk(current, shell, now, 'cancelled');
            captured.push({ account: back.account, drafts: back.drafts });
            return back.account;
          });
          await commitDrafts(deps, captured[captured.length - 1]?.drafts ?? [], { lotId, sellerId, stage: 'return' });
          void restored;
        }
      }
    } catch (cleanup) {
      // Провал отката — не тихая потеря: лот остаётся `pending_escrow`/`cancelled`, и
      // reconcile доведёт его по журналу. Звонок нужен, чтобы это было видно в логах.
      deps.onError?.(cleanup instanceof Error ? cleanup : new Error(String(cleanup)), {
        lotId,
        sellerId,
        stage: 'cancel_shell'
      });
    }
    throw error;
  }
}

// ─── Покупка ──────────────────────────────────────────────────────────────────

export interface BuyResult {
  lot: LotState;
  buyer: UserAccount;
  /** null — продавец ещё не получил деньги: их доводит reconcile по журналу. */
  seller: UserAccount | null;
  /** false — деньги у покупателя списались, но продавцу не доведены. */
  settled: boolean;
}

/**
 * Выкупить лот: захват (CAS) → деньги и товар покупателя → выплата продавцу.
 *
 * Дешёвые проверки (монета, потолок склада, «не свой лот») стоят ДО захвата
 * намеренно: захват чужого по деньгам лота и последующий откат — лишняя запись
 * в документе, вокруг которого толпятся другие покупатели. Отказать дешевле, чем
 * заморозить и разморозить.
 */
export async function buyLot(
  deps: MarketDeps,
  buyerId: string,
  lotId: string,
  now: Date,
  config: EconomyConfig
): Promise<BuyResult> {
  const buyer0 = await deps.users.findById(buyerId);
  if (!buyer0) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { buyerId });
  const listed = await deps.lots.findById(lotId);
  if (!listed) throw notFound(`Лот ${lotId} не найден`);
  if (listed.sellerId === buyerId) {
    throw new AppError(ErrorCodes.MARKET_SELF_PURCHASE, 400, 'Нельзя выкупить собственный лот', { lotId });
  }
  if (listed.status !== 'listed') {
    throw new AppError(ErrorCodes.MARKET_LOT_TAKEN, 409, 'Лот уже продан, снят или просрочен', {
      lotId,
      status: listed.status
    });
  }
  if (Math.floor(buyer0.resources.sec) < listed.total) {
    throw new AppError(ErrorCodes.INSUFFICIENT_FUNDS, 409, 'Недостаточно SEC для выкупа', {
      currency: 'sec',
      required: listed.total,
      available: Math.floor(buyer0.resources.sec)
    });
  }
  const junkCap = config.limits.loot.junkCap;
  const held = junkTotal(buyer0.junk);
  if (junkCap > 0 && held + listed.amount > junkCap) {
    throw new AppError(ErrorCodes.JUNK_CAP_REACHED, 409, 'Склад хлама переполнен — освободите место до покупки', {
      cap: junkCap,
      current: held,
      incoming: listed.amount
    });
  }

  // Шаг 1: атомарный захват. Второй покупатель придёт в тот же редуктор и получит
  // отказ, а не второе списание.
  const claimed = await deps.lots.transact(lotId, (current) => claimLot(current, buyerId, now));

  // Шаг 2: монета покупателя и товар ему.
  const captured: LedgerDraft[][] = [];
  let buyer: UserAccount;
  try {
    buyer = await deps.users.transact(buyerId, (current) => {
      const side = settleBuyer(current, claimed, now, junkCap);
      captured.push(side.drafts);
      return side.account;
    });
    await commitDrafts(deps, captured[captured.length - 1] ?? [], { lotId, buyerId, stage: 'trade' });
  } catch (error) {
    // Товар размораживается: иначе отказ по чужому переполненному складу навсегда
    // снял бы лот с рынка. `unclaimLot` идемпотентен и CAS-повтору не вредит.
    try {
      await deps.lots.transact(lotId, (current) => unclaimLot(current, now));
    } catch (cleanup) {
      deps.onError?.(cleanup instanceof Error ? cleanup : new Error(String(cleanup)), {
        lotId,
        buyerId,
        stage: 'unclaim'
      });
    }
    throw error;
  }

  // Шаг 3: выплата продавцу за вычетом комиссии.
  const net = lotNet(claimed);
  try {
    const payouts: LedgerDraft[][] = [];
    const seller = await deps.users.transact(claimed.sellerId, (current) => {
      const movement = paySeller(current, claimed, net, now);
      payouts.push(movement.drafts);
      return movement.account;
    });
    const written = await commitDrafts(deps, payouts[payouts.length - 1] ?? [], { lotId, buyerId, stage: 'payout' });
    const lot = await deps.lots.transact(lotId, (current) => markPaid(current, now));
    // Право объявить продажу — у того, кто записал выплату. `written === 0` значит,
    // что ключ `market:<лот>:payout` занял другой участник гонки (обычно это reconcile,
    // догнавший упавший между шагами buyLot), и вторым пушем мы бы просто наступили
    // на чужие уже отправленные деньги.
    if (written > 0) emitSold(deps, soldEvent(lot, seller, buyerId, net, now), { lotId, stage: 'payout' });
    return { lot, buyer, seller, settled: true };
  } catch (error) {
    // Худший из допустимых исходов: покупатель заплатил, продавец не получил.
    // Лот остаётся `sold` с `payoutSettled: false`, и reconcile доведёт деньги по
    // записи `market:<lot>:sec` — именно поэтому захват делался до денег, а не после.
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), {
      lotId,
      buyerId,
      sellerId: claimed.sellerId,
      stage: 'payout'
    });
    return { lot: claimed, buyer, seller: null, settled: false };
  }
}

// ─── Снятие лота продавцом ────────────────────────────────────────────────────

/**
 * Снять объявление: лот закрывается, хлам возвращается владельцу.
 *
 * Возврат идёт БЕЗ проверки потолка склада (см. `returnJunk`): игрок не виноват,
 * что его товар залежался, а ящик тем временем забился рейдами. Потерять его —
 * худший из исходов.
 */
export async function cancelLot(
  deps: MarketDeps,
  sellerId: string,
  lotId: string,
  now: Date
): Promise<{ lot: LotState; account: UserAccount }> {
  const found = await deps.lots.findById(lotId);
  if (!found) throw notFound(`Лот ${lotId} не найден`);
  if (found.sellerId !== sellerId) {
    throw new AppError(ErrorCodes.FORBIDDEN, 403, 'Чужой лот нельзя снять', { lotId, sellerId });
  }
  if (found.status === 'sold') {
    throw new AppError(ErrorCodes.MARKET_LOT_TAKEN, 409, 'Проданный лот нельзя снять', { lotId });
  }

  const released = await deps.lots.transact(lotId, (current) => releaseLot(current, 'cancelled', now));
  const captured: LedgerDraft[][] = [];
  const account = await deps.users.transact(sellerId, (current) => {
    const back = returnJunk(current, released, now, 'cancelled');
    captured.push(back.drafts);
    return back.account;
  });
  await commitDrafts(deps, captured[captured.length - 1] ?? [], { lotId, stage: 'return' });
  return { lot: released, account };
}

// ─── Разбор зависших лотов ────────────────────────────────────────────────────

export interface ReconcileResult {
  /** Лоты, чей эскроу подтвердился журналом и которые вышли в витрину. */
  activated: number;
  /** Лоты, снятые как просроченные, с возвращённым продавцу хламом. */
  expired: number;
  /** Проданные лоты, по которым деньги наконец доведены продавцу. */
  paidOut: number;
}

/**
 * Доводит до конца прерванные операции рынка. Арбитр — журнал (`hasKey`), потому что
 * статус документа знает только то, что мы про него думали в момент падения.
 *
 * Вызывается с чтения витрины (как `reconcileClan`): без фонового воркера это
 * единственный момент, когда «завис» может честно превратиться в «сделано» или
 * «отменено». Ограничение по `limit` держит цену запроса предсказуемой.
 */
export async function reconcileMarket(
  deps: MarketDeps,
  now: Date,
  limit = MARKET_FEED_LIMIT
): Promise<ReconcileResult> {
  const result: ReconcileResult = { activated: 0, expired: 0, paidOut: 0 };

  // 1. Лоты, вставленные, но не подтверждённые эскроу.
  for (const lot of await deps.lots.listPendingEscrow(limit)) {
    const escrowed = await deps.ledger.hasKey(makeIdempotencyKey('market', `${lot.id}:escrow`));
    if (escrowed) {
      await deps.lots.transact(lot.id, (current) => activateLot(current, now));
      result.activated += 1;
      continue;
    }
    // Списания нет — лот фиктивный, снимается. Хлам возвращать не нужно: его не списывали.
    await deps.lots.transact(lot.id, (current) => releaseLot(current, 'cancelled', now));
  }

  // 2. Просроченные витринные лоты: товар возвращается владельцу.
  for (const lot of await deps.lots.listExpired(now, limit)) {
    const escrowed = await deps.ledger.hasKey(makeIdempotencyKey('market', `${lot.id}:escrow`));
    const released = await deps.lots.transact(lot.id, (current) => releaseLot(current, 'expired', now));
    if (!escrowed) continue;
    const captured: LedgerDraft[][] = [];
    await deps.users.transact(lot.sellerId, (current) => {
      const back = returnJunk(current, released, now, 'expired');
      captured.push(back.drafts);
      return back.account;
    });
    await commitDrafts(deps, captured[captured.length - 1] ?? [], { lotId: lot.id, stage: 'return' });
    result.expired += 1;
  }

  // 3. Проданные без выплаты: покупатель заплатил (доказательство в журнале) —
  //    продавец должен получить.
  for (const lot of await deps.lots.listUnpaidPayouts(limit)) {
    const paid = await deps.ledger.hasKey(makeIdempotencyKey('market', `${lot.id}:sec`));
    if (!paid) {
      // Денег нет, а лот помечен проданным — значит падение было между захватом и
      // списанием. Возвращаем лот в витрину: держать чужой товар захваченным
      // бессмысленно.
      await deps.lots.transact(lot.id, (current) => unclaimLot(current, now));
      continue;
    }
    // Доказательство того, что деньги продавцу УЖЕ доведены, — запись выплаты в
    // журнале, а не флаг лота. Без этой проверки второй участник гонки (reconcile,
    // догнавший buyLot, упавший между журналом и отметкой лота) зачислил бы продавцу
    // сумму повторно: журнал отсекает ДВИЖЕНИЕ по уникальному ключу, а изменение
    // счёта игрока — нет, и `users.transact` послушно применяет редуктор к свежему
    // документу. Окно между этим `hasKey` и записью остаётся — закрывается оно только
    // транзакционным хранилищем (см. шапку user.store.ts про Шаг 6), здесь мы делаем
    // его настолько малым, насколько позволяет чтение одного документа.
    if (await deps.ledger.hasKey(makeIdempotencyKey('market', `${lot.id}:payout`))) {
      await deps.lots.transact(lot.id, (current) => markPaid(current, now));
      continue;
    }
    const net = lotNet(lot);
    const captured: LedgerDraft[][] = [];
    const seller = await deps.users.transact(lot.sellerId, (current) => {
      const movement = paySeller(current, lot, net, now);
      captured.push(movement.drafts);
      return movement.account;
    });
    const written = await commitDrafts(deps, captured[captured.length - 1] ?? [], {
      lotId: lot.id,
      stage: 'payout'
    });
    const settled = await deps.lots.transact(lot.id, (current) => markPaid(current, now));
    if (written > 0) {
      result.paidOut += 1;
      // Продажа, доведённая фоном, — ровно тот случай, когда продавца нет в игре
      // (иначе он бы увидел это сам и не ждал). Пуш здесь нужнее, чем в buyLot.
      emitSold(deps, soldEvent(settled, seller, lot.buyerId, net, now), { lotId: lot.id, stage: 'payout' });
    }
  }

  return result;
}

