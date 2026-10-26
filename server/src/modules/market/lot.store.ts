import { notFound } from '../../lib/errors.js';
import { createStoreMetrics, type StoreMetricsSnapshot } from '../../lib/store.metrics.js';
import { cloneLot, emptyJunkTotals, isActiveLot, isExpired, isPendingEscrow, type LotState } from './lot.types.js';
import type { JunkId } from '../../config/workshop.js';

/**
 * Хранилище лотов (Часть 2). Контракт зеркалит `ClanStore`: те же
 * `connect/disconnect/findById/transact/insert`, та же оптимистичная блокировка по
 * `revision`.
 *
 * ГОНКА, РАДИ КОТОРОЙ ЗДЕСЬ CAS, а не «прочитал и записал». Два игрока, нажавшие
 * «выкупить» на одном лоте в один миллисекундный промежуток, — штатная ситуация рынка,
 * а не исключение. Без атомарного захвата оба прочитают `status: 'listed'`, оба
 * заплатят SEC, и товар уйдёт одному из них, а деньги возьмут у обоих. `transact`
 * здесь — единственное место, где такой исход физически невозможен.
 */
export interface LotStore {
  readonly driver: 'memory' | 'mongo';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  findById(id: string): Promise<LotState | null>;

  /**
   * Атомарно применяет редуктор к лоту (CAS по `revision`). Редуктор обязан быть
   * чистым и повторимо вызываемым: при конфликте он запускается заново на свежем
   * документе, и «захватить лот» внутри него должно проверять состояние ещё раз.
   */
  transact(id: string, reducer: (current: LotState) => LotState): Promise<LotState>;

  insert(lot: LotState): Promise<LotState>;
  save(lot: LotState): Promise<LotState>;

  /** Витрина: активные лоты, дешёвые сверху. Чужой продавец исключается на стороне БД. */
  listActive(options: { junk?: JunkId; excludeSellerId?: string; limit: number }): Promise<LotState[]>;

  /** Сколько у продавца активных лотов (потолок `MARKET_MAX_ACTIVE_LOTS`). */
  countActiveBySeller(sellerId: string): Promise<number>;

  /**
   * Суммарное предложение по видам: сколько единиц каждого хлама сейчас лежит на
   * рынке эскроу (P5).
   *
   * Отдельный метод, а не `listActive` с редуктором в вызывающем коде, по трём
   * причинам. Первая: `listActive` ограничен `MARKET_FEED_LIMIT`, и считать объём
   * рынка по первым 50 лотам значит пересчитывать коридор по витрине, а не по
   * рынку — при 300 лотах рынок выглядел бы пустым и цены взлетели бы на ровном
   * месте. Вторая: агрегат не таскает сотни документов через сеть ради шести
   * чисел. Третья: вид с нулевым предложением обязан быть в ответе нулём, а не
   * отсутствовать — «нет строки» и «ноль единиц» для коридора разные сигналы.
   */
  sumActiveUnits(): Promise<Record<JunkId, number>>;

  /** Просроченные, но ещё не возвращённые лоты. */
  listExpired(now: Date, limit: number): Promise<LotState[]>;

  /** Проданные, где деньги продавцу не доведены — работа для reconcile. */
  listUnpaidPayouts(limit: number): Promise<LotState[]>;

  /** Вставленные, но не подтверждённые эскроу — работа для reconcile. */
  listPendingEscrow(limit: number): Promise<LotState[]>;

  /** Счётчики обращений за жизнь процесса (см. lib/store.metrics.ts). */
  metrics(): StoreMetricsSnapshot;
}

/** Лот не обновлён после CAS-повторов: конкурентная запись, а не отсутствие документа. */
export class LotConflictError extends Error {
  constructor(readonly lotId: string, readonly attempts: number) {
    super(`Не удалось обновить лот ${lotId}: конфликт версий после ${attempts} попыток`);
    this.name = 'LotConflictError';
  }
}

export const MAX_LOT_TRANSACT_ATTEMPTS = 5;

/** Инмемори-стор — дев и автотесты, без БД. Наружу всегда отдаёт копии. */
export class MemoryLotStore implements LotStore {
  readonly driver = 'memory' as const;

  private readonly byId = new Map<string, LotState>();
  private readonly counters = createStoreMetrics();

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.byId.clear();
  }

  async findById(id: string): Promise<LotState | null> {
    this.counters.read();
    const lot = this.byId.get(id);
    return lot ? cloneLot(lot) : null;
  }

  /**
   * В памяти редуктор применяется ОДИН разом и без ожиданий: пока выполняется тело,
   * никто другой в этот Map не зайдёт. Поэтому цикла повторов здесь нет — он был бы
   * мёртвым кодом, который выглядит защитой и не защищает ничего. Повторы живут в
   * mongo-сторе, где между чтением и записью действительно есть окно.
   */
  async transact(id: string, reducer: (current: LotState) => LotState): Promise<LotState> {
    this.counters.transact();
    const stored = this.byId.get(id);
    if (!stored) throw notFound(`Лот ${id} не найден`);
    this.counters.read();
    const next = reducer(cloneLot(stored));
    next.id = stored.id;
    next.revision = stored.revision + 1;
    this.byId.set(id, next);
    this.counters.write();
    return cloneLot(next);
  }

  metrics(): StoreMetricsSnapshot {
    return this.counters.snapshot();
  }

  async insert(lot: LotState): Promise<LotState> {
    if (this.byId.has(lot.id)) throw new Error(`Лот ${lot.id} уже существует`);
    const stored = cloneLot(lot);
    stored.revision = 0;
    this.byId.set(stored.id, stored);
    return cloneLot(stored);
  }

  async save(lot: LotState): Promise<LotState> {
    const stored = cloneLot(lot);
    this.byId.set(stored.id, stored);
    return cloneLot(stored);
  }

  private active(): LotState[] {
    return [...this.byId.values()].filter(isActiveLot);
  }

  async listActive(options: { junk?: JunkId; excludeSellerId?: string; limit: number }): Promise<LotState[]> {
    return this.active()
      .filter((lot) => (options.junk ? lot.junk === options.junk : true))
      .filter((lot) => (options.excludeSellerId ? lot.sellerId !== options.excludeSellerId : true))
      .sort((a, b) => a.pricePerUnit - b.pricePerUnit || a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, Math.max(0, options.limit))
      .map(cloneLot);
  }

  async countActiveBySeller(sellerId: string): Promise<number> {
    return this.active().filter((lot) => lot.sellerId === sellerId).length;
  }

  async sumActiveUnits(): Promise<Record<JunkId, number>> {
    const totals = emptyJunkTotals();
    for (const lot of this.active()) totals[lot.junk] += lot.amount;
    return totals;
  }

  async listExpired(now: Date, limit: number): Promise<LotState[]> {
    return this.active()
      .filter((lot) => isExpired(lot, now))
      .slice(0, Math.max(0, limit))
      .map(cloneLot);
  }

  async listUnpaidPayouts(limit: number): Promise<LotState[]> {
    return [...this.byId.values()]
      .filter((lot) => lot.status === 'sold' && !lot.payoutSettled)
      .slice(0, Math.max(0, limit))
      .map(cloneLot);
  }

  async listPendingEscrow(limit: number): Promise<LotState[]> {
    return [...this.byId.values()]
      .filter(isPendingEscrow)
      .slice(0, Math.max(0, limit))
      .map(cloneLot);
  }
}
