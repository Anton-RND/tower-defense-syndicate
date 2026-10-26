import { notFound } from '../../lib/errors.js';
import { createStoreMetrics, type StoreMetricsSnapshot } from '../../lib/store.metrics.js';
import { cloneClan, type ClanState } from './clan.types.js';

/**
 * Абстракция хранилища кланов (Часть 2).
 *
 * Контракт зеркалит `UserStore`: те же `connect/disconnect/findById/transact/save`,
 * та же оптимистичная блокировка по `revision`. Отдельное хранилище, а не метод
 * юзер-стора, потому что документ клана — другая сущность с другим жизненным циклом
 * и другим набором читателей (взнос пишет два документа, а не один).
 *
 * ЧЕГО ЗДЕСЬ НЕТ: `findByName` без нормализации. Имя ищется по канонической форме,
 * которую гарантирует `normalizeClanName` на входе: иначе «занято?» стало бы вопросом
 * к регистру и лишним пробелам.
 */
export interface ClanStore {
  readonly driver: 'memory' | 'mongo';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  findById(id: string): Promise<ClanState | null>;
  /** По каноническому (нормализованному) имени. Используется для проверки занятости. */
  findByName(name: string): Promise<ClanState | null>;

  /** Атомарно применяет редуктор к документу клана (CAS по `revision`). */
  transact(id: string, reducer: (current: ClanState) => ClanState): Promise<ClanState>;

  /**
   * Вставка нового клана. Реализация ОБЯЗАНА отказать при уже занятом имени
   * (уникальный индекс в mongo, проверка в памяти), иначе два игрока, нажавшие
   * «основать» одновременно, получат по клану на двоих.
   */
  insert(clan: ClanState): Promise<ClanState>;

  /** Прямая запись (сидирование тестов/дева). */
  save(clan: ClanState): Promise<ClanState>;

  /** Участники клана — для витрины и разбора членства. */
  listByMember(userId: string, limit?: number): Promise<ClanState[]>;

  /** Счётчики обращений за жизнь процесса (см. lib/store.metrics.ts). */
  metrics(): StoreMetricsSnapshot;
}

export class DuplicateClanNameError extends Error {
  /** Имя (не `name`: это поле Error, и перекрывать его параметром нельзя). */
  readonly clanName: string;

  constructor(clanName: string) {
    super(`Клан с именем ${clanName} уже существует`);
    this.name = 'DuplicateClanNameError';
    this.clanName = clanName;
  }
}

/** Клан не обновлён после CAS-повторов: конкурентная запись, а не отсутствие документа. */
export class ClanConflictError extends Error {
  constructor(readonly clanId: string, readonly attempts: number) {
    super(`Не удалось обновить клан ${clanId}: конфликт версий после ${attempts} попыток`);
    this.name = 'ClanConflictError';
  }
}

export const MAX_CLAN_TRANSACT_ATTEMPTS = 5;

/** Инмемемуарный стор — дев и автотесты, без БД. Наружу всегда отдаёт копии. */
export class MemoryClanStore implements ClanStore {
  readonly driver = 'memory' as const;

  private readonly byId = new Map<string, ClanState>();
  private readonly byName = new Map<string, string>();
  private readonly counters = createStoreMetrics();

  async connect(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    this.byId.clear();
    this.byName.clear();
  }

  async findById(id: string): Promise<ClanState | null> {
    this.counters.read();
    const clan = this.byId.get(id);
    return clan ? cloneClan(clan) : null;
  }

  async findByName(name: string): Promise<ClanState | null> {
    const id = this.byName.get(name);
    return id ? this.findById(id) : null;
  }

  async transact(id: string, reducer: (current: ClanState) => ClanState): Promise<ClanState> {
    this.counters.transact();
    const stored = this.byId.get(id);
    if (!stored) throw notFound(`Клан ${id} не найден`);
    this.counters.read();
    const next = reducer(cloneClan(stored));
    next.id = stored.id;
    next.revision = stored.revision + 1;
    this.byId.set(id, next);
    this.byName.set(next.name, id);
    this.counters.write();
    return cloneClan(next);
  }

  metrics(): StoreMetricsSnapshot {
    return this.counters.snapshot();
  }

  async insert(clan: ClanState): Promise<ClanState> {
    if (this.byName.has(clan.name)) throw new DuplicateClanNameError(clan.name);
    const stored = cloneClan(clan);
    this.byId.set(stored.id, stored);
    this.byName.set(stored.name, stored.id);
    return cloneClan(stored);
  }

  async save(clan: ClanState): Promise<ClanState> {
    const stored = cloneClan(clan);
    this.byId.set(stored.id, stored);
    this.byName.set(stored.name, stored.id);
    return cloneClan(stored);
  }

  async listByMember(userId: string, limit = 10): Promise<ClanState[]> {
    const rows: ClanState[] = [];
    for (const clan of this.byId.values()) {
      if (clan.members.includes(userId)) rows.push(cloneClan(clan));
      if (rows.length >= limit) break;
    }
    return rows;
  }

  get size(): number {
    return this.byId.size;
  }
}
