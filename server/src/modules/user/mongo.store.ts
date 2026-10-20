import { randomUUID } from 'node:crypto';

import { createConnection, type Connection } from 'mongoose';

import { Logger, type LogLevel } from '../../lib/logger.js';
import { notFound } from '../../lib/errors.js';
import type { Platform } from '../../config/env.js';
import type { SocialIdentity } from '../auth/vk.adapter.js';
import { cloneAccount, type UserAccount } from './user.types.js';
import { toAccount, toSetPayload, createUserModel, type UserDoc, type UserModel } from './mongo.model.js';
import {
  ConcurrentUpdateError,
  MAX_TRANSACT_ATTEMPTS,
  type MatchCandidate,
  type OpponentFilter,
  type UserStore
} from './user.store.js';

type Identity = Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>;

/** Проекция кандидата из агрегации findOpponents (шестичисленный документ, не аккаунт). */
interface OpponentRow {
  _id: string;
  rating?: number;
  walls?: number;
  units?: number;
  version?: number;
}

/**
 * Mongo-стор. Атомарность изменений — оптимистичная блокировка по полю `revision`
 * (CAS + повтор до MAX_TRANSACT_ATTEMPTS раз). Для Шага 4 (рейды) и Шага 6 (нагрузка)
 * планово переход на транзакции реплик-набора или Redis-локи по userId.
 */
export class MongoUserStore implements UserStore {
  readonly driver = 'mongo' as const;

  private connection: Connection | null = null;
  private model: UserModel | null = null;

  constructor(
    private readonly uri: string,
    private readonly options: {
      dbName?: string;
      timeoutMs?: number;
      logger?: Logger;
      logLevel?: LogLevel;
      idFactory?: () => string;
    } = {}
  ) {}

  async connect(): Promise<void> {
    if (this.model) return;
    this.connection = await createConnection(this.uri, {
      dbName: this.options.dbName,
      serverSelectionTimeoutMS: this.options.timeoutMs ?? 5000,
      maxPoolSize: 20
    });
    this.model = createUserModel(this.connection);
    try {
      // Ждём построения уникального индекса: до него getOrCreate не гарантирует одиночный аккаунт.
      await this.model.init();
    } catch (error) {
      this.logger.warn('Не удалось проверить индексы users (возможно, уже существуют)', {
        error: (error as Error).message
      });
    }
    this.logger.info('Mongo подключён', { db: this.connection.name, collection: 'users' });
  }

  async disconnect(): Promise<void> {
    if (this.connection) {
      await this.connection.close();
      this.connection = null;
      this.model = null;
      this.logger.info('Mongo отключён');
    }
  }

  private get db(): UserModel {
    if (!this.model) throw new Error('MongoUserStore: нет подключения — вызовите connect()');
    return this.model;
  }

  private get logger(): Logger {
    return this.options.logger ?? new Logger(this.options.logLevel ?? 'info', { store: 'mongo' });
  }

  async findById(id: string): Promise<UserAccount | null> {
    const doc = (await this.db.findById(id).lean<UserDoc | null>().exec()) as UserDoc | null;
    return doc ? toAccount(doc) : null;
  }

  async findBySocial(platform: Platform, socialId: string): Promise<UserAccount | null> {
    const doc = (await this.db
      .findOne({ platform, socialId })
      .lean<UserDoc | null>()
      .exec()) as UserDoc | null;
    return doc ? toAccount(doc) : null;
  }

  /**
   * Поиск по (platform, socialId) с созданием при отсутствии.
   * Уникальный индекс uniq_platform_social — источник атомарности: гонка двух
   * параллельных входа одного игрока заканчивается тем, что второй ловит E11000
   * и перечитывает уже готовую запись.
   */
  async getOrCreate(
    identity: Identity,
    now: Date,
    build: (identity: Identity, now: Date) => UserAccount
  ): Promise<{ account: UserAccount; created: boolean }> {
    const found = await this.findBySocial(identity.platform, identity.socialId);
    if (found) return { account: await this.touchLogin(found.id, identity, now), created: false };

    const candidate = build(identity, now);
    try {
      await this.db.create({ _id: candidate.id, ...toSetPayload(candidate) });
      return { account: candidate, created: true };
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
      // Кто-то успел создать аккаунт параллельно — догоняем его.
      const raced = await this.findBySocial(identity.platform, identity.socialId);
      if (!raced) throw notFound('Не удалось создать или найти игрока в Mongo');
      return { account: await this.touchLogin(raced.id, identity, now), created: false };
    }
  }

  /** Обновляет метаданные входа (lastLoginAt, appId/groupId из свежего initData). */
  private async touchLogin(id: string, identity: Identity, now: Date): Promise<UserAccount> {
    const set: Record<string, unknown> = { lastLoginAt: now };
    if (identity.appId) set.appId = identity.appId;
    if (identity.groupId) set.groupId = identity.groupId;

    await this.db.updateOne({ _id: id }, { $set: set }).exec();
    const account = await this.findById(id);
    if (!account) throw notFound(`Игрок ${id} не найден`);
    return account;
  }

  async transact(id: string, reducer: (current: UserAccount) => UserAccount): Promise<UserAccount> {
    for (let attempt = 1; attempt <= MAX_TRANSACT_ATTEMPTS; attempt++) {
      const doc = (await this.db.findById(id).lean<UserDoc | null>().exec()) as UserDoc | null;
      if (!doc) throw notFound(`Игрок ${id} не найден`);

      const current = toAccount(doc);
      // Редуктор может бросить AppError (не хватило энергии и т.п.) — запись не трогается.
      const next = reducer(cloneAccount(current));
      next.id = current.id;
      next.revision = current.revision + 1;

      const res = await this.db
        .updateOne({ _id: current.id, revision: current.revision }, { $set: toSetPayload(next) })
        .exec();

      if (res.matchedCount === 1) return next;

      this.logger.debug('Конфликт версий, повторяем', { id, attempt, revision: current.revision });
    }
    throw new ConcurrentUpdateError(id, MAX_TRANSACT_ATTEMPTS);
  }

  async save(account: UserAccount): Promise<UserAccount> {
    const id = account.id || randomUUID();
    await this.db
      .updateOne({ _id: id }, { $set: { ...toSetPayload(account), _id: id } }, { upsert: true })
      .exec();
    return { ...account, id };
  }

  /**
   * Подбор соперников агрегатом, а не `find` с проекцией.
   *
   * Причина конкретна: `find` вернёт массивы клеток (до 120 стен × {x,y}) на каждого
   * из 40 кандидатов — десятки килобайт ради шести чисел. `$size` считает длины
   * на сервере Mongo, наружу идут только проекции. `$match` при этом полностью
   * покрывается индексом idx_platform_rating, построенным ровно для этого запроса.
   *
   * Перекос выборки к нижнему краю коридора (нет $sample) осознанный: коридор узкий
   * (±150 на первой попытке), а порядок внутри него перемешивает матчмейкинг, так что
   * один и тот же соперник не становится «постоянным».
   */
  async findOpponents(filter: OpponentFilter): Promise<MatchCandidate[]> {
    const limit = Math.max(1, Math.trunc(filter.limit) || 1);
    const rows = await this.db
      .aggregate<OpponentRow>([
        {
          $match: {
            platform: filter.platform,
            _id: { $ne: filter.excludeUserId },
            'pvp.rating': { $gte: filter.ratingMin, $lte: filter.ratingMax }
          }
        },
        {
          $project: {
            rating: '$pvp.rating',
            walls: { $size: { $ifNull: ['$base.walls', []] } },
            units: { $size: { $ifNull: ['$base.units', []] } },
            version: '$base.version'
          }
        },
        { $limit: limit }
      ])
      .exec();

    return rows.map((row) => ({
      userId: String(row._id),
      rating: Number(row.rating ?? 0),
      walls: Number(row.walls ?? 0),
      units: Number(row.units ?? 0),
      baseVersion: Number(row.version ?? 0)
    }));
  }
}
