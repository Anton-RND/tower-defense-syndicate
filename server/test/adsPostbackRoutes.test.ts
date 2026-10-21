import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/http/app.js';
import { getAdOffer } from '../src/config/ads.js';
import { createContext, type AppContext } from '../src/http/context.js';
import { signVkMiniApp } from '../src/modules/auth/vk.signature.js';
import { openAdSession } from '../src/modules/ads/rewarded.js';
import { createAccount } from '../src/modules/user/user.types.js';
import { testConfig } from './fixtures.js';

/**
 * /callbacks/vk/ads — постбэк rewarded-рекламы на реальном транспорте.
 *
 * Домен закрыт в ads.rewarded.test.ts; этот файл проверяет транспорт: подпись
 * площадки открывается из query-параметров (та же схема mini_app, что и у
 * initData), выдача происходит ровно один раз, а повторная доставка и сгоревшая
 * сессия отвечают «принято» с логом вместо вечного ретрая площадки.
 */

const SECRET = 'test-vk-secret';
const APP_ID = '777001';

const opened: Array<{ close(): Promise<void> }> = [];

function openStand(env: Record<string, string> = {}, overrides: Record<string, unknown> = {}) {
  const config = testConfig({
    ADS_ENABLED: 'true',
    VK_APP_ID: APP_ID,
    VK_SECRET_KEY: SECRET,
    ALLOWED_ORIGINS: 'https://vk.com',
    ...env
  });
  const ctx = createContext(config, overrides as never);
  return buildApp(ctx).then((app) => {
    opened.push(app);
    return { app, ctx, config };
  });
}

async function createPlayer(ctx: AppContext, socialId = '12345'): Promise<string> {
  const { account } = await ctx.users.getOrCreate(
    { platform: 'vk', socialId, appId: APP_ID, groupId: null },
    ctx.now(),
    (identity, at) => createAccount(identity, at, ctx.config.economy, ctx.idFactory)
  );
  return account.id;
}

async function openSession(ctx: AppContext, userId: string, sku = 'ad_energy_25'): Promise<string> {
  const offer = getAdOffer(sku);
  if (!offer) throw new Error(`нет оффера ${sku}`);
  const account = await ctx.users.transact(userId, (current) => {
    const opened = openAdSession(current, offer, ctx.now(), ctx.config.economy, ctx.idFactory);
    return opened.account;
  });
  const pending = account.ads.pending;
  if (!pending) throw new Error('сессия не открылась');
  return pending.id;
}

function signedQuery(params: Record<string, string>): string {
  const signParams = { ...params };
  const sign = signVkMiniApp(signParams, Number(APP_ID), SECRET);
  const query = new URLSearchParams(signParams);
  query.set('sign', sign);
  return `/callbacks/vk/ads?${query.toString()}`;
}

async function get(
  app: FastifyInstance,
  url: string
): Promise<{ statusCode: number; json(): { error?: { code?: string } } }> {
  return app.inject({ method: 'GET', url });
}

afterEach(async () => {
  while (opened.length > 0) {
    const app = opened.pop();
    if (app) await app.close();
  }
});

describe('callbacks/vk/ads: награда выходит только под валидной подписью', () => {
  it('GET-постбэк выдаёт награду ровно один раз; повтор — «принято» без повторной выдачи', async () => {
    const { app, ctx } = await openStand();
    const userId = await createPlayer(ctx);
    const sessionId = await openSession(ctx, userId, 'ad_asterium_10');

    const url = signedQuery({ user_id: '12345', reward_id: sessionId });
    const first = await get(app, url);
    expect(first.statusCode).toBe(200);

    const afterFirst = await ctx.users.findById(userId);
    expect(afterFirst?.materials.asterium.earned).toBe(10);
    expect(afterFirst?.ads.claimed).toBe(1);
    expect(afterFirst?.ads.pending).toBeNull();

    // Повторная доставка той же подписи площадкой: 200 (ретрай остановлен),
    // награда и счётчик не двигаются ни на единицу.
    const replay = await get(app, url);
    expect(replay.statusCode).toBe(200);
    const afterReplay = await ctx.users.findById(userId);
    expect(afterReplay?.materials.asterium.earned).toBe(10);
    expect(afterReplay?.ads.claimed).toBe(1);
  });

  it('чужая подпись → 401 INVALID_AD_POSTBACK_SIGNATURE и ни одной единицы', async () => {
    const { app, ctx } = await openStand();
    const userId = await createPlayer(ctx);
    const sessionId = await openSession(ctx, userId, 'ad_asterium_10');

    const params = { user_id: '12345', reward_id: sessionId };
    const paramsWithForeignSign = {
      ...params,
      sign: signVkMiniApp(params, Number(APP_ID), 'attacker-secret')
    };
    const query = new URLSearchParams(paramsWithForeignSign);
    const response = await get(app, `/callbacks/vk/ads?${query.toString()}`);
    expect(response.statusCode).toBe(401);
    expect(response.json().error?.code).toBe('INVALID_AD_POSTBACK_SIGNATURE');

    const account = await ctx.users.findById(userId);
    expect(account?.materials.asterium.earned).toBe(0);
    expect(account?.ads.pending).not.toBeNull();
  });

  it('валидная подпись, но нет reward_id → 400', async () => {
    const { app } = await openStand();
    const response = await get(app, signedQuery({ user_id: '12345' }));
    expect(response.statusCode).toBe(400);
  });

  it('неизвестный игрок принимается «по-доброму»: 200 и причина в логе', async () => {
    const { app } = await openStand();
    const response = await get(app, signedQuery({ user_id: '999999', reward_id: 'session-ghost' }));
    expect(response.statusCode).toBe(200);
  });
});

describe('callbacks/vk/ads: методы и бюджет', () => {
  it('POST JSON-формом принимается — тот же договор, что и GET-query', async () => {
    const { app, ctx } = await openStand();
    const userId = await createPlayer(ctx, '777');
    const sessionId = await openSession(ctx, userId, 'ad_chips_2');

    const params = { user_id: '777', reward_id: sessionId };
    const sign = signVkMiniApp(params, Number(APP_ID), SECRET);
    const response = await app.inject({
      method: 'POST',
      url: '/callbacks/vk/ads',
      payload: { ...params, sign },
      headers: { 'content-type': 'application/json' }
    });
    expect(response.statusCode).toBe(200);

    const account = await ctx.users.findById(userId);
    expect(account?.junk.chips).toBe(2);
    expect(account?.ads.pending).toBeNull();
  });

  it('сгоревшая сессия — «принято» и долг не выдаётся', async () => {
    let clock = new Date('2026-10-20T00:00:00.000Z');
    const { app, ctx } = await openStand({}, { now: () => clock });
    const userId = await createPlayer(ctx, '555');
    const offer = getAdOffer('ad_asterium_10');
    if (!offer) throw new Error('нет оффера');
    // createPlayer уже создал игрока; открываем сессию с фиксированными часами.
    await ctx.users.transact(userId, (current) => {
      const opened = openAdSession(current, offer, clock, ctx.config.economy, ctx.idFactory);
      return opened.account;
    });
    const pendingAccount = await ctx.users.findById(userId);
    const sessionId = pendingAccount?.ads.pending?.id;
    if (!sessionId) throw new Error('сессия не открылась');

    // Увеличили время: сессия истекла (ADS_SESSION_TTL_SEC=180).
    clock = new Date(clock.getTime() + 4 * 60_000);
    const url = signedQuery({ user_id: '555', reward_id: sessionId });
    const response = await get(app, url);
    expect(response.statusCode).toBe(200);

    const after = await ctx.users.findById(userId);
    expect(after?.materials.asterium.earned).toBe(0);
    expect(after?.ads.claimed).toBe(0);
    // Сессия осталась в документе — столь же, сколь и до постбэка: мы её не тронули.
    expect(after?.ads.pending?.id).toBe(sessionId);
  });

  it('превышение RATE_LIMIT_EVENT_PER_MIN → 429', async () => {
    const { app } = await openStand({ RATE_LIMIT_EVENT_PER_MIN: '1' });
    expect((await get(app, signedQuery({ user_id: '1', reward_id: 'a' }))).statusCode).toBe(200);
    const blocked = await get(app, signedQuery({ user_id: '1', reward_id: 'b' }));
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error?.code).toBe('RATE_LIMITED');
  });
});
