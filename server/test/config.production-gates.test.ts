import { describe, expect, it } from 'vitest';

import { ConfigError, DEV_JWT_SECRET, authModeOf, loadConfig, parseOrigins, type AppConfig } from '../src/config/env.js';
import { publicConfig } from '../src/modules/economy/view.js';

/**
 * config/production-gates: production должен быть невозможным испортить молча.
 *
 * Повод не гипотетический. `NODE_ENV` по умолчанию `development`, и деплой без
 * явного флага раньше приносил в прод сразу четыре вещи, каждая из которых
 * выглядит нормальной до первого инцидента: dev-секрет JWT, стор в RAM,
 * распашонку CORS `*` и включённые отладочные маршруты печати ресурсов. Процесс
 * при этом стартовал зелёным, `/health` отвечал `ok: true`, а обнаруживалось это
 * либо по исчезнувшим кошелькам, либо по чужому сайту в логах.
 *
 * Отсюда правило отбора: здесь проверяются только те конфигурации, которые
 * **теряют данные или деньги**. Про них сказано жёстко — отказ старта, а не
 * предупреждение в лог, потому что предупреждение в асинхронном логе контейнера
 * не читает никто, кто не ищет уже сгоревший продакшн.
 *
 * И зеркальная обязанность: гейты не имеют права мешать разработке. Последний
 * набор проверяет ровно это — тот же конфиг вне production обязан собираться.
 */

/** Эталонный production: всё, что требуют прод-правила, и ничего лишнего. */
const PROD: Record<string, string> = {
  NODE_ENV: 'production',
  JWT_SECRET: 'x'.repeat(48),
  STORE_DRIVER: 'mongo',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/tds',
  VK_APP_ID: '54836331',
  VK_SECRET_KEY: 'app-secret',
  ALLOWED_ORIGINS: 'https://vk.com,https://vk.ru'
};

function prod(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({ ...PROD, ...overrides } as NodeJS.ProcessEnv);
}

/** Список претензий прод-валидации; пусто — конфиг принят. */
function problems(overrides: Record<string, string> = {}): string[] {
  try {
    prod(overrides);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues;
    throw error;
  }
  return [];
}

const hasProblem = (issues: string[], pattern: RegExp): boolean =>
  issues.some((issue) => pattern.test(issue));

describe('config/production-gates: отказ старта там, где теряются данные и деньги', () => {
  it('эталонный production собирается', () => {
    const config = prod();
    expect(config.env).toBe('production');
    expect(config.store.driver).toBe('mongo');
    expect(authModeOf(config)).toBe('vk');
  });

  it('стор в RAM в production не стартует: рестарт деплоя стёр бы всех игроков', () => {
    expect(hasProblem(problems({ STORE_DRIVER: 'memory' }), /STORE_DRIVER=mongo/)).toBe(true);
  });

  it('wildcard CORS в production не стартует, в том числе спрятанный за пробелом в списке', () => {
    expect(hasProblem(problems({ ALLOWED_ORIGINS: '*' }), /ALLOWED_ORIGINS=\*/)).toBe(true);
    // `https://vk.com, *` — ровно та форма, которую `split(',')` без trim увидел бы
    // как безопасный список источников, а CORS-плагин применил бы как `*`.
    expect(hasProblem(problems({ ALLOWED_ORIGINS: 'https://vk.com, *' }), /ALLOWED_ORIGINS=\*/)).toBe(true);
  });

  it('пустой список источников в production не стартует: WebView не сможет вызвать API', () => {
    expect(hasProblem(problems({ ALLOWED_ORIGINS: '' }), /ALLOWED_ORIGINS пуст/)).toBe(true);
  });

  it('dev-константа в качестве JWT_SECRET в production не стартует', () => {
    // Секрет опубликован в репозитории, то есть известен любому читателю кода:
    // подпись сессий таким ключом — отсутствие подписи при зелёном старте.
    expect(hasProblem(problems({ JWT_SECRET: DEV_JWT_SECRET }), /DEV_JWT_SECRET/)).toBe(true);
  });

  it('реклама без подтверждённого postback в production не стартует', () => {
    expect(hasProblem(problems({ ADS_ENABLED: 'true' }), /ADS_POSTBACK_READY/)).toBe(true);
    expect(hasProblem(problems({ ADS_ENABLED: 'true', ADS_POSTBACK_READY: 'true' }), /ADS_POSTBACK_READY/)).toBe(false);
  });

  it('отладочные маршруты в production по-прежнему запрещены', () => {
    expect(hasProblem(problems({ DEV_SIGNER_ENABLED: 'true' }), /DEV_SIGNER_ENABLED/)).toBe(true);
  });

  it('гейты действуют только в production: разработка принимает тот же конфиг', () => {
    // Проверка на собственный овершут. Запретить memory-стор и `*` везде — значит
    // сломать стенд, на котором эти самые прод-правила и проверяются.
    expect(() =>
      loadConfig({
        NODE_ENV: 'development',
        STORE_DRIVER: 'memory',
        ALLOWED_ORIGINS: '*',
        ADS_ENABLED: 'true',
        DEV_SIGNER_ENABLED: 'true'
      } as NodeJS.ProcessEnv)
    ).not.toThrow();
  });
});

describe('config/auth-mode: один ответ на вопрос «чем входит игрок»', () => {
  it('полные координаты — vk', () => {
    expect(authModeOf(prod())).toBe('vk');
  });

  it('один App ID без секрета — не vk-режим: ровно та полузаполненная ловушка', () => {
    // Исторический симптом: `/health` считал флаг как `appId > 0`, витрина верила,
    // что контейнер подключён, и вела игрока на маршрут, отвечающий 500.
    const half = loadConfig({ NODE_ENV: 'test', VK_APP_ID: '54836331', VK_SECRET_KEY: '' } as NodeJS.ProcessEnv);
    expect(authModeOf(half)).toBe('disabled');
    expect(publicConfig(half).platform).toMatchObject({ vk: false });
  });

  it('без координат, но со стендом — dev', () => {
    const stand = loadConfig({ NODE_ENV: 'development', DEV_SIGNER_ENABLED: 'true' } as NodeJS.ProcessEnv);
    expect(authModeOf(stand)).toBe('dev');
  });

  it('ни координат, ни стенда — disabled', () => {
    const bare = loadConfig({ NODE_ENV: 'development' } as NodeJS.ProcessEnv);
    expect(authModeOf(bare)).toBe('disabled');
  });

  it('`/v1/config` отдаёт тот же режим, что считает авторизация', () => {
    expect(publicConfig(prod()).auth).toEqual({ mode: 'vk' });
  });
});

describe('config/parseOrigins: разбор списка источников — одна функция на все применения', () => {
  it('режет по запятым, срезает пробелы и выбрасывает пустоты', () => {
    expect(parseOrigins(' https://vk.com , https://vk.ru ,, ')).toEqual(['https://vk.com', 'https://vk.ru']);
    expect(parseOrigins('')).toEqual([]);
  });

  it('wildcard виден в списке как отдельный источник, а не как подстрока', () => {
    expect(parseOrigins('*')).toContain('*');
    expect(parseOrigins('https://vk.com')).not.toContain('*');
  });
});
