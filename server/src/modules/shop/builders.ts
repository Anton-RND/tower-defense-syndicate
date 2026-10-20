import type { EconomyConfig } from '../../config/env.js';
import { BUILDER_SLOT_SKU, MAX_BUILDERS, builderPrice } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { effectiveBuildRobots, grantEntitlement } from '../economy/entitlements.js';
import { asteriumTotal, spendAsterium } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { Entitlement, UserAccount } from '../user/user.types.js';

/**
 * Магазин: продажа постоянных слотов роботов-строителей за астериев (п.3.1).
 *
 * Два решения, которые отличаются от «наивного» `user.buildersMax += 1`:
 *
 * 1. Слот — это перманентный entitlement, а не поле. Тогда возврат платежа
 *    откатывает его одной операцией `revokeEntitlementsByOrder(orderId)`, а не
 *    «догадывается», сколько слотов надо снять. Идемпотентность выдачи — тоже
 *    по orderId: повторный вебхук провайдера не продаст слот дважды.
 *
 * 2. Лестница цен считается по ПЕРМАНЕНТНЫМ слотам, а не по текущему эффективному
 *    числу роботов. Иначе временный буст «+1 робот на день» поднял бы цену
 *    постоянного слота — игрок заплатил бы больше за то же самое.
 *    Поэтому MAX_BUILDERS ограничивает ПРОДАЖУ, а не эффект временных бустов.
 */

export interface BuyBuilderInput {
  /** Внешний заказ (витрина / VK Pay). Не задан — генерируем детерминированный внутренний. */
  orderId?: string | null;
  idFactory: () => string;
}

export interface BuilderPurchase {
  account: UserAccount;
  /** Движения критания (сначала заработанный кошелёк, потом купленный). */
  drafts: LedgerDraft[];
  entitlement: Entitlement;
  orderId: string;
  price: number;
  /** Постоянных слотов после покупки (позиция на лестнице цен). */
  ownedAfter: number;
  /** Эффективное число роботов после покупки (с учётом временных бустов). */
  buildersMax: number;
  /** Цена следующего слота; null — продавать больше нечего. */
  nextPrice: number | null;
  asteriumLeft: number;
}

/** Сколько слотов куплено НАВСЕГДА (перманентные builder_slot). */
export function permanentBuilders(account: UserAccount): number {
  return account.entitlements
    .filter((entitlement) => entitlement.kind === 'builder_slot' && entitlement.permanent)
    .reduce((total, entitlement) => total + Math.trunc(entitlement.value), 0);
}

/** Позиция игрока на лестнице цен: базовые роботы + купленные навсегда слоты. */
export function buildersOwned(account: UserAccount): number {
  return Math.trunc(account.buildRobots) + permanentBuilders(account);
}

/** Детерминированный orderId слота: повторный ретрай клиента не создаст второй. */
export function builderOrderId(account: UserAccount, targetCount: number): string {
  return `builder:${account.id}:${targetCount}`;
}

export interface BuilderShopView {
  owned: number;
  limit: number;
  effective: number;
  /** Цена следующего слота; null — слотов больше нет. */
  price: number | null;
  canBuy: boolean;
  /** Причина отказа для UI: 'ok' | 'limit' | 'debt' | 'funds'. */
  reason: 'ok' | 'limit' | 'debt' | 'funds';
}

/** Витрина магазина: состояние кнопки «Купить робота» без бросания исключений. */
export function describeBuilderShop(account: UserAccount, now: Date): BuilderShopView {
  const owned = buildersOwned(account);
  const effective = effectiveBuildRobots(account, now);
  const price = owned >= MAX_BUILDERS ? null : builderPrice(owned);
  const total = asteriumTotal(account);

  if (price === null) return { owned, limit: MAX_BUILDERS, effective, price: null, canBuy: false, reason: 'limit' };
  // В долгу по донату платить можно только заработанным астерием: купленный кошелёк
  // отрицательный, и списание на него сверху только углубило бы долг без пользы площадке.
  const debtBlocked = account.materials.asterium.purchased < 0 && account.materials.asterium.earned < price;
  if (debtBlocked) return { owned, limit: MAX_BUILDERS, effective, price, canBuy: false, reason: 'debt' };
  if (total < price) return { owned, limit: MAX_BUILDERS, effective, price, canBuy: false, reason: 'funds' };
  return { owned, limit: MAX_BUILDERS, effective, price, canBuy: true, reason: 'ok' };
}

/**
 * Покупка следующего робота-строителя. Чистая функция: HTTP-слой оборачивает её
 * в `UserStore.transact`, а черновики журнала уходят в `LedgerStore.appendMany`.
 */
export function buyBuilder(
  account: UserAccount,
  now: Date,
  config: EconomyConfig,
  input: BuyBuilderInput
): BuilderPurchase {
  const owned = buildersOwned(account);

  if (owned >= MAX_BUILDERS) {
    throw new AppError(ErrorCodes.BUILDER_LIMIT_REACHED, 409, `Достигнут лимит роботов-строителей (${MAX_BUILDERS})`, {
      owned,
      limit: MAX_BUILDERS
    });
  }

  const price = builderPrice(owned);
  if (price === null) {
    throw new AppError(ErrorCodes.BUILDER_PRICE_MISSING, 500, 'В лестнице цен нет ступени для этого слота', { owned });
  }

  if (account.materials.asterium.purchased < 0 && account.materials.asterium.earned < price) {
    throw new AppError(
      ErrorCodes.PURCHASES_BLOCKED,
      403,
      'Есть неотработанный возврат платежа: покупка возможна только за заработанный астериев',
      { price, earned: account.materials.asterium.earned }
    );
  }

  const orderId = input.orderId ?? builderOrderId(account, owned + 1);
  if (account.entitlements.some((entitlement) => entitlement.orderId === orderId)) {
    // Проверка ДО списания: иначе ретрай вебхука спишет астериев и только потом откажет.
    throw new AppError(ErrorCodes.DUPLICATE_ORDER, 409, 'Этот слот уже выдан', { orderId });
  }

  const spent = spendAsterium(account, price, {
    ts: now,
    reason: 'builder_purchase',
    refType: 'order',
    refId: orderId,
    idempotencyKey: makeIdempotencyKey('builder', orderId),
    meta: { owned_before: owned, owned_after: owned + 1 }
  });

  const granted = grantEntitlement(
    spent.account,
    { sku: BUILDER_SLOT_SKU, kind: 'builder_slot', value: 1, source: 'purchase', durationMs: null, orderId },
    now,
    { idFactory: input.idFactory, maxActive: config.limits.purchases.maxActiveEntitlements }
  );

  const entitlement = granted.entitlements.at(-1);
  if (!entitlement) {
    throw new AppError(ErrorCodes.INTERNAL, 500, 'Магазин: слот выдан, но не найден в списке привилегий');
  }

  const ownedAfter = owned + 1;
  return {
    account: granted,
    drafts: spent.drafts,
    entitlement,
    orderId,
    price,
    ownedAfter,
    buildersMax: effectiveBuildRobots(granted, now),
    nextPrice: ownedAfter >= MAX_BUILDERS ? null : builderPrice(ownedAfter),
    asteriumLeft: asteriumTotal(granted)
  };
}

