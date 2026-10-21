import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import { z } from 'zod';

import { buildLimits, type LimitsConfig } from './limits.js';

/**
 * Загрузка .env из корня монорепо (c:\local\TD\.env) и серверного .env.
 * Корень поднимаемся на два уровня вверх от src/config.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of [
  path.resolve(here, '../../../.env'),
  path.resolve(here, '../../.env'),
  path.resolve(process.cwd(), '.env')
]) {
  dotenv.config({ path: candidate, quiet: true });
}

export type Platform = 'vk' | 'tg';
export type StoreDriver = 'memory' | 'mongo';
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** Ресурсы, которые добываются экстракторами и лежат на складе до ручного сбора (п.2.1). */
export const MINING_RESOURCES = ['ferrum', 'silicium', 'uranium', 'plasma'] as const;
export type MiningResource = (typeof MINING_RESOURCES)[number];

export interface VkConfig {
  /** App ID мини-приложения/игры. 0 — не задан (авторизация вернёт 500 VK_NOT_CONFIGURED). */
  appId: number;
  /** Secret Key приложения («Защищённый режим» в настройках). */
  secretKey: string;
  /** Сколько секунд живут параметры запуска/инициализации (защита от replay). */
  initDataSourceTtlSec: number;
}

export interface NotificationsConfig {
  push: {
    enabled: boolean;
    endpoint: string;
    apiVersion: string;
    timeoutMs: number;
  };
  /** Потолок очереди: рынок может породить фактов быстрее, чем ВК их пропустит. */
  queueCapacity: number;
  /** Повторы при временном отказе площадки (429/5xx/таймаут), сверх первого похода. */
  retryAttempts: number;
  /** Пауза между проходами очереди уведомлений. */
  drainIntervalMs: number;
}

export interface MarketRuntimeConfig {
  worker: {
    enabled: boolean;
    /** Пауза между проходами обслуживания рынка: разбор зависших лотов + пересчёт коридоров. */
    intervalMs: number;
  };
}

export interface EconomyConfig {
  /** Кап энергии (п.2.3). */
  energyCap: number;
  /** Пассивный реген энергии, ед./час (базовый; бусты применяются в entitlements). */
  energyRegenPerHour: number;
  /** Суточные лимиты ассистов, рекламы и покупок (антифрод + монетизация). */
  limits: LimitsConfig;
  /** Вместимость склада, ед. — на каждый ресурс отдельно (п.2.2). */
  storageCapacity: number;
  /** Стартовые ставки добычи, ед./час (п.2.2). */
  miningRates: Record<MiningResource, number>;
  /** Максимум времени, за которое начисляется офлайн-майнинг. */
  maxOfflineHours: number;
  /** Доля несобранных ресурсов, доступная грабителям (п.4.1). */
  lootShare: number;
  /** Роботов-строителей по умолчанию (п.3.1). */
  buildRobotsDefault: number;
}

export interface AppConfig {
  env: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: LogLevel;
  store: { driver: StoreDriver; mongoUri: string | null };
  jwt: { secret: string; ttlSec: number };
  allowedOrigins: string[];
  vk: VkConfig;
  notifications: NotificationsConfig;
  market: MarketRuntimeConfig;
  tg: { botToken: string | null };
  economy: EconomyConfig;
  /** POST /v1/dev/vk/sign разрешён только вне production и при явном флаге. */
  devSignerEnabled: boolean;
  /** true — подписанный postback рекламы настроен; см. requireProductionRules. */
  adsPostbackReady: boolean;
  security: SecurityConfig;
  /** Сколько секунд процессу на дозавершение запросов при SIGTERM/SIGINT. */
  shutdownTimeoutMs: number;
  /**
   * Приём подписанных событий площадки (платежи). `serviceId` — id сущности-источника
   * в схеме HMAC; 0 в окружении означает «брать VK_APP_ID» (см. provider.vk.ts).
   */
  vkEvents: { serviceId: number; maxAgeSec: number };
}

/** Бюджет необработанных запросов на один адрес. 0 — соответствующий лимитер выключен. */
export interface RateLimitConfig {
  /** `/v1/auth/*` — перебор initData и подбор socialId. */
  authPerMin: number;
  /** `/callbacks/*` — площадка приходит пачками, но не бесконечно. */
  eventPerMin: number;
  /** Потолок одновременных адресов: без него карта лимитера сама становится DoS. */
  maxKeys: number;
  /** Ведро без обращений дольше этого срока выбрасывается при sweep. */
  idleTtlMs: number;
}

export interface SecurityConfig {
  /** Читать `X-Forwarded-For` — только когда сверху действительно наш прокси. */
  trustForwardedFor: boolean;
  rateLimit: RateLimitConfig;
  /**
   * Кому разрешено встраивать игру в iframe.
   *
   * ВК грузит приложение именно так, поэтому список обязан включать vk.com/vk.ru:
   * шаблонный `X-Frame-Options: DENY` или `frame-ancestors 'none'` не смягчает
   * защиту, а выключает игру целиком — приложение перестанет открываться.
   * `X-Frame-Options` поэтому не отправляется вовсе: он не понимает списков
   * источников, и один провайдер с нестандартным поддоменом убил бы вход.
   */
  frameAncestors: string[];
}

/** Чем игрок входит в игру на текущем конфиге. */
export type AuthMode =
  /** Боевой путь: VK_APP_ID + VK_SECRET_KEY заданы, подпись initData проверяется. */
  | 'vk'
  /** Стенд: вход по голому socialId, только вне production. */
  | 'dev'
  /** Ни того, ни другого: витрина обязана сказать причину, а не молча ловить 403. */
  | 'disabled';

const logLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  STORE_DRIVER: z.enum(['memory', 'mongo']).default('memory'),
  MONGODB_URI: z.string().optional(),
  JWT_SECRET: z.string().optional(),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(7 * 24 * 3600),
  ALLOWED_ORIGINS: z.string().default('*'),
  VK_APP_ID: z.coerce.number().int().nonnegative().default(0),
  VK_SECRET_KEY: z.string().default(''),
  VK_INIT_DATA_SOURCE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  /**
   * VK Push (Часть 2, backlog 3). Выключен по умолчанию осознанно: `secure.sendNotification`
   * требует права на метод у приложения, и на неподготовленном ключе каждый пуш вернёт 6.13.2.
   * Молча включающий продажи уведомлений конфиг был бы хуже, чем явный флаг.
   */
  VK_PUSH_ENABLED: z.enum(['true', 'false']).default('false'),
  VK_PUSH_ENDPOINT: z.string().url().default('https://api.vk.com/method/secure.sendNotification'),
  VK_PUSH_API_VERSION: z.string().min(1).default('5.199'),
  VK_PUSH_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),
  /** Очередь уведомлений: потолок накопления и число повторов при временном отказе ВК. */
  NOTICE_QUEUE_CAPACITY: z.coerce.number().int().positive().max(10_000).default(500),
  NOTICE_RETRY_ATTEMPTS: z.coerce.number().int().nonnegative().max(5).default(2),
  NOTICE_DRAIN_INTERVAL_MS: z.coerce.number().int().positive().max(60_000).default(5000),
  /** Фоновое обслуживание рынка (Часть 2, backlog 4). */
  MARKET_WORKER_ENABLED: z.enum(['true', 'false']).default('true'),
  MARKET_WORKER_INTERVAL_MS: z.coerce.number().int().positive().max(3_600_000).default(60_000),
  TG_BOT_TOKEN: z.string().default(''),
  ENERGY_CAP: z.coerce.number().int().positive().default(100),
  ENERGY_REGEN_PER_HOUR: z.coerce.number().nonnegative().default(5),
  ENERGY_ASSIST_PERCENT: z.coerce.number().int().min(1).max(100).default(25),
  ENERGY_ASSIST_DAILY_LIMIT: z.coerce.number().int().nonnegative().default(4),
  ADS_ENABLED: z.enum(['true', 'false']).default('false'),
  ADS_DAILY_REWARDS: z.coerce.number().int().nonnegative().default(6),
  ADS_MIN_INTERVAL_SEC: z.coerce.number().int().nonnegative().default(120),
  ADS_SESSION_TTL_SEC: z.coerce.number().int().positive().default(180),
  PURCHASE_DAILY_PER_SKU: z.coerce.number().int().nonnegative().default(0),
  MAX_ACTIVE_ENTITLEMENTS: z.coerce.number().int().nonnegative().default(50),
  REFUND_WINDOW_DAYS: z.coerce.number().int().positive().default(14),
  PAYMENTS_ENABLED: z.enum(['true', 'false']).default('false'),
  PAYMENT_ORDER_TTL_SEC: z.coerce.number().int().positive().default(900),
  PAYMENT_HISTORY: z.coerce.number().int().positive().default(20),
  CLAN_DAILY_DEPOSITS: z.coerce.number().int().nonnegative().default(20),
  CLAN_DAILY_UNITS: z.coerce.number().int().nonnegative().default(100_000),
  CLAN_PENDING_TTL_SEC: z.coerce.number().int().positive().default(600),
  STORAGE_CAPACITY: z.coerce.number().int().positive().default(1000),
  MINING_RATE_FERRUM: z.coerce.number().nonnegative().default(50),
  MINING_RATE_SILICIUM: z.coerce.number().nonnegative().default(30),
  MINING_RATE_URANIUM: z.coerce.number().nonnegative().default(8),
  MINING_RATE_PLASMA: z.coerce.number().nonnegative().default(2),
  MAX_OFFLINE_HOURS: z.coerce.number().positive().default(72),
  LOOT_SHARE: z.coerce.number().min(0).max(1).default(0.3),
  BUILD_ROBOTS_DEFAULT: z.coerce.number().int().positive().default(2),
  LOOT_DAILY_EVENTS: z.coerce.number().int().nonnegative().default(50),
  JUNK_CAP: z.coerce.number().int().nonnegative().default(20000),
  PVP_DAILY_ATTACKS: z.coerce.number().int().nonnegative().default(30),
  REFERRAL_DAILY_MAX: z.coerce.number().int().nonnegative().default(20),

  // ─── Продакшн-обвязка (P10) ────────────────────────────────────────────────
  /**
   * Доверять `X-Forwarded-For` при определении адреса клиента.
   *
   * По умолчанию нет: заголовок пишет кто угодно, и включённый без прокси флаг
   * превращает лимитер в самообман (атакующий сам выбирает себе ведро). Включать
   * только тогда, когда сверху стоит наш reverse proxy, который этот заголовок
   * перезаписывает, а не добавляет к нему.
   */
  TRUST_FORWARDED_FOR: z.enum(['true', 'false']).default('false'),
  /** Запросов в минуту на адрес к маршрутам входа. 0 — лимитер выключен. */
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(0).max(1_000).default(10),
  /** Запросов в минуту на адрес к маршрутам площадки. 0 — лимитер выключен. */
  RATE_LIMIT_EVENT_PER_MIN: z.coerce.number().int().min(0).max(10_000).default(120),
  /** Сколько адресов одновременно держат лимитеры: больше — только вытеснением. */
  RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(1_000).max(1_000_000).default(50_000),
  /** Ведро без обращений дольше этого срока выбрасывается: карта не раздувается. */
  RATE_LIMIT_IDLE_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  /** Потолок ожидания дозавершения запросов при SIGTERM, сверх него — exit 1. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().max(120_000).default(15_000),
  /** id сущности-источника в подписи событий площадки; 0 — брать VK_APP_ID. */
  VK_EVENT_SERVICE_ID: z.coerce.number().int().nonnegative().default(0),
  /** Как долго подписанное событие площадки ещё принимают (replay-окно). */
  VK_EVENT_MAX_AGE_SECONDS: z.coerce.number().int().positive().max(86_400).default(3_600),
  /**
   * Подтверждение оператора, что подписанный postback рекламы настроен.
   *
   * Отдельный флаг, а не следствие ADS_ENABLED, намеренно: рекламный канал в этом
   * монорепо пока не имеет обработчика подписанного подтверждения (в отличие от
   * платёжного), и включённая реклама в проде дарила бы игрокам мёртвую кнопку.
   */
  ADS_POSTBACK_READY: z.enum(['true', 'false']).default('false'),

  DEV_SIGNER_ENABLED: z.enum(['true', 'false']).default('false')
});

/** Значение по умолчанию для разработки, когда JWT_SECRET не задан. */
export const DEV_JWT_SECRET = 'dev-only-change-me';

export class ConfigError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * Разбор ALLOWED_ORIGINS в список.
 *
 * Одна функция на прод-проверку и на сборку конфига намеренно: две похожие
 * реализации разъезжаются молча, и тогда проверка пропускает то, что runtime
 * потом применит.
 */
export function parseOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function requireProductionRules(raw: z.infer<typeof envSchema>, source: NodeJS.ProcessEnv): void {
  if (raw.NODE_ENV !== 'production') return;

  const problems: string[] = [];
  if (!source.JWT_SECRET) problems.push('JWT_SECRET обязателен в production');
  else if (source.JWT_SECRET.length < 32) problems.push('JWT_SECRET должен быть не короче 32 символов');
  if (raw.STORE_DRIVER === 'mongo' && !raw.MONGODB_URI) problems.push('MONGODB_URI обязателен при STORE_DRIVER=mongo');
  if (raw.VK_APP_ID <= 0) problems.push('VK_APP_ID обязателен в production');
  if (!raw.VK_SECRET_KEY) problems.push('VK_SECRET_KEY обязателен в production');
  // Подтверждение платежа проверяется HMAC по этому же секрету: включить продажи без
  // секрета — значит принимать деньги, которые невозможно верифицировать.
  if (raw.PAYMENTS_ENABLED === 'true' && !raw.VK_SECRET_KEY) {
    problems.push('PAYMENTS_ENABLED=true требует VK_SECRET_KEY');
  }
  // Пуш без ключей — это не «тихо не работает», а гарантированные 6.13.2/113 на каждой
  // продаже и пустой лог вместо объяснения, почему игрок не узнал о деньгах.
  if (raw.VK_PUSH_ENABLED === 'true') {
    if (raw.VK_APP_ID <= 0) problems.push('VK_PUSH_ENABLED=true требует VK_APP_ID');
    if (!raw.VK_SECRET_KEY) problems.push('VK_PUSH_ENABLED=true требует VK_SECRET_KEY');
  }
  if (raw.DEV_SIGNER_ENABLED === 'true') problems.push('DEV_SIGNER_ENABLED запрещён в production');

  // Хранилище в RAM: процесс падает раз в день на деплое, и вместе с ним исчезают
  // кошельки, склады и заказы всех игроков. Это не «деградация», а потеря данных,
  // поэтому memory в production — отказ старта, а не предупреждение в лог.
  if (raw.STORE_DRIVER !== 'mongo') {
    problems.push('STORE_DRIVER=mongo обязателен в production (memory теряет состояние при рестарте)');
  }
  // Распахнутый CORS в проде: WebView всегда приходит с известного источника, и
  // `*` не добавляет ни одной легитимной возможности — только любой площадке,
  // способной исполнить наш запрос от имени украденного токена.
  const origins = parseOrigins(raw.ALLOWED_ORIGINS);
  if (origins.length === 0) {
    problems.push('ALLOWED_ORIGINS пуст: ни один источник не сможет вызвать API');
  }
  if (origins.includes('*')) {
    problems.push('ALLOWED_ORIGINS=* запрещён в production — перечислите источники WebView явно');
  }
  // Dev-константа длиной 18 символов уже отсекается проверкой длины выше, но
  // явное сравнение держит смысл в одном месте: «секрет не подменён примером».
  if (source.JWT_SECRET === DEV_JWT_SECRET) {
    problems.push('JWT_SECRET совпадает с dev-константой DEV_JWT_SECRET');
  }
  // Реклама без подтверждённого postback: награду выдавать некому, кнопка мёртва.
  if (raw.ADS_ENABLED === 'true' && raw.ADS_POSTBACK_READY !== 'true') {
    problems.push('ADS_ENABLED=true требует ADS_POSTBACK_READY=true (подписанного postback в этом монорепо пока нет)');
  }

  if (problems.length > 0) {
    throw new ConfigError(`Некорректная конфигурация production:\n - ${problems.join('\n - ')}`, problems);
  }
}

/**
 * Собирает типизированный конфиг из окружения.
 * @param source окружение (по умолчанию process.env) — инжектится ради тестируемости.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
    throw new ConfigError(`Ошибка валидации переменных окружения:\n - ${issues.join('\n - ')}`, issues);
  }
  const raw = parsed.data;
  requireProductionRules(raw, source);
  const origins = parseOrigins(raw.ALLOWED_ORIGINS);

  const miningRates: Record<MiningResource, number> = {
    ferrum: raw.MINING_RATE_FERRUM,
    silicium: raw.MINING_RATE_SILICIUM,
    uranium: raw.MINING_RATE_URANIUM,
    plasma: raw.MINING_RATE_PLASMA
  };

  return {
    env: raw.NODE_ENV,
    host: raw.HOST,
    port: raw.PORT,
    logLevel: raw.LOG_LEVEL,
    store: {
      driver: raw.STORE_DRIVER,
      mongoUri: raw.MONGODB_URI && raw.MONGODB_URI.length > 0 ? raw.MONGODB_URI : null
    },
    jwt: {
      secret: raw.JWT_SECRET ?? DEV_JWT_SECRET,
      ttlSec: raw.JWT_TTL_SECONDS
    },
    allowedOrigins: origins,
    vk: {
      appId: raw.VK_APP_ID,
      secretKey: raw.VK_SECRET_KEY,
      initDataSourceTtlSec: raw.VK_INIT_DATA_SOURCE_TTL_SECONDS
    },
    notifications: {
      push: {
        enabled: raw.VK_PUSH_ENABLED === 'true',
        endpoint: raw.VK_PUSH_ENDPOINT,
        apiVersion: raw.VK_PUSH_API_VERSION,
        timeoutMs: raw.VK_PUSH_TIMEOUT_MS
      },
      queueCapacity: raw.NOTICE_QUEUE_CAPACITY,
      retryAttempts: raw.NOTICE_RETRY_ATTEMPTS,
      drainIntervalMs: raw.NOTICE_DRAIN_INTERVAL_MS
    },
    market: {
      worker: {
        enabled: raw.MARKET_WORKER_ENABLED === 'true',
        intervalMs: raw.MARKET_WORKER_INTERVAL_MS
      }
    },
    tg: { botToken: raw.TG_BOT_TOKEN.length > 0 ? raw.TG_BOT_TOKEN : null },
    economy: {
      energyCap: raw.ENERGY_CAP,
      energyRegenPerHour: raw.ENERGY_REGEN_PER_HOUR,
      limits: buildLimits({
        assistDailyLimit: raw.ENERGY_ASSIST_DAILY_LIMIT,
        assistPercent: raw.ENERGY_ASSIST_PERCENT,
        adsEnabled: raw.ADS_ENABLED === 'true',
        adsDailyRewards: raw.ADS_DAILY_REWARDS,
        adsMinIntervalSec: raw.ADS_MIN_INTERVAL_SEC,
        adsSessionTtlSec: raw.ADS_SESSION_TTL_SEC,
        purchaseDailyPerSku: raw.PURCHASE_DAILY_PER_SKU,
        maxActiveEntitlements: raw.MAX_ACTIVE_ENTITLEMENTS,
        refundWindowDays: raw.REFUND_WINDOW_DAYS,
        paymentsEnabled: raw.PAYMENTS_ENABLED === 'true',
        orderTtlSec: raw.PAYMENT_ORDER_TTL_SEC,
        purchaseHistory: raw.PAYMENT_HISTORY,
        clanDailyDeposits: raw.CLAN_DAILY_DEPOSITS,
        clanDailyUnits: raw.CLAN_DAILY_UNITS,
        clanPendingTtlSec: raw.CLAN_PENDING_TTL_SEC,
        lootDailyEvents: raw.LOOT_DAILY_EVENTS,
        junkCap: raw.JUNK_CAP,
        pvpDailyAttacks: raw.PVP_DAILY_ATTACKS,
        referralDailyMax: raw.REFERRAL_DAILY_MAX
      }),
      storageCapacity: raw.STORAGE_CAPACITY,
      miningRates,
      maxOfflineHours: raw.MAX_OFFLINE_HOURS,
      lootShare: raw.LOOT_SHARE,
      buildRobotsDefault: raw.BUILD_ROBOTS_DEFAULT
    },
    devSignerEnabled: raw.DEV_SIGNER_ENABLED === 'true' && raw.NODE_ENV !== 'production',
    adsPostbackReady: raw.ADS_POSTBACK_READY === 'true',
    security: {
      trustForwardedFor: raw.TRUST_FORWARDED_FOR === 'true',
      rateLimit: {
        authPerMin: raw.RATE_LIMIT_AUTH_PER_MIN,
        eventPerMin: raw.RATE_LIMIT_EVENT_PER_MIN,
        maxKeys: raw.RATE_LIMIT_MAX_KEYS,
        idleTtlMs: raw.RATE_LIMIT_IDLE_MS
      },
      // Тот же список, что и на вызовы API: кто имеет право дёргать /v1/*, тот и
      // встраивает игру. Разводить их — значит получить пару, разъезжающуюся молча.
      frameAncestors: origins.filter((origin) => origin !== '*')
    },
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
    vkEvents: {
      serviceId: raw.VK_EVENT_SERVICE_ID > 0 ? raw.VK_EVENT_SERVICE_ID : raw.VK_APP_ID,
      maxAgeSec: raw.VK_EVENT_MAX_AGE_SECONDS
    }
  };
}

export function isVkConfigured(config: Pick<AppConfig, 'vk'>): boolean {
  return config.vk.appId > 0 && config.vk.secretKey.length > 0;
}

/**
 * Чем на этом конфиге входит игрок — один источник правды для `/health`,
 * `/v1/config` и витрины.
 *
 * Причина завести это здесь, а не вычислять в двух местах по-своему: `GET /health`
 * считал «ВК подключён» как `appId > 0`, а авторизация требует ещё и секрет
 * (`isVkConfigured`). Половина координат в окружении — и витрина отправляет игрока
 * на маршрут, отвечающий 500 VK_NOT_CONFIGURED. Разнобой был задокументирован в
 * `.env.example` как известная боль вместо того, чтобы быть невозможным.
 */
export function authModeOf(config: Pick<AppConfig, 'vk' | 'devSignerEnabled'>): AuthMode {
  if (isVkConfigured(config)) return 'vk';
  // Стенд живёт без координат ВК: у него есть свой вход, и он же — единственная
  // причина, по которой 'disabled' не наступает при appId = 0.
  return config.devSignerEnabled ? 'dev' : 'disabled';
}
