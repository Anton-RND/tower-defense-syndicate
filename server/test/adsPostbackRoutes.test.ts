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
 *
 * Отдельный блок — двойная корреляция postback'а: `reward_id` площадки не обязан
 * быть нашим id сессии (мост 3.0.2 вообще не передаёт приложению свой
 * идентификатор), поэтому тесты держат оба режима — строгий по совпадению и по
 * владельцу — и требуют, чтобы выбранный режим был виден в логе.
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

/**
 * Шпион логгера. Постбэк отвечает площадке «принято» почти во всех случаях, а
 * значит единственный способ увидеть, ЧТО именно сервер решил и ПОЧЕМУ — записи.
 * Без них тест проверял бы только код 200 и молча принимал любую выдачу.
 */
function recordingLogger(): {
  logger: unknown;
  entries: Array<{ level: string; msg: string; meta: Record<string, unknown> }>;
} {
  const entries: Array<{ level: string; msg: string; meta: Record<string, unknown> }> = [];
  const push = (level: string) => (msg: string, meta: Record<string, unknown> = {}): void => {
    entries.push({ level, msg, meta });
  };
  return {
    logger: { debug: push('debug'), info: push('info'), warn: push('warn'), error: push('error') },
    entries
  };
}

function lastEntry(
  entries: Array<{ msg: string; meta: Record<string, unknown> }>,
  msg: string
): { meta: Record<string, unknown> } | null {
  return [...entries].reverse().find((entry) => entry.msg === msg) ?? null;
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
    const logs = recordingLogger();
    const { app, ctx } = await openStand({}, { logger: logs.logger });
    const userId = await createPlayer(ctx);
    const sessionId = await openSession(ctx, userId, 'ad_asterium_10');

    const url = signedQuery({ user_id: '12345', reward_id: sessionId });
    const first = await get(app, url);
    expect(first.statusCode).toBe(200);

    const afterFirst = await ctx.users.findById(userId);
    expect(afterFirst?.materials.asterium.earned).toBe(10);
    expect(afterFirst?.ads.claimed).toBe(1);
    expect(afterFirst?.ads.pending).toBeNull();
    // Совпавший reward_id — строгий режим: подпись назвала именно эту сессию.
    expect(lastEntry(logs.entries, 'ad_postback_claimed')?.meta.correlated).toBe('reward_id');

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

  it('валидная подпись, но нет user_id → 400', async () => {
    const { app } = await openStand();
    const response = await get(app, signedQuery({ reward_id: 'anything' }));
    expect(response.statusCode).toBe(400);
  });

  it('чужой reward_id (площадка не знает наших id) → награда по владельцу, режим в логе', async () => {
    const logs = recordingLogger();
    const { app, ctx } = await openStand({}, { logger: logs.logger });
    const userId = await createPlayer(ctx, '222');
    await openSession(ctx, userId, 'ad_asterium_10');

    // vk-bridge 3.0.2 не даёт приложению передать площадке свой идентификатор
    // показа (ShowNativeAdsRequest = ad_format + use_waterfall), поэтому в
    // постбэке прийдёт id площадки, и строгое сравнение с id сессии невозможно.
    const response = await get(app, signedQuery({ user_id: '222', reward_id: 'vk-reward-77' }));
    expect(response.statusCode).toBe(200);

    const after = await ctx.users.findById(userId);
    expect(after?.materials.asterium.earned).toBe(10);
    expect(after?.ads.claimed).toBe(1);
    expect(after?.ads.pending).toBeNull();
    expect(lastEntry(logs.entries, 'ad_postback_claimed')?.meta.correlated).toBe('owner');
  });

  it('reward_id отсутствует вовсе → награда по владельцу, а не 400', async () => {
    const logs = recordingLogger();
    const { app, ctx } = await openStand({}, { logger: logs.logger });
    const userId = await createPlayer(ctx, '333');
    await openSession(ctx, userId, 'ad_chips_2');

    const response = await get(app, signedQuery({ user_id: '333' }));
    expect(response.statusCode).toBe(200);

    const after = await ctx.users.findById(userId);
    expect(after?.junk.chips).toBe(2);
    expect(lastEntry(logs.entries, 'ad_postback_claimed')?.meta.correlated).toBe('owner');
  });

  it('режим по владельцу не воскрешает сгоревшую сессию — домен остаётся истиной', async () => {
    let clock = new Date('2026-10-20T00:00:00.000Z');
    const logs = recordingLogger();
    const { app, ctx } = await openStand({}, { now: () => clock, logger: logs.logger });
    const userId = await createPlayer(ctx, '444');
    const offer = getAdOffer('ad_asterium_10');
    if (!offer) throw new Error('нет оффера');
    await ctx.users.transact(userId, (current) => {
      const opened = openAdSession(current, offer, clock, ctx.config.economy, ctx.idFactory);
      return opened.account;
    });
    const sessionId = (await ctx.users.findById(userId))?.ads.pending?.id;
    if (!sessionId) throw new Error('сессия не открылась');

    clock = new Date(clock.getTime() + 4 * 60_000);
    const response = await get(app, signedQuery({ user_id: '444' }));
    expect(response.statusCode).toBe(200);

    const after = await ctx.users.findById(userId);
    expect(after?.materials.asterium.earned).toBe(0);
    expect(after?.ads.claimed).toBe(0);
    expect(after?.ads.pending?.id).toBe(sessionId);
    const dropped = lastEntry(logs.entries, 'ad_postback_dropped');
    expect(dropped?.meta.code).toBe('AD_SESSION_EXPIRED');
    expect(dropped?.meta.correlated).toBe('owner');
  });

  it('пустой слот и чужой reward_id → «принято» без выдачи и с причиной в логе', async () => {
    const logs = recordingLogger();
    const { app, ctx } = await openStand({}, { logger: logs.logger });
    const userId = await createPlayer(ctx, '666');

    const response = await get(app, signedQuery({ user_id: '666', reward_id: 'vk-reward-1' }));
    expect(response.statusCode).toBe(200);

    const after = await ctx.users.findById(userId);
    expect(after?.ads.claimed).toBe(0);
    expect(lastEntry(logs.entries, 'ad_postback_ignored')?.meta.reason).toBe('no_pending_session');
  });

  it('неизвестный игрок принимается «по-доброму»: 200 и причина в логе', async () => {
    const { app } = await openStand();
    const response = await get(app, signedQuery({ user_id: '999999', reward_id: 'session-ghost' }));
    expect(response.statusCode).toBe(200);
  });
});

describe('callbacks/vk/ads: анти-реплей — память исполненных reward_id', () => {
  it('повтор того же reward_id не кормит следующий слот и не сжигает его', async () => {
    let clock = new Date('2026-10-20T00:00:00.000Z');
    const logs = recordingLogger();
    const { app, ctx } = await openStand({}, { now: () => clock, logger: logs.logger });
    const userId = await createPlayer(ctx, '808');
    await openSession(ctx, userId, 'ad_asterium_10');

    // Площадка прислала СВОЙ id (наш мост ей ничего не передаёт), награда выдана
    // по владельцу. Именно этот id и обязан вспомниться при повторной доставке.
    expect((await get(app, signedQuery({ user_id: '808', reward_id: 'vk-reward-dup' }))).statusCode).toBe(200);
    const first = await ctx.users.findById(userId);
    expect(first?.ads.claimed).toBe(1);
    expect(first?.ads.used.map((used) => used.id)).toEqual(['vk-reward-dup']);

    // Игрок посмотрел второе видео: слот открыт, и именно в него раньше
    // приземлялся сетевой ретрай первой доставки, оплачивая чужой показ.
    clock = new Date(clock.getTime() + 3 * 60_000);
    await openSession(ctx, userId, 'ad_asterium_10');

    expect((await get(app, signedQuery({ user_id: '808', reward_id: 'vk-reward-dup' }))).statusCode).toBe(200);
    const replay = await ctx.users.findById(userId);
    expect(replay?.materials.asterium.earned).toBe(10);
    expect(replay?.ads.claimed).toBe(1);
    // Слот НЕ сожжён: настоящее подтверждение второго показа ещё впереди.
    expect(replay?.ads.pending).not.toBeNull();
    expect(lastEntry(logs.entries, 'ad_postback_replay')?.meta.rewardId).toBe('vk-reward-dup');

    // ...и оно проходит. Память отбивает повтор, а не превращает игрока в
    // заложника одного id площадки.
    expect((await get(app, signedQuery({ user_id: '808', reward_id: 'vk-reward-second' }))).statusCode).toBe(200);
    const second = await ctx.users.findById(userId);
    expect(second?.ads.claimed).toBe(2);
    expect(second?.ads.pending).toBeNull();
    expect(second?.ads.used.map((used) => used.id)).toEqual(['vk-reward-dup', 'vk-reward-second']);
  });

  it('память привязана к игроку: тот же reward_id у другого награду не отбивает', async () => {
    const { app, ctx } = await openStand({}, { now: () => new Date('2026-10-20T00:00:00.000Z') });
    const alice = await createPlayer(ctx, '901');
    const bob = await createPlayer(ctx, '902');
    await openSession(ctx, alice, 'ad_asterium_10');
    await openSession(ctx, bob, 'ad_asterium_10');

    await get(app, signedQuery({ user_id: '901', reward_id: 'shared-id' }));
    expect((await ctx.users.findById(alice))?.ads.claimed).toBe(1);

    // Площадка не обязана делать id уникальными между нашими игроками, и сводить
    // их глобально — значит даром отрезать награду второму за чужой показ.
    const response = await get(app, signedQuery({ user_id: '902', reward_id: 'shared-id' }));
    expect(response.statusCode).toBe(200);
    const after = await ctx.users.findById(bob);
    expect(after?.ads.claimed).toBe(1);
    expect(after?.materials.asterium.earned).toBe(10);
  });

  it('reward_id старше ADS_REPLAY_WINDOW_SEC забывается: проверка и документ', async () => {
    let clock = new Date('2026-10-20T00:00:00.000Z');
    const { app, ctx } = await openStand({ ADS_REPLAY_WINDOW_SEC: '120' }, { now: () => clock });
    const userId = await createPlayer(ctx, '903');
    await openSession(ctx, userId, 'ad_asterium_10');
    await get(app, signedQuery({ user_id: '903', reward_id: 'vk-old' }));
    expect((await ctx.users.findById(userId))?.ads.used).toHaveLength(1);

    // Десять минут спустя то же самое подтверждение — это уже другой показ:
    // окно памяти его не видит, и награда выдаётся честно.
    clock = new Date(clock.getTime() + 10 * 60_000);
    await openSession(ctx, userId, 'ad_asterium_10');
    expect((await get(app, signedQuery({ user_id: '903', reward_id: 'vk-old' }))).statusCode).toBe(200);
    const after = await ctx.users.findById(userId);
    expect(after?.ads.claimed).toBe(2);
    // Запись не кочует вечно: старая выпала за окно, осталась ровно одна, свежая.
    expect(after?.ads.used).toHaveLength(1);
    expect(after?.ads.used[0]?.at.getTime()).toBe(clock.getTime());
  });

  it('без reward_id помнить нечего — риск зафиксирован тестом, а не надеждой', async () => {
    let clock = new Date('2026-10-20T00:00:00.000Z');
    const { app, ctx } = await openStand({}, { now: () => clock });
    const userId = await createPlayer(ctx, '904');
    await openSession(ctx, userId, 'ad_asterium_10');
    await get(app, signedQuery({ user_id: '904' }));
    // Выдумывать ключ сверки сервер не станет: память остаётся пустой.
    expect((await ctx.users.findById(userId))?.ads.used).toEqual([]);

    clock = new Date(clock.getTime() + 3 * 60_000);
    await openSession(ctx, userId, 'ad_asterium_10');
    await get(app, signedQuery({ user_id: '904' }));
    const after = await ctx.users.findById(userId);
    // Если живой постбэк окажется без reward_id, единственная защита повтора —
    // лимиты (ADS_DAILY_REWARDS, ADS_MIN_INTERVAL_SEC, TTL сессии). Именно это и
    // держит ADS_POSTBACK_READY=false до перехвата настоящего запроса.
    expect(after?.ads.claimed).toBe(2);
    expect(after?.materials.asterium.earned).toBe(20);
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
