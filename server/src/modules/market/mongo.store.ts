import { randomUUID } from 'node:crypto';

import { createConnection, type Connection } from 'mongoose';

import { notFound } from '../../lib/errors.js';
import { Logger, type LogLevel } from '../../lib/logger.js';
import { cloneLot, isExpired, isPendingEscrow, type LotState } from './lot.types.js';
import { createLotModel, toLot, toLotSetPayload, type LotDoc, type LotModel } from './mongo.model.js';
import { LotConflictError, MAX_LOT_TRANSACT_ATTEMPTS, type LotStore } from './lot.store.js';
import type { JunkId } from '../../config/workshop.js';

/**
 * Mongo-стор лотов. Тот же контракт, что у `MongoClanStore` и `MongoUserStore`:
 * CAS по `revision`, копия наружу, никакой доменной логики внутри.
 *
 * Здесь ретрай ОПРАВДАН, в отличие от инмемори-стора: между `findById` и `updateOne`
 * есть реальное окно, и два покупателя одного лота в него попадают. Без повторов
 * второй покупатель получил бы «конфликт версий» вместо честного отказа
 * «лот уже продан», который ему отдаёт редуктор `claimLot` на свежем документе.
 */
export class MongoLotStore implements LotStore {
  readonly driver = 'mongo' as const;

  private connection: Connection | null = null;
  private model: LotModel | null = null;

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
    this.model = createLotModel(this.connection);
    try {
      await this.model.init();
    } catch (error) {
      this.logger.warn('Не удалось проверить индексы market_lots (возможно, уже существуют)', {
        error: (error as Error).message
      });
    }
    this.logger.info('Mongo подключён', { db: this.connection.name, collection: 'market_lots' });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.model = null;
    }
  }

  private get db(): LotModel {
    if (!this.model) throw new Error('MongoLotStore: нет подключения — вызовите connect()');
    return this.model;
  }

  private get logger(): Logger {
    return this.options.logger ?? new Logger(this.options.logLevel ?? 'info', { store: 'mongo-lot' });
  }

  async findById(id: string): Promise<LotState | null> {
    const doc = (await this.db.findById(id).lean<LotDoc | null>().exec()) as LotDoc | null;
    return doc ? toLot(doc) : null;
  }

  async transact(id: string, reducer: (current: LotState) => LotState): Promise<LotState> {
    for (let attempt = 1; attempt <= MAX_LOT_TRANSACT_ATTEMPTS; attempt++) {
      const doc = (await this.db.findById(id).lean<LotDoc | null>().exec()) as LotDoc | null;
      if (!doc) throw notFound(`Лот ${id} не найден`);

      const current = toLot(doc);
      const next = reducer(cloneLot(current));
      next.id = current.id;
      next.revision = current.revision + 1;

      const res = await this.db
        .updateOne({ _id: current.id, revision: current.revision }, { $set: toLotSetPayload(next) })
        .exec();
      if (res.matchedCount === 1) return next;

      this.logger.debug('Конфликт версий лота, повторяем', { id, attempt, revision: current.revision });
    }
    throw new LotConflictError(id, MAX_LOT_TRANSACT_ATTEMPTS);
  }

  async insert(lot: LotState): Promise<LotState> {
    const id = lot.id || randomUUID();
    await this.db.insertOne({ ...toLotSetPayload(lot), _id: id } as never);
    return { ...lot, id };
  }

  async save(lot: LotState): Promise<LotState> {
    const id = lot.id || randomUUID();
    await this.db.updateOne({ _id: id }, { $set: { ...toLotSetPayload(lot), _id: id } }, { upsert: true }).exec();
    return { ...lot, id };
  }

  async listActive(options: { junk?: JunkId; excludeSellerId?: string; limit: number }): Promise<LotState[]> {
    const query: Record<string, unknown> = { status: 'listed' };
    if (options.junk) query.junk = options.junk;
    if (options.excludeSellerId) query.sellerId = { $ne: options.excludeSellerId };
    const docs = await this.db
      .find(query)
      .sort({ pricePerUnit: 1, createdAt: 1 })
      .limit(Math.max(1, Math.trunc(options.limit) || 1))
      .lean<LotDoc[]>()
      .exec();
    return docs.map(toLot);
  }

  async countActiveBySeller(sellerId: string): Promise<number> {
    return this.db.countDocuments({ sellerId, status: 'listed' }).exec();
  }

  async listExpired(now: Date, limit: number): Promise<LotState[]> {
    const docs = await this.db
      .find({ status: 'listed', expiresAt: { $lte: now } })
      .limit(Math.max(1, Math.trunc(limit) || 1))
      .lean<LotDoc[]>()
      .exec();
    return docs.map(toLot).filter((lot) => isExpired(lot, now));
  }

  async listUnpaidPayouts(limit: number): Promise<LotState[]> {
    const docs = await this.db
      .find({ status: 'sold', payoutSettled: false })
      .limit(Math.max(1, Math.trunc(limit) || 1))
      .lean<LotDoc[]>()
      .exec();
    return docs.map(toLot);
  }

  async listPendingEscrow(limit: number): Promise<LotState[]> {
    const docs = await this.db
      .find({ status: 'pending_escrow' })
      .limit(Math.max(1, Math.trunc(limit) || 1))
      .lean<LotDoc[]>()
      .exec();
    return docs.map(toLot).filter(isPendingEscrow);
  }
}
