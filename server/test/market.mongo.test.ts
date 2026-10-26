import { createConnection, type Connection } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config/env.js';
import { MARKET_CORRIDORS, MARKET_LOT_TTL_MS, MARKET_PRICE_DYNAMICS, hardBoundsOf } from '../src/config/market.js';
import { JUNK_IDS, type JunkId } from '../src/config/workshop.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MongoClanStore } from '../src/modules/clan/mongo.store.js';
import { DuplicateClanNameError } from '../src/modules/clan/clan.store.js';
import { buildClanShell } from '../src/modules/clan/service.js';
import { MongoLedgerStore } from '../src/modules/ledger/ledger.mongo.js';
import { makeIdempotencyKey } from '../src/modules/ledger/ledger.types.js';
import { MongoCommodityStore } from '../src/modules/market/commodity.mongo.js';
import { neutralCommodity, type CommodityState } from '../src/modules/market/commodity.types.js';
import { MongoLotStore } from '../src/modules/market/mongo.store.js';
import { activateLot, buildLot, claimLot } from '../src/modules/market/service.js';
import { buyLot, listLot, reconcileMarket, type MarketDeps } from '../src/modules/market/commit.js';
import { repriceMarket } from '../src/modules/market/economy.js';
import { lotTotal, type LotState } from '../src/modules/market/lot.types.js';
import { MongoUserStore } from '../src/modules/user/mongo.store.js';
import { cloneAccount, createAccount, type UserAccount } from '../src/modules/user/user.types.js';
import {
  newAccount,
  withJunk,
  withResources,
  withStaniumField,
  withTech
} from './fixtures.js';

/**
 * Прогон mongo-сторов на НАСТОЯЩЕЙ базе (P5, пункт 4 закрытия P4).
 *
 * Зачем, если юнит-тесты покрывают домен на memory-сторах: memory-стор
 * принципиально НЕ может выразить три вещи, ради которых весь рынок построен на CAS.
 *
 *  1. Окно между чтением и записью. В памяти тело `transact` атомарно по
 *     построению, поэтому «два покупателя одного лота» там даже не возникает —
 *     тест гонки на memory-сторе проверял бы синхронность Node, а не наш протокол.
 *  2. Уникальные индексы. `hasKey` и дубль кланового имени в памяти — это
 *     `Map.has`, в базе — конфликт 11000. Исходы гонки двух вставок расходятся
 *     ровно там, где деньги.
 *  3. Маппинг BSON. Дата остаётся датой, `null` не превращается в `undefined`,
 *     enum не принимает чужую строку — всё это видно только из реального
 *     раунд-трипа.
 *
 * Поэтому здесь проверяются СТОРЫ и их пересечения с доменом, а не бизнес-правила:
 * правила покрыты market.test.ts и market.economy.test.ts, и дублировать их здесь
 * значило бы удвоить число мест, где правка баланса обязана помнить о втором тесте.
 *
 * СТЕНД. По умолчанию поднимается реальный `mongod` из кэша
 * `mongodb-memory-server` (тот же бинарник, что в проде, только ephemeral-порт и
 * временный каталог). `TD_MONGO_URI` переключает на внешнюю базу — например на
 * прод-подобный репликат, где важна совместимость с версиями и индексами на
 * живой коллекции. Нет ни того, ни другого (офлайн, CI без права качать) — набор
 * пропускается целиком, а не падает: отсутствие базы не отменяет 476 других тестов.
 */

const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const rules = config.economy;
const D = MARKET_PRICE_DYNAMICS;

const externalUri = process.env.TD_MONGO_URI ?? null;
const disableMemory = process.env.TD_MONGO_MEMORY === 'off';

/**
 * Каталог бинарника стенда — АБСОЛЮТНЫЙ, не зависящий от cwd и НЕ внутри node_modules.
 *
 * Ловушка, найденная этим прогоном: `mongodb-memory-server` якорит свой кэш на
 * ближайший `package.json` с секцией `config`, а ищет он ПОСЛЕДНИМ ШАГОМ ОТ cwd
 * ВВЕРХ. Монитор-процесс поднят из `server/` и находит один каталог, тот же набор
 * тестов, запущенный корнем (`npm test` в корне репозитория), — другой, и тогда
 * стартует загрузка бинарника MongoDB посреди прогона: таймаут теста становится
 * неотличим от зависшего подключения к базе.
 *
 * Вторая ловушка — сам выбор места. Раньше кэш лежал в
 * `server/node_modules/.cache/mongodb-memory-server/`, и из этого следовал запрет
 * запускать `npm ci`: установка стирает `node_modules` целиком и уносила 74 МБ
 * бинарника. Теперь кэш живёт в `<репозиторий>/.cache/`, вне `node_modules`, поэтому
 * `npm ci` (и `npm install` с расходящимся деревом) безопасны: дерево пакетов
 * пересоздаётся, бинарник остаётся.
 *
 * Путь от `import.meta.url` не зависит от cwd, поэтому корень и `server/`
 * получают один и тот же каталог и одно и то же попадание в кэш.
 */
const STAND_BIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache', 'mongodb-memory-server');

let memory: MongoMemoryServer | null = null;
let uri: string | null = externalUri;

if (!uri && !disableMemory) {
  try {
    memory = await MongoMemoryServer.create({ binary: { downloadDir: STAND_BIN_DIR } });
    uri = memory.getUri();
  } catch (error) {
    // Причина пишется в вывод vitest: «набор пропущен» без объяснения позже примут
    // за покрытие, которого на самом деле нет.
    console.warn(`[market.mongo] стенд недоступен: ${(error as Error).message}`);
  }
}

const run = Boolean(uri);
const DB_NAME = `tds_market_it_${process.pid}`;
const dbName = (suffix: string) => `${DB_NAME}_${suffix}`;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

/** Лот на рынке: тот же путь через домен, что и в бою, а не рука написанный объект. */
function listedLot(junk: JunkId, amount: number, pricePerUnit: number, sellerId: string, now = new Date()): LotState {
  const total = lotTotal(amount, pricePerUnit);
  const commission = Math.floor(total * 0.05);
  const shell = buildLot(
    { junk, amount, pricePerUnit, total, commission, net: total - commission },
    sellerId,
    nextId('lot'),
    now
  );
  return activateLot(shell, now);
}

function trader(now = new Date()): UserAccount {
  return createAccount(
    { platform: 'vk', socialId: nextId('social'), appId: null, groupId: null },
    now,
    rules,
    () => nextId('acc')
  );
}

/** Инспекция коллекции в обход стора: индексы и «грязные» записи — не его контракт. */
async function withRawDb<T>(tag: string, fn: (db: Connection) => Promise<T>): Promise<T> {
  const probe = await createConnection(uri as string, { dbName: dbName(tag) });
  try {
    return await fn(probe);
  } finally {
    await probe.close();
  }
}

/**
 * Лот-стор на СВОЕЙ базе.
 *
 * Каждая проверка получает отдельную коллекцию, и это не перестраховка: первый же
 * прогон на общем стенде показал, что `listActive` и `sumActiveUnits` видят лоты
 * соседа по файлу, и абсолютные ожидания (`chips === 7`) превратились в «сколько
 * наплодило предыдущее описание». Тест на стор без изоляции проверял бы порядок
 * объявлений в файле, а не контракт стора.
 */
async function freshLotStore(tag: string): Promise<MongoLotStore> {
  const store = new MongoLotStore(uri as string, { dbName: dbName(tag) });
  await store.connect();
  return store;
}

async function freshCommodityStore(tag: string): Promise<MongoCommodityStore> {
  const store = new MongoCommodityStore(uri as string, { dbName: dbName(tag) });
  await store.connect();
  return store;
}

/**
 * Монотонные часы пересчёта.
 *
 * Каждый следующий тик строго на паузу позже предыдущего. Без этого тест,
 * прогнавший рынок через 12 пересчётов вперёд, оставляет в базе `repricedAt` из
 * будущего — и следующий тест честным образом получает «все виды в паузе» вместо
 * проверяемого движения коридора. Время здесь — часть состояния товара, поэтому
 * им нельзя распорядиться небрежно.
 */
let lastTick = 0;
function nextNow(): Date {
  lastTick = Math.max(Date.now(), lastTick + D.cooldownMs + 1);
  return new Date(lastTick);
}

describe.skipIf(!run)('market.mongo: стор лотов', () => {
  it('документ лота ездит в BSON и обратно без потерь', async () => {
    const lots = await freshLotStore('lots-roundtrip');
    try {
      const sellerId = nextId('seller');
      const lot = listedLot('engines', 25, 120, sellerId);
      await lots.insert(lot);

      const restored = await lots.findById(lot.id);
      expect(restored).not.toBeNull();
      expect(restored?.id).toBe(lot.id);
      expect(restored?.sellerId).toBe(sellerId);
      expect(restored?.junk).toBe('engines');
      expect(restored?.amount).toBe(25);
      expect(restored?.pricePerUnit).toBe(120);
      expect(restored?.total).toBe(3_000);
      expect(restored?.status).toBe('listed');
      expect(restored?.buyerId).toBeNull();
      expect(restored?.purchasedAt).toBeNull();
      expect(restored?.payoutSettled).toBe(false);
      expect(restored?.revision).toBe(0);
      // Даты обязаны остаться датами: `isExpired` вызывает .getTime() без приведения,
      // и строка вместо Date сделала бы каждый лот вечно живым либо вечно мёртвым.
      expect(restored?.expiresAt).toBeInstanceOf(Date);
      expect(restored?.expiresAt.getTime()).toBe(lot.expiresAt.getTime());
      expect(restored?.createdAt.getTime()).toBe(lot.createdAt.getTime());
    } finally {
      await lots.disconnect();
    }
  });

  it('enum схемы — граница приложения, а не базы: прямая запись в коллекцию проходит', async () => {
    const lots = await freshLotStore('lots-boundary');
    try {
      const lot = listedLot('chips', 5, 50, nextId('seller'));
      await lots.insert(lot);
      const filter: Record<string, unknown> = { _id: lot.id };
      // Проходит, а не падает — и это зафиксировано тестом, чтобы никто не построил
      // защиту на том, чего нет. `enum` в mongoose валидирует запись ЧЕРЕЗ МОДЕЛЬ с
      // `runValidators`, а стор ходит `insertOne`/`updateOne` в обход валидаторов.
      // Значит «база не пустит чужой статус» — ложное утверждение, и единственная
      // настоящая решётка — доменная: юнион `LotStatus`, `isJunkId` и фильтры
      // reconcile, которые незнакомый статус просто не выбирают.
      const res = await withRawDb('lots-boundary', (db) =>
        db.collection('market_lots').updateOne(filter, { $set: { status: 'archived' } })
      );
      expect(res.acknowledged).toBe(true);

      // Последствия ровно те, что обещает домен: лот с чужим статусом исчезает и из
      // витрины, и из разбора зависших — то есть становится невидимым, а не опасным.
      expect(await lots.listActive({ limit: 10 })).toHaveLength(0);
      expect(await lots.sumActiveUnits()).toMatchObject({ chips: 0 });
    } finally {
      await lots.disconnect();
    }
  });

  it('витринные индексы реально созданы, а не только объявлены в схеме', async () => {
    const lots = await freshLotStore('lots-indexes');
    try {
      await withRawDb('lots-indexes', async (db) => {
        const names = (await db.collection('market_lots').indexes()).map((index) => index.name);
        // `connect()` глотает ошибку построения индексов в `warn`: на живой коллекции
        // с чужим индексом того же имени он не падает, и проверить, что индексы на
        // месте, можно только снизу. Без `idx_lot_feed` лента рынка — полный сбор
        // коллекции, растущий с историей торгов, а не с числом живых объявлений.
        expect(names).toContain('idx_lot_feed');
        expect(names).toContain('idx_lot_seller');
        expect(names).toContain('idx_lot_expiry');
        expect(names).toContain('idx_lot_payout');
      });
    } finally {
      await lots.disconnect();
    }
  });

  it('витрина сортируется по цене и не показывает чужие статусы', async () => {
    const lots = await freshLotStore('lots-feed');
    try {
      const sellerId = nextId('seller');
      const cheap = listedLot('chips', 10, 20, sellerId);
      const dear = listedLot('chips', 10, 180, sellerId);
      const sold = { ...listedLot('chips', 10, 5, sellerId), status: 'sold' as const };
      await lots.insert(cheap);
      await lots.insert(dear);
      await lots.insert(sold);

      const feed = await lots.listActive({ limit: 10 });
      expect(feed.map((lot) => lot.id)).toEqual([cheap.id, dear.id]);
      expect(await lots.listActive({ limit: 10, junk: 'engines' })).toHaveLength(0);
      expect(await lots.listActive({ limit: 10, excludeSellerId: sellerId })).toHaveLength(0);
    } finally {
      await lots.disconnect();
    }
  });

  it('`sumActiveUnits` считает по всей коллекции, а не по витринному лимиту', async () => {
    const lots = await freshLotStore('lots-supply');
    try {
      const sellerId = nextId('seller');
      // 60 лотов при `MARKET_FEED_LIMIT` = 50: ровно тот случай, когда объём рынка,
      // посчитанный по витрине, занижен, и коридор уехал бы вверх на пустом месте.
      for (let i = 0; i < 60; i++) await lots.insert(listedLot('boards', 100, 40, sellerId));
      await lots.insert({ ...listedLot('boards', 100, 40, sellerId), status: 'cancelled' as const });
      await lots.insert(listedLot('chips', 7, 50, sellerId));

      expect((await lots.listActive({ limit: 50 })).length).toBe(50);

      const supply = await lots.sumActiveUnits();
      expect(supply.boards).toBe(6_000);
      expect(supply.chips).toBe(7);
      expect(supply.engines).toBe(0);
      for (const junk of JUNK_IDS) expect(typeof supply[junk]).toBe('number');
    } finally {
      await lots.disconnect();
    }
  });

  it('потолок продавца и выборка просроченных работают на реальных индексах', async () => {
    const lots = await freshLotStore('lots-expiry');
    try {
      const sellerId = nextId('seller');
      const now = new Date();
      // Просроченным лот становится по истечении `MARKET_LOT_TTL_MS`, а не «чуть
      // раньше»: создан час назад лот с TTL в сутки — живой, и ждать от него
      // возврата хлама было бы ошибкой теста, а не домена.
      const stale = listedLot('ammo_casings', 50, 10, sellerId, new Date(now.getTime() - MARKET_LOT_TTL_MS - 60_000));
      await lots.insert(stale);
      await lots.insert(listedLot('ammo_casings', 50, 10, sellerId, now));

      expect(await lots.countActiveBySeller(sellerId)).toBe(2);
      const found = await lots.listExpired(now, 10);
      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe(stale.id);
    } finally {
      await lots.disconnect();
    }
  });

  it('CAS под реальным окном: доменный захват отдаёт лот одному из двоих', async () => {
    const lots = await freshLotStore('lots-cas');
    try {
      const lot = listedLot('transmissions', 4, 100, nextId('seller'));
      await lots.insert(lot);
      const first = nextId('buyer');
      const second = nextId('buyer');
      const at = new Date();

      const outcomes = await Promise.allSettled([
        lots.transact(lot.id, (current) => claimLot(current, first, at)),
        lots.transact(lot.id, (current) => claimLot(current, second, at))
      ]);

      const won = outcomes.filter((item) => item.status === 'fulfilled');
      const lost = outcomes.filter((item) => item.status === 'rejected');
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: ErrorCodes.MARKET_LOT_TAKEN });

      const stored = await lots.findById(lot.id);
      expect(stored?.revision).toBe(1);
      expect(stored?.buyerId).toBe((won[0] as PromiseFulfilledResult<LotState>).value.buyerId);

      // ПОЧЕМУ РЕДУКТОР, А НЕ СЛЕПАЯ ЗАПИСЬ. Слепое `updateOne` с ретраем прошло бы
      // ДВОЖДЫ: проигравший перечитал бы свежий документ и наложил своё поверх
      // чужого — оба «успешны», последний перезаписал. Единственная защита от этого
      // — редуктор, который на повторе заново проверяет состояние и отказывает.
      // Именно поэтому контракт `transact` требует чистый, повторно вызываемый
      // редуктор, и именно поэтому здесь проверяется `claimLot`, а не объект-литерал.
    } finally {
      await lots.disconnect();
    }
  });
});

describe.skipIf(!run)('market.mongo: стор товаров и пересчёт', () => {
  /**
   * Пара сторов на одной базе, своя на каждый тест.
   *
   * Лоты и товары обязаны жить в ОДНОЙ базе только для пересчёта, но в разных — от
   * соседей по файлу: `repricedAt` товара из прошлого теста накрывает часы будущего
   * паузой, и следующий тест получает «все виды в паузе» вместо движения коридора.
   */
  async function pair(tag: string) {
    const lots = await freshLotStore(`economy-${tag}-lots`);
    const commodities = await freshCommodityStore(`economy-${tag}-goods`);
    return {
      lots,
      commodities,
      deps: { lots, commodities },
      close: async () => {
        await Promise.all([lots.disconnect(), commodities.disconnect()]);
      }
    };
  }

  it('холодный старт создаёт шесть документов и переживает рестарт процесса', async () => {
    const env = await pair('cold');
    try {
      await repriceMarket(env.deps, nextNow());
      const all = await env.commodities.list();
      expect(all).toHaveLength(JUNK_IDS.length);
      expect(new Set(all.map((state) => state.junk)).size).toBe(JUNK_IDS.length);

      // Второй стор поверх тех же коллекций — имитация рестарта: состояние коридора
      // обязано читаться из базы, а не пересоздаваться якорем.
      const restarted = await freshCommodityStore(`economy-${'cold'}-goods`);
      try {
        const again = await restarted.list();
        expect(again.map((state) => state.revision).sort()).toEqual(all.map((state) => state.revision).sort());
        const chips = again.find((state) => state.junk === 'chips');
        const original = all.find((state) => state.junk === 'chips');
        expect(chips?.createdAt.getTime()).toBe(original?.createdAt.getTime());
      } finally {
        await restarted.disconnect();
      }
    } finally {
      await env.close();
    }
  });

  it('пауза `cooldownMs` держится и на реальной базе', async () => {
    const env = await pair('cooldown');
    try {
      const now = nextNow();
      await repriceMarket(env.deps, now);
      const before = await env.commodities.find('chips');

      const second = await repriceMarket(env.deps, new Date(now.getTime() + 1_000));
      expect(second.paused).toBe(JUNK_IDS.length);
      const after = await env.commodities.find('chips');
      expect(after?.revision).toBe(before?.revision);
      expect(after?.factor).toBe(before?.factor);
    } finally {
      await env.close();
    }
  });

  it('пустой рынок на реальной базе поднимает коридор до потолка, но не выше предела', async () => {
    const env = await pair('scarce');
    try {
      for (let i = 0; i < 12; i++) await repriceMarket(env.deps, nextNow());
      for (const state of await env.commodities.list()) {
        const hard = hardBoundsOf(state.junk) as { minPerUnit: number; maxPerUnit: number };
        expect(state.factor).toBe(D.factorCeil);
        expect(state.supply).toBe(0);
        expect(state.minPerUnit).toBeGreaterThanOrEqual(hard.minPerUnit);
        expect(state.maxPerUnit).toBeLessThanOrEqual(hard.maxPerUnit);
      }
    } finally {
      await env.close();
    }
  });

  it('предложение с реальной коллекции двигает коридор вниз', async () => {
    const env = await pair('glut');
    try {
      const sellerId = nextId('seller');
      for (let i = 0; i < 20; i++) await env.lots.insert(listedLot('batteries', 1_000, 4, sellerId));

      const before = (await env.commodities.find('batteries')) ?? neutralCommodity('batteries', nextNow());
      for (let i = 0; i < 12; i++) await repriceMarket(env.deps, nextNow());
      const after = (await env.commodities.find('batteries')) as CommodityState;

      expect(after.supply).toBe(20_000);
      expect(after.factor).toBeLessThan(before.factor);
      expect(after.minPerUnit).toBeLessThan(before.minPerUnit);
    } finally {
      await env.close();
    }
  });

  it('гонка двух читателей за один такт: пересчёт проходит ровно один раз', async () => {
    const env = await pair('race');
    try {
      await repriceMarket(env.deps, nextNow());
      const junk: JunkId = 'ammo_casings';
      const before = (await env.commodities.find(junk)) as CommodityState;
      const at = nextNow();

      const results = await Promise.all([repriceMarket(env.deps, at), repriceMarket(env.deps, at)]);
      const after = (await env.commodities.find(junk)) as CommodityState;

      expect(await env.commodities.list()).toHaveLength(JUNK_IDS.length);
      // Скорость хода обязана быть функцией от `cooldownMs`, а не от числа
      // одновременных читателей: ровно один пересчёт на такт, то есть +1 ревизия.
      // Без CAS здесь было бы +2, и витрина дёргалась бы тем сильнее, чем больше
      // на неё одновременно смотрят.
      expect(after.revision - before.revision).toBe(1);
      const movedAcross = results.reduce((sum, report) => sum + report.moved.length, 0);
      const heldAcross = results.reduce((sum, report) => sum + report.held.length, 0);
      const pausedAcross = results.reduce((sum, report) => sum + report.paused, 0);
      expect(movedAcross + heldAcross + pausedAcross).toBe(JUNK_IDS.length * 2);
      expect(pausedAcross).toBeGreaterThanOrEqual(JUNK_IDS.length);
    } finally {
      await env.close();
    }
  });

  it('`ensure` не перетирает живой снапшот чужим холодным стартом', async () => {
    const commodities = await freshCommodityStore('economy-ensure-goods');
    try {
      const junk: JunkId = 'boards';
      const first = await commodities.ensure(neutralCommodity(junk, new Date(0)));
      const moved = await commodities.transact(junk, (state) => ({
        ...state,
        factor: 1.5,
        minPerUnit: Math.round(MARKET_CORRIDORS.boards.minPerUnit * 1.5),
        maxPerUnit: Math.round(MARKET_CORRIDORS.boards.maxPerUnit * 1.5),
        revision: state.revision + 1
      }));

      const again = await commodities.ensure(neutralCommodity(junk, new Date()));
      expect(again.factor).toBe(moved.factor);
      expect(again.revision).toBe(moved.revision);
      expect(again.createdAt.getTime()).toBe(first.createdAt.getTime());
    } finally {
      await commodities.disconnect();
    }
  });
});

describe.skipIf(!run)('market.mongo: протокол сделки на реальной базе', () => {
  let deps: MarketDeps;

  beforeAll(async () => {
    const users = new MongoUserStore(uri as string, { dbName: dbName('protocol') });
    const lots = new MongoLotStore(uri as string, { dbName: dbName('protocol') });
    const commodities = new MongoCommodityStore(uri as string, { dbName: dbName('protocol') });
    const ledger = new MongoLedgerStore(uri as string, { dbName: dbName('protocol') });
    await Promise.all([users.connect(), lots.connect(), commodities.connect(), ledger.connect()]);
    deps = {
      users,
      lots,
      commodities,
      ledger,
      idFactory: () => nextId('entry'),
      onError: () => {}
    };
  });

  afterAll(async () => {
    await Promise.all([
      deps?.users.disconnect(),
      deps?.lots.disconnect(),
      deps?.commodities.disconnect(),
      deps?.ledger.disconnect()
    ]);
  });

  /** Продавец с хламом на складе; SEC в кошельке не нужен — он только получает. */
  async function vendor(chips: number): Promise<UserAccount> {
    const account = withJunk(trader(), { chips });
    await deps.users.save(account);
    return account;
  }

  async function purchaserOf(sec: number): Promise<UserAccount> {
    const account = withResources(trader(), { sec });
    await deps.users.save(account);
    return account;
  }

  it('листинг → покупка: хлам переходит, SEC сгорает ровно комиссией', async () => {
    const seller = await vendor(500);
    const purchaser = await purchaserOf(100_000);

    const { lot } = await listLot(deps, seller.id, { junk: 'chips', amount: 100, pricePerUnit: 50 }, new Date());
    expect(lot.status).toBe('listed');
    expect((await deps.users.findById(seller.id))?.junk.chips).toBe(400);

    const bought = await buyLot(deps, purchaser.id, lot.id, new Date(), rules);
    expect(bought.settled).toBe(true);

    const finalSeller = await deps.users.findById(seller.id);
    const finalBuyer = await deps.users.findById(purchaser.id);
    expect(finalBuyer?.junk.chips).toBe(100);
    expect(finalBuyer?.resources.sec).toBe(95_000);
    expect(finalSeller?.resources.sec).toBe(4_750);

    // Инвариант P4 на реальной базе: расхождение монеты двоих — ровно комиссия, и
    // она вышла из обращения, а не легла на чей-то счёт.
    const buyerFlow = await deps.ledger.sum(purchaser.id, 'sec');
    const sellerFlow = await deps.ledger.sum(seller.id, 'sec');
    expect(buyerFlow + sellerFlow).toBe(-250);

    // Каждое движение записано с `id`: без него Mongo генерировал бы `_id` на лету,
    // и аудит выплат потерял бы связь с лотом. Именно это и было сломано в P4.
    for (const entry of await deps.ledger.list(purchaser.id)) expect(entry.id).toBeTruthy();
  });

  it('два покупателя одновременно: товар у одного, деньги списаны у одного', async () => {
    const seller = await vendor(500);
    const first = await purchaserOf(100_000);
    const second = await purchaserOf(100_000);

    const { lot } = await listLot(deps, seller.id, { junk: 'chips', amount: 50, pricePerUnit: 100 }, new Date());
    const at = new Date();

    const outcomes = await Promise.allSettled([
      buyLot(deps, first.id, lot.id, at, rules),
      buyLot(deps, second.id, lot.id, at, rules)
    ]);

    const won = outcomes.filter((item) => item.status === 'fulfilled');
    const lost = outcomes.filter((item) => item.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({ code: ErrorCodes.MARKET_LOT_TAKEN });

    const winnerId = (won[0] as PromiseFulfilledResult<{ buyer: UserAccount }>).value.buyer.id;
    const stored = await deps.lots.findById(lot.id);
    expect(stored?.buyerId).toBe(winnerId);
    expect(stored?.status).toBe('sold');

    // Проигравший не заплатил ни монеты: CAS-отказ произошёл ДО списания. На
    // memory-сторе эта проверка невыполнима в принципе — там нет окна между
    // чтением и записью, и именно поэтому её не заменяет ни один юнит-тест.
    const loserId = winnerId === first.id ? second.id : first.id;
    const loser = await deps.users.findById(loserId);
    expect(loser?.resources.sec).toBe(100_000);
    expect(loser?.junk.chips).toBe(0);
    expect(await deps.ledger.hasKey(makeIdempotencyKey('market', `${lot.id}:sec`))).toBe(true);
  });

  it('зависшая выплата доводится разбором по журналу и не повторяется', async () => {
    const seller = await vendor(500);
    const purchaser = await purchaserOf(100_000);
    const at = new Date();

    const { lot } = await listLot(deps, seller.id, { junk: 'chips', amount: 20, pricePerUnit: 60 }, at);
    // Обрыв между «деньги покупателя списаны» и «продавец получил»: захват есть,
    // `payoutSettled` — нет. Арбитр «покупатель заплатил» — только журнал.
    const claimed = await deps.lots.transact(lot.id, (current) => claimLot(current, purchaser.id, at));
    await deps.ledger.appendMany([
      {
        id: nextId('entry'),
        userId: purchaser.id,
        currency: 'sec' as never,
        delta: -claimed.total,
        balanceAfter: 0,
        reason: 'market_trade' as const,
        refType: 'lot' as const,
        refId: claimed.id,
        idempotencyKey: makeIdempotencyKey('market', `${claimed.id}:sec`),
        ts: at
      }
    ]);

    const stuck = await deps.lots.findById(claimed.id);
    expect(stuck?.status).toBe('sold');
    expect(stuck?.payoutSettled).toBe(false);

    expect((await reconcileMarket(deps, at)).paidOut).toBe(1);
    const settled = await deps.lots.findById(claimed.id);
    expect(settled?.payoutSettled).toBe(true);
    const paid = await deps.users.findById(seller.id);
    expect(paid?.resources.sec).toBe(claimed.total - Math.floor(claimed.total * 0.05));

    // Повторный разбор молчит: ключ выплаты уже в журнале, и уникальный индекс
    // не даёт дописать второе движение. На memory-сторе это `Map.has`, здесь —
    // конфликт 11000, то есть ровно тот механизм, на котором держится прод.
    expect((await reconcileMarket(deps, at)).paidOut).toBe(0);
    const twice = await deps.users.findById(seller.id);
    expect(twice?.resources.sec).toBe(paid?.resources.sec);
  });

  it('уникальный индекс журнала отбивает дубль на уровне базы', async () => {
    const account = await purchaserOf(10_000);
    const key = makeIdempotencyKey('market', `${nextId('lot')}:sec`);
    const entry = {
      id: nextId('entry'),
      userId: account.id,
      currency: 'sec' as never,
      delta: -1,
      balanceAfter: 0,
      reason: 'market_trade' as const,
      refType: 'lot' as const,
      refId: 'x',
      idempotencyKey: key,
      ts: new Date()
    };

    expect(await deps.ledger.append(entry)).toBe(true);
    expect(await deps.ledger.append({ ...entry, id: nextId('entry') })).toBe(false);
    expect(await deps.ledger.appendMany([{ ...entry, id: nextId('entry') }])).toBe(0);
    expect(await deps.ledger.hasKey(key)).toBe(true);
    expect(await deps.ledger.hasKey(`${key}:nope`)).toBe(false);
  });
});

describe.skipIf(!run)('market.mongo: соседи по базе — игрок и клан', () => {
  it('аккаунт с хламом, сырьём и сроком модуля ездит в BSON и обратно', async () => {
    const users = new MongoUserStore(uri as string, { dbName: dbName('users') });
    await users.connect();
    try {
      const until = new Date(Date.now() + 90 * 60_000);
      const account = withTech(
        withStaniumField(withJunk(withResources(trader(), { sec: 12_345 }), { chips: 40 }), until),
        { chronium: 15, wolfram: 50, stanium: 20 }
      );
      await users.save(account);

      const restored = await users.findById(account.id);
      expect(restored?.resources.sec).toBe(12_345);
      expect(restored?.junk.chips).toBe(40);
      expect(restored?.materials.chronium).toBe(15);
      expect(restored?.materials.staniumFieldUntil).toBeInstanceOf(Date);
      expect(restored?.materials.staniumFieldUntil?.getTime()).toBe(until.getTime());
      expect(restored?.clanId).toBeNull();

      // `getOrCreate` дважды — один аккаунт: его контракт держится на уникальном
      // индексе (platform, socialId), а не на проверке «есть ли такой» до вставки.
      const identity = { platform: 'vk' as const, socialId: account.socialId, appId: null, groupId: null };
      const first = await users.getOrCreate(identity, new Date(), () => account);
      const second = await users.getOrCreate(identity, new Date(), () => account);
      expect(second.created).toBe(false);
      expect(second.account.id).toBe(first.account.id);
    } finally {
      await users.disconnect();
    }
  });

  it('дельта-запись: холостой transact не трогает документ, частичный — сохраняет нетронутые поля', async () => {
    // Смысл теста — не бизнес-правило, а свойство самого `$set`: дельта обязана
    // давать побайтово тот же документ, что дал бы полный пейлоад. Memory-стор
    // этого не проверяет: у него нет ни BSON, ни сетки путей, ни oplog.
    const users = new MongoUserStore(uri as string, { dbName: dbName('users') });
    await users.connect();
    try {
      const seed = withJunk(withResources(newAccount(config, new Date(), 'delta-write'), { sec: 7 }), { chips: 3 });
      await users.save(seed);
      const before = await users.findById(seed.id);
      if (!before) throw new Error('фикстура: игрок не сохранился');

      // 1. Редуктор, вернувший эквивалентный клон, — холостой: ни записи, ни revision.
      const noop = await users.transact(seed.id, (current) => cloneAccount(current));
      expect(noop.revision).toBe(before.revision);

      // 2. Меняется ОДНО поле; тяжёлые соседи (инвентарь, планировка, заказы) обязаны
      //    остаться в документе — именно их полный `$set` перетирал ради ~1 КБ дельты.
      const partial = await users.transact(seed.id, (current) => ({
        ...current,
        resources: { ...current.resources, sec: 999 }
      }));
      expect(partial.revision).toBe(before.revision + 1);

      const after = await users.findById(seed.id);
      expect(after?.resources.sec).toBe(999);
      expect(after?.junk.chips).toBe(3);
      expect(after?.inventory).toEqual(before?.inventory);
      expect(after?.base).toEqual(before?.base);
      expect(after?.orders).toEqual(before?.orders);
      expect(after?.entitlements).toEqual(before?.entitlements);
    } finally {
      await users.disconnect();
    }
  });

  it('клон с занятым именем не создаётся базой, а не приложением', async () => {
    const clans = new MongoClanStore(uri as string, { dbName: dbName('clans') });
    await clans.connect();
    try {
      const leaderId = nextId('leader');
      const identity = { name: `Осада-${process.pid}`, tag: 'SDG', description: 'интеграционный прогон' };
      const shell = buildClanShell(identity, nextId('clan'), leaderId, new Date());
      await clans.insert(shell.clan);

      await expect(
        clans.insert({ ...shell.clan, id: nextId('clan'), createdAt: new Date(), updatedAt: new Date() })
      ).rejects.toBeInstanceOf(DuplicateClanNameError);

      expect((await clans.findByName(identity.name))?.id).toBe(shell.clan.id);
    } finally {
      await clans.disconnect();
    }
  });
});




