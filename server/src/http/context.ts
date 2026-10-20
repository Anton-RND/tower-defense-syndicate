import { randomUUID } from 'node:crypto';

import { loadConfig, type AppConfig } from '../config/env.js';
import { Logger } from '../lib/logger.js';
import { TokenService } from '../modules/auth/token.js';
import { MemoryLedgerStore } from '../modules/ledger/ledger.memory.js';
import { MongoLedgerStore } from '../modules/ledger/ledger.mongo.js';
import type { LedgerStore } from '../modules/ledger/ledger.store.js';
import { MemoryUserStore } from '../modules/user/memory.store.js';
import { MongoUserStore } from '../modules/user/mongo.store.js';
import type { UserStore } from '../modules/user/user.store.js';

/**
 * Сборка зависимостей процесса: конфиг → сторы → журнал → токены → логгер.
 *
 * Всё инжектится, а не читается глобально: тесты подсовывают memory-сторы и
 * детерминированный idFactory, прод — mongo из `.env`. Ничего не решает о транспорте
 * (см. http/app.ts), поэтому домен остаётся независимым от Fastify ровно так же,
 * как он независим от Mongo.
 */

export interface AppContext {
  readonly config: AppConfig;
  readonly users: UserStore;
  readonly ledger: LedgerStore;
  readonly tokens: TokenService;
  readonly logger: Logger;
  /** Идентификаторы записей журнала и доменов. В проде — UUID; в тестах — свой. */
  readonly idFactory: () => string;
  /** Часы процесса. Одна точка, чтобы подменять время в тестах. */
  now(): Date;
  connect(): Promise<void>;
  close(): Promise<void>;
}

interface Stores {
  users: UserStore;
  ledger: LedgerStore;
}

function buildStores(config: AppConfig, logger: Logger): Stores {
  if (config.store.driver === 'mongo') {
    // MONGODB_URI обязателен при этом драйвере — это проверяет loadConfig (env.ts).
    const uri = config.store.mongoUri;
    if (!uri) throw new Error('STORE_DRIVER=mongo требует MONGODB_URI');
    return {
      users: new MongoUserStore(uri, { logger }),
      ledger: new MongoLedgerStore(uri, { logger })
    };
  }
  return { users: new MemoryUserStore(), ledger: new MemoryLedgerStore() };
}

export function createContext(config: AppConfig = loadConfig(), overrides: Partial<AppContext> = {}): AppContext {
  const logger = overrides.logger ?? new Logger(config.logLevel);
  const stores = overrides.users && overrides.ledger
    ? { users: overrides.users, ledger: overrides.ledger }
    : buildStores(config, logger);

  const context: AppContext = {
    config,
    users: stores.users,
    ledger: stores.ledger,
    tokens:
      overrides.tokens ??
      new TokenService({ secret: config.jwt.secret, ttlSec: config.jwt.ttlSec }),
    logger,
    idFactory: overrides.idFactory ?? (() => randomUUID()),
    now: overrides.now ?? (() => new Date()),
    async connect(): Promise<void> {
      // Порядок не важен: коллекции создаёт сам mongoose при первом обращении.
      await Promise.all([stores.users.connect(), stores.ledger.connect()]);
    },
    async close(): Promise<void> {
      await Promise.all([stores.users.disconnect(), stores.ledger.disconnect()]);
    }
  };
  return context;
}
