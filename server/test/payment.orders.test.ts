import { describe, expect, it } from 'vitest';

import { describeCatalog, getSku, getSkuByBoxItem, SHOP_SKUS } from '../src/config/shop.js';
import { isCraftTechId } from '../src/config/materials.js';
import { credit, hasTechDebt, isPurchaseBlocked, spendTech, tech } from '../src/modules/economy/wallet.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import {
  confirmPayment,
  noteClientReceipt,
  openCheckout,
  refundPayment,
  sweepExpiredOrders,
  type PaymentDeps
} from '../src/modules/payment/commit.js';
import {
  parseVkPaymentEvent,
  signatureEquals,
  signVkEvent,
  verifyVkEvent,
  vkEventFailure
} from '../src/modules/payment/provider.vk.js';
import {
  MAX_PENDING_ORDERS,
  confirmPurchase,
  describeOrders,
  findOrder,
  fulfillOrder,
  makeOrderId,
  markPaid,
  openOrder,
  parseOrderId,
  refundOrder,
  voidExpiredOrders,
  ordersOfSkuToday
} from '../src/modules/payment/orders.js';
import { newAccount, testConfig, withAsterium, withTech, T0, addMs, MINUTE, DAY, errorCode } from './fixtures.js';

/**
 * Заказы на покупку (Часть 1).
 *
 * Главный инвариант, который проверяется здесь снова и снова: товар выдаётся ТОЛЬКО
 * после подтверждения площадки, и повторное подтверждение не удваивает выдачу. Всё
 * остальное — детали каталога и лимитов.
 */

const config = testConfig({ PAYMENTS_ENABLED: 'true' });
const rules = config.economy;
const PACK = 'asterium_pack_500';
const CHRONIUM = 'chronium_pack_15';
const WOLFRAM = 'wolfram_pack_50';
const SHIELD = 'rest_shield_24h';

let seq = 0;
const idFactory = () => `gen-${++seq}`;

function buyer(purchased = 0, earned = 0) {
  return withAsterium(newAccount(config, T0, `payer-${purchased}-${earned}`), purchased, earned);
}

/** Заказ «из коробки»: открыли, получили id. */
function opened(sku = PACK, now = T0, purchased = 0, earned = 0) {
  const account = buyer(purchased, earned);
  return openOrder(account, sku, now, rules, `nonce-${sku}-${now.getTime()}`);
}

describe('shop: каталог SKU', () => {
  it('каждый SKU имеет уникальный артикул и параметры окна оплаты', () => {
    const skus = SHOP_SKUS.map((item) => item.sku);
    expect(new Set(skus).size).toBe(skus.length);
    for (const item of SHOP_SKUS) {
      expect(item.priceRub).toBeGreaterThan(0);
      if (item.box.type === 'item') expect(item.box.item).toBe(item.sku);
      if (item.box.type === 'votes') expect(item.votes).toBeGreaterThan(0);
      if (item.kind === 'material') {
        // Guard, а не предположение: материал приходит из конфига, а выдаётся в кошелек
        // по этому полю, и опечатка («wolframm») молча создала бы новый счётчик.
        expect(isCraftTechId(item.material), item.sku).toBe(true);
        expect(item.amount, item.sku).toBeGreaterThan(0);
        expect(item.sku.startsWith(item.material), item.sku).toBe(true);
      }
      if (item.kind === 'asterium') expect(item.amount).toBeGreaterThan(0);
      if (item.kind === 'entitlement') expect(item.entitlement.durationMs).toBeGreaterThan(0);
    }
  });

  it('витрина отдаёт только то, что можно показать клиенту', () => {
    const view = describeCatalog();
    expect(view.length).toBe(SHOP_SKUS.length);
    expect(view[0]).toEqual({
      sku: PACK,
      label: '500 астерия',
      kind: 'asterium',
      priceRub: 49,
      amount: 500,
      material: null,
      box: { type: 'item', item: PACK }
    });
    // Сырьевой пак обязан нести именно материал: клиент отправляет только `sku`, а то,
    // ЧТО и СКОЛЬКО выдавать, решает сервер по этому полю (см. orders.fulfillOrder).
    expect(view.find((entry) => entry.sku === CHRONIUM)).toEqual({
      sku: CHRONIUM,
      label: '15 хрониума (15 минут ускорений)',
      kind: 'material',
      priceRub: 29,
      amount: 15,
      material: 'chronium',
      box: { type: 'item', item: CHRONIUM }
    });
    expect(view.find((entry) => entry.sku === SHIELD)).toEqual({
      sku: SHIELD,
      label: 'Щит покоя, 24 часа',
      kind: 'entitlement',
      priceRub: 79,
      amount: null,
      material: null,
      box: { type: 'item', item: SHIELD }
    });
  });

  it('поиск по имени товара в панели ВК находит тот же SKU', () => {
    expect(getSkuByBoxItem(PACK)?.sku).toBe(PACK);
    expect(getSku('no_such_sku')).toBeUndefined();
  });
});

describe('orders.openOrder: заказ создаёт сервер, а не клиент', () => {
  it('создаёт pending-заказ со снимком каталога и сроком жизни', () => {
    const { account, order, resumed } = opened(PACK, T0, 1000, 0);
    expect(resumed).toBe(false);
    expect(order.status).toBe('pending');
    expect(order.amount).toBe(500);
    expect(order.priceRub).toBe(49);
    expect(order.expiresAt.getTime() - order.createdAt.getTime()).toBe(rules.limits.purchases.orderTtlMs);
    // Создание заказа не трогает баланс: деньги списывает площадка, а не мы.
    expect(account.materials.asterium).toEqual({ purchased: 1000, earned: 0 });
    expect(account.orders).toHaveLength(1);
  });

  it('отключённые платежи: 503 без всяких заказов', () => {
    const off = testConfig();
    expect(errorCode(() => openOrder(buyer(1000, 0), PACK, T0, off.economy, 'n1'))).toBe(
      ErrorCodes.PAYMENTS_NOT_CONFIGURED
    );
  });

  it('неизвестный SKU — отказ, а не заказ «на глаз»', () => {
    expect(errorCode(() => openOrder(buyer(1000, 0), 'asterium_pack_999999', T0, rules, 'n2'))).toBe(
      ErrorCodes.UNKNOWN_SKU
    );
  });

  it('ретрай клиента возвращает живой заказ, а не второй', () => {
    const first = opened(PACK, T0, 1000, 0);
    const second = openOrder(first.account, PACK, addMs(T0, MINUTE), rules, 'other-nonce');
    expect(second.resumed).toBe(true);
    expect(second.order.id).toBe(first.order.id);
    expect(second.account.orders).toHaveLength(1);
  });

  it('потолок неподтверждённых заказов держит перебор разных SKU', () => {
    let account = buyer(5000, 0);
    const skus = describeCatalog().map((entry) => entry.sku);
    for (let i = 0; i < MAX_PENDING_ORDERS; i += 1) {
      account = openOrder(account, skus[i] as string, T0, rules, `bulk-${i}`).account;
    }
    expect(account.orders).toHaveLength(MAX_PENDING_ORDERS);
    expect(errorCode(() => openOrder(account, skus[MAX_PENDING_ORDERS] as string, T0, rules, 'overflow'))).toBe(
      ErrorCodes.PURCHASE_LIMIT_REACHED
    );
  });

  it('суточный лимит на SKU считается выданными заказами, а не попытками UI', () => {
    const limited = testConfig({ PAYMENTS_ENABLED: 'true', PURCHASE_DAILY_PER_SKU: '1' });
    const first = openOrder(buyer(5000, 0), PACK, T0, limited.economy, 'l1');
    const fulfilled = confirmPurchase(
      first.account,
      first.order.id,
      { item: PACK, providerOrderId: 'vk-l1' },
      addMs(T0, MINUTE),
      limited.economy,
      idFactory
    ).account;

    expect(ordersOfSkuToday(fulfilled, PACK, T0)).toBe(1);
    expect(errorCode(() => openOrder(fulfilled, PACK, addMs(T0, 2 * MINUTE), limited.economy, 'l2'))).toBe(
      ErrorCodes.PURCHASE_LIMIT_REACHED
    );
    // На следующий день (UTC) лимит сбрасывается.
    expect(errorCode(() => openOrder(fulfilled, PACK, addMs(T0, 2 * DAY), limited.economy, 'l3'))).toBeUndefined();
  });

  it('order id однозначно указывает владельца: постбэк приходит без сессии', () => {
    const { order } = opened(PACK, T0, 1000, 0);
    expect(parseOrderId(order.id)).toBe(order.id.split(':')[1]);
    expect(parseOrderId(makeOrderId('u-1', 'n-1'))).toBe('u-1');
    expect(parseOrderId('foreign-order')).toBeNull();
  });
});

describe('orders.markPaid: доверие появляется только от площадки', () => {
  it('pending → paid с номером платежа площадки', () => {
    const placed = opened(PACK, T0, 1000, 0);
    const paid = markPaid(placed.account, placed.order.id, { item: PACK, providerOrderId: 'vk-42' }, addMs(T0, MINUTE));
    expect(paid.duplicate).toBe(false);
    expect(paid.order.status).toBe('paid');
    expect(paid.order.providerOrderId).toBe('vk-42');
    expect(paid.order.paidAt).toEqual(addMs(T0, MINUTE));
  });

  it('чужое имя товара в подтверждении — отказ, а не выдача', () => {
    const placed = opened(PACK, T0, 1000, 0);
    expect(errorCode(() => markPaid(placed.account, placed.order.id, { item: 'asterium_pack_12000' }, T0))).toBe(
      ErrorCodes.INVALID_PAYMENT_SIGNATURE
    );
  });

  it('повторное подтверждение не меняет заказ и помечается как дубль', () => {
    const placed = opened(PACK, T0, 1000, 0);
    const once = markPaid(placed.account, placed.order.id, { item: PACK }, T0);
    const twice = markPaid(once.account, placed.order.id, { item: PACK }, addMs(T0, MINUTE));
    expect(twice.duplicate).toBe(true);
    expect(twice.account).toBe(once.account);
  });

  it('заказ чужого игрока не находится', () => {
    const placed = opened(PACK, T0, 1000, 0);
    expect(errorCode(() => markPaid(buyer(1000, 0), placed.order.id, { item: PACK }, T0))).toBe(
      ErrorCodes.ORDER_NOT_FOUND
    );
  });

  it('позднее подтверждение воскрешает сгоревший заказ: деньги-то списались', () => {
    const placed = opened(PACK, T0, 1000, 0);
    const swept = voidExpiredOrders(placed.account, addMs(T0, rules.limits.purchases.orderTtlMs + MINUTE));
    expect(swept.voided).toBe(1);
    expect(findOrder(swept.account, placed.order.id)?.status).toBe('void');

    const paid = markPaid(swept.account, placed.order.id, { item: PACK, providerOrderId: 'vk-late' }, addMs(T0, DAY));
    expect(paid.order.status).toBe('paid');
    expect(paid.order.note).toBe('resurrected_by_provider_confirmation');
  });
});

describe('orders.fulfillOrder: выдача товара', () => {
  it('pending-заказ не выдаётся: только по подтверждению площадки', () => {
    const placed = opened(PACK, T0, 1000, 0);
    expect(errorCode(() => fulfillOrder(placed.account, placed.order.id, T0, rules, idFactory))).toBe(
      ErrorCodes.ORDER_UNPAID
    );
  });

  it('пакет астерия падает в купленный кошелёк и пишет одно движение журнала', () => {
    const placed = opened(PACK, T0, 1000, 0);
    const paid = markPaid(placed.account, placed.order.id, { item: PACK }, addMs(T0, MINUTE));
    const result = fulfillOrder(paid.account, placed.order.id, addMs(T0, 2 * MINUTE), rules, idFactory);
    expect(result.granted).toBe('asterium_purchased:500');
    expect(result.account.materials.asterium).toEqual({ purchased: 1500, earned: 0 });
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0];
    expect(draft?.currency).toBe('asterium_purchased');
    expect(draft?.delta).toBe(500);
    expect(draft?.balanceAfter).toBe(1500);
    expect(draft?.reason).toBe('purchase');
    expect(draft?.idempotencyKey).toBe(`order:${placed.order.id}`);
    expect(draft?.meta?.sku).toBe(PACK);
  });

  it('пакет сырья падает в плоский счётчик своего материала', () => {
    const placed = opened(CHRONIUM, T0, 0, 0);
    const paid = markPaid(placed.account, placed.order.id, { item: CHRONIUM }, addMs(T0, MINUTE));
    const result = fulfillOrder(paid.account, placed.order.id, addMs(T0, 2 * MINUTE), rules, idFactory);

    expect(result.granted).toBe('chronium:15');
    expect(result.account.materials.chronium).toBe(15);
    // Ни кошельков, ни чужих счётчиков: астерий и соседнее сырьё не тронуты.
    expect(result.account.materials.asterium).toEqual({ purchased: 0, earned: 0 });
    expect(result.account.materials.wolfram).toBe(0);
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0];
    expect(draft?.currency).toBe('chronium');
    expect(draft?.delta).toBe(15);
    expect(draft?.balanceAfter).toBe(15);
    expect(draft?.reason).toBe('purchase');
    expect(draft?.meta?.material).toBe('chronium');
    // Тот же ключ заказа, что и у астерия: повторный вебхук обязан найти заказ
    // в статусе `fulfilled` и ничего не выдать, а не полагаться на особый путь сырья.
    expect(draft?.idempotencyKey).toBe(`order:${placed.order.id}`);

    const again = fulfillOrder(result.account, placed.order.id, addMs(T0, 3 * MINUTE), rules, idFactory);
    expect(again.duplicate).toBe(true);
    expect(again.account.materials.chronium).toBe(15);
  });

  it('привилегия выдаётся с orderId заказа — рефанд отзывает её одной операцией', () => {
    const placed = opened(SHIELD, T0, 1000, 0);
    const paid = markPaid(placed.account, placed.order.id, { item: SHIELD }, addMs(T0, MINUTE));
    const result = fulfillOrder(paid.account, placed.order.id, addMs(T0, 2 * MINUTE), rules, idFactory);
    expect(result.granted).toBe(`entitlement:${SHIELD}`);
    expect(result.drafts).toHaveLength(0);
    const entitlement = result.account.entitlements[0];
    expect(entitlement?.kind).toBe('shield');
    expect(entitlement?.permanent).toBe(false);
    expect(entitlement?.orderId).toBe(placed.order.id);
    expect((entitlement?.expiresAt as Date).getTime() - (entitlement?.grantedAt as Date).getTime()).toBe(DAY);
  });

  it('повторная выдача того же заказа не удваивает пак', () => {
    const placed = opened(PACK, T0, 1000, 0);
    const paid = markPaid(placed.account, placed.order.id, { item: PACK }, addMs(T0, MINUTE));
    const first = fulfillOrder(paid.account, placed.order.id, addMs(T0, 2 * MINUTE), rules, idFactory);
    const second = fulfillOrder(first.account, placed.order.id, addMs(T0, 3 * MINUTE), rules, idFactory);
    expect(second.duplicate).toBe(true);
    expect(second.account.materials.asterium).toEqual({ purchased: 1500, earned: 0 });
    expect(second.drafts).toHaveLength(0);
  });

  it('confirmPurchase = подтверждение + выдача одной операцией', () => {
    const placed = opened(PACK, T0, 0, 500);
    const result = confirmPurchase(placed.account, placed.order.id, { item: PACK }, addMs(T0, MINUTE), rules, idFactory);
    expect(result.duplicate).toBe(false);
    // Игрок платит площадке рублями/голосами, а не астерием: кошелёк `earned` не тронут,
    // купленный пак падает СВЕРХУ в `purchased` — из него же он и списывается при refund.
    expect(result.account.materials.asterium).toEqual({ purchased: 500, earned: 500 });
    expect(result.order.status).toBe('fulfilled');
  });
});

describe('orders.refundOrder: возврат платежа', () => {
  it('отзывает привилегию и не трогает валюту', () => {
    const placed = opened(SHIELD, T0, 1000, 0);
    const fulfilled = confirmPurchase(
      placed.account,
      placed.order.id,
      { item: SHIELD },
      addMs(T0, MINUTE),
      rules,
      idFactory
    );
    expect(fulfilled.account.entitlements).toHaveLength(1);

    const refunded = refundOrder(fulfilled.account, placed.order.id, addMs(T0, 2 * MINUTE), rules);
    expect(refunded.account.entitlements).toHaveLength(0);
    expect(refunded.order.status).toBe('refunded');
    expect(refunded.drafts).toHaveLength(0);
    expect(refunded.account.materials.asterium).toEqual({ purchased: 1000, earned: 0 });
  });

  it('возврат пакета уходит в минус, если астериев уже потрачен: это и есть анти-рефанд', () => {
    const placed = opened(PACK, T0, 500, 0);
    const fulfilled = confirmPurchase(placed.account, placed.order.id, { item: PACK }, addMs(T0, MINUTE), rules, idFactory);
    expect(fulfilled.account.materials.asterium).toEqual({ purchased: 1000, earned: 0 });

    // Игрок потратил весь астериев, и только после этого платёж вернулся: площадка
    // забирает своё, остаток становится долгом (purchased < 0) и блокирует будущие
    // покупки — молча «простить» возврат означало бы продать валюту бесплатно.
    const spent = withAsterium(fulfilled.account, 0, 0);
    const refunded = refundOrder(spent, placed.order.id, addMs(T0, 2 * MINUTE), rules);
    expect(refunded.account.materials.asterium.purchased).toBe(-500);
    expect(refunded.drafts[0]?.reason).toBe('refund');
    expect(refunded.drafts[0]?.idempotencyKey).toBe(`order:${placed.order.id}:refund`);
  });

  it('возврат пакета сырья уходит в минус по материалу: долг нельзя потратить', () => {
    const placed = opened(WOLFRAM, T0, 0, 0);
    const fulfilled = confirmPurchase(
      placed.account,
      placed.order.id,
      { item: WOLFRAM },
      addMs(T0, MINUTE),
      rules,
      idFactory
    );
    expect(fulfilled.account.materials.wolfram).toBe(50);

    // Игрок успел потратить пак до chargeback: площадка всё равно забирает свои 50.
    // Минус по сырью — единственный честный исход, потому что у сырья нет пары
    // кошельков, которой можно было бы «отдать долг купленным» (см. refundAsterium).
    const spent = withTech(fulfilled.account, { wolfram: 0 });
    const refunded = refundOrder(spent, placed.order.id, addMs(T0, 2 * MINUTE), rules);

    expect(refunded.account.materials.wolfram).toBe(-50);
    expect(hasTechDebt(refunded.account)).toBe(true);
    expect(refunded.order.status).toBe('refunded');
    expect(refunded.drafts[0]?.currency).toBe('wolfram');
    expect(refunded.drafts[0]?.reason).toBe('refund');
    expect(refunded.drafts[0]?.delta).toBe(-50);
    expect(refunded.drafts[0]?.idempotencyKey).toBe(`order:${placed.order.id}:refund`);

    // Долг гасится новыми начислениями того же материала, а трата в минусе — отказ.
    expect(errorCode(() => spendTech(refunded.account, 'wolfram', 1, { ts: T0, reason: 'craft' }))).toBe(
      ErrorCodes.INSUFFICIENT_FUNDS
    );
    const repaid = credit(refunded.account, tech('wolfram'), 60, { ts: T0, reason: 'recycle' });
    expect(repaid.account.materials.wolfram).toBe(10);
    expect(hasTechDebt(repaid.account)).toBe(false);
    const spentAgain = spendTech(repaid.account, 'wolfram', 10, { ts: T0, reason: 'craft' });
    expect(spentAgain.account.materials.wolfram).toBe(0);
    // Астериевый долг — отдельный фронт: возврат сырья не блокирует покупки за рубли.
    expect(isPurchaseBlocked(refunded.account)).toBe(false);
  });

  it('за пределами окна возврат не принимается', () => {
    const placed = opened(PACK, T0, 1000, 0);
    const fulfilled = confirmPurchase(placed.account, placed.order.id, { item: PACK }, T0, rules, idFactory);
    const late = addMs(T0, (rules.limits.purchases.refundWindowDays + 1) * DAY);
    expect(errorCode(() => refundOrder(fulfilled.account, placed.order.id, late, rules))).toBe(
      ErrorCodes.REFUND_TOO_LATE
    );
  });

  it('возврат неоплаченного заказа невозможен, повторный возврат — дубль', () => {
    const placed = opened(PACK, T0, 1000, 0);
    expect(errorCode(() => refundOrder(placed.account, placed.order.id, T0, rules))).toBe(ErrorCodes.ORDER_UNPAID);
    const fulfilled = confirmPurchase(placed.account, placed.order.id, { item: PACK }, T0, rules, idFactory);
    const once = refundOrder(fulfilled.account, placed.order.id, addMs(T0, MINUTE), rules);
    expect(refundOrder(once.account, placed.order.id, addMs(T0, 2 * MINUTE), rules).duplicate).toBe(true);
  });
});

describe('payment.history: потолок журнала заказов', () => {
  it('потолок истории заказов обрезает закрытые, но не живые', () => {
    const tiny = testConfig({ PAYMENTS_ENABLED: 'true', PAYMENT_HISTORY: '2' });
    let account = buyer(5000, 0);
    for (let i = 0; i < 4; i += 1) {
      const placed = openOrder(account, PACK, addMs(T0, i * DAY), tiny.economy, `h-${i}`);
      account = confirmPurchase(
        placed.account,
        placed.order.id,
        { item: PACK },
        addMs(T0, i * DAY + MINUTE),
        tiny.economy,
        idFactory
      ).account;
    }
    expect(account.orders.length).toBeLessThanOrEqual(2);
    expect(describeOrders(account).every((row) => row.status === 'fulfilled')).toBe(true);
  });
});

// ─── Точка сборки: сторы + журнал ─────────────────────────────────────────────

interface Harness {
  deps: PaymentDeps;
  userId: string;
}

async function harness(account: UserAccount): Promise<Harness> {
  const users = new MemoryUserStore();
  const saved = await users.save(account);
  return { deps: { users, ledger: new MemoryLedgerStore(), idFactory }, userId: saved.id };
}

describe('payment.commit: маршрут через сторы', () => {
  it('openCheckout → confirmPayment выдаёт пак и пишет ровно одну запись журнала', async () => {
    const { deps, userId } = await harness(buyer(1000, 0));
    const checkout = await openCheckout(deps, userId, PACK, T0, rules);
    expect(checkout.box).toEqual({ type: 'item', item: PACK });
    expect(checkout.order.status).toBe('pending');

    const result = await confirmPayment(
      deps,
      checkout.order.id,
      { item: PACK, providerOrderId: 'vk-1' },
      addMs(T0, MINUTE),
      rules
    );
    expect(result.granted).toBe('asterium_purchased:500');
    expect(result.userId).toBe(userId);
    const entries = await deps.ledger.list(userId, { reasons: ['purchase'] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.idempotencyKey).toBe(`order:${checkout.order.id}`);

    // Повторная доставка того же подтверждения площадкой: товар НЕ удваивается.
    const replay = await confirmPayment(deps, checkout.order.id, { item: PACK }, addMs(T0, 2 * MINUTE), rules);
    expect(replay.duplicate).toBe(true);
    expect(replay.account.materials.asterium.purchased).toBe(1500);
    expect(await deps.ledger.count(userId)).toBe(1);
  });

  it('ретрай клиента возвращает тот же заказ и ничего не списывает', async () => {
    const { deps, userId } = await harness(buyer(1000, 0));
    const first = await openCheckout(deps, userId, PACK, T0, rules);
    const second = await openCheckout(deps, userId, PACK, addMs(T0, MINUTE), rules);
    expect(second.order.id).toBe(first.order.id);
    expect(second.resumed).toBe(true);
    expect(await deps.ledger.count(userId)).toBe(0);
  });

  it('квитанция клиента запоминает номер платежа, но не выдаёт пак', async () => {
    const { deps, userId } = await harness(buyer(1000, 0));
    const checkout = await openCheckout(deps, userId, PACK, T0, rules);
    const account = await noteClientReceipt(deps, userId, checkout.order.id, 'vk-77', addMs(T0, MINUTE));
    expect(findOrder(account, checkout.order.id)?.providerOrderId).toBe('vk-77');
    expect(account.materials.asterium.purchased).toBe(1000);
    expect(await deps.ledger.count(userId)).toBe(0);
  });

  it('квитанция чужого заказа отклоняется, а не портит чужой документ', async () => {
    const { deps, userId } = await harness(buyer(1000, 0));
    const checkout = await openCheckout(deps, userId, PACK, T0, rules);
    await expect(noteClientReceipt(deps, 'other-player', checkout.order.id, 'vk-77', T0)).rejects.toMatchObject({
      code: ErrorCodes.ORDER_NOT_FOUND
    });
  });

  it('sweepExpiredOrders сжигает неподтверждённые заказы', async () => {
    const { deps, userId } = await harness(buyer(1000, 0));
    const checkout = await openCheckout(deps, userId, PACK, T0, rules);
    const swept = await sweepExpiredOrders(deps, userId, addMs(T0, rules.limits.purchases.orderTtlMs + MINUTE));
    expect(findOrder(swept, checkout.order.id)?.status).toBe('void');
  });

  it('refundPayment отзывает пак и пишет возврат', async () => {
    const { deps, userId } = await harness(buyer(1000, 0));
    const checkout = await openCheckout(deps, userId, PACK, T0, rules);
    await confirmPayment(deps, checkout.order.id, { item: PACK }, addMs(T0, MINUTE), rules);
    const refunded = await refundPayment(deps, checkout.order.id, addMs(T0, 2 * MINUTE), rules);
    expect(refunded.order.status).toBe('refunded');
    expect(refunded.account.materials.asterium.purchased).toBe(1000);
    expect(await deps.ledger.list(userId, { reasons: ['refund'] })).toHaveLength(1);
  });

  it('подтверждение несуществующего заказа — 404, а не выдача товара', async () => {
    const { deps, userId } = await harness(buyer(1000, 0));
    await expect(confirmPayment(deps, makeOrderId(userId, 'ghost'), { item: PACK }, T0, rules)).rejects.toMatchObject({
      code: ErrorCodes.ORDER_NOT_FOUND
    });
  });
});

// ─── Подпись подтверждения площадки ───────────────────────────────────────────

const SECRET = 'secret-key-for-tests';
const APP_ID = 53377165;

function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event_id: 'evt-1',
    type: 'onAppPayment',
    api_id: APP_ID,
    viewer_id: 42,
    sent_at: Math.floor(T0.getTime() / 1000),
    reference: { order_id: '9001', external_order_id: 'order:u:1', item: PACK, amount: 5 },
    ...overrides
  });
}

const sentAtSec = Math.floor(T0.getTime() / 1000);

describe('payment.provider.vk: проверка подписанного события', () => {
  it('своя подпись принимается, чужая — нет', () => {
    const body = eventBody();
    const good = verifyVkEvent(body, signVkEvent(body, SECRET, APP_ID), {
      secretKey: SECRET,
      serviceId: APP_ID,
      sentAt: sentAtSec,
      now: T0
    });
    expect(good).toEqual({ ok: true, reason: 'ok' });

    const bad = verifyVkEvent(body, 'deadbeef', { secretKey: SECRET, serviceId: APP_ID, sentAt: sentAtSec, now: T0 });
    expect(bad.reason).toBe('sign_mismatch');
    expect(vkEventFailure(bad)?.code).toBe(ErrorCodes.INVALID_PAYMENT_SIGNATURE);

    expect(verifyVkEvent(body, undefined, { secretKey: SECRET, serviceId: APP_ID, sentAt: sentAtSec, now: T0 }).reason).toBe(
      'no_signature'
    );
    expect(verifyVkEvent(body, 'x', { secretKey: '', serviceId: APP_ID, sentAt: sentAtSec, now: T0 }).reason).toBe(
      'secret_missing'
    );
  });

  it('подпись другого приложения не проходит: ключ привязан к service id', () => {
    const body = eventBody();
    const check = verifyVkEvent(body, signVkEvent(body, SECRET, APP_ID + 1), {
      secretKey: SECRET,
      serviceId: APP_ID,
      sentAt: sentAtSec,
      now: T0
    });
    expect(check.reason).toBe('sign_mismatch');
  });

  it('replay старого события отклоняется по окну свежести', () => {
    const body = eventBody();
    const check = verifyVkEvent(body, signVkEvent(body, SECRET, APP_ID), {
      secretKey: SECRET,
      serviceId: APP_ID,
      sentAt: sentAtSec - 7200,
      now: T0,
      maxAgeSec: 3600
    });
    expect(check.reason).toBe('body_expired');
    expect(vkEventFailure(check)?.code).toBe(ErrorCodes.EXPIRED_INIT_DATA);
  });

  it('разбор тела события: наше — читается, чужое — null', () => {
    const parsed = parseVkPaymentEvent(eventBody());
    expect(parsed?.event.eventType).toBe('onAppPayment');
    expect(parsed?.event.reference.externalId).toBe('order:u:1');
    expect(parsed?.event.reference.orderId).toBe('9001');
    expect(parsed?.event.reference.item).toBe(PACK);
    expect(parsed?.event.reference.votes).toBe(5);
    expect(parseVkPaymentEvent('not json')).toBeNull();
    expect(parseVkPaymentEvent('{"foo":1}')).toBeNull();
  });

  it('изменение хотя бы одного байта тела ломает подпись', () => {
    const body = eventBody();
    const signature = signVkEvent(body, SECRET, APP_ID);
    const tampered = body.replace('"amount":5', '"amount":500');
    expect(signatureEquals(signVkEvent(tampered, SECRET, APP_ID), signature)).toBe(false);
  });
});
