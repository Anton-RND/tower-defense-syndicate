import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/http/app.js';
import { createContext, type AppContext } from '../src/http/context.js';
import type { LedgerStore } from '../src/modules/ledger/ledger.store.js';
import { signVkParams, type VkParams } from '../src/modules/auth/vk.signature.js';
import { REFERRAL_REWARD_ASTERIUM, REFERRAL_REWARD_ENERGY } from '../src/modules/social/referral.js';
import { testConfig } from './fixtures.js';

/**
 * Боевой вход `/v1/auth/vk/init-data` на реальном транспорте.
 *
 * Домен подписи покрыт `vk.signature.test.ts`, а реферал — `social.referral.test.ts`.
 * Этот файл проверяет то, чего ни один доменный тест не увидит: что HTTP-слой
 * ДЕЙСТВИТЕЛЬНО ходит в верификатор, а не верит себе; что отказ приходит кодом
 * `INVALID_INIT_DATA`/`EXPIRED_INIT_DATA`, а не «тихим 500»; что реферальная
 * связка срабатывает ровно один раз и только на рождении аккаунта; и что
 * генератор initData (`POST /v1/dev/vk/sign`) выдаёт строку, которую принимает
 * боевой маршрут, — то есть стенд и прод говорят на одном диалекте.
 *
 * Координаты площадки задаются ЯВНО (`VK_APP_ID`/`VK_SECRET_KEY`), иначе
 * `authModeOf` вернул бы 'dev', и витрина, проверенная этим файлом, отличалась
 * бы от той, что увидит игрок.
 */

const SECRET = 'test-vk-secret';
const APP_ID = 777001;

const opened: Array<{ close(): Promise<void> }> = [];

async function openStand(env: Record<string, string> = {}) {
  const config = testConfig({
    DEV_SIGNER_ENABLED: 'true',
    VK_APP_ID: String(APP_ID),
    VK_SECRET_KEY: SECRET,
    ...env
  });
  const ctx = createContext(config);
  const app = await buildApp(ctx);
  opened.push(app);
  return { app, ctx, config };
}

afterEach(async () => {
  while (opened.length > 0) {
    const app = opened.pop();
    if (app) await app.close();
  }
});

/** Сборка initData ровно так, как её приносит WebView: подписанный набор + sign. */
function initDataOf(
  socialId: string | number,
  overrides: VkParams = {},
  options: { appId?: number; secretKey?: string; signKey?: 'sign' | 'sig'; ts?: number } = {}
): string {
  const ts = String(options.ts ?? Math.floor(Date.now() / 1000));
  const params: VkParams = {
    allow_preview: '0',
    is_app_user: '1',
    language: 'ru',
    platform: 'vk',
    platform_type: 'mobile_web',
    realm: 'vk.com',
    session_hash: `hash-${socialId}`,
    sign_version: '2',
    ts,
    vk_app_id: String(options.appId ?? APP_ID),
    viewer_id: String(socialId),
    ...overrides
  };
  return signVkParams(params, {
    appId: options.appId ?? APP_ID,
    secretKey: options.secretKey ?? SECRET,
    signKey: options.signKey ?? 'sign'
  }).initData;
}

function postInitData(app: FastifyInstance, initData: string, from = '10.0.0.1') {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/vk/init-data',
    payload: { initData },
    remoteAddress: from
  });
}

interface Session {
  token: string;
  created: boolean;
  user: { id: string };
  referral?: { ref: string; source: string; bound: boolean; credited: boolean; reason: string };
}

async function login(app: FastifyInstance, socialId: string | number, overrides: VkParams = {}): Promise<Session> {
  const response = await postInitData(app, initDataOf(socialId, overrides));
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Session;
}

describe('auth/vk-init-data: вход по подписанным параметрам площадки', () => {
  it('валидная initData рождает аккаунт, а второй вход — тот же игрок и created=false', async () => {
    const { app } = await openStand();

    const first = await login(app, 321450423);
    expect(first.created).toBe(true);
    expect(first.token.length).toBeGreaterThan(20);

    const second = await login(app, 321450423);
    expect(second.created).toBe(false);
    expect(second.user.id).toBe(first.user.id);
  });

  it('подпись в поле sig принимается наравне со sign', async () => {
    const { app } = await openStand();
    const response = await postInitData(app, initDataOf(111, {}, { signKey: 'sig' }));
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as Session).created).toBe(true);
  });

  it('session_hash с base64-спецсимволами не ломает вход', async () => {
    const { app } = await openStand();
    const response = await postInitData(app, initDataOf(112, { session_hash: 'A+B/C==' }));
    expect(response.statusCode, response.body).toBe(200);
  });

  it('чужая подпись → 401 INVALID_INIT_DATA и ни одного аккаунта', async () => {
    const { app, ctx } = await openStand();
    const response = await postInitData(app, initDataOf(123, {}, { secretKey: 'attacker-secret' }));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_INIT_DATA');
    expect(await ctx.users.findBySocial('vk', '123')).toBeNull();
  });

  it('подменённый viewer_id при настоящей подписи → 401', async () => {
    const { app } = await openStand();
    const response = await postInitData(app, initDataOf(200).replace('viewer_id=200', 'viewer_id=999'));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_INIT_DATA');
  });

  it('чужой app_id → 401 INVALID_INIT_DATA, а не VK_NOT_CONFIGURED', async () => {
    const { app } = await openStand();
    const response = await postInitData(app, initDataOf(201, {}, { appId: 999888 }));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_INIT_DATA');
  });

  it('устаревшая строка запуска → 401 EXPIRED_INIT_DATA', async () => {
    const { app } = await openStand();
    const stale = Math.floor(Date.now() / 1000) - 7200;
    const response = await postInitData(app, initDataOf(202, {}, { ts: stale }));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('EXPIRED_INIT_DATA');
  });

  it('параметры без подписи → 401', async () => {
    const { app } = await openStand();
    const response = await postInitData(app, `vk_app_id=${APP_ID}&viewer_id=203`);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_INIT_DATA');
  });

  it('пустое тело → 400 VALIDATION_ERROR, а не 500', async () => {
    const { app } = await openStand();
    const response = await app.inject({ method: 'POST', url: '/v1/auth/vk/init-data', payload: {} });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('без координат площадки — 500 VK_NOT_CONFIGURED, вход не совершается', async () => {
    const { app } = await openStand({ VK_APP_ID: '0', VK_SECRET_KEY: '' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/vk/init-data',
      payload: { initData: 'viewer_id=1&sign=deadbeef' }
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('VK_NOT_CONFIGURED');
  });

  it('витрина видит режим: /v1/config → auth.mode=vk, /health → auth=vk', async () => {
    const { app } = await openStand();
    const config = await app.inject({ method: 'GET', url: '/v1/config' });
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect((config.json() as { auth: { mode: string } }).auth.mode).toBe('vk');
    expect((health.json() as { auth: string }).auth).toBe('vk');
  });

  it('бюджет на адрес держит: третий вход подряд при RATE_LIMIT_AUTH_PER_MIN=2 → 429', async () => {
    const { app } = await openStand({ RATE_LIMIT_AUTH_PER_MIN: '2' });
    const first = await postInitData(app, initDataOf(300), '203.0.113.7');
    const second = await postInitData(app, initDataOf(301), '203.0.113.7');
    const third = await postInitData(app, initDataOf(302), '203.0.113.7');
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json().error.code).toBe('RATE_LIMITED');
  });
});

describe('auth/vk-init-data: реферал из параметров запуска', () => {
  it('hash=inv_<id> привязывает новичка и награждает пригласившего один раз', async () => {
    const { app, ctx } = await openStand();
    const inviter = await login(app, 500);
    const before = await ctx.users.findById(inviter.user.id);
    expect(before).not.toBeNull();

    const response = await postInitData(app, initDataOf(501, { hash: `inv_${inviter.user.id}` }));
    expect(response.statusCode, response.body).toBe(200);
    const invitee = response.json() as Session;
    expect(invitee.created).toBe(true);
    expect((await ctx.users.findById(invitee.user.id))?.referral.invitedBy).toBe(inviter.user.id);

    const after = await ctx.users.findById(inviter.user.id);
    expect(after?.referral.count).toBe(1);
    expect(after?.referral.invited).toContain(invitee.user.id);
    // Астерий — только `earned`: купленные за рубли единицы из виральной выдачи не состоят.
    expect((after?.materials.asterium.earned ?? 0) - (before?.materials.asterium.earned ?? 0)).toBe(
      REFERRAL_REWARD_ASTERIUM
    );
    // Энергия урезается капом, как в ассисте, но приглашение всё равно засчитывается.
    const cap = ctx.config.economy.energyCap;
    expect(after?.resources.energy).toBe(Math.min(cap, (before?.resources.energy ?? 0) + REFERRAL_REWARD_ENERGY));
  });

  it('ответ входа несёт диагностику привязки: source=hash, reason=ok', async () => {
    const { app } = await openStand();
    const inviter = await login(app, 502);
    const response = await postInitData(app, initDataOf(503, { hash: `inv_${inviter.user.id}` }));
    const session = response.json() as Session;
    expect(session.referral).toMatchObject({
      ref: `inv_${inviter.user.id}`,
      source: 'hash',
      bound: true,
      credited: true,
      reason: 'ok',
      asterium: REFERRAL_REWARD_ASTERIUM
    });
  });

  it('повторный вход по той же initData ничего не доначисляет', async () => {
    const { app, ctx } = await openStand();
    const inviter = await login(app, 504);
    const initData = initDataOf(505, { hash: `inv_${inviter.user.id}` });

    await postInitData(app, initData);
    const afterFirst = await ctx.users.findById(inviter.user.id);
    // Второй вход того же игрока: `created === false`, и реферальный путь не
    // вызывается вовсе — иначе суточный лимит пригласившего щёлкался бы ретраем.
    const repeat = await postInitData(app, initData);
    expect((repeat.json() as Session).created).toBe(false);
    expect((repeat.json() as Session).referral).toBeUndefined();

    const afterSecond = await ctx.users.findById(inviter.user.id);
    expect(afterSecond?.referral.count).toBe(afterFirst?.referral.count);
    expect(afterSecond?.referral.invited.length).toBe(afterFirst?.referral.invited.length);
  });

  it('подписанный ref важнее голого hash: источник указывается честно', async () => {
    const { app, ctx } = await openStand();
    const signed = await login(app, 506);
    const ignored = await login(app, 507);

    const response = await postInitData(app, initDataOf(508, { ref: `inv_${signed.user.id}`, hash: `inv_${ignored.user.id}` }));
    const session = response.json() as Session;
    expect(session.referral?.source).toBe('signed');
    expect(session.referral?.ref).toBe(`inv_${signed.user.id}`);
    expect((await ctx.users.findById(session.user.id))?.referral.invitedBy).toBe(signed.user.id);
    expect((await ctx.users.findById(ignored.user.id))?.referral.count).toBe(0);
  });

  it('чужая метка перехода не ломает вход и не награждает никого', async () => {
    const { app, ctx } = await openStand();
    const response = await postInitData(app, initDataOf(509, { hash: 'vk_share_panel' }));
    expect(response.statusCode).toBe(200);
    const session = response.json() as Session;
    expect(session.referral).toMatchObject({ source: 'hash', bound: false, credited: false, reason: 'not-ours' });
    expect((await ctx.users.findById(session.user.id))?.referral.invitedBy).toBeNull();
  });

  it('ссылка на несуществующего пригласившего: связка есть, награды нет', async () => {
    const { app, ctx } = await openStand();
    const ghost = '00000000-0000-4000-8000-000000000000';
    const response = await postInitData(app, initDataOf(510, { hash: `inv_${ghost}` }));
    const session = response.json() as Session;
    expect(session.referral).toMatchObject({ bound: true, credited: false, reason: 'inviter-not-found' });
    expect((await ctx.users.findById(session.user.id))?.referral.invitedBy).toBe(ghost);
  });

  it('суточный потолок пригласившего отсекает третьего друга, не трогая вход', async () => {
    const { app, ctx } = await openStand({ REFERRAL_DAILY_MAX: '2' });
    const inviter = await login(app, 511);
    const first = await postInitData(app, initDataOf(512, { hash: `inv_${inviter.user.id}` }));
    const second = await postInitData(app, initDataOf(513, { hash: `inv_${inviter.user.id}` }));
    const third = await postInitData(app, initDataOf(514, { hash: `inv_${inviter.user.id}` }));

    expect((first.json() as Session).referral?.credited).toBe(true);
    expect((second.json() as Session).referral?.credited).toBe(true);
    expect(third.statusCode, third.body).toBe(200);
    expect((third.json() as Session).referral).toMatchObject({ bound: true, credited: false, reason: 'limit' });
    expect((await ctx.users.findById(inviter.user.id))?.referral.count).toBe(2);
  });

  it('dev-login идёт через тот же реферальный путь, что боевой вход', async () => {
    const { app, ctx } = await openStand();
    const inviter = await login(app, 515);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { socialId: 'dev-516', ref: `inv_${inviter.user.id}` }
    });
    expect(response.statusCode, response.body).toBe(200);
    const session = response.json() as Session;
    expect(session.referral).toMatchObject({ bound: true, credited: true, reason: 'ok' });
    expect((await ctx.users.findById(session.user.id))?.referral.invitedBy).toBe(inviter.user.id);
  });
});

describe('dev/vk-sign: генератор initData говорит на диалекте боевого входа', () => {
  async function sign(app: FastifyInstance, body: Record<string, unknown> = {}) {
    const response = await app.inject({ method: 'POST', url: '/v1/dev/vk/sign', payload: body });
    return response;
  }

  it('выданная строка принимается /v1/auth/vk/init-data', async () => {
    const { app } = await openStand();
    const signed = await sign(app, { socialId: '600' });
    expect(signed.statusCode, signed.body).toBe(200);
    const payload = signed.json() as { initData: string; scheme: string; signKey: string; expiresInSec: number };
    expect(payload.scheme).toBe('mini_app');
    expect(payload.signKey).toBe('sign');
    expect(payload.expiresInSec).toBeGreaterThan(0);

    const loginResponse = await postInitData(app, payload.initData);
    expect(loginResponse.statusCode, loginResponse.body).toBe(200);
    expect((loginResponse.json() as Session).created).toBe(true);
  });

  it('ref кладётся и в подписанный ref, и в hash — обе ветки извлечения работают', async () => {
    const { app, ctx } = await openStand();
    const inviter = await login(app, 601);
    const signed = await sign(app, { socialId: '602', ref: `inv_${inviter.user.id}` });
    const payload = signed.json() as { initData: string };
    expect(payload.initData).toContain('hash=inv_');

    const response = await postInitData(app, payload.initData);
    expect(response.statusCode, response.body).toBe(200);
    const session = response.json() as Session;
    // Подписанный источник обязан победить голый hash: метка одна, доверия разное.
    expect(session.referral).toMatchObject({ source: 'signed', bound: true, credited: true, reason: 'ok' });
    expect((await ctx.users.findById(inviter.user.id))?.referral.count).toBe(1);
  });

  it('scheme=launch_params: старая схема тоже проходит боевой вход', async () => {
    const { app } = await openStand();
    const signed = await sign(app, { socialId: '603', scheme: 'launch_params' });
    const payload = signed.json() as { initData: string; scheme: string };
    expect(payload.scheme).toBe('launch_params');
    const response = await postInitData(app, payload.initData);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('signKey=sig: подпись в алиасе принимается боевым маршрутом', async () => {
    const { app } = await openStand();
    const signed = await sign(app, { socialId: '604', signKey: 'sig' });
    const response = await postInitData(app, (signed.json() as { initData: string }).initData);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('ageSec сверх TTL: генератор честно предупреждает, а вход отвечает EXPIRED_INIT_DATA', async () => {
    const { app } = await openStand({ VK_INIT_DATA_SOURCE_TTL_SECONDS: '60' });
    const signed = await sign(app, { socialId: '605', ageSec: 120 });
    const payload = signed.json() as { initData: string; expiresInSec: number };
    expect(payload.expiresInSec).toBeLessThan(0);
    const response = await postInitData(app, payload.initData);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('EXPIRED_INIT_DATA');
  });

  it('чужой secretKey в теле: генератор подписывает им, а боевой вход отвергает строку', async () => {
    const { app } = await openStand();
    const signed = await sign(app, { socialId: '606', secretKey: 'attacker-secret' });
    const response = await postInitData(app, (signed.json() as { initData: string }).initData);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_INIT_DATA');
  });

  it('кривые параметры тела → 400, а не 500', async () => {
    const { app } = await openStand();
    const badScheme = await sign(app, { scheme: 'telegram' });
    const badSocial = await sign(app, { socialId: 'abc' });
    expect(badScheme.statusCode).toBe(400);
    expect(badScheme.json().error.code).toBe('VALIDATION_ERROR');
    expect(badSocial.statusCode).toBe(400);
  });

  it('DEV_SIGNER_ENABLED=false закрывает генератор 403 — наружу он не печатает ничего', async () => {
    const { app } = await openStand({ DEV_SIGNER_ENABLED: 'false' });
    const response = await sign(app, { socialId: '607' });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('FORBIDDEN');
  });

  it('signHash=true: генератор подписывает `hash`, и боевой вход такую строку принимает', async () => {
    const { app, ctx } = await openStand();
    const inviter = await login(app, 608);
    const signed = await sign(app, { socialId: '609', ref: `inv_${inviter.user.id}`, signHash: true });
    const payload = signed.json() as { initData: string; signHash: boolean };
    expect(payload.signHash).toBe(true);

    const response = await postInitData(app, payload.initData);
    expect(response.statusCode, response.body).toBe(200);
    const session = response.json() as Session;
    expect(session.referral).toMatchObject({ bound: true, credited: true, reason: 'ok' });
    expect((await ctx.users.findById(session.user.id))?.referral.invitedBy).toBe(inviter.user.id);
  });

  it('кривая форма socialId в dev-login → 400, а не запись в уникальный индекс', async () => {
    const { app } = await openStand();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { socialId: 'два слова' }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });
});



describe('auth/vk-init-data: форма initData, которую обязан перебрать верификатор', () => {
  /** initData, где `hash` включён в строку проверки — форма переходов из шеринга. */
  function hashSigned(socialId: number, extra: VkParams = {}, includeHash = true): string {
    const params: VkParams = {
      is_app_user: '1',
      platform: 'vk',
      session_hash: `hash-${socialId}`,
      ts: String(Math.floor(Date.now() / 1000)),
      vk_app_id: String(APP_ID),
      viewer_id: String(socialId),
      hash: 'inv_0f1e2d3c4b5a',
      ...extra
    };
    return signVkParams(params, { appId: APP_ID, secretKey: SECRET, includeHash }).initData;
  }

  it('подписанный hash проходит боевым входом', async () => {
    const { app } = await openStand();
    const response = await postInitData(app, hashSigned(901));
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as Session).created).toBe(true);
  });

  it('подменённый hash в строке, подписанной вместе с ним, → 401', async () => {
    const { app } = await openStand();
    const signed = hashSigned(902);
    const tampered = signed.replace('hash=inv_0f1e2d3c4b5a', 'hash=inv_aaaa1111bbbb2222');
    const response = await postInitData(app, tampered);
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_INIT_DATA');
  });

  it('каноническая форма (hash не подписан) по-прежнему принимается и остаётся источником `hash`', async () => {
    const { app } = await openStand();
    const response = await postInitData(app, hashSigned(903, {}, false));
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as Session).referral?.source).toBe('hash');
  });
});

describe('auth/vk-init-data: догон реферальной награды после падения', () => {
  it('связка без отметки догоняется на следующем входе ровно один раз', async () => {
    const { app, ctx } = await openStand();
    const inviter = await login(app, 700);
    const invitee = await login(app, 701);

    // Падение процесса между двумя записями: новичок привязан, второй документ
    // не тронут. Воспроизводим напрямую в сторе, а не разрывом запроса, — иначе
    // механизм нельзя было бы проверить ни тестом, ни смоком.
    await ctx.users.transact(invitee.user.id, (current) => ({
      ...current,
      referral: { ...current.referral, invitedBy: inviter.user.id, settledAt: null }
    }));

    const recovered = await postInitData(app, initDataOf(701));
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect((recovered.json() as Session).referral).toMatchObject({
      source: 'stored',
      bound: true,
      credited: true,
      reason: 'ok'
    });
    expect((await ctx.users.findById(inviter.user.id))?.referral.count).toBe(1);
    expect((await ctx.users.findById(invitee.user.id))?.referral.settledAt).not.toBeNull();

    // Третий вход: отметка стоит → догона нет, и `referral` в ответе отсутствует.
    const third = await postInitData(app, initDataOf(701));
    expect((third.json() as Session).referral).toBeUndefined();
    expect((await ctx.users.findById(inviter.user.id))?.referral.count).toBe(1);
  });

  it('догон после уже выданной награды печатать астерий не может', async () => {
    const { app, ctx } = await openStand();
    const inviter = await login(app, 702);
    const signup = await postInitData(app, initDataOf(703, { hash: `inv_${inviter.user.id}` }));
    expect((signup.json() as Session).referral?.credited).toBe(true);
    expect((await ctx.users.findById(inviter.user.id))?.referral.count).toBe(1);
    const inviteeId = (signup.json() as Session).user.id;

    // Сняли только `settledAt`, не тронув список `invited` пригласившего: догон
    // обязан отказать как «уже награждён», а не выдать астерий второй раз.
    await ctx.users.transact(inviteeId, (current) => ({
      ...current,
      referral: { ...current.referral, settledAt: null }
    }));

    const retried = await postInitData(app, initDataOf(703));
    expect((retried.json() as Session).referral).toMatchObject({
      source: 'stored',
      credited: false,
      reason: 'already-credited'
    });
    const after = await ctx.users.findById(inviter.user.id);
    expect(after?.referral.count).toBe(1);
    expect(after?.referral.invited).toContain(inviteeId);
  });
});


describe('health/vk-auth: наблюдение за входом без доступа к хосту', () => {
  interface Health {
    vk_auth: {
      accepted: number;
      rejected: number;
      rejectsByCode: Record<string, number>;
      lastAccepted: { scheme: string; signKey: string; source: string; hashIncluded: boolean; tsKey: string } | null;
      lastRejected: { code: string; signKey: string; signShape: string } | null;
    };
  }

  it('счётчики и профиль последней подписи видны в /health', async () => {
    const { app } = await openStand();
    const before = (await app.inject({ method: 'GET', url: '/health' })).json() as Health;
    expect(before.vk_auth).toMatchObject({ accepted: 0, rejected: 0, lastAccepted: null, lastRejected: null });

    await postInitData(app, initDataOf(800));
    await postInitData(app, initDataOf(801, {}, { secretKey: 'attacker-secret' }));

    const after = (await app.inject({ method: 'GET', url: '/health' })).json() as Health;
    expect(after.vk_auth.accepted).toBe(1);
    expect(after.vk_auth.rejected).toBe(1);
    expect(after.vk_auth.rejectsByCode['INVALID_INIT_DATA']).toBe(1);
    // Ожидаемая форма живого входа: сырые байты, hash вне проверки, поле `ts`.
    expect(after.vk_auth.lastAccepted).toMatchObject({
      scheme: 'mini_app',
      signKey: 'sign',
      source: 'raw',
      hashIncluded: false,
      tsKey: 'ts'
    });
    // Форма подписи не зависит от секрета: по ней «не тот секрет» отличается от
    // «незнакомая схема» ещё до всякого сравнения.
    expect(after.vk_auth.lastRejected).toMatchObject({
      code: 'INVALID_INIT_DATA',
      signKey: 'sign',
      signShape: 'mini_app'
    });
  });

  it('персональные данные наружу не уходят: ни viewer_id, ни session_hash, ни секрет', async () => {
    const { app } = await openStand();
    await postInitData(app, initDataOf(802, { session_hash: 'uniq-session-hash-802' }));
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.body).not.toContain('802');
    expect(response.body).not.toContain('uniq-session-hash-802');
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain('viewer_id');
  });
});


describe('auth/vk-init-data: сбой реферала не срывает вход', () => {
  it('отказ журнала не отдаёт 500, а догон не удваивает награду', async () => {
    const config = testConfig({
      DEV_SIGNER_ENABLED: 'true',
      VK_APP_ID: String(APP_ID),
      VK_SECRET_KEY: SECRET
    });
    const base = createContext(config);
    let journalDown = true;
    // Ломаем только записи реферальной награды (`event`): стартовый комплект
    // новичка обязан пройти — иначе проверка превращается в «вход упал по другой
    // причине» и врёт про причину.
    const ledger = new Proxy(base.ledger, {
      get(target, property) {
        if (property === 'appendMany') {
          return async (entries: Parameters<LedgerStore['appendMany']>[0]) => {
            if (journalDown && entries.some((entry) => entry.reason === 'event')) {
              throw new Error('журнал событий не пишет');
            }
            return target.appendMany(entries);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      }
    });
    const ctx = createContext(config, {
      users: base.users,
      clans: base.clans,
      lots: base.lots,
      commodities: base.commodities,
      ledger
    });
    const app = await buildApp(ctx);
    opened.push(app);

    const inviter = await login(app, 1000);
    const signup = await postInitData(app, initDataOf(1001, { hash: `inv_${inviter.user.id}` }));
    expect(signup.statusCode, signup.body).toBe(200);
    const invitee = signup.json() as Session;
    expect(invitee.created).toBe(true);
    // Реферала в ответе нет — он не состоялся. Вход состоялся, и это главное:
    // награда другу не имеет права ломать игроку игру.
    expect(invitee.referral).toBeUndefined();
    const bound = await ctx.users.findById(invitee.user.id);
    expect(bound?.referral.invitedBy).toBe(inviter.user.id);
    expect(bound?.referral.settledAt).toBeNull();

    journalDown = false;
    const retry = await postInitData(app, initDataOf(1001));
    expect((retry.json() as Session).referral).toMatchObject({
      source: 'stored',
      credited: false,
      reason: 'already-credited'
    });
    // Пригласивший получил награду один раз: его документ был записан до отказа
    // журнала, поэтому догон обязан отказать как «уже награждён».
    expect((await ctx.users.findById(inviter.user.id))?.referral.count).toBe(1);
    expect((await ctx.users.findById(invitee.user.id))?.referral.settledAt).not.toBeNull();
  });
});
