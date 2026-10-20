import { describe, expect, it } from 'vitest';

import { junkTotal, type MaterialCost } from '../src/config/workshop.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { generateBattleLoot, resetLootDay, rollBattleLoot } from '../src/modules/raid/loot.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { DAY, T0, addMs, errorCode, fixedRng, newAccount, testConfig, withJunk } from './fixtures.js';

const config = testConfig({ LOOT_DAILY_EVENTS: '3', JUNK_CAP: '500' });
const rules = config.economy;

const winReport = { raidId: 'raid-1', outcome: 'win' as const, destroyed: 10 };

describe('боевой лут: масштаб разрушений и исход', () => {
  it('победа даёт больше, чем поражение, при том же ГСЧ', () => {
    const won = generateBattleLoot(newAccount(config), winReport, T0, rules, fixedRng(0.5));
    const lost = generateBattleLoot(newAccount(config), { ...winReport, raidId: 'raid-2', outcome: 'loss' }, T0, rules, fixedRng(0.5));

    expect(won.multiplier).toBe(1);
    expect(lost.multiplier).toBe(0.2);
    expect(won.units).toBeGreaterThan(lost.units);
    expect(lost.units).toBeGreaterThan(0);
  });

  it('количество уничтоженного увеличивает выдачу (смысл агрессивной игры)', () => {
    const small = generateBattleLoot(newAccount(config), { ...winReport, destroyed: 0 }, T0, rules, fixedRng(0.5));
    const big = generateBattleLoot(newAccount(config), { ...winReport, raidId: 'raid-3', destroyed: 50 }, T0, rules, fixedRng(0.5));
    expect(big.units).toBeGreaterThan(small.units * 3);
  });

  it('ничья — между победой и поражением', () => {
    const won = rollBattleLoot({ ...winReport, destroyed: 20 }, 'win', fixedRng(0.5));
    const drawn = rollBattleLoot({ ...winReport, destroyed: 20 }, 'draw', fixedRng(0.5));
    const lost = rollBattleLoot({ ...winReport, destroyed: 20 }, 'loss', fixedRng(0.5));
    const sum = (cost: MaterialCost): number => {
      let total = 0;
      for (const value of Object.values(cost)) total += value ?? 0;
      return total;
    };

    expect(sum(won)).toBeGreaterThan(sum(drawn));
    expect(sum(drawn)).toBeGreaterThan(sum(lost));
  });

  it('хлам падает в junkInventory, а журнал получает отдельную валюту на каждый тип', async () => {
    const account = newAccount(config);
    const result = generateBattleLoot(account, winReport, T0, rules, fixedRng(0.5));

    expect(junkTotal(result.account.junk)).toBe(result.units);
    expect(result.drafts.every((draft) => draft.reason === 'battle_loot')).toBe(true);
    expect(result.drafts.every((draft) => draft.refType === 'raid' && draft.refId === 'raid-1')).toBe(true);
    expect(result.drafts.every((draft) => draft.currency.startsWith('junk_'))).toBe(true);
    // Ключ обязан включать тип хлама: иначе все записи одного боя, кроме первой,
    // будут отброшены уникальным индексом журнала.
    expect(new Set(result.drafts.map((draft) => draft.idempotencyKey)).size).toBe(result.drafts.length);

    const store = new MemoryLedgerStore();
    await store.connect();
    const written = await store.appendMany(result.drafts.map((draft, index) => ({ ...draft, id: `l${index}` })));
    expect(written).toBe(result.drafts.length);
    // Повторная пачка (ретрай резолвера) не добавит ни одной записи.
    expect(await store.appendMany(result.drafts.map((draft, index) => ({ ...draft, id: `dup${index}` })))).toBe(0);
  });

  it('суточной лимит событий держит бота, а новый день обнуляет счётчик', () => {
    let account = newAccount(config);
    for (let i = 1; i <= 3; i += 1) {
      account = generateBattleLoot(account, { ...winReport, raidId: `raid-day-${i}` }, T0, rules, fixedRng(0.5)).account;
    }
    expect(account.loot.events).toBe(3);
    expect(errorCode(() => generateBattleLoot(account, { ...winReport, raidId: 'raid-day-4' }, T0, rules, fixedRng(0.5)))).toBe(
      ErrorCodes.LOOT_LIMIT_REACHED
    );

    const tomorrow = addMs(T0, DAY);
    const next = generateBattleLoot(account, { ...winReport, raidId: 'raid-day-4' }, tomorrow, rules, fixedRng(0.5));
    expect(next.account.loot.events).toBe(1);
    expect(next.account.loot.day).toBe(new Date(tomorrow).toISOString().slice(0, 10));
  });

  it('потолок склада хлама отправляет игрока в цех переработки', () => {
    const strict = testConfig({ JUNK_CAP: '10', LOOT_DAILY_EVENTS: '0' }).economy;
    const account = withJunk(newAccount(config), { boards: 5, chips: 5 });
    expect(errorCode(() => generateBattleLoot(account, winReport, T0, strict, fixedRng(0.5)))).toBe(
      ErrorCodes.JUNK_CAP_REACHED
    );
    // Отказ не начислил ни единицы хлама.
    expect(junkTotal(account.junk)).toBe(10);
  });
});

describe('боевой лут: антифрод и валидация отчёта', () => {
  it('повторный отчёт того же боя — DUPLICATE_ORDER', () => {
    const first = generateBattleLoot(newAccount(config), winReport, T0, rules, fixedRng(0.5));
    expect(
      errorCode(() => generateBattleLoot(first.account, { ...winReport, destroyed: 200 }, T0, rules, fixedRng(0.5)))
    ).toBe(ErrorCodes.DUPLICATE_ORDER);
  });

  it('мусорный отчёт отклоняется до начисления', () => {
    const account = newAccount(config);
    const cases = [
      { raidId: '', outcome: 'win', destroyed: 1 },
      { raidId: '   ', outcome: 'win', destroyed: 1 },
      { raidId: 'raid-x', outcome: 'surrender', destroyed: 1 },
      { raidId: 'raid-x', outcome: 'win', destroyed: -1 },
      { raidId: 'raid-x', outcome: 'win', destroyed: 1.5 },
      { raidId: 'raid-x', outcome: 'win', destroyed: 10_000 }
    ];

    for (const report of cases) {
      expect(errorCode(() => generateBattleLoot(account, report, T0, rules, fixedRng(0.5)))).toBe(
        ErrorCodes.INVALID_BATTLE_REPORT
      );
    }
    expect(junkTotal(account.junk)).toBe(0);
  });

  it('в журнале видно исход и масштаб боя — это читает антифрод', () => {
    const result = generateBattleLoot(newAccount(config), { raidId: 'raid-meta', outcome: 'draw', destroyed: 30 }, T0, rules, fixedRng(0.5));
    const draft = result.drafts[0];
    expect(draft?.meta).toMatchObject({ outcome: 'draw', destroyed: 30, multiplier: 0.5 });
    expect(draft?.idempotencyKey).toContain('raid-meta');
  });

  it('resetLootDay обнуляет счётчик нового дня', () => {
    const account = generateBattleLoot(newAccount(config), winReport, T0, rules, fixedRng(0.5)).account;
    expect(account.loot.events).toBe(1);

    const reset = resetLootDay(account, addMs(T0, DAY));
    expect(reset.loot).toMatchObject({ events: 0, totalUnits: 0, lastRaidId: null });
    // То же время — тот же объект, без лишней аллокации (идемпотентность тика).
    expect(resetLootDay(account, T0)).toBe(account);
  });
});

