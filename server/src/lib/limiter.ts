/**
 * Токен-бакет с потолком ключей.
 *
 * Свой, а не очередь плагинов, по той же причине, по которой в этом монорепо свои
 * JWT (`modules/auth/token.ts`), свой логгер (`lib/logger.ts`) и свой планировщик
 * (`lib/scheduler.ts`): структура на шестьдесят строк, зато поведение видно целиком
 * и оно детерминированно в тестах — часы инжектятся, и ни один тест не спит.
 *
 * ГЛАВНАЯ ВЕЩЬ, РАДИ КОТОРОЙ НАПИСАН ПОТОЛОК КЛЮЧЕЙ. Лимитер, ключущий по адресу
 * клиента, — это карта, которую наполняет сам атакующий: трафик с подменённым
 * `X-Forwarded-For` или с ротации прокси-адресов растит её до OOM. То есть защита
 * от отказа в обслуживании становится отказом в обслуживании. Поэтому здесь три
 * механизма вместо одного: восстановление по времени, выбрасывание протухших
 * адресов и LRU-вытеснение при достижении потолка.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: распределённого состояния. Бакет живёт в процессе, поэтому при
 * нескольких репликах бюджет делится на их число. Для маршрутов входа это
 * приемлемо (порог считается на адрес, а не на игру), и честнее сказать это здесь,
 * чем молча подразумевать: с репликами удваивать лимиты по числу процессов.
 */

export interface BucketPolicy {
  /** Ёмкость: сколько запросов проходит подряд, до начала восстановления. */
  capacity: number;
  /** Единиц восполняется в секунду. */
  refillPerSec: number;
}

export interface BucketVerdict {
  allowed: boolean;
  /** Сколько запросов ещё проходит прямо сейчас. */
  remaining: number;
  /** Через сколько секунд придёт достаточно токенов для `cost`. При успехе — 0. */
  retryAfterSec: number;
}

export interface LimiterOptions {
  /** Потолок одновременных ключей. Сверх — выбрасывание давно не трогаемых. */
  maxKeys: number;
  /** Ключ без обращений дольше этого срока считается протухшим и убирается. */
  idleTtlMs: number;
  /** Часы в миллисекундах. Инжектятся ради детерминированных тестов без снов. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Политика из «запросов в минуту»: бакет = лимит, восстановление = лимит / 60.
 *
 * Такая пара даёт и всплеск (игрок с плохой сетью может промахнуться дважды подряд),
 * и среднее по минуте — ровно то, что значат лимиты в `.env.example`.
 */
export function perMinutePolicy(requestsPerMinute: number): BucketPolicy {
  return { capacity: requestsPerMinute, refillPerSec: requestsPerMinute / 60 };
}

export class Limiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly clock: () => number;
  private lastSweepAt: number;

  constructor(
    private readonly policy: BucketPolicy,
    private readonly options: LimiterOptions
  ) {
    // Нулевой лимит — это «выключено», и выражается оно на уровне вызывающего хука.
    // Молча принять capacity=0 здесь означало бы бакет, который всегда пуст.
    if (!(policy.capacity >= 1)) throw new Error('Limiter: capacity должен быть не меньше 1');
    if (!(policy.refillPerSec > 0)) throw new Error('Limiter: refillPerSec должен быть положительным');
    if (!(options.maxKeys >= 1)) throw new Error('Limiter: maxKeys должен быть не меньше 1');
    if (!(options.idleTtlMs > 0)) throw new Error('Limiter: idleTtlMs должен быть положительным');
    this.clock = options.now ?? (() => Date.now());
    this.lastSweepAt = this.clock();
  }

  /** Берёт `cost` токенов у ключа. Отказ не мутует состояние в сторону «стало лучше». */
  take(key: string, cost = 1): BucketVerdict {
    const at = this.clock();
    this.sweep(at, false);

    const previous = this.buckets.get(key);
    // Delete+set: Map держит порядок вставки, поэтому переброс в конец превращает
    // его в LRU по последнему обращению — вытеснять надо тех, кто не является
    // дольше всех, а не тех, кто появился раньше всех.
    this.buckets.delete(key);

    const tokens = previous
      ? Math.min(this.policy.capacity, previous.tokens + ((at - previous.updatedAt) * this.policy.refillPerSec) / 1000)
      : this.policy.capacity;

    if (tokens < cost) {
      this.buckets.set(key, { tokens, updatedAt: at });
      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil((cost - tokens) / this.policy.refillPerSec))
      };
    }

    const left = tokens - cost;
    this.buckets.set(key, { tokens: left, updatedAt: at });
    this.ensureCapacity(at);
    return { allowed: true, remaining: Math.floor(left), retryAfterSec: 0 };
  }

  /** Сколько адресов сейчас на учёте. Нужно тестам и диагностике раздувания. */
  get size(): number {
    return this.buckets.size;
  }

  reset(): void {
    this.buckets.clear();
    this.lastSweepAt = this.clock();
  }

  private sweep(at: number, force: boolean): void {
    if (!force && at - this.lastSweepAt < this.options.idleTtlMs) return;
    this.lastSweepAt = at;
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.updatedAt > this.options.idleTtlMs) this.buckets.delete(key);
    }
  }

  private ensureCapacity(at: number): void {
    if (this.buckets.size <= this.options.maxKeys) return;
    // Сначала протухшие: они и так почти мертвы. Вытеснять живой адрес — значит
    // дать атакующему шанс обойти бакет просто количеством новых ключей.
    this.sweep(at, true);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size <= this.options.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}
