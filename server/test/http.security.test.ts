import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';

import { buildCsp, clientIpOf, normalizeRequestId, resolveRequestId } from '../src/http/security.js';
import { buildApp } from '../src/http/app.js';
import { createContext } from '../src/http/context.js';
import { loadConfig } from '../src/config/env.js';
import { testConfig } from './fixtures.js';

/**
 * http/security: головы, идентификатор запроса и бюджет входа — на реальном
 * транспорте.
 *
 * До этого коммита HTTP-слой не имел ни одного интеграционного теста: `vitest`
 * проверял домен, `http.frontend-contract.test.ts` сверял адреса маршрутов
 * статически, а смоук бил по живому серверу вручную. Разница между «редуктор
 * правильный» и «игрок получил ответ» оставалась за пределами автотестов — ровно
 * там, где живёт этот слой, потому что головы и лимитеры не имеют доменной логики
 * и потому проверить их можно только вместе с транспортом.
 *
 * Отсюда и выбор маршрута для тестов: `/v1/auth/dev-login` — самый дешёвый
 * необработанный POST, который реально существует на тестовом конфиге.
 */

const opened: Array<{ close(): Promise<void> }> = [];

async function openStand(env: Record<string, string> = {}) {
  const config = testConfig({ DEV_SIGNER_ENABLED: 'true', ALLOWED_ORIGINS: 'https://vk.com,https://vk.ru', ...env });
  const ctx = createContext(config);
  const app = await buildApp(ctx);
  opened.push(app);
  return app;
}

afterEach(async () => {
  while (opened.length > 0) {
    const app = opened.pop();
    if (app) await app.close();
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('http/security: защитные головы на всех ответах', () => {
  it('ответ API несёт головы и НЕ несёт X-Frame-Options', () => {
    // ВК грузит приложение в iframe. `X-Frame-Options: DENY` из любого примера в
    // интернете выключил бы игру целиком, и произошло бы это на проде, где
    // встраивание не проверить.
    const csp = buildCsp(['https://vk.com', 'https://vk.ru']);
    expect(csp).toContain("frame-ancestors https://vk.com https://vk.ru");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it('пустой список источников закрывает встраивание, а не распахивает его', () => {
    expect(buildCsp([])).toContain("frame-ancestors 'none'");
  });

  it('каждый ответ сервера получает головы — включая 404', async () => {
    const app = await openStand();
    const response = await app.inject({ method: 'GET', url: '/nope' });
    expect(response.statusCode).toBe(404);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(String(response.headers['content-security-policy'])).toContain('frame-ancestors https://vk.com https://vk.ru');
    expect(response.headers['x-frame-options']).toBeUndefined();
  });

  it('HSTS появляется только в production', async () => {
    const dev = await openStand();
    expect((await dev.inject({ method: 'GET', url: '/v1/config' })).headers['strict-transport-security']).toBeUndefined();

    // Прод-конфиг собирается тем же loadConfig, что и на реальном деплое:
    // mongo-сторы конструируются, но не подключаются (ctx.connect() не вызывается),
    // поэтому проверять головы можно без живой БД.
    const prodConfig = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(48),
      STORE_DRIVER: 'mongo',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/tds',
      VK_APP_ID: '54836331',
      VK_SECRET_KEY: 'secret',
      ALLOWED_ORIGINS: 'https://vk.com,https://vk.ru'
    } as NodeJS.ProcessEnv);
    const prodApp = await buildApp(createContext(prodConfig));
    opened.push(prodApp);
    const response = await prodApp.inject({ method: 'GET', url: '/v1/config' });
    expect(String(response.headers['strict-transport-security'])).toContain('max-age=31536000');
  });
});

describe('http/security: идентификатор запроса', () => {
  it('чужой корректный id принимается дословно — трейс должен быть сквозным', async () => {
    const app = await openStand();
    const response = await app.inject({ method: 'GET', url: '/v1/config', headers: { 'x-request-id': 'vk-42-a' } });
    expect(response.headers['x-request-id']).toBe('vk-42-a');
  });

  it('без заголовка генерируется UUID', async () => {
    const app = await openStand();
    const response = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(String(response.headers['x-request-id'])).toMatch(UUID_RE);
  });

  it('кривой id отбрасывается, а не попадает в лог как есть', () => {
    // id печатается в структурированный лог дословно: перевод строки в этом поле
    // — подделка записи в агрегаторе, а не диагностика.
    expect(normalizeRequestId('ok.id:1_2')).toBe('ok.id:1_2');
    expect(normalizeRequestId('bad\nid')).toBeNull();
    expect(normalizeRequestId('x'.repeat(65))).toBeNull();
    expect(normalizeRequestId('   ')).toBeNull();
    expect(normalizeRequestId(undefined)).toBeNull();
    expect(resolveRequestId('bad\nid')).toMatch(UUID_RE);
  });
});

describe('http/security: бюджет маршрутов входа', () => {
  const login = { method: 'POST' as const, url: '/v1/auth/dev-login', payload: { socialId: '1' } };

  it('превышение лимита отдаёт 429 с Retry-After и кодом RATE_LIMITED', async () => {
    const app = await openStand({ RATE_LIMIT_AUTH_PER_MIN: '3' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await app.inject(login)).statusCode).toBe(200);
    }
    const blocked = await app.inject(login);
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Отказ — тоже ответ: головы на нём обязательны так же, как на 200.
    expect(blocked.headers['x-content-type-options']).toBe('nosniff');
  });

  it('нулевой лимит выключает бакет, а не закрывает вход', async () => {
    const app = await openStand({ RATE_LIMIT_AUTH_PER_MIN: '0' });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      expect((await app.inject(login)).statusCode).toBe(200);
    }
  });

  it('разные адреса не делят один бакет', async () => {
    const app = await openStand({ RATE_LIMIT_AUTH_PER_MIN: '1' });
    expect((await app.inject({ ...login, remoteAddress: '203.0.113.1' })).statusCode).toBe(200);
    expect((await app.inject({ ...login, remoteAddress: '203.0.113.1' })).statusCode).toBe(429);
    expect((await app.inject({ ...login, remoteAddress: '203.0.113.2' })).statusCode).toBe(200);
  });

  it('подмена X-Forwarded-For не размножает бакеты: по умолчанию заголовку не верим', async () => {
    const app = await openStand({ RATE_LIMIT_AUTH_PER_MIN: '2' });
    const statuses: number[] = [];
    for (const spoof of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
      const response = await app.inject({
        ...login,
        remoteAddress: '203.0.113.9',
        headers: { 'x-forwarded-for': spoof }
      });
      statuses.push(response.statusCode);
    }
    // Три разных «клиента» на одном TCP-адресе = три запроса в один бакет.
    expect(statuses).toEqual([200, 200, 429]);
  });

  it('с явным доверием к прокси адрес берётся из левого элемента цепи', async () => {
    const app = await openStand({ RATE_LIMIT_AUTH_PER_MIN: '1', TRUST_FORWARDED_FOR: 'true' });
    const chain = { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' };
    expect((await app.inject({ ...login, remoteAddress: '203.0.113.9', headers: chain })).statusCode).toBe(200);
    expect((await app.inject({ ...login, remoteAddress: '203.0.113.9', headers: chain })).statusCode).toBe(429);
    expect(
      (await app.inject({
        ...login,
        remoteAddress: '203.0.113.9',
        headers: { 'x-forwarded-for': '198.51.100.8, 203.0.113.9' }
      })).statusCode
    ).toBe(200);
  });

  it('clientIpOf: без доверия — адрес соединения, с доверием — левый в цепи', () => {
    const chained = { ip: '203.0.113.9', headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' } };
    expect(clientIpOf(chained as unknown as FastifyRequest, false)).toBe('203.0.113.9');
    expect(clientIpOf(chained as unknown as FastifyRequest, true)).toBe('198.51.100.7');

    const bare = { ip: '203.0.113.9', headers: {} };
    expect(clientIpOf(bare as unknown as FastifyRequest, true)).toBe('203.0.113.9');

    // Пустой первый элемент — не адрес: откатываемся на соединение, а не заводим
    // бакет с ключом `auth:`, общий для всех таких.
    const malformed = { ip: '203.0.113.9', headers: { 'x-forwarded-for': '  , 198.51.100.7' } };
    expect(clientIpOf(malformed as unknown as FastifyRequest, true)).toBe('203.0.113.9');
  });
});

