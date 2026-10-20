import type { EconomyConfig } from '../../config/env.js';
import { getSku, type ShopSku } from '../../config/shop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { dayKey } from '../economy/energy.js';
import { credit, refundAsterium, refundTech, asterium, tech } from '../economy/wallet.js';
import { grantEntitlement, revokeEntitlementsByOrder } from '../economy/entitlements.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';

/**
 * Заказы на покупку (Часть 1).
 *
 * ПОЧЕМУ ЗАКАЗ ЖИВЁТ В ДОКУМЕНТЕ ИГРОКА, А НЕ В ОТДЕЛЬНОЙ КОЛЛЕКЦИИ. Идемпотентность
 * выдачи товара обеспечивает состояние аккаунта, а не журнал (см. шапку
 * modules/ledger/ledger.store.ts): повторный вебхук обязан найти в документе заказ
 * в статусе `paid` и выдать товар ровно один раз, переведя его в `fulfilled`.
 * Отдельная коллекция означала бы два документа на одно действие при том, что стор
 * атомарен в пределах одного, — ровно та проблема, которую в Шаге 4 решал `commitRaid`.
 * Здесь же «выдать и отметить» происходит в одном редукторе `UserStore.transact`.
 *
 * СТАТУСЫ — ЭТО ШАГЫ ДОВЕРИЯ, А НЕ ДЕКОРАЦИЯ:
 *   pending   заказ создан, площадка о нём ещё ничего не сообщала;
 *   paid      площадка подтвердила оплату подписанным событием — ДОВЕРИЕ ПОЯВИЛОСЬ;
 *   fulfilled товар выдан игроку;
 *   void      заказ сгорел (окно вышло) или отменён: деньги не списывались;
 *   refunded  платёж возвращён, товар отозван (см. refundOrder).
 * Между `pending` и `paid` нет перехода «по просьбе клиента»: единственный способ
 * попасть в `paid` — пройти проверку подписи в modules/payment/provider.vk.ts.
 */

export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'void' | 'refunded';

export interface PurchaseOrder {
  /** Наш id: `order:<userId>:<nonce>`. По нему постбэк площадки находит игрока. */
  id: string;
  sku: string;
  /** Сколько критания положено по SKU (снимок каталога на момент создания заказа). */
  amount: number;
  /** Цена на момент создания, рубли — для сверки с агентом выплат. */
  priceRub: number;
  status: OrderStatus;
  createdAt: Date;
  /** После этой даты неподтверждённый заказ аннулируется (деньги не списывались). */
  expiresAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  refundedAt: Date | null;
  /** order_id площадки: внешний ключ сверки и ответа на тикет «где мой пак». */
  providerOrderId: string | null;
  /** Причина аннулирования/отказа — только для диагностики, на логику не влияет. */
  note: string | null;
}

/** Сколько неподтверждённых заказов может висеть у одного игрока одновременно. */
export const MAX_PENDING_ORDERS = 3;

const ORDER_PREFIX = 'order:';

/** order id, из которого однозначно читается владелец: постбэк приходит без сессии. */
export function makeOrderId(userId: string, nonce: string): string {
  return `${ORDER_PREFIX}${userId}:${nonce}`;
}

/** Владелец заказа по его id. null — id не наш (подделка или чужая схема). */
export function parseOrderId(id: string): string | null {
  if (!id.startsWith(ORDER_PREFIX)) return null;
  const rest = id.slice(ORDER_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep === rest.length - 1) return null;
  return rest.slice(0, sep);
}

export function findOrder(account: UserAccount, orderId: string): PurchaseOrder | undefined {
  return account.orders.find((order) => order.id === orderId);
}

export function pendingOrders(account: UserAccount, now: Date): PurchaseOrder[] {
  return account.orders.filter((o) => o.status === 'pending' && o.expiresAt.getTime() > now.getTime());
}

/** Сколько раз этот SKU уже заказан сегодня (считаем и pending: лимит — на попытки). */
export function ordersOfSkuToday(account: UserAccount, sku: string, now: Date): number {
  const day = dayKey(now);
  return account.orders.filter(
    (order) => order.sku === sku && order.status !== 'void' && order.createdAt.toISOString().slice(0, 10) === day
  ).length;
}

function assertPaymentsEnabled(config: EconomyConfig): void {
  if (!config.limits.purchases.enabled) {
    throw new AppError(ErrorCodes.PAYMENTS_NOT_CONFIGURED, 503, 'Платежи ещё не подключены на площадке');
  }
}

function assertKnownSku(sku: string): ShopSku {
  const item = getSku(sku);
  if (!item) throw new AppError(ErrorCodes.UNKNOWN_SKU, 400, 'Такой позиции нет в каталоге', { sku });
  if (item.retired) throw new AppError(ErrorCodes.UNKNOWN_SKU, 409, 'Позиция снята с продажи', { sku });
  return item;
}

function withOrders(account: UserAccount, orders: PurchaseOrder[]): UserAccount {
  return { ...account, orders };
}

/** Выбрасывает самые старые ЗАКРЫТЫЕ заказы, сохраняя потолок размера документа. */
function pruneOrders(orders: PurchaseOrder[], history: number): PurchaseOrder[] {
  if (history <= 0 || orders.length <= history) return orders;
  const live = orders.filter((o) => o.status === 'pending' || o.status === 'paid');
  const closed = orders.filter((o) => o.status !== 'pending' && o.status !== 'paid');
  const keepClosed = closed.slice(Math.max(0, closed.length - Math.max(0, history - live.length)));
  return [...keepClosed, ...live].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

export interface OpenOrderResult {
  account: UserAccount;
  order: PurchaseOrder;
  /** true — такой заказ уже был создан ранее (ретрай клиента), новый не создавался. */
  resumed: boolean;
}

/**
 * Шаг 1 (по просьбе клиента): завести заказ и получить параметры окна оплаты ВК.
 *
 * Возврат существующего неподтверждённого заказа того же SKU — не ошибка: фронт
 * ретраит запрос по плохой сети, а второй заказ того же пака означал бы двойное
 * списание за одну нажатую кнопку.
 */
export function openOrder(
  account: UserAccount,
  sku: string,
  now: Date,
  config: EconomyConfig,
  nonce: string
): OpenOrderResult {
  assertPaymentsEnabled(config);
  const item = assertKnownSku(sku);
  const limits = config.limits.purchases;

  const pending = pendingOrders(account, now);
  const existing = pending.find((order) => order.sku === sku);
  if (existing) return { account, order: existing, resumed: true };

  if (pending.length >= MAX_PENDING_ORDERS) {
    throw new AppError(ErrorCodes.PURCHASE_LIMIT_REACHED, 429, 'Слишком много неподтверждённых заказов', {
      pending: pending.length,
      limit: MAX_PENDING_ORDERS
    });
  }
  if (limits.dailyPerSku > 0 && ordersOfSkuToday(account, sku, now) >= limits.dailyPerSku) {
    throw new AppError(ErrorCodes.PURCHASE_LIMIT_REACHED, 429, 'Суточный лимит покупок этой позиции исчерпан', {
      sku,
      limit: limits.dailyPerSku
    });
  }

  const order: PurchaseOrder = {
    id: makeOrderId(account.id, nonce),
    sku: item.sku,
    amount: item.kind === 'asterium' || item.kind === 'material' ? item.amount : 0,
    priceRub: item.priceRub,
    status: 'pending',
    createdAt: now,
    expiresAt: new Date(now.getTime() + limits.orderTtlMs),
    paidAt: null,
    fulfilledAt: null,
    refundedAt: null,
    providerOrderId: null,
    note: null
  };

  return {
    account: withOrders(account, pruneOrders([...account.orders, order], limits.orderHistory)),
    order,
    resumed: false
  };
}

/** Что именно принесло подписанное событие площадки. */
export interface ProviderProof {
  providerOrderId?: string | null;
  /** Имя товара для `type: 'item'`. */
  item?: string | null;
  /** Количество Голосов для `type: 'votes'`. */
  votes?: number | null;
}

export interface FulfillResult {
  account: UserAccount;
  order: PurchaseOrder;
  drafts: LedgerDraft[];
  /** 'asterium:<n>' | 'entitlement:<sku>' | '' — что реально выдано этим вызовом. */
  granted: string;
  /** true — повторное подтверждение: товар во второй раз НЕ выдавался. */
  duplicate: boolean;
}

function patchOrder(account: UserAccount, orderId: string, patch: Partial<PurchaseOrder>): UserAccount {
  return withOrders(
    account,
    account.orders.map((order) => (order.id === orderId ? { ...order, ...patch } : order))
  );
}

/**
 * Шаг 2: площадка сообщила об оплате. Единственный вход в статус `paid`.
 *
 * ПОЗДНЕЕ ПОДТВЕРЖДЕНИЕ ВОССТАНАВЛИВАЕТ ЗАКАЗ. Наш TTL нужен интерфейсу, чтобы
 * отпустить кнопку «купить»: он не знает, успел ли игрок заплатить. Подписанное
 * событие площадки авторитетнее нашего таймера — если деньги списались, товар
 * обязан быть выдан, даже если заказ уже успели пометить `void`. Молчаливый отказ
 * здесь означал бы «игрок заплатил и ничего не получил» — худший ответ монетизации.
 */
export function markPaid(
  account: UserAccount,
  orderId: string,
  proof: ProviderProof,
  now: Date
): { account: UserAccount; order: PurchaseOrder; duplicate: boolean } {
  const order = findOrder(account, orderId);
  if (!order) throw new AppError(ErrorCodes.ORDER_NOT_FOUND, 404, 'Заказ не найден', { orderId });

  const item = assertKnownSku(order.sku);
  if (item.box.type === 'item') {
    const name = proof.item ?? null;
    if (name !== null && name !== item.box.item) {
      throw new AppError(ErrorCodes.INVALID_PAYMENT_SIGNATURE, 400, 'Товар в подтверждении не совпал с заказом', {
        orderId,
        expected: item.box.item,
        got: name
      });
    }
  } else if (item.votes !== null && typeof proof.votes === 'number' && proof.votes < item.votes) {
    throw new AppError(ErrorCodes.INVALID_PAYMENT_SIGNATURE, 400, 'Голосов списано меньше, чем стоит позиция', {
      orderId,
      expected: item.votes,
      got: proof.votes
    });
  }

  if (order.status === 'paid' || order.status === 'fulfilled') {
    return { account, order, duplicate: true };
  }
  if (order.status === 'refunded') {
    throw new AppError(ErrorCodes.ORDER_ALREADY_FULFILLED, 409, 'Заказ уже возвращён площадкой', { orderId });
  }

  const next = patchOrder(account, orderId, {
    status: 'paid',
    paidAt: now,
    providerOrderId: proof.providerOrderId ?? order.providerOrderId,
    note: order.status === 'void' ? 'resurrected_by_provider_confirmation' : null
  });
  return { account: next, order: findOrder(next, orderId) as PurchaseOrder, duplicate: false };
}

/**
 * Шаг 3: выдать товар. Отдельный шаг, а не склейка с `markPaid`, потому что
 * идемпотентность держится на «уже выдано», а не на «уже оплачено»: вебхук площадки
 * может прийти дважды подряд, и второй не обязан удваивать пак.
 */
export function fulfillOrder(
  account: UserAccount,
  orderId: string,
  now: Date,
  config: EconomyConfig,
  idFactory: () => string
): FulfillResult {
  const limits = config.limits.purchases;
  const order = findOrder(account, orderId);
  if (!order) throw new AppError(ErrorCodes.ORDER_NOT_FOUND, 404, 'Заказ не найден', { orderId });
  if (order.status === 'fulfilled') {
    return { account, order, drafts: [], granted: '', duplicate: true };
  }
  if (order.status !== 'paid') {
    throw new AppError(ErrorCodes.ORDER_UNPAID, 409, 'Заказ не подтверждён площадкой — товар не выдаётся', {
      orderId,
      status: order.status
    });
  }

  const item = assertKnownSku(order.sku);
  const drafts: LedgerDraft[] = [];
  let next = account;
  let granted = '';

  if (item.kind === 'asterium') {
    const movement = credit(next, asterium('purchased'), order.amount, {
      ts: now,
      reason: 'purchase',
      refType: 'order',
      refId: order.id,
      idempotencyKey: makeIdempotencyKey('order', order.id),
      meta: {
        sku: order.sku,
        price_rub: order.priceRub,
        provider_order_id: order.providerOrderId
      }
    });
    next = movement.account;
    drafts.push(movement.draft);
    granted = `asterium_purchased:${order.amount}`;
  } else if (item.kind === 'material') {
    // Пакет сырья: плоский счётчик, без разделения на купленное/заработанное.
    // Идемпотентность — по тому же ключу заказа, что и у астерия: повторный вебхук
    // площадки обязан найти заказ в статусе `fulfilled` и ничего не выдать.
    const movement = credit(next, tech(item.material), order.amount, {
      ts: now,
      reason: 'purchase',
      refType: 'order',
      refId: order.id,
      idempotencyKey: makeIdempotencyKey('order', order.id),
      meta: {
        sku: order.sku,
        material: item.material,
        price_rub: order.priceRub,
        provider_order_id: order.providerOrderId
      }
    });
    next = movement.account;
    drafts.push(movement.draft);
    granted = `${item.material}:${order.amount}`;
  } else {
    next = grantEntitlement(
      next,
      {
        sku: item.sku,
        kind: item.entitlement.kind,
        value: item.entitlement.value,
        source: 'purchase',
        durationMs: item.entitlement.durationMs,
        orderId: order.id
      },
      now,
      { idFactory, maxActive: limits.maxActiveEntitlements }
    );
    // Движения валюты нет: реальная цена привилегии зафиксирована не в журнале, а в
    // заказе (providerOrderId + priceRub) — по ним и строится сверка с агентом выплат.
    granted = `entitlement:${item.sku}`;
  }

  next = patchOrder(next, orderId, { status: 'fulfilled', fulfilledAt: now, note: null });
  return {
    account: withOrders(next, pruneOrders(next.orders, limits.orderHistory)),
    order: findOrder(next, orderId) as PurchaseOrder,
    drafts,
    granted,
    duplicate: false
  };
}

/** Шаги 2+3 одной операцией для обработчика подписанного события площадки. */
export function confirmPurchase(
  account: UserAccount,
  orderId: string,
  proof: ProviderProof,
  now: Date,
  config: EconomyConfig,
  idFactory: () => string
): FulfillResult {
  const marked = markPaid(account, orderId, proof, now);
  if (marked.order.status === 'fulfilled') {
    return { account: marked.account, order: marked.order, drafts: [], granted: '', duplicate: true };
  }
  return fulfillOrder(marked.account, orderId, now, config, idFactory);
}

/** Аннулирование неподтверждённых заказов: вызывается тиком и перед чтением витрины. */
export function voidExpiredOrders(account: UserAccount, now: Date): { account: UserAccount; voided: number } {
  const isExpired = (order: PurchaseOrder): boolean =>
    order.status === 'pending' && order.expiresAt.getTime() <= now.getTime();
  const expired = account.orders.filter(isExpired);
  if (expired.length === 0) return { account, voided: 0 };

  return {
    account: withOrders(
      account,
      account.orders.map((order) => (isExpired(order) ? { ...order, status: 'void' as const, note: 'expired' } : order))
    ),
    voided: expired.length
  };
}

/**
 * Возврат платежа: отзыв товара и долг по купленному кошельку.
 *
 * Окно приёма ограничено (`limits.purchases.refundWindowDays`) не из солидарности:
 * отозвать уже потраченный буст нельзя, а вот уйти в минус по астерию и заблокировать
 * игроку будущие покупки (`isPurchaseBlocked`) — реальный вред, и он допустим только
 * против свежих платежей, которые площадка ещё может отменить по нашей же просьбе.
 */
export function refundOrder(
  account: UserAccount,
  orderId: string,
  now: Date,
  config: EconomyConfig
): FulfillResult {
  const limits = config.limits.purchases;
  const order = findOrder(account, orderId);
  if (!order) throw new AppError(ErrorCodes.ORDER_NOT_FOUND, 404, 'Заказ не найден', { orderId });
  if (order.status === 'refunded') {
    return { account, order, drafts: [], granted: '', duplicate: true };
  }
  if (order.status !== 'fulfilled') {
    throw new AppError(ErrorCodes.ORDER_UNPAID, 409, 'Возврат возможен только по выданному заказу', {
      orderId,
      status: order.status
    });
  }
  const fulfilledAt = order.fulfilledAt ?? order.paidAt ?? order.createdAt;
  const windowMs = limits.refundWindowDays * 24 * 60 * 60 * 1000;
  if (now.getTime() - fulfilledAt.getTime() > windowMs) {
    throw new AppError(ErrorCodes.REFUND_TOO_LATE, 409, 'Окно приёма возврата истекло', {
      orderId,
      refundWindowDays: limits.refundWindowDays
    });
  }

  const drafts: LedgerDraft[] = [];
  let next = revokeEntitlementsByOrder(account, order.id);
  const item = assertKnownSku(order.sku);
  if (order.amount > 0 && item.kind === 'asterium') {
    const movement = refundAsterium(next, order.amount, {
      ts: now,
      reason: 'refund',
      refType: 'order',
      refId: order.id,
      idempotencyKey: makeIdempotencyKey('order', `${order.id}:refund`),
      meta: { sku: order.sku, price_rub: order.priceRub }
    });
    next = movement.account;
    drafts.push(movement.draft);
  } else if (order.amount > 0 && item.kind === 'material') {
    // Сырьё отзываем в тот же плоский счётчик, вплоть до минуса: игрок мог успеть
    // потратить пак до chargeback, и «верни то, чего нет» здесь — не ошибка, а
    // единственный честный исход. Минус блокирует трату материала (debit требует
    // available >= amount) и гасится новыми начислениями.
    const movement = refundTech(next, item.material, order.amount, {
      ts: now,
      reason: 'refund',
      refType: 'order',
      refId: order.id,
      idempotencyKey: makeIdempotencyKey('order', `${order.id}:refund`),
      meta: { sku: order.sku, material: item.material, price_rub: order.priceRub }
    });
    next = movement.account;
    drafts.push(movement.draft);
  }
  next = patchOrder(next, orderId, { status: 'refunded', refundedAt: now, note: 'refunded' });

  return {
    account: withOrders(next, pruneOrders(next.orders, limits.orderHistory)),
    order: findOrder(next, orderId) as PurchaseOrder,
    drafts,
    granted: `refund:${order.sku}`,
    duplicate: false
  };
}

/** Витрина статуса заказов: по ней клиент догоняет выдачу после возвращения в WebView. */
export interface OrderView {
  id: string;
  sku: string;
  status: OrderStatus;
  amount: number;
  createdAt: Date;
  expiresAt: Date;
  fulfilledAt: Date | null;
  providerOrderId: string | null;
}

export function describeOrders(account: UserAccount): OrderView[] {
  return account.orders.map((order) => ({
    id: order.id,
    sku: order.sku,
    status: order.status,
    amount: order.amount,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    fulfilledAt: order.fulfilledAt,
    providerOrderId: order.providerOrderId
  }));
}
