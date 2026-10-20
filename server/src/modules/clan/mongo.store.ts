import { randomUUID } from 'node:crypto';

import { createConnection, type Connection } from 'mongoose';

import { notFound } from '../../lib/errors.js';
import { Logger, type LogLevel } from '../../lib/logger.js';
import { cloneClan, type ClanState } from './clan.types.js';
import { createClanModel, toClan, toSetPayload, type ClanDoc, type ClanModel } from './mongo.model.js';
import { ClanConflictError, DuplicateClanNameError, MAX_CLAN_TRANSACT_ATTEMPTS, type ClanStore } from './clan.store.js';

/**
 * Mongo-стор кланов (Часть 2). Тот же контракт, что у `MongoUserStore`: CAS по
 * `revision`, копия наружу, никакой доменной логики внутри.
 *
 * Вставка клана ловит ошибку уникального индекса (code 11000) и превращает её в
 * `DuplicateClanNameError`: это единственный честный способ разрешить гонку двух
 * игроков, основавших клан с одним именем одновременно, — проверка «свободно ли имя»
 * до вставки от такой гонки не защищает.
 */
export class MongoClanStore implements ClanStore {
  readonly driver = 'mongo' as const;

  private connection: Connection | null = null;
  private model: ClanModel | null = null;

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
    this.model = createClanModel(this.connection);
    try {
      await this.model.init();
    } catch (error) {
      this.logger.warn('Не удалось проверить индексы clans (возможно, уже существуют)', {
        error: (error as Error).message
      });
    }
    this.logger.info('Mongo подключён', { db: this.connection.name, collection: 'clans' });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.model = null;
    }
  }

  private get db(): ClanModel {
    if (!this.model) throw new Error('MongoClanStore: нет подключения — вызовите connect()');
    return this.model;
  }

  private get logger(): Logger {
    return this.options.logger ?? new Logger(this.options.logLevel ?? 'info', { store: 'mongo-clan' });
  }

  async findById(id: string): Promise<ClanState | null> {
    const doc = (await this.db.findById(id).lean<ClanDoc | null>().exec()) as ClanDoc | null;
    return doc ? toClan(doc) : null;
  }

  async findByName(name: string): Promise<ClanState | null> {
    const doc = (await this.db.findOne({ name }).lean<ClanDoc | null>().exec()) as ClanDoc | null;
    return doc ? toClan(doc) : null;
  }

  async transact(id: string, reducer: (current: ClanState) => ClanState): Promise<ClanState> {
    for (let attempt = 1; attempt <= MAX_CLAN_TRANSACT_ATTEMPTS; attempt++) {
      const doc = (await this.db.findById(id).lean<ClanDoc | null>().exec()) as ClanDoc | null;
      if (!doc) throw notFound(`Клан ${id} не найден`);

      const current = toClan(doc);
      const next = reducer(cloneClan(current));
      next.id = current.id;
      next.revision = current.revision + 1;

      const res = await this.db
        .updateOne({ _id: current.id, revision: current.revision }, { $set: toSetPayload(next) })
        .exec();
      if (res.matchedCount === 1) return next;

      this.logger.debug('Конфликт версий клана, повторяем', { id, attempt, revision: current.revision });
    }
    throw new ClanConflictError(id, MAX_CLAN_TRANSACT_ATTEMPTS);
  }

  async insert(clan: ClanState): Promise<ClanState> {
    const id = clan.id || randomUUID();
    try {
      await this.db.insertOne({ ...toSetPayload(clan), _id: id } as never);
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new DuplicateClanNameError(clan.name);
      throw error;
    }
    return { ...clan, id };
  }

  async save(clan: ClanState): Promise<ClanState> {
    const id = clan.id || randomUUID();
    await this.db.updateOne({ _id: id }, { $set: { ...toSetPayload(clan), _id: id } }, { upsert: true }).exec();
    return { ...clan, id };
  }

  async listByMember(userId: string, limit = 10): Promise<ClanState[]> {
    const docs = await this.db
      .find({ members: userId })
      .limit(Math.max(1, Math.trunc(limit) || 1))
      .lean<ClanDoc[]>()
      .exec();
    return docs.map(toClan);
  }
}
