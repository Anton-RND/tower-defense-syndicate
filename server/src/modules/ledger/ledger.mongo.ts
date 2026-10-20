import { createConnection, type Connection } from 'mongoose';

import { Logger, type LogLevel } from '../../lib/logger.js';
import { createLedgerModel, toLedgerEntry, type LedgerDoc, type LedgerModel } from './ledger.model.js';
import type { LedgerEntry, LedgerQuery } from './ledger.types.js';
import type { LedgerStore } from './ledger.store.js';

/**
 * Mongo-журнал. Append-only, поэтому CAS не нужен: гонку двойной записи гасит
 * уникальный индекс `uniq_idempotency_key`.
 */
export class MongoLedgerStore implements LedgerStore {
  readonly driver = 'mongo' as const;

  private connection: Connection | null = null;
  private model: LedgerModel | null = null;
  private readonly logger: Logger;

  constructor(
    private readonly uri: string,
    private readonly options: { dbName?: string; timeoutMs?: number; logger?: Logger; logLevel?: LogLevel } = {}
  ) {
    this.logger = options.logger ?? new Logger(options.logLevel ?? 'info');
  }

  async connect(): Promise<void> {
    if (this.model) return;
    this.connection = await createConnection(this.uri, {
      dbName: this.options.dbName,
      serverSelectionTimeoutMS: this.options.timeoutMs ?? 5000,
      maxPoolSize: 10
    });
    this.model = createLedgerModel(this.connection);
    try {
      await this.model.init();
    } catch (error) {
      this.logger.warn('Не удалось проверить индексы ledger (возможно, уже существуют)', {
        error: (error as Error).message
      });
    }
    this.logger.info('Mongo подключён', { db: this.connection.name, collection: 'ledger' });
  }

  async disconnect(): Promise<void> {
    if (this.connection) await this.connection.close();
    this.connection = null;
    this.model = null;
  }

  private get db(): LedgerModel {
    if (!this.model) throw new Error('LedgerStore не подключён — вызовите connect()');
    return this.model;
  }

  async append(entry: LedgerEntry): Promise<boolean> {
    try {
      await this.db.insertOne(this.toDoc(entry) as never);
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        this.logger.debug('Дубль движения журнала проигнорирован', {
          idempotencyKey: entry.idempotencyKey,
          reason: entry.reason
        });
        return false;
      }
      throw error;
    }
  }

  async appendMany(entries: LedgerEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    try {
      const result = await this.db.insertMany(entries.map((entry) => this.toDoc(entry) as never), {
        ordered: false
      });
      if (Array.isArray(result)) return result.length;
      return entries.length;
    } catch (error) {
      // Дубль ключа — штатный исход ретрая клиента или повторного вебхука, а не авария:
      // деньги УЖЕ списаны транзакцией аккаунта, и 500 отсюда только заглушил бы след.
      // Всё остальное (сеть, схема) обязан поднять наружу, а не прятать за «частичной
      // записью» — иначе half-write станет нормой.
      const writeErrors = (error as { writeErrors?: Array<{ code?: number }> } | null)?.writeErrors ?? [];
      const duplicates = writeErrors.filter((item) => item.code === 11000).length;
      if (duplicates === 0 || duplicates !== writeErrors.length) throw error;
      this.logger.debug('Дубли движений журнала проигнорированы', {
        duplicates,
        attempted: entries.length
      });
      return entries.length - duplicates;
    }
  }

  async hasKey(idempotencyKey: string): Promise<boolean> {
    // Уникальный индекс uniq_idempotency_key делает это поиск точечным, а не сканом.
    const found = await this.db.exists({ idempotencyKey }).exec();
    return found !== null;
  }

  private toDoc(entry: LedgerEntry): Omit<LedgerDoc, '_id'> & { _id: string } {
    return {
      _id: entry.id,
      userId: entry.userId,
      currency: entry.currency,
      delta: entry.delta,
      balanceAfter: entry.balanceAfter,
      reason: entry.reason,
      refType: entry.refType,
      refId: entry.refId,
      idempotencyKey: entry.idempotencyKey,
      ts: entry.ts,
      ...(entry.meta ? { meta: entry.meta } : {})
    };
  }

  private buildFilter(userId: string, query: LedgerQuery = {}): Record<string, unknown> {
    const filter: Record<string, unknown> = { userId };
    if (query.reasons && query.reasons.length > 0) filter.reason = { $in: query.reasons };
    if (query.since || query.until) {
      filter.ts = {
        ...(query.since ? { $gte: query.since } : {}),
        ...(query.until ? { $lte: query.until } : {})
      };
    }
    return filter;
  }

  async list(userId: string, query: LedgerQuery = {}): Promise<LedgerEntry[]> {
    let cursor = this.db.find(this.buildFilter(userId, query)).sort({ ts: -1 }).lean<LedgerDoc[]>();
    if (query.limit) cursor = cursor.limit(query.limit) as typeof cursor;
    const docs = await cursor.exec();
    return docs.map(toLedgerEntry);
  }

  async sum(userId: string, currency: LedgerEntry['currency'], query: LedgerQuery = {}): Promise<number> {
    const [row] = await this.db
      .aggregate<{ total: number }>([
        { $match: { ...this.buildFilter(userId, query), currency } },
        { $group: { _id: null, total: { $sum: '$delta' } } }
      ])
      .exec();
    return row?.total ?? 0;
  }

  async count(userId?: string): Promise<number> {
    return userId ? this.db.countDocuments(this.buildFilter(userId)).exec() : this.db.countDocuments().exec();
  }
}