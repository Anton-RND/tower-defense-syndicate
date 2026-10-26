import { notFound } from '../../lib/errors.js';
import { createNoopAwareStoreMetrics, type StoreMetricsSnapshot } from '../../lib/store.metrics.js';
import { cloneCommodity, neutralCommodity, type CommodityState } from './commodity.types.js';
import type { JunkId } from '../../config/workshop.js';

/**
 * Хранилище товаров (Часть 2, P5). Контракт — уменьшенная копия `LotStore`:
 * тот же CAS по `revision`, те же копии наружу, никакой доменной логики.
 *
 * КЛЮЧ — ВИД ХЛАМА, а не id. Документов ровно шесть (по числу видов), и это не
 * каприз экономии: листинг обязан прочитать коридор СВОЕГО вида одним обращением,
 * а не найти его среди N записей. `junk` в `CommodityState` и есть первичный ключ.
 *
 * ГОНКА, РАДИ КОТОРОЙ ЗДЕСЬ CAS. Пересчёт запускается с чтения витрины, а читателей
 * много одновременно. Без атомарности два запроса прочитали `factor: 1`, оба
 * насчитали дефицит, оба записали — и рынок сдвинулся на два шага за одну паузу,
 * то есть скорость хода перестала бы зависеть от `cooldownMs` и превратилась бы в
 * «сколько пришло людей». Редуктор `repriceCommodity` при этом идемпотентен по
 * паузе, так что проигравший повтор просто ничего не меняет — и это единственно
 * верный исход: пересчётов за паузу быть не может.
 */
export interface CommodityStore {
  readonly driver: 'memory' | 'mongo';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** Снапшот товара; null — документа ещё нет (рынок не трогали), см. `neutralCommodity`. */
  find(junk: JunkId): Promise<CommodityState | null>;

  /** Все товары: витрине нужны шесть строк, а не шесть запросов. */
  list(): Promise<CommodityState[]>;

  /** Атомарно применяет редуктор (CAS по `revision`). Редуктор обязан быть чистым. */
  transact(junk: JunkId, reducer: (current: CommodityState) => CommodityState): Promise<CommodityState>;

  /** Создаёт отсутствующий снапшот; существующий НЕ перезаписывает. */
  ensure(state: CommodityState): Promise<CommodityState>;

  /** Счётчики обращений за жизнь процесса (см. lib/store.metrics.ts). */
  metrics(): StoreMetricsSnapshot;
}

/** Снапшот не обновлён после CAS-повторов: конкурентный читатель, а не отсутствие документа. */
export class CommodityConflictError extends Error {
  constructor(readonly junk: string, readonly attempts: number) {
    super(`Не удалось обновить товар ${junk}: конфликт версий после ${attempts} попыток`);
    this.name = 'CommodityConflictError';
  }
}

export const MAX_COMMODITY_TRANSACT_ATTEMPTS = 5;

/** Инмемори-стор — дев и автотесты, без БД. Наружу всегда отдаёт копии. */
export class MemoryCommodityStore implements CommodityStore {
  readonly driver = 'memory' as const;

  private readonly byJunk = new Map<JunkId, CommodityState>();
  private readonly counters = createNoopAwareStoreMetrics();

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {
    this.byJunk.clear();
  }

  async find(junk: JunkId): Promise<CommodityState | null> {
    this.counters.read();
    const state = this.byJunk.get(junk);
    return state ? cloneCommodity(state) : null;
  }

  async list(): Promise<CommodityState[]> {
    return [...this.byJunk.values()].map(cloneCommodity);
  }

  /**
   * Как и у лотов: в памяти тело редуктора выполняется целиком, конкурента внутри
   * нет, поэтому цикла повторов здесь нет — он был бы мёртвым кодом, который
   * выглядит защитой и не защищает ничего. Повторы живут в mongo-сторе.
   */
  async transact(junk: JunkId, reducer: (current: CommodityState) => CommodityState): Promise<CommodityState> {
    this.counters.transact();
    const stored = this.byJunk.get(junk);
    if (!stored) throw notFound(`Товар ${junk} не найден`);
    this.counters.read();
    const next = reducer(cloneCommodity(stored));
    next.junk = stored.junk;
    // Ревизию ведёт РЕДУКТОР (см. шапку MongoCommodityStore.transact), поэтому она и есть
    // бесплатный признак холостого хода: не сдвинулась ревизия — не сдвинулось ничего.
    // Пара `noops`/`writes` здесь показывает цену, которую этот стор платит зря:
    // пересчёт внутри паузы пишет документ целиком, хотя менять нечего.
    if (next.revision === stored.revision) this.counters.noop();
    this.byJunk.set(junk, next);
    this.counters.write();
    return cloneCommodity(next);
  }

  metrics(): StoreMetricsSnapshot {
    return this.counters.snapshot();
  }

  /**
   * Гонка двух первых запросов витрины: оба решили, что документа нет, оба
   * создают. `ensure` выигрывает тот, кто пришёл первым, второй получает его
   * снапшот — а не свой, иначе `createdAt` и `revision` зависели бы от порядка
   * прихода.
   */
  async ensure(state: CommodityState): Promise<CommodityState> {
    const existing = this.byJunk.get(state.junk);
    if (existing) return cloneCommodity(existing);
    const created = cloneCommodity(state);
    created.revision = 0;
    this.byJunk.set(created.junk, created);
    return cloneCommodity(created);
  }
}

/**
 * Шесть снапшотов рынка в виде карты по видам: удобная форма для витрины и для
 * проверки листинга, собираемая ОДНИМ обращением к стору.
 *
 * Пустые виды отсутствуют, а не нулятся: вызывающий код обязан знать разницу
 * между «рынок по этому виду не трогали» (`neutralCommodity`) и «рынок по этому
 * виду пуст» (снапшот с `supply: 0`). Подмена первого вторым удорожала бы первое
 * же объявление до края диапазона.
 */
export type CommodityMap = Partial<Record<JunkId, CommodityState>>;

export function toCommodityMap(states: readonly CommodityState[]): CommodityMap {
  const map: CommodityMap = {};
  for (const state of states) map[state.junk] = state;
  return map;
}

/** Снапшот товара с фолбэком на покой. Единственный разрешённый способ читать коридор. */
export function commodityOrNeutral(map: CommodityMap, junk: JunkId, now: Date): CommodityState {
  return map[junk] ?? neutralCommodity(junk, now);
}
