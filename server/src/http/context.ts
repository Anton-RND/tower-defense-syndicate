import { randomUUID } from 'node:crypto';

import { loadConfig, type AppConfig } from '../config/env.js';
import { Logger } from '../lib/logger.js';
import { createSecurityLayer, type SecurityLayer } from './security.js';
import { TokenService } from '../modules/auth/token.js';
import { MemoryLedgerStore } from '../modules/ledger/ledger.memory.js';
import { MongoLedgerStore } from '../modules/ledger/ledger.mongo.js';
import type { LedgerStore } from '../modules/ledger/ledger.store.js';
import { MemoryUserStore } from '../modules/user/memory.store.js';
import { MongoUserStore } from '../modules/user/mongo.store.js';
import type { UserStore } from '../modules/user/user.store.js';
import { MemoryClanStore } from '../modules/clan/clan.store.js';
import { MongoClanStore } from '../modules/clan/mongo.store.js';
import type { ClanStore } from '../modules/clan/clan.store.js';
import { MemoryLotStore } from '../modules/market/lot.store.js';
import { MongoLotStore } from '../modules/market/mongo.store.js';
import type { LotStore } from '../modules/market/lot.store.js';
import { MemoryCommodityStore } from '../modules/market/commodity.store.js';
import { MongoCommodityStore } from '../modules/market/commodity.mongo.js';
import type { CommodityStore } from '../modules/market/commodity.store.js';
import type { MarketDeps } from '../modules/market/commit.js';
import { createMarketMaintenanceLoop } from '../modules/market/maintenance.js';
import { createNoticeOutbox, type NoticeOutbox } from '../modules/notification/outbox.js';
import type { Loop } from '../lib/scheduler.js';

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
  /**
   * Клановый стор (Часть 2). Отдельный от `users`, потому что операция взноса или
   * основания пишет ДВА документа и общей транзакции у нас нет — порядок шагов и
   * reconcile живут в clan/commit.ts, а не в транспорте.
   */
  readonly clans: ClanStore;
  /** Лоты чёрного рынка (Часть 2). Третья учётная сущность: не игрок и не клан. */
  readonly lots: LotStore;
  /**
   * Снапшоты товаров рынка (P5): четвёртая учётная сущность, шесть документов,
   * живущих по закону «двигается только на чтении витрины».
   */
  readonly commodities: CommodityStore;
  readonly ledger: LedgerStore;
  /**
   * Зависимости протоколов рынка (Часть 2). Объект ОДИН на HTTP-маршруты и на фоновый
   * цикл: у него есть `onSold`, и два разных набора означали бы, что право объявить
   * продажу зависит от того, кто доделал лот — игрок своим запросом витрины или воркер.
   */
  readonly marketDeps: MarketDeps;
  /**
   * Очередь VK Push (Часть 2, backlog 3). Живёт в контексте, потому что переживает
   * любой отдельный запрос: пуш о продаже уходит игроку, которого в этот момент
   * в игре нет.
   */
  readonly notices: NoticeOutbox;
  /**
   * Фоновый цикл обслуживания рынка (Часть 2, backlog 4). Создан, но НЕ запущен:
   * `startWorkers()` вызывает только `index.ts`, тесты же получают контекст без
   * таймеров — иначе каждый прогон vitest ловил бы гонку цикла с собственными
   * ассертами.
   */
  readonly marketWorker: Loop;
  readonly tokens: TokenService;
  readonly logger: Logger;
  /**
   * Слой безопасности транспорта: бакеты по адресу клиента, защитные головы,
   * идентификатор запроса.
   *
   * Живёт в контексте, а не собирается внутри `buildApp`, по той же причине, по
   * какой там живут сторы: состояние обязано переживать отдельный запрос и быть
   * ОДНИМ на все маршруты. Два бакета на один адрес — это два разных лимита, и
   * «сколько запросов пропускает игра» перестаёт быть свойством конфигурации.
   */
  readonly security: SecurityLayer;
  /** Идентификаторы записей журнала и доменов. В проде — UUID; в тестах — свой. */
  readonly idFactory: () => string;
  /** Часы процесса. Одна точка, чтобы подменять время в тестах. */
  now(): Date;
  /**
   * Запуск фоновых циклов (обслуживание рынка, очередь пушей). Делает только
   * `index.ts` — после `connect()` и `listen()`. Тесты не вызывают: им нужны
   * детерминированные проходы через `marketWorker.tick()` и `notices.drain()`.
   */
  startWorkers(): void;
  connect(): Promise<void>;
  close(): Promise<void>;
}

interface Stores {
  users: UserStore;
  clans: ClanStore;
  lots: LotStore;
  commodities: CommodityStore;
  ledger: LedgerStore;
}

function buildStores(config: AppConfig, logger: Logger): Stores {
  if (config.store.driver === 'mongo') {
    // MONGODB_URI обязателен при этом драйвере — это проверяет loadConfig (env.ts).
    const uri = config.store.mongoUri;
    if (!uri) throw new Error('STORE_DRIVER=mongo требует MONGODB_URI');
    return {
      users: new MongoUserStore(uri, { logger }),
      clans: new MongoClanStore(uri, { logger }),
      lots: new MongoLotStore(uri, { logger }),
      commodities: new MongoCommodityStore(uri, { logger }),
      ledger: new MongoLedgerStore(uri, { logger })
    };
  }
  return {
    users: new MemoryUserStore(),
    clans: new MemoryClanStore(),
    lots: new MemoryLotStore(),
    commodities: new MemoryCommodityStore(),
    ledger: new MemoryLedgerStore()
  };
}

export function createContext(config: AppConfig = loadConfig(), overrides: Partial<AppContext> = {}): AppContext {
  const logger = overrides.logger ?? new Logger(config.logLevel);
  const stores =
    overrides.users && overrides.ledger && overrides.clans && overrides.lots && overrides.commodities
      ? {
          users: overrides.users,
          clans: overrides.clans,
          lots: overrides.lots,
          commodities: overrides.commodities,
          ledger: overrides.ledger
        }
      : buildStores(config, logger);

  const idFactory = overrides.idFactory ?? (() => randomUUID());
  const now = overrides.now ?? (() => new Date());

  const notices: NoticeOutbox = createNoticeOutbox({
    push: {
      appId: config.vk.appId,
      secretKey: config.vk.secretKey,
      endpoint: config.notifications.push.endpoint,
      apiVersion: config.notifications.push.apiVersion,
      timeoutMs: config.notifications.push.timeoutMs
    },
    policy: {
      enabled: config.notifications.push.enabled,
      capacity: config.notifications.queueCapacity,
      attempts: config.notifications.retryAttempts,
      drainIntervalMs: config.notifications.drainIntervalMs
    },
    logger
  });

  // Единая сборка зависимостей рынка: протоколы (маршруты) и фоновый цикл видят один
  // и тот же объект, включая `onSold`. Разделить их — значит получить два разных
  // правила на объявление продажи.
  const marketDeps: MarketDeps = {
    users: stores.users,
    lots: stores.lots,
    commodities: stores.commodities,
    ledger: stores.ledger,
    idFactory,
    onError: (error, context) =>
      logger.error('market_commit_cleanup_failed', { error: error.message, ...context }),
    onSold: (event) => {
      notices.enqueue(event);
    }
  };

  const marketWorker = createMarketMaintenanceLoop(marketDeps, logger, {
    intervalMs: config.market.worker.intervalMs,
    now
  });

  const context: AppContext = {
    config,
    users: stores.users,
    clans: stores.clans,
    lots: stores.lots,
    commodities: stores.commodities,
    ledger: stores.ledger,
    marketDeps,
    notices,
    marketWorker,
    tokens:
      overrides.tokens ??
      new TokenService({ secret: config.jwt.secret, ttlSec: config.jwt.ttlSec }),
    security: overrides.security ?? createSecurityLayer(config),
    logger,
    idFactory,
    now,
    startWorkers(): void {
      // Порядок не важен, но смысл один: циклы стартуют после `connect()`, иначе
      // первый тик может прийти в ещё не поднятый стор.
      if (config.market.worker.enabled) marketWorker.start();
      notices.start();
      logger.info('workers_started', {
        market_worker: config.market.worker.enabled,
        market_interval_ms: config.market.worker.intervalMs,
        push: notices.readiness()
      });
    },
    async connect(): Promise<void> {
      // Порядок не важен: коллекции создаёт сам mongoose при первом обращении.
      await Promise.all([
        stores.users.connect(),
        stores.clans.connect(),
        stores.lots.connect(),
        stores.commodities.connect(),
        stores.ledger.connect()
      ]);
    },
    async close(): Promise<void> {
      // Сначала циклы, потом соединения: остановка дожидается идущего прохода, и
      // рвать его посередине закрытого Mongo — значит оставить рынок с половиной
      // протокола. Очередь пушей при этом честно теряет недоставанное с записью
      // `notice_lost_on_stop`.
      await Promise.all([marketWorker.stop(), notices.stop()]);
      await Promise.all([
        stores.users.disconnect(),
        stores.clans.disconnect(),
        stores.lots.disconnect(),
        stores.commodities.disconnect(),
        stores.ledger.disconnect()
      ]);
    }
  };
  return context;
}
