import type { Platform } from '../../config/env.js';
import { notFound } from '../../lib/errors.js';
import { createNoopAwareStoreMetrics, type StoreMetricsSnapshot } from '../../lib/store.metrics.js';
import type { SocialIdentity } from '../auth/vk.adapter.js';
import { cloneAccount, type UserAccount } from './user.types.js';
import { sameState } from './doc.diff.js';
import type { MatchCandidate, OpponentFilter, UserStore } from './user.store.js';

/**
 * Инмемуарный стор — режим разработки и автотестов (БД не требуется).
 * Хранит канонические объекты, наружу всегда отдаёт копии.
 */
export class MemoryUserStore implements UserStore {
  readonly driver = 'memory' as const;

  private readonly byId = new Map<string, UserAccount>();
  private readonly bySocial = new Map<string, string>();
  private readonly counters = createNoopAwareStoreMetrics();

  async connect(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    this.byId.clear();
    this.bySocial.clear();
  }

  private static socialKey(platform: Platform, socialId: string): string {
    return `${platform}:${socialId}`;
  }

  async findById(id: string): Promise<UserAccount | null> {
    this.counters.read();
    const account = this.byId.get(id);
    return account ? cloneAccount(account) : null;
  }

  async findBySocial(platform: Platform, socialId: string): Promise<UserAccount | null> {
    const id = this.bySocial.get(MemoryUserStore.socialKey(platform, socialId));
    return id ? this.findById(id) : null;
  }

  async getOrCreate(
    identity: Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>,
    now: Date,
    build: (
      identity: Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>,
      now: Date
    ) => UserAccount
  ): Promise<{ account: UserAccount; created: boolean }> {
    const key = MemoryUserStore.socialKey(identity.platform, identity.socialId);
    const existingId = this.bySocial.get(key);

    if (existingId) {
      const stored = this.byId.get(existingId);
      if (stored) {
        stored.lastLoginAt = now;
        stored.appId = identity.appId ?? stored.appId;
        stored.groupId = identity.groupId ?? stored.groupId;
        return { account: cloneAccount(stored), created: false };
      }
    }

    const account = build(identity, now);
    this.byId.set(account.id, account);
    this.bySocial.set(key, account.id);
    return { account: cloneAccount(account), created: true };
  }

  async transact(id: string, reducer: (current: UserAccount) => UserAccount): Promise<UserAccount> {
    this.counters.transact();
    const stored = this.byId.get(id);
    if (!stored) throw notFound(`Игрок ${id} не найден`);
    this.counters.read();
    // Редуктор работает на копии: исключение внутри = никаких изменений (all-or-nothing).
    const next = reducer(cloneAccount(stored));
    next.id = stored.id;
    // Та же семантика, что у Mongo-драйвера (см. MongoUserStore.transact): холостой
    // редуктор не пишет документ и не растит revision. Драйверы обязаны сходиться,
    // иначе тесты на memory проверяют поведение, которого в проде нет.
    if (sameState(stored, next)) {
      this.counters.noop();
      return cloneAccount(stored);
    }
    next.revision = stored.revision + 1;
    this.byId.set(id, next);
    this.counters.write();
    return cloneAccount(next);
  }

  /**
   * Конкурентных проигрышей у этого драйвера не бывает по построению: тело редуктора
   * выполняется целиком, без ожиданий (см. шапку MemoryLotStore.transact). Поэтому
   * `casConflicts` здесь всегда ноль — и это не пустое поле, а проверка обратной
   * стороны: любой ненулевой конфликт в проде приходит из mongo-драйвера.
   */
  metrics(): StoreMetricsSnapshot {
    return this.counters.snapshot();
  }

  async save(account: UserAccount): Promise<UserAccount> {
    const stored = cloneAccount(account);
    this.byId.set(stored.id, stored);
    this.bySocial.set(MemoryUserStore.socialKey(stored.platform, stored.socialId), stored.id);
    return cloneAccount(stored);
  }

  /**
   * Подбор соперников. Скан по Map + сортировка: на инмемуарном драйвере это тесты
   * и дев, где игроков десятки, — платить за индекс незачем.
   */
  async findOpponents(filter: OpponentFilter): Promise<MatchCandidate[]> {
    this.counters.read();
    const limit = Math.max(1, Math.trunc(filter.limit) || 1);
    const middle = (filter.ratingMin + filter.ratingMax) / 2;
    const candidates: MatchCandidate[] = [];
    for (const account of this.byId.values()) {
      if (account.platform !== filter.platform) continue;
      if (account.id === filter.excludeUserId) continue;
      if (account.pvp.rating < filter.ratingMin || account.pvp.rating > filter.ratingMax) continue;
      candidates.push({
        userId: account.id,
        rating: account.pvp.rating,
        walls: account.base.walls.length,
        units: account.base.units.length,
        baseVersion: account.base.version
      });
    }
    candidates.sort((a, b) => Math.abs(a.rating - middle) - Math.abs(b.rating - middle) || (a.userId < b.userId ? -1 : 1));
    return candidates.slice(0, limit);
  }

  /** Отладка/тесты: снимок всех аккаунтов. */
  list(): UserAccount[] {
    return [...this.byId.values()].map(cloneAccount);
  }

  get size(): number {
    return this.byId.size;
  }
}
