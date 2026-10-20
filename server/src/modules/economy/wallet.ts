import {
  isCraftTechId,
  isTechMaterialId,
  TECH_LABEL,
  type AsteriumWalletName,
  type CraftTechId
} from '../../config/materials.js';
import {
  isJunkId,
  isMetalId,
  materialEntries,
  type JunkId,
  type MaterialCost,
  type MaterialId,
  type MetalId
} from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import {
  ASTERIUM_CURRENCY,
  junkCurrency,
  type LedgerCurrency,
  type LedgerDraft,
  type LedgerReason,
  type LedgerRefType
} from '../ledger/ledger.types.js';
import type { ResourceId, UserAccount } from '../user/user.types.js';

/**
 * Единая точка движения ценностей. Любая транзакция (покупка, реклама, крафт,
 * разбор, переработка, рейд, станок) обязана идти через эти функции: тогда каждое
 * изменение баланса сопровождается записью в журнал, и «откуда у игрока 10 000
 * астерия» перестаёт быть вопросом.
 */

export type BalanceTarget =
  | { kind: 'resource'; id: ResourceId }
  | { kind: 'asterium'; wallet: AsteriumWalletName }
  | { kind: 'tech'; id: CraftTechId }
  | { kind: 'metal'; id: MetalId }
  | { kind: 'junk'; id: JunkId };

export interface MovementContext {
  ts: Date;
  reason: LedgerReason;
  refType?: LedgerRefType;
  refId?: string | null;
  idempotencyKey?: string | null;
  meta?: Record<string, string | number | boolean | null>;
}

export interface Movement {
  account: UserAccount;
  draft: LedgerDraft;
}

export interface Movements {
  account: UserAccount;
  drafts: LedgerDraft[];
}

export const resource = (id: ResourceId): BalanceTarget => ({ kind: 'resource', id });
export const asterium = (wallet: AsteriumWalletName): BalanceTarget => ({ kind: 'asterium', wallet });
export const tech = (id: CraftTechId): BalanceTarget => ({ kind: 'tech', id });
export const metal = (id: MetalId): BalanceTarget => ({ kind: 'metal', id });
export const junk = (id: JunkId): BalanceTarget => ({ kind: 'junk', id });

/**
 * Материал чертежа → его баланс. Энергия в MaterialId не входит, поэтому
 * ветка 'resource' здесь всегда принимает валидный ResourceId.
 */
export function material(id: MaterialId): BalanceTarget {
  if (isJunkId(id)) return junk(id);
  if (isMetalId(id)) return metal(id);
  if (isCraftTechId(id)) return tech(id);
  return resource(id);
}

/** Человекочитаемое имя материала для сообщений об отказе («Недостаточно вольфрама»). */
export function balanceLabel(target: BalanceTarget): string {
  switch (target.kind) {
    case 'asterium':
      return TECH_LABEL.asterium.label.toLowerCase();
    case 'tech':
      return TECH_LABEL[target.id].label.toLowerCase();
    case 'metal':
    case 'junk':
    case 'resource':
      return target.id;
  }
}

function currencyOf(target: BalanceTarget): LedgerCurrency {
  switch (target.kind) {
    case 'resource':
      return target.id;
    case 'asterium':
      return ASTERIUM_CURRENCY[target.wallet];
    case 'tech':
      return target.id;
    case 'metal':
      return target.id;
    case 'junk':
      return junkCurrency(target.id);
  }
}

export function readBalance(account: UserAccount, target: BalanceTarget): number {
  switch (target.kind) {
    case 'resource':
      return account.resources[target.id];
    case 'asterium':
      return account.materials.asterium[target.wallet];
    case 'tech':
      return account.materials[target.id];
    case 'metal':
      return account.metals[target.id];
    case 'junk':
      return account.junk[target.id];
  }
}

function withBalance(account: UserAccount, target: BalanceTarget, value: number): UserAccount {
  switch (target.kind) {
    case 'resource':
      return { ...account, resources: { ...account.resources, [target.id]: value } };
    case 'asterium':
      return {
        ...account,
        materials: { ...account.materials, asterium: { ...account.materials.asterium, [target.wallet]: value } }
      };
    case 'tech':
      return { ...account, materials: { ...account.materials, [target.id]: value } };
    case 'metal':
      return { ...account, metals: { ...account.metals, [target.id]: value } };
    case 'junk':
      return { ...account, junk: { ...account.junk, [target.id]: value } };
  }
}

function assertAmount(amount: number, ctx: MovementContext): void {
  if (!Number.isFinite(amount) || amount < 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'Сумма движения не может быть отрицательной', {
      amount,
      reason: ctx.reason
    });
  }
}

function makeDraft(
  account: UserAccount,
  target: BalanceTarget,
  delta: number,
  after: number,
  ctx: MovementContext
): LedgerDraft {
  return {
    userId: account.id,
    currency: currencyOf(target),
    delta,
    balanceAfter: after,
    reason: ctx.reason,
    refType: ctx.refType ?? null,
    refId: ctx.refId ?? null,
    idempotencyKey: ctx.idempotencyKey ?? null,
    ts: ctx.ts,
    ...(ctx.meta ? { meta: ctx.meta } : {})
  };
}

/** Начисление. Возвращает новый аккаунт + черновик записи журнала. */
export function credit(account: UserAccount, target: BalanceTarget, amount: number, ctx: MovementContext): Movement {
  assertAmount(amount, ctx);
  const after = readBalance(account, target) + amount;
  return { account: withBalance(account, target, after), draft: makeDraft(account, target, amount, after, ctx) };
}

/** Списание. Не хватает — INSUFFICIENT_FUNDS (стор ничего не запишет: редуктор упал до мутации). */
export function debit(account: UserAccount, target: BalanceTarget, amount: number, ctx: MovementContext): Movement {
  assertAmount(amount, ctx);
  const available = readBalance(account, target);
  if (available < amount) {
    throw new AppError(ErrorCodes.INSUFFICIENT_FUNDS, 409, `Недостаточно средств: нужно ${amount}, есть ${available}`, {
      currency: currencyOf(target),
      required: amount,
      available,
      reason: ctx.reason
    });
  }
  const after = available - amount;
  return { account: withBalance(account, target, after), draft: makeDraft(account, target, -amount, after, ctx) };
}

/**
 * Трата астерия: сначала ЗАРАБОТАННЫЙ кошелёк, потом КУПЛЕННЫЙ.
 * Порядок принципиален — при возврате платежа у нас должен оставаться запас
 * купленных единиц для честного отзыва, а не ситуация «игрок потратил купленное,
 * а долг снимать с заработанного».
 */
export function spendAsterium(account: UserAccount, amount: number, ctx: MovementContext): Movements {
  assertAmount(amount, ctx);
  const drafts: LedgerDraft[] = [];
  let next = account;

  // Ключ на КОШЕЛЁК, а не на действие. Одно списание может разделиться на два
  // движения (заработанный + купленный), а уникальный индекс журнала смотрит только
  // на idempotencyKey: с общим ключом второе движение было бы молча отброшено как
  // дубль первого — единицы ушли бы из баланса без следа в учёте.
  const keyed = (wallet: AsteriumWalletName): MovementContext =>
    ctx.idempotencyKey ? { ...ctx, idempotencyKey: `${ctx.idempotencyKey}:${wallet}` } : ctx;

  const fromEarned = Math.min(next.materials.asterium.earned, amount);
  if (fromEarned > 0) {
    const movement = debit(next, asterium('earned'), fromEarned, keyed('earned'));
    next = movement.account;
    drafts.push(movement.draft);
  }
  const rest = amount - fromEarned;
  if (rest > 0) {
    const movement = debit(next, asterium('purchased'), rest, keyed('purchased'));
    next = movement.account;
    drafts.push(movement.draft);
  }
  if (drafts.length === 0) {
    throw new AppError(ErrorCodes.INSUFFICIENT_FUNDS, 409, 'Недостаточно астерия', {
      currency: 'asterium',
      required: amount,
      available: asteriumTotal(account),
      reason: ctx.reason
    });
  }
  return { account: next, drafts };
}

/**
 * Возврат платежа: снимаем ТОЛЬКО с купленного кошелька и не боимся уйти в минус —
 * минус блокирует будущие покупки (isPurchaseBlocked), но не отнимает уже купленный
 * игровой прогресс, полученный честно до возврата.
 */
export function refundAsterium(account: UserAccount, amount: number, ctx: MovementContext): Movement {
  assertAmount(amount, ctx);
  const after = account.materials.asterium.purchased - amount;
  const next: UserAccount = {
    ...account,
    materials: { ...account.materials, asterium: { ...account.materials.asterium, purchased: after } }
  };
  return {
    account: next,
    draft: makeDraft(account, asterium('purchased'), -amount, after, { ...ctx, reason: 'refund' })
  };
}

export function asteriumTotal(account: UserAccount): number {
  return account.materials.asterium.purchased + account.materials.asterium.earned;
}

/** Признак «игрок в минусе по донату» — платёжный маршрут обязан отказать. */
export function isPurchaseBlocked(account: UserAccount): boolean {
  return account.materials.asterium.purchased < 0;
}

// ─── Сырьевые материалы (хрониум, вольфрам, станиум) ───────────────────────────

/**
 * Трата сырья в один шаг. В отличие от астерия здесь один кошелёк, поэтому и одно
 * движение с одним ключом: суффиксы кошелька нужны только там, где одна трата
 * распадается на два баланса.
 */
export function spendTech(account: UserAccount, id: CraftTechId, amount: number, ctx: MovementContext): Movement {
  return debit(account, tech(id), amount, ctx);
}

/**
 * Возврат платежа за пак сырья: снимаем начисленное и позволяем уйти в минус.
 *
 * Минус по сырью — не «валюта в долг», а признак неотработанного возврата:
 * тратить отрицательный баланс debit всё равно не даст (available < amount на любом
 * положительном количестве), а честный заработок игрока при этом не страдает —
 * долг гасится новыми начислениями того же материала.
 * Запретить уход в минус было бы хуже: игрок успел бы потратить пак до chargeback,
 * и отзыв превратился бы в невозможный «верни то, чего нет».
 */
export function refundTech(account: UserAccount, id: CraftTechId, amount: number, ctx: MovementContext): Movement {
  assertAmount(amount, ctx);
  const after = readBalance(account, tech(id)) - amount;
  return {
    account: withBalance(account, tech(id), after),
    draft: makeDraft(account, tech(id), -amount, after, { ...ctx, reason: 'refund' })
  };
}

/** Суммарный долг по сырью — признак «есть неотработанный возврат платежа». */
export function hasTechDebt(account: UserAccount): boolean {
  return account.materials.chronium < 0 || account.materials.wolfram < 0 || account.materials.stanium < 0;
}

// ─── Монета синдиката (SEC) ─────────────────────────────────────────────────

/**
 * Трата SEC.
 *
 * ПРИЧЕМ ЗДЕСЬ, А НЕ ПРЯМОЙ `debit(account, resource('sec'), …)` В МАРШРУТЕ
 * ───────────────────────────────────────────────────────────────────────────
 * Кошелёк монеты ДРОБНЫЙ (`secGained = coinRate × часы`), а тратить её разрешено
 * ЦЕЛОЕ — ровно то число, которое витрина показала игроку как `secSpendable`
 * (modules/economy/view.ts). Прямой `debit` это правило не проверит: он честно
 * спишет 123.45, а игрок увидел 123. Расхождение между «сколько показал» и
 * «сколько снял» — самый дорогой сорт бага в экономике, потому что виден только
 * через месяц, по жалобе на баланс.
 *
 * Вторая причина — точка учёта. Пока SEC тратится из одного места, «откуда у игрока
 * столько монет» и «куда они ушли» отвечаются одной функцией. Когда рынок (Часть 2)
 * добавит вторую и третью трату, разбросанный `debit` превратится в N мест, где
 * правило целости надо вспоминать вручную.
 */
export function spendSec(account: UserAccount, amount: number, ctx: MovementContext): Movement {
  assertAmount(amount, ctx);
  if (!Number.isInteger(amount)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'SEC тратятся целыми единицами', {
      amount,
      reason: ctx.reason
    });
  }
  return debit(account, resource('sec'), amount, ctx);
}

/** Доступный к трате остаток монеты — то же число, что витрина показывает игроку. */
export function spendableSec(account: UserAccount): number {
  return Math.floor(account.resources.sec);
}

// ─── Пачки материалов (чертежи, разбор, лут, переработка) ─────────────────────

export interface MaterialContext extends MovementContext {
  /**
   * Ключ идемпотентности отдельно на каждый материал пачки. Без этого вторая
   * запись одного действия попадёт под уникальный индекс первой и будет потеряна.
   * Возврат null = запись в журнал без ключа (одноразовые клиентские действия,
   * где роль дедауплера играет само состояние аккаунта).
   */
  idempotencyKeyFor?: (id: MaterialId) => string | null;
}

export interface MaterialMovement {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Что реально переместилось (после нормализации конфига). */
  moved: MaterialCost;
}

function contextForMaterial(ctx: MaterialContext, id: MaterialId): MovementContext {
  const { idempotencyKeyFor, ...rest } = ctx;
  return { ...rest, idempotencyKey: idempotencyKeyFor ? idempotencyKeyFor(id) : (ctx.idempotencyKey ?? null) };
}

/**
 * Списывает набор материалов (оплата чертежа, сдача хлама).
 * Атомарно: на первом же дефиците бросается INSUFFICIENT_FUNDS, а редуктор в
 * `UserStore.transact` означает «запись не тронута» — частичной оплаты не бывает.
 */
export function payMaterials(account: UserAccount, cost: MaterialCost, ctx: MaterialContext): MaterialMovement {
  const drafts: LedgerDraft[] = [];
  const moved: MaterialCost = {};
  let next = account;
  for (const [id, amount] of materialEntries(cost)) {
    const movement = debit(next, material(id), amount, contextForMaterial(ctx, id));
    next = movement.account;
    drafts.push(movement.draft);
    moved[id] = amount;
  }
  return { account: next, drafts, moved };
}

/** Начисляет набор материалов (возврат при разборе, выход переработки, боевой лут). */
export function gainMaterials(account: UserAccount, cost: MaterialCost, ctx: MaterialContext): MaterialMovement {
  const drafts: LedgerDraft[] = [];
  const moved: MaterialCost = {};
  let next = account;
  for (const [id, amount] of materialEntries(cost)) {
    const movement = credit(next, material(id), amount, contextForMaterial(ctx, id));
    next = movement.account;
    drafts.push(movement.draft);
    moved[id] = amount;
  }
  return { account: next, drafts, moved };
}