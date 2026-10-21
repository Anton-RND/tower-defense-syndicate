import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/http/app.js';
import { createContext, type AppContext } from '../src/http/context.js';
import { openCheckout } from '../src/modules/payment/commit.js';
import { signVkEvent } from '../src/modules/payment/provider.vk.js';
import { createAccount } from '../src/modules/user/user.types.js';
import { testConfig } from './fixtures.js';

/**
 * /callbacks/vk/events — приём подписанных событий площадки на реальном транспорте.
 *
 * Домен здесь уже покрыт (payment.orders.test.ts): открытие заказа, подтверждение,
 * возврат, идемпотентность и проверка подписи тестируются напрямую. Этот файл
 * проверяет ровно то, что домен проверить не может: тело подписи приходит
 * СЫРЫМИ байтами (не переплавленным JSON), отказ выглядит как 401/400, а не
 * «тихий 200», и эндпойнт закрыт бюджетом RATE_LIMIT_EVENT_PER_MIN. Без
 * интеграционного теста сломанный raw-body парсер дал бы сервер, который верит
 * любой валидной JSON-схеме и принимает подпись со сдвигом по байтам.
 */

const SECRET = 'test-vk-secret';
const APP_ID = '777001';
const PACK = 'asterium_pack_500';

const opened: Array<{ close(): Promise<void> }> = [];

async function openStand(env: Record<string, string> = {}) {
  const config = testConfig({
    DEV_SIGNER_ENABLED: 'true',
    PAYMENTS_ENABLED: 'true',
    VK_APP_ID: APP_ID,
    VK_SECRET_KEY: SECRET,
    ALLOWED_ORIGINS: 'https://vk.com',
    ...env
  });
  const ctx = createContext(config);
  const app = await buildApp(ctx);
  opened.push(app);
  return { app, ctx, config };
}

async function createBuyer(ctx: AppContext): Promise<string> {
  const { account } = await ctx.users.getOrCreate(
    { platform: 'vk', socialId: 'buyer', appId: APP_ID, groupId: null },
    ctx.now(),
    (identity, at) => createAccount(identity, at, ctx.config.economy, ctx.idFactory)
  );
  return account.id;
}

async function openOrder(ctx: AppContext, userId: string): Promise<string> {
  const deps = { users: ctx.users, ledger: ctx.ledger, idFactory: ctx.idFactory };
  const checkout = await openCheckout(deps, userId, PACK, ctx.now(), ctx.config.economy);
  return checkout.order.id;
}

function eventBody(ctx: AppContext, overrides: Record<string, unknown> = {}): string {
  const body: Record<string, unknown> = {
    event_id: 'evt-1',
    type: 'onAppPayment',
    api_id: Number(APP_ID),
    viewer_id: 42,
    sent_at: Math.floor(ctx.now().getTime() / 1000),
    reference: { order_id: '9001', external_order_id: 'order:buyer:1', item: PACK, amount: 5 },
    ...overrides
  };
  return JSON.stringify(body);
}

function postEvent(app: FastifyInstance, body: string, signature: string) {
  return app.inject({
    method: 'POST',
    url: '/callbacks/vk/events',
    payload: body,
    headers: { 'content-type': 'application/json', 'x-vk-signature': signature }
  });
}

afterEach(async () => {
  while (opened.length > 0) {
    const app = opened.pop();
    if (app) await app.close();
  }
});

describe('callbacks/vk/events: товар выходит только под валидной подписью', () => {
  it('своя подпись выдаёт пак ровно один раз; повтор — ok без повторной выдачи', async () => {
    const { app, ctx } = await openStand();
    const userId = await createBuyer(ctx);
    const orderId = await openOrder(ctx, userId);

    const body = eventBody(ctx, { reference: { order_id: '9001', external_order_id: orderId, item: PACK, amount: 5 } });
    const signature = signVkEvent(body, SECRET, Number(APP_ID));

    const first = await postEvent(app, body, signature);
    expect(first.statusCode).toBe(200);
    expect(first.body).toBe('ok');
    // Площадке отвечаем plain-text, а не нашим JSON-форматом.
    expect(first.headers['content-type']).toContain('text/plain');

    const afterFirst = await ctx.users.findById(userId);
    expect(afterFirst?.materials.asterium.purchased).toBe(500);
    expect(afterFirst?.orders.find((order) => order.id === orderId)?.status).toBe('fulfilled');

    // Повторная доставка того же события площадкой: 200, а товар не удваивается.
    const second = await postEvent(app, body, signature);
    expect(second.statusCode).toBe(200);
    const afterSecond = await ctx.users.findById(userId);
    expect(afterSecond?.materials.asterium.purchased).toBe(500);
  });

  it('чужая подпись → 401 INVALID_PAYMENT_SIGNATURE и ни копейки', async () => {
    const { app, ctx } = await openStand();
    const userId = await createBuyer(ctx);
    const body = eventBody(ctx);
    const forged = signVkEvent(body, 'attacker-secret', Number(APP_ID));

    const response = await postEvent(app, body, forged);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_PAYMENT_SIGNATURE');
    const account = await ctx.users.findById(userId);
    expect(account?.materials.asterium.purchased).toBe(0);
  });

  it('без заголовка подписи → 401, а не тихий приём', async () => {
    const { app, ctx } = await openStand();
    const body = eventBody(ctx);
    const response = await app.inject({
      method: 'POST',
      url: '/callbacks/vk/events',
      payload: body,
      headers: { 'content-type': 'application/json' }
    });
    expect(response.statusCode).toBe(401);
  });

  it('протухшее событие → 401 на окне свежести VK_EVENT_MAX_AGE_SECONDS', async () => {
    const { app, ctx } = await openStand({ VK_EVENT_MAX_AGE_SECONDS: '3600' });
    const old = Math.floor(ctx.now().getTime() / 1000) - 7200;
    const body = eventBody(ctx, { sent_at: old });
    const signature = signVkEvent(body, SECRET, Number(APP_ID));
    const response = await postEvent(app, body, signature);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('EXPIRED_INIT_DATA');
  });

  it('подписанное, но нечитаемое тело → 400, потому что подпись — не довод для действий', async () => {
    const { app } = await openStand();
    const body = 'not json at all';
    const signature = signVkEvent(body, SECRET, Number(APP_ID));
    const response = await postEvent(app, body, signature);
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('незнакомый тип события подтверждается приёмом и не трогает состояние', async () => {
    const { app, ctx } = await openStand();
    const userId = await createBuyer(ctx);
    const body = eventBody(ctx, { type: 'future_event_type' });
    const signature = signVkEvent(body, SECRET, Number(APP_ID));
    const response = await postEvent(app, body, signature);
    expect(response.statusCode).toBe(200);
    const account = await ctx.users.findById(userId);
    expect(account?.orders).toHaveLength(0);
  });
});

describe('callbacks/vk/events: возврат платежа', () => {
  it('chargeback после выдачи отзывает товар и не даёт удвоить возврат', async () => {
    const { app, ctx } = await openStand();
    const userId = await createBuyer(ctx);
    const orderId = await openOrder(ctx, userId);

    const confirm = eventBody(ctx, {
      reference: { order_id: '9001', external_order_id: orderId, item: PACK, amount: 5 }
    });
    expect((await postEvent(app, confirm, signVkEvent(confirm, SECRET, Number(APP_ID)))).statusCode).toBe(200);

    const chargeback = eventBody(ctx, {
      type: 'chargeback',
      reference: { order_id: '9001', external_order_id: orderId, item: PACK }
    });
    expect(
      (await postEvent(app, chargeback, signVkEvent(chargeback, SECRET, Number(APP_ID)))).statusCode
    ).toBe(200);

    const after = await ctx.users.findById(userId);
    expect(after?.materials.asterium.purchased).toBe(0);
    expect(after?.orders.find((order) => order.id === orderId)?.status).toBe('refunded');

    // Повторный chargeback — не ошибка: возврат уже выполнен, двойного отзыва нет.
    expect(
      (await postEvent(app, chargeback, signVkEvent(chargeback, SECRET, Number(APP_ID)))).statusCode
    ).toBe(200);
  });

  it('возврат чужого заказа — 404, а не молчаливое списание', async () => {
    const { app, ctx } = await openStand();
    const body = eventBody(ctx, {
      type: 'chargeback',
      reference: { order_id: '9001', external_order_id: 'order:ghost:1' }
    });
    const response = await postEvent(app, body, signVkEvent(body, SECRET, Number(APP_ID)));
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});

describe('callbacks/vk/events: бюджет площадки', () => {
  it('события сверх RATE_LIMIT_EVENT_PER_MIN получают 429', async () => {
    const { app, ctx } = await openStand({ RATE_LIMIT_EVENT_PER_MIN: '2' });
    // Все запросы с одного адреса: бакет один, первая пара съедает его целиком.
    for (const custom of ['a', 'b']) {
      const body = eventBody(ctx, { event_id: custom, type: 'future_event_type' });
      const response = await postEvent(app, body, signVkEvent(body, SECRET, Number(APP_ID)));
      expect(response.statusCode).toBe(200);
    }
    const third = eventBody(ctx, { event_id: 'c', type: 'future_event_type' });
    const blocked = await postEvent(app, third, signVkEvent(third, SECRET, Number(APP_ID)));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
  });
});
