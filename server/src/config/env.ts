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
  tg: { botToken: string | null };
  economy: EconomyConfig;
  /** POST /v1/dev/vk/sign разрешён только вне production и при явном флаге. */
  devSignerEnabled: boolean;
}

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
  DEV_SIGNER_ENABLED: z.enum(['true', 'false']).default('false')
});

/** Значение по умолчанию для разработки, когда JWT_SECRET не задан. */
export const DEV_JWT_SECRET = 'dev-on…e-me';

export class ConfigError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = 'ConfigError';
  }
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
  if (raw.DEV_SIGNER_ENABLED === 'true') problems.push('DEV_SIGNER_ENABLED запрещён в production');

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
    allowedOrigins: raw.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    vk: {
      appId: raw.VK_APP_ID,
      secretKey: raw.VK_SECRET_KEY,
      initDataSourceTtlSec: raw.VK_INIT_DATA_SOURCE_TTL_SECONDS
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
    devSignerEnabled: raw.DEV_SIGNER_ENABLED === 'true' && raw.NODE_ENV !== 'production'
  };
}

export function isVkConfigured(config: Pick<AppConfig, 'vk'>): boolean {
  return config.vk.appId > 0 && config.vk.secretKey.length > 0;
}
