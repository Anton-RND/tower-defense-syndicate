import type { EconomyConfig } from '../../config/env.js';
import { getSku } from '../../config/shop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import type { LedgerEntry } from '../ledger/ledger.types.js';
import type { LedgerStore } from '../ledger/ledger.store.js';
import type { UserAccount } from '../user/user.types.js';
import type { UserStore } from '../user/user.store.js';
import {
  confirmPurchase,
  openOrder,
  parseOrderId,
  refundOrder,
  voidExpiredOrders,
  type FulfillResult,
  type OpenOrderResult,
  type ProviderProof,
  type PurchaseOrder
} from './orders.js';

/**
 * Точка сборки платёжного маршрута (Часть 1) — единственное место, где домен заказов
 * встречается со сторами.
 *
 * Порядок фиксации общий для всего проекта: сначала `UserStore.transact` успешно
 * меняет аккаунт, затем `LedgerStore.appendMany` пишет факт (см. шапку ledger.store.ts).
 * Исключение внутри редуктора = запись не тронута, поэтому отказ по `ORDER_UNPAID`
 * не оставляет «половинчатых» денег в журнале.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: выдачу товара по сигналу клиента. Функция для этого одна —
 * `confirmPayment`, и вызываться она может только из обработчика подписанного события
 * площадки. `noteClientReceipt` лишь запоминает order_id из ответа bridge: он нужен
 * поддержке для связки «экран игрока ↔ платёж площадки», и больше ни для чего.
 */

export interface PaymentDeps {
  users: UserStore;
  ledger: LedgerStore;
  idFactory: () => string;
}

export interface Checkout {
  account: UserAccount;
  order: PurchaseOrder;
  /** Параметры для `VKWebAppShowOrderBox` — их выбирает сервер, а не клиент. */
  box: { type: 'votes' | 'item'; item: string | null };
  priceRub: number;
  /** true — заказ уже существовал (ретрай клиента), новый не создавался. */
  resumed: boolean;
}

/** Шаг 1: создать (или вернуть живой) заказ и отдать клиенту параметры окна оплаты. */
export async function openCheckout(
  deps: PaymentDeps,
  userId: string,
  sku: string,
  now: Date,
  config: EconomyConfig
): Promise<Checkout> {
  const item = getSku(sku);
  if (!item) throw new AppError(ErrorCodes.UNKNOWN_SKU, 400, 'Такой позиции нет в каталоге', { sku });

  // Массив, а не переменная: TS не верит присваиваниям внутри колбэка (тот же приём,
  // что и в commitRaid), а редуктор обязан вернуть и новый аккаунт, и созданный заказ.
  const captured: OpenOrderResult[] = [];
  const account = await deps.users.transact(userId, (current) => {
    const result = openOrder(current, sku, now, config, `${now.getTime()}:${deps.idFactory()}`);
    captured.push(result);
    return result.account;
  });
  const result = captured[captured.length - 1];
  if (!result) throw new AppError(ErrorCodes.INTERNAL, 500, 'Заказ не создан');

  return { account, order: result.order, box: { ...item.box }, priceRub: item.priceRub, resumed: result.resumed };
}

/**
 * Шаг 2+3: подтверждение оплаты от площадки. `orderId` — наш external_order_id из
 * подписанного события; владелец читается прямо из него (постбэк приходит без JWT).
 */
export async function confirmPayment(
  deps: PaymentDeps,
  orderId: string,
  proof: ProviderProof,
  now: Date,
  config: EconomyConfig
): Promise<FulfillResult & { userId: string }> {
  const userId = parseOrderId(orderId);
  if (!userId) throw new AppError(ErrorCodes.ORDER_NOT_FOUND, 404, 'Заказ не принадлежит нашему каталогу', { orderId });

  const captured: FulfillResult[] = [];
  const account = await deps.users.transact(userId, (current) => {
    const result = confirmPurchase(current, orderId, proof, now, config, deps.idFactory);
    captured.push(result);
    return result.account;
  });
  const result = captured[captured.length - 1];
  if (!result) throw new AppError(ErrorCodes.INTERNAL, 500, 'Резолвер заказа не вернул результата');

  const entries: LedgerEntry[] = result.drafts.map((draft) => ({ ...draft, id: deps.idFactory() }));
  if (entries.length > 0) await deps.ledger.appendMany(entries);

  return { ...result, account, userId };
}

/** Возврат платежа от площадки: отзыв товара и долг по купленному кошельку. */
export async function refundPayment(
  deps: PaymentDeps,
  orderId: string,
  now: Date,
  config: EconomyConfig
): Promise<FulfillResult & { userId: string }> {
  const userId = parseOrderId(orderId);
  if (!userId) throw new AppError(ErrorCodes.ORDER_NOT_FOUND, 404, 'Заказ не принадлежит нашему каталогу', { orderId });

  const captured: FulfillResult[] = [];
  const account = await deps.users.transact(userId, (current) => {
    const result = refundOrder(current, orderId, now, config);
    captured.push(result);
    return result.account;
  });
  const result = captured[captured.length - 1];
  if (!result) throw new AppError(ErrorCodes.INTERNAL, 500, 'Резолвер возврата не вернул результата');

  const entries: LedgerEntry[] = result.drafts.map((draft) => ({ ...draft, id: deps.idFactory() }));
  if (entries.length > 0) await deps.ledger.appendMany(entries);

  return { ...result, account, userId };
}

/**
 * Сигнал клиента: окно оплаты закрылось. Товар НЕ выдаёт — только запоминает
 * order_id площадки в живой заказ, чтобы поддержка могла связать экран с платежом.
 */
export async function noteClientReceipt(
  deps: PaymentDeps,
  userId: string,
  orderId: string,
  providerOrderId: string | null,
  now: Date
): Promise<UserAccount> {
  if (parseOrderId(orderId) !== userId) {
    throw new AppError(ErrorCodes.ORDER_NOT_FOUND, 404, 'Заказ не принадлежит игроку', { orderId, userId });
  }
  return deps.users.transact(userId, (current) => {
    const order = current.orders.find((candidate) => candidate.id === orderId);
    if (!order) throw new AppError(ErrorCodes.ORDER_NOT_FOUND, 404, 'Заказ не найден', { orderId });
    if (!providerOrderId) return current;
    if (order.providerOrderId && order.providerOrderId !== providerOrderId) {
      throw new AppError(ErrorCodes.INVALID_PAYMENT_SIGNATURE, 400, 'Номер платежа не совпал с заказом', { orderId });
    }
    return {
      ...current,
      orders: current.orders.map((candidate) =>
        candidate.id === orderId
          ? { ...candidate, providerOrderId, note: `client_receipt:${now.toISOString()}` }
          : candidate
      )
    };
  });
}

/** Уборка сгоревших заказов: дёргается тиком экономики и читателем витрины. */
export async function sweepExpiredOrders(deps: PaymentDeps, userId: string, now: Date): Promise<UserAccount> {
  return deps.users.transact(userId, (current) => voidExpiredOrders(current, now).account);
}

