import { gzipSync, gunzipSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/http/app.js';
import { createContext } from '../src/http/context.js';
import { testConfig } from './fixtures.js';

/**
 * Сжатие ответа (R4).
 *
 * Проверяются четыре утверждения, и каждое — про границу, а не про «плагин работает»:
 *
 *  1. крупный ответ жмётся, и жмётся существенно (иначе бессмысленно);
 *  2. распакованное байт в байт равно тому JSON, который клиент получил бы без
 *     `Accept-Encoding` — сжатие не имеет права менять тело;
 *  3. `Vary: Accept-Encoding` присутствует: без него промежуточный кэш однажды
 *     отдаст сжатое тело тому, кто его не просил, и это будет выглядеть как
 *     повреждённый ответ сервера, а не как ошибка кэша;
 *  4. мелкий ответ НЕ жмётся (порог `minSize`), и сжатое ТЕЛО ЗАПРОСА не разжимается
 *     (`inflateRequest: false`) — иначе `bodyLimit` перестаёт быть защитой и 1 МБ
 *     входящего потока превращается в гигабайт распакованного.
 *
 * Маршруты взяты публичные (`/v1/config`, `/health`): тест о канале, а не об
 * авторизации, и втягивать сюда выпуск токена значило бы удвоить число причин, по
 * которым он может покраснеть не из-за сжатия.
 */

const opened: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (opened.length > 0) {
    const app = opened.pop();
    if (app) await app.close();
  }
});

/**
 * Стенд с возможностью заморозить часы.
 *
 * Замораживать МОЖНО ТОЛЬКО ПОСЛЕ входа. Токен выдаётся относительно `ctx.now()`, и
 * застывшая заранее дата сделала бы его просроченным ещё до первого запроса — тот же
 * капкан уже описан в test/http.amplification.test.ts и здесь повторен осознанно.
 */
interface Stand {
  app: Awaited<ReturnType<typeof buildApp>>;
  /** Сдвинуть стрелки на `offsetMs` от текущего момента и заморозить их там. */
  freeze(offsetMs: number): void;
}

async function stand(): Promise<Stand> {
  let frozen: Date | null = null;
  const app = await buildApp(
    createContext(testConfig({ DEV_SIGNER_ENABLED: 'true' }), {
      now: () => frozen ?? new Date()
    })
  );
  opened.push(app);
  return {
    app,
    freeze(offsetMs): void {
      frozen = new Date(Date.now() + offsetMs);
    }
  };
}

describe('http/compression: канал', () => {
  it('/v1/config по gzip приезжает тем же JSON и заметно меньше', async () => {
    const { app } = await stand();

    const plain = await app.inject({ method: 'GET', url: '/v1/config' });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['content-encoding']).toBeUndefined();

    const packed = await app.inject({
      method: 'GET',
      url: '/v1/config',
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(packed.statusCode).toBe(200);
    expect(packed.headers['content-encoding']).toBe('gzip');
    // Регистр имени заголовка в `Vary` не нормируется ни плагином, ни CORS (`Origin,
    // accept-encoding`), поэтому сравниваем без регистра: проверка должна ловить
    // ОТСУТСТВИЕ договорённости, а не смену написания.
    expect(String(packed.headers.vary ?? '').toLowerCase()).toContain('accept-encoding');

    const raw = packed.rawPayload;
    const inflated = gunzipSync(raw);
    expect(inflated.equals(plain.rawPayload)).toBe(true);
    // Существенность: если степень падает ниже, плагин стал балластом, и узнать это
    // надо здесь, а не по графику трафика.
    expect(raw.length).toBeLessThan(plain.rawPayload.length / 2);
    expect(JSON.parse(inflated.toString('utf8'))).toEqual(plain.json());
  });

  it('мелкий ответ не жмётся: заголовки окна zlib дороже выгоды', async () => {
    const { app } = await stand();
    // Взят 404, а не `/health`: `/health` с блоком `stores` из четырёх снимков уже
    // подобрался к порогу, и тест на «ниже порога» начал бы зависеть от того, сколько
    // полей мы в него добавили. Тело отказа — стабильные десятки байт.
    const response = await app.inject({
      method: 'GET',
      url: '/definitely-not-a-route',
      headers: { 'accept-encoding': 'gzip' }
    });
    expect(response.statusCode).toBe(404);
    expect(response.rawPayload.length).toBeLessThan(1024);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.json()).toBeDefined();
  });

  it('клиент без Accept-Encoding получает обычный JSON, а не поток', async () => {
    const { app } = await stand();
    const response = await app.inject({ method: 'GET', url: '/v1/config', headers: { 'accept-encoding': 'identity' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBeUndefined();
    expect(response.json()).toBeDefined();
  });

  it('сжатое тело запроса отвергается, а не разжимается: bodyLimit остаётся границей', async () => {
    const { app } = await stand();
    // Отправляем ИМЕННО сжатые байты. Смысл утверждения: сервер не тратит ни байта CPU
    // на разворачивание чужого потока, и `bodyLimit` 1 МБ остаётся 1 МБ в руке, а не
    // 1 МБ после декомпрессии. Ответ — 415 (неподдерживаемый Content-Encoding), и он
    // приходит до парсера.
    const compressed = gzipSync(Buffer.from(JSON.stringify({ socialId: 'compression-probe' })));
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      payload: compressed
    });
    expect(response.statusCode).toBe(415);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('витрина /v1/economy ужимается в разы — именно ради неё всё и затеяно', async () => {
    const { app, freeze } = await stand();
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/dev-login',
      payload: { socialId: 'compress-economy' }
    });
    expect(login.statusCode).toBe(200);
    const token = (login.json() as { token: string }).token;
    const headers = { authorization: `Bearer ${token}` };
    // Вход отработал на живых часах — теперь можно останавливать. `GET /v1/economy`
    // пишет (тик при каждом запросе), поэтому два вызова на живом времени возвращают
    // РАЗНЫЕ тела, и сравнение «сжатое vs несжатое» сравнивало бы экономику, а не
    // канал. Статичный /v1/config этой ловушки лишён, зато он не узкое место.
    freeze(5 * 60_000);

    const plain = await app.inject({ method: 'GET', url: '/v1/economy', headers });
    expect(plain.statusCode).toBe(200);
    expect(plain.rawPayload.length).toBeGreaterThan(1024);

    const packed = await app.inject({
      method: 'GET',
      url: '/v1/economy',
      headers: { ...headers, 'accept-encoding': 'gzip' }
    });
    expect(packed.headers['content-encoding']).toBe('gzip');
    expect(gunzipSync(packed.rawPayload).equals(plain.rawPayload)).toBe(true);

    // Планка 2x — это ХУДШИЙ случай: голый аккаунт новичка, в котором мало повторов.
    // Замер на «типичном» игроке (120 стен, 24 башни, история привилегий) даёт 8-9x,
    // и именно он платится на каждом опросе. Смысл здесь не реклама степени, а
    // страховка: если на витрину попадёт содержимое, которое gzip не ужимает (base64,
    // уже сжатые данные, токены), отношение придёт сюда и обвалится ниже — узнать это
    // надо в тесте, а не по графику трафика.
    expect(plain.rawPayload.length / packed.rawPayload.length).toBeGreaterThan(2);
  });
});
