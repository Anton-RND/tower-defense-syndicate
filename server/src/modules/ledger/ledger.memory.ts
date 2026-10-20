import type { LedgerEntry, LedgerQuery } from './ledger.types.js';
import type { LedgerStore } from './ledger.store.js';

/**
 * Инмемори-журнал: режим разработки и автотестов (без БД), как и MemoryUserStore.
 * Хранит плоский массив + Set ключей идемпотентности; при переполнении отсекает старое.
 */
export class MemoryLedgerStore implements LedgerStore {
  readonly driver = 'memory' as const;

  private entries: LedgerEntry[] = [];
  private keys = new Set<string>();

  constructor(private readonly maxSize: number = 100_000) {}

  async connect(): Promise<void> {
    /* no-op */
  }

  async disconnect(): Promise<void> {
    this.entries = [];
    this.keys.clear();
  }

  private push(entry: LedgerEntry): boolean {
    if (entry.idempotencyKey) {
      if (this.keys.has(entry.idempotencyKey)) return false;
      this.keys.add(entry.idempotencyKey);
    }
    this.entries.push(entry);
    if (this.entries.length > this.maxSize) {
      const dropped = this.entries.splice(0, this.entries.length - this.maxSize);
      for (const item of dropped) {
        if (item.idempotencyKey) this.keys.delete(item.idempotencyKey);
      }
    }
    return true;
  }

  async append(entry: LedgerEntry): Promise<boolean> {
    return this.push(entry);
  }

  async hasKey(idempotencyKey: string): Promise<boolean> {
    return this.keys.has(idempotencyKey);
  }

  async appendMany(entries: LedgerEntry[]): Promise<number> {
    let inserted = 0;
    for (const entry of entries) if (this.push(entry)) inserted += 1;
    return inserted;
  }

  private filter(userId: string, query: LedgerQuery = {}): LedgerEntry[] {
    const since = query.since?.getTime();
    const until = query.until?.getTime();
    const reasons = query.reasons ? new Set(query.reasons) : null;

    return this.entries.filter((entry) => {
      if (entry.userId !== userId) return false;
      if (reasons && !reasons.has(entry.reason)) return false;
      const ts = entry.ts.getTime();
      if (since !== undefined && ts < since) return false;
      if (until !== undefined && ts > until) return false;
      return true;
    });
  }

  async list(userId: string, query: LedgerQuery = {}): Promise<LedgerEntry[]> {
    const rows = this.filter(userId, query)
      .slice()
      .sort((a, b) => b.ts.getTime() - a.ts.getTime());
    return query.limit ? rows.slice(0, query.limit) : rows;
  }

  async sum(userId: string, currency: LedgerEntry['currency'], query: LedgerQuery = {}): Promise<number> {
    return this.filter(userId, query)
      .filter((entry) => entry.currency === currency)
      .reduce((total, entry) => total + entry.delta, 0);
  }

  async count(userId?: string): Promise<number> {
    if (!userId) return this.entries.length;
    return this.filter(userId).length;
  }
}