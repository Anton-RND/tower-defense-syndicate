import { createConnection, Schema, type Connection, type Model } from 'mongoose';

import { notFound } from '../../lib/errors.js';
import { Logger, type LogLevel } from '../../lib/logger.js';
import { createNoopAwareStoreMetrics, type StoreMetricsSnapshot } from '../../lib/store.metrics.js';
import { JUNK_IDS } from '../../config/workshop.js';
import type { JunkId } from '../../config/workshop.js';
import { cloneCommodity, type CommodityState } from './commodity.types.js';
import {
  CommodityConflictError,
  MAX_COMMODITY_TRANSACT_ATTEMPTS,
  type CommodityStore
} from './commodity.store.js';

/**
 * Mongo-стор товаров (Часть 2, P5). Тот же контракт, что у `MongoLotStore`: CAS по
 * `revision`, копия наружу, никакой доменной логики внутри.
 *
 * Первичный ключ — вид хлама, а не ObjectId: документов ровно шесть, и читать
 * коридор своего вида одним `findById` важнее, чем иметь свободу завести седьмой.
 */
interface CommodityDoc {
  _id: string;
  factor: number;
  minPerUnit: number;
  maxPerUnit: number;
  supply: number;
  hardMinPerUnit: number;
  hardMaxPerUnit: number;
  repricedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
}

const commoditySchema = new Schema<CommodityDoc>(
  {
    _id: { type: String, required: true, enum: [...JUNK_IDS] },
    factor: { type: Number, required: true, min: 0.01 },
    minPerUnit: { type: Number, required: true, min: 1 },
    maxPerUnit: { type: Number, required: true, min: 1 },
    supply: { type: Number, required: true, min: 0 },
    hardMinPerUnit: { type: Number, required: true, min: 1 },
    hardMaxPerUnit: { type: Number, required: true, min: 1 },
    repricedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    revision: { type: Number, required: true, default: 0 }
  },
  { collection: 'market_commodities', versionKey: false }
);

function toCommodity(doc: CommodityDoc): CommodityState {
  return {
    junk: doc._id as JunkId,
    factor: doc.factor,
    minPerUnit: doc.minPerUnit,
    maxPerUnit: doc.maxPerUnit,
    supply: doc.supply,
    hardMinPerUnit: doc.hardMinPerUnit,
    hardMaxPerUnit: doc.hardMaxPerUnit,
    repricedAt: new Date(doc.repricedAt),
    createdAt: new Date(doc.createdAt),
    updatedAt: new Date(doc.updatedAt),
    revision: doc.revision
  };
}

/** Поля документа без `_id`: он же первичный ключ и он же путь запроса. */
function toDoc(state: CommodityState): Omit<CommodityDoc, '_id'> {
  return {
    factor: state.factor,
    minPerUnit: state.minPerUnit,
    maxPerUnit: state.maxPerUnit,
    supply: state.supply,
    hardMinPerUnit: state.hardMinPerUnit,
    hardMaxPerUnit: state.hardMaxPerUnit,
    repricedAt: state.repricedAt,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    revision: state.revision
  };
}

export type CommodityModel = Model<CommodityDoc>;

export class MongoCommodityStore implements CommodityStore {
  readonly driver = 'mongo' as const;

  private connection: Connection | null = null;
  private model: CommodityModel | null = null;
  private readonly counters = createNoopAwareStoreMetrics();

  constructor(
    private readonly uri: string,
    private readonly options: {
      dbName?: string;
      timeoutMs?: number;
      logger?: Logger;
      logLevel?: LogLevel;
    } = {}
  ) {}

  async connect(): Promise<void> {
    if (this.model) return;
    this.connection = await createConnection(this.uri, {
      dbName: this.options.dbName,
      serverSelectionTimeoutMS: this.options.timeoutMs ?? 5000,
      maxPoolSize: 10
    });
    this.model = this.connection.model<CommodityDoc>('MarketCommodity', commoditySchema);
    try {
      await this.model.init();
    } catch (error) {
      this.logger.warn('Не удалось проверить индексы market_commodities', {
        error: (error as Error).message
      });
    }
    this.logger.info('Mongo подключён', { db: this.connection.name, collection: 'market_commodities' });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.model = null;
    }
  }

  private get db(): CommodityModel {
    if (!this.model) throw new Error('MongoCommodityStore: нет подключения — вызовите connect()');
    return this.model;
  }

  private get logger(): Logger {
    return this.options.logger ?? new Logger(this.options.logLevel ?? 'info', { store: 'mongo-commodity' });
  }

  async find(junk: JunkId): Promise<CommodityState | null> {
    this.counters.read();
    const doc = (await this.db.findById(junk).lean<CommodityDoc | null>().exec()) as CommodityDoc | null;
    return doc ? toCommodity(doc) : null;
  }

  async list(): Promise<CommodityState[]> {
    const docs = await this.db.find({}).lean<CommodityDoc[]>().exec();
    return docs.map(toCommodity);
  }

  /**
   * В отличие от `MongoLotStore.transact`, счётчик версии ведёт РЕДУКТОР, а не стор:
   * `repriceCommodity` инкрементирует `revision` сам и НЕ инкрементирует его, когда
   * пауза не прошла. Именно это даёт `repriceOne` его проверку «пересчёт не
   * состоялся» — сравнением ревизии до и после. Стор, увеличивающий счётчик поверх
   * редуктора, превратил бы эту проверку в ложное «сдвинулось» на каждом запросе
   * внутри паузы.
   */
  async transact(junk: JunkId, reducer: (current: CommodityState) => CommodityState): Promise<CommodityState> {
    this.counters.transact();
    for (let attempt = 1; attempt <= MAX_COMMODITY_TRANSACT_ATTEMPTS; attempt++) {
      const doc = (await this.db.findById(junk).lean<CommodityDoc | null>().exec()) as CommodityDoc | null;
      if (!doc) throw notFound(`Товар ${junk} не найден`);
      this.counters.read();

      const current = toCommodity(doc);
      const next = reducer(cloneCommodity(current));
      next.junk = current.junk;
      // Ревизию ведёт редуктор, поэтому она — бесплатный признак холостого хода.
      const noop = next.revision === current.revision;

      const res = await this.db
        .updateOne({ _id: junk, revision: current.revision }, { $set: toDoc(next) })
        .exec();
      if (noop) this.counters.noop();
      if (res.matchedCount === 1) {
        this.counters.write();
        return next;
      }

      this.counters.conflict(attempt);
      this.logger.debug('Конфликт версий товара, повторяем', { junk, attempt, revision: current.revision });
    }
    this.counters.abandon(MAX_COMMODITY_TRANSACT_ATTEMPTS);
    throw new CommodityConflictError(junk, MAX_COMMODITY_TRANSACT_ATTEMPTS);
  }

  metrics(): StoreMetricsSnapshot {
    return this.counters.snapshot();
  }

  /**
   * Всё тело — в `$setOnInsert`, а не в `$set`: существующий снапшот не имеет права
   * быть тронут чужим холодным стартом. Два первых запроса витрины после рестарта
   * приходят одновременно, и проигравший обязан получить документ победителя, а не
   * перезаписать его своим `createdAt`.
   */
  async ensure(state: CommodityState): Promise<CommodityState> {
    const res = await this.db
      .findOneAndUpdate(
        { _id: state.junk },
        { $setOnInsert: { ...toDoc(state), _id: state.junk } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
      )
      .lean<CommodityDoc | null>()
      .exec();
    if (!res) throw notFound(`Товар ${state.junk} не создан`);
    return toCommodity(res as unknown as CommodityDoc);
  }
}

