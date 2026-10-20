import { describe, expect, it } from 'vitest';

import { JUNK_IDS } from '../src/config/workshop.js';
import { MARKET_COMMISSION, MARKET_PRICE_DYNAMICS } from '../src/config/market.js';
import type { LoopTimers } from '../src/lib/scheduler.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { makeIdempotencyKey, type LedgerEntry } from '../src/modules/ledger/ledger.types.js';
import { MemoryCommodityStore } from '../src/modules/market/commodity.store.js';
import { NEUTRAL_FACTOR } from '../src/modules/market/commodity.types.js';
import { MemoryLotStore } from '../src/modules/market/lot.store.js';
import { activateLot, buildLot } from '../src/modules/market/service.js';
import { lotTotal, type LotState } from '../src/modules/market/lot.types.js';
import type { MarketDeps } from '../src/modules/market/commit.js';
import { createMarketMaintenanceLoop, runMarketMaintenance } from '../src/modules/market/maintenance.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { T0, addMs, newAccount, testConfig, withJunk } from './fixtures.js';

/**
 * Фоновое обслуживание рынка (Часть 2, backlog 4).
 *
 * Главное, что здесь проверяется, — ПОРЯДОК. `reconcileMarket` меняет предложение
 * (возвращает просроченный хлам, доводит выплаты), а `repriceMarket` строит коридор
 * по предложению. Переставь их — и рынок один раз дёргается на затоваривание, которого
 * через миллисекунду уже нет. Проверяется не по порядку строк в логе (он следствие),
 * а по направлению движения множителя: это тот признак, который игрок видит в цене.
 */

const config = testConfig();
const D = MARKET_PRICE_DYNAMICS;

let seq = 0;
const idFactory = () => `lot-${++seq}`;

function sellerFixture(): UserAccount {
  return newAccount(config, T0, '777001');
}

// ─── Логи и таймеры на палке ─────────────────────────────────────────────────

interface Logged {
  level: string;
  msg: string;
  meta?: Record<string, unknown>;
}

interface RecordingLogger {
  records: Logged[];
  msgs: () => string[];
  trace(msg: string, meta?: Record<string, unknown>): void;
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  fatal(msg: string, meta?: Record<string, unknown>): void;
}

function recordingSink(): RecordingLogger {
  const records: Logged[] = [];
  const writer = (level: string) => (msg: string, meta?: Record<string, unknown>): void => {
    records.push({ level, msg, meta });
  };
  return {
    records,
    msgs: (): string[] => records.map((r) => r.msg),
    trace: writer('trace'),
    debug: writer('debug'),
    info: writer('info'),
    warn: writer('warn'),
    error: writer('error'),
    fatal: writer('fatal')
  };
}

function fakeTimers(): LoopTimers & { size: () => number; fire: () => void } {
  const scheduled = new Map<number, () => void>();
  let handle = 0;
  return {
    setTimeout: (fn: () => void, _ms: number) => {
      handle += 1;
      scheduled.set(handle, fn);
      return handle;
    },
    clearTimeout: (id: unknown) => {
      scheduled.delete(id as number);
    },
    size: () => scheduled.size,
    fire: () => {
      const jobs = [...scheduled.values()];
      scheduled.clear();
      for (const job of jobs) job();
    }
  };
}

// ─── Фикстуры рынка ──────────────────────────────────────────────────────────

function depsHarness(): { deps: MarketDeps; logger: RecordingLogger } {
  return {
    deps: {
      users: new MemoryUserStore(),
      lots: new MemoryLotStore(),
      commodities: new MemoryCommodityStore(),
      ledger: new MemoryLedgerStore(),
      idFactory
    },
    logger: recordingSink()
  };
}

/** Лот-оболочка: вставленный, но эскроу не подтверждённый — шаг 1 протокола. */
function shellOf(who: UserAccount, at: Date, amount: number, pricePerUnit: number, id: string): LotState {
  const total = lotTotal(amount, pricePerUnit);
  const commission = Math.floor(total * MARKET_COMMISSION);
  return buildLot({ junk: 'chips', amount, pricePerUnit, total, commission, net: total - commission }, who.id, id, at);
}

/** Тот же лот, вышедший в витрину. */
function listedLot(who: UserAccount, at: Date, amount: number, pricePerUnit: number, id: string): LotState {
  return activateLot(shellOf(who, at, amount, pricePerUnit, id), at);
}

/** Доказательство движения для моделирования падения между шагами. */
function proof(userId: string, key: string, reason: LedgerEntry['reason']): LedgerEntry {
  return {
    id: `ledger-${++seq}`,
    userId,
    currency: 'junk_chips',
    delta: 0,
    balanceAfter: 0,
    reason,
    refType: 'lot',
    refId: key,
    idempotencyKey: key,
    ts: T0
  };
}

describe('market.maintenance: порядок важнее наличия', () => {
  it('просроченный хлам возвращается ДО пересчёта: коридор растёт, а не падает', async () => {
    const { deps } = depsHarness();
    const owner = withJunk(sellerFixture(), { chips: 1000 });
    await deps.users.save(owner);
    // Лот в витрине означает «хлам уже списан со склада в эскроу» (шаг 2 протокола):
    // без этого возврат проверял бы появление товара из воздуха.
    await deps.users.transact(owner.id, (current) => ({
      ...current,
      junk: { ...current.junk, chips: current.junk.chips - 1000 }
    }));
    // 1000 чипов — в 1,67 раза больше эталона (600): если бы пересчёт шёл первым,
    // множитель двинулся бы ВНИЗ по затовариванию, которого через миллисекунду уже нет.
    await deps.lots.insert(listedLot(owner, T0, 1000, 50, 'expiring'));
    await deps.ledger.appendMany([
      proof(owner.id, makeIdempotencyKey('market', 'expiring:escrow'), 'market_list')
    ]);

    const report = await runMarketMaintenance(deps, addMs(T0, 25 * 60 * 60_000), recordingSink());

    expect(report.expired).toBe(1);
    expect((await deps.lots.findById('expiring'))?.status).toBe('expired');
    const chips = await deps.commodities.find('chips');
    expect(chips?.factor).toBeGreaterThan(NEUTRAL_FACTOR);
    // Весь хлам вернулся владельцу, а не сгорел из-за того, что лот истёк.
    expect((await deps.users.findById(owner.id))?.junk.chips).toBe(1000);
  });

  it('разбор зависших лотов опережает пересчёт и в логе', async () => {
    const { deps, logger } = depsHarness();
    const owner = withJunk(sellerFixture(), { chips: 1000 });
    await deps.users.save(owner);
    await deps.lots.insert(listedLot(owner, T0, 1000, 50, 'expiring'));
    await deps.ledger.appendMany([
      proof(owner.id, makeIdempotencyKey('market', 'expiring:escrow'), 'market_list')
    ]);

    await runMarketMaintenance(deps, addMs(T0, 25 * 60 * 60_000), logger);
    const msgs = logger.msgs();
    expect(msgs.indexOf('market_reconciled')).toBeGreaterThanOrEqual(0);
    expect(msgs.indexOf('market_reconciled')).toBeLessThan(msgs.indexOf('market_repriced'));
    expect(logger.records[0]?.meta).toMatchObject({ activated: 0, expired: 1, paidOut: 0 });
  });

  it('фиктивный лот без доказательства эскроу снимается, не трогая склад продавца', async () => {
    const { deps } = depsHarness();
    const owner = withJunk(sellerFixture(), { chips: 10 });
    await deps.users.save(owner);
    await deps.lots.insert(shellOf(owner, T0, 5, 50, 'ghost'));

    await runMarketMaintenance(deps, T0, recordingSink());
    expect((await deps.lots.findById('ghost'))?.status).toBe('cancelled');
    expect((await deps.users.findById(owner.id))?.junk.chips).toBe(10);
  });

  it('здоровый рынок в паузу не оставляет следа в логе', async () => {
    const { deps, logger } = depsHarness();
    await runMarketMaintenance(deps, T0, logger);
    // Первый проход холодный: шесть товаров создаются и двигаются — след законен.
    expect(logger.msgs()).toContain('market_repriced');

    logger.records.length = 0;
    await runMarketMaintenance(deps, T0, logger);
    // Тот же момент времени: все виды внутри `cooldownMs`, движений нет, лога нет.
    // Цикл, пишущий каждый тик, сделал бы лог бесполезным ровно там, где он нужен.
    expect(logger.msgs()).toEqual([]);
  });

  it('холодный рынок получает ровно шесть товаров, а не один на первый лот', async () => {
    const { deps } = depsHarness();
    await runMarketMaintenance(deps, T0, recordingSink());
    expect(await deps.commodities.list()).toHaveLength(JUNK_IDS.length);
  });
});

describe('market.maintenance: фоновый цикл', () => {
  it('tick() идёт по часам процесса и уважает паузу между пересчётами', async () => {
    const { deps, logger } = depsHarness();
    const timers = fakeTimers();
    let clock = T0;
    const loop = createMarketMaintenanceLoop(deps, logger, {
      intervalMs: D.cooldownMs,
      now: () => clock,
      timers
    });

    expect(await loop.tick()).toBe(true);
    const first = await deps.commodities.find('chips');
    expect(first?.factor).toBeGreaterThan(NEUTRAL_FACTOR);

    // Второй тик в ту же миллисекунду: `cooldownMs` не прошёл, множитель стоит.
    expect(await loop.tick()).toBe(true);
    const second = await deps.commodities.find('chips');
    expect(second?.factor).toBe(first?.factor);

    clock = addMs(clock, D.cooldownMs);
    expect(await loop.tick()).toBe(true);
    const third = await deps.commodities.find('chips');
    expect(third?.factor).toBeGreaterThan(second?.factor ?? 0);
    await loop.stop();
  });

  it('падение стора не рвёт цикл: onError пишет в лог, цепочка таймеров жива', async () => {
    const { deps, logger } = depsHarness();
    const broken: MarketDeps = {
      ...deps,
      lots: {
        ...deps.lots,
        sumActiveUnits: async () => {
          throw new Error('mongo down');
        }
      }
    };
    const timers = fakeTimers();
    const loop = createMarketMaintenanceLoop(broken, logger, {
      intervalMs: 1000,
      now: () => T0,
      timers
    });

    loop.start();
    timers.fire();
    for (let i = 0; i < 10; i++) await Promise.resolve();

    expect(logger.msgs()).toContain('market_maintenance_error');
    expect(timers.size()).toBe(1);
    await loop.stop();
    expect(timers.size()).toBe(0);
  });
});
