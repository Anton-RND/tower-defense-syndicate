import { describe, expect, it } from 'vitest';

import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { saveLayout } from '../src/modules/pvp/defense.js';
import { bandFor, defenderLabel, findOpponent } from '../src/modules/pvp/matchmaking.js';
import {
  applyRaidToDefender,
  assertAttackable,
  attacksRemainingToday,
  attacksToday,
  commitRaid,
  grantDefenderLoot,
  makeRaidId,
  mirrorOutcome,
  resolveRaid,
  type RaidInput
} from '../src/modules/pvp/raid.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { ATTACK_ENERGY_COST, MATCH_BAND_START, OUTCOME_STEAL_FACTOR, RAID_FUEL_HORIZON_MS } from '../src/config/pvp.js';
import { STANIUM_SPEED_MULTIPLIER } from '../src/config/materials.js';
import { T0, addMs, entitlement, errorCode, fixedRng, HOUR, itemOf, MINUTE, newAccount, testConfig, withJunk, withMined, withMetals, withPvp, withResources, withStaniumField, withStorages } from './fixtures.js';
import { junkTotal, type MaterialCost } from '../src/config/workshop.js';

/**
 * Рейд (Шаг 4): подбор соперника, расчёт боя и запись на два документа.
 *
 * Здесь проверяются не столько числа (ими заведует pvp.battle.test), сколько границы
 * ответственности: кто имеет право начать бой, что происходит при повторе, и что
 * НЕ меняется у защитника. Последний пункт — главный инвариант асинхронного PvP:
 * проигравший защитник не должен просыпаться с разграбленной картой.
 */

const config = testConfig();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${++seq}`;

const cells = (list: Array<[number, number]>) => list.map(([x, y]) => ({ x, y }));

function rich(account: UserAccount): UserAccount {
  return withMetals(
    withResources(account, { energy: 100, ferrum: 1_000_000, silicium: 1_000_000, uranium: 100_000, plasma: 100_000 }),
    { black_metal: 100_000, colored_metal: 100_000, precious_metal: 100_000 }
  );
}

/** Защитник с живой обороной: одна башня — и база уже осмысленная цель для рейда. */
function makeDefender(socialId: string, rating = 1000): UserAccount {
  const tower = itemOf('tower_laser_mk1');
  const account = { ...rich(newAccount(config, T0, socialId)), inventory: [tower] };
  const saved = saveLayout(account, { units: [{ itemId: tower.id, x: 6, y: 6 }] }, T0).account;
  return withPvp(saved, { rating });
}

function makeAttacker(socialId: string, codes: string[], rating = 1000): UserAccount {
  const account = { ...rich(newAccount(config, T0, socialId)), inventory: codes.map((code) => itemOf(code)) };
  return withPvp(account, { rating });
}

function shielded(account: UserAccount, ms = 3600_000): UserAccount {
  return {
    ...account,
    entitlements: [...account.entitlements, entitlement({ kind: 'shield', permanent: false, expiresAt: addMs(T0, ms) })]
  };
}

function raidInput(attacker: UserAccount, defender: UserAccount, overrides: Partial<RaidInput> = {}): RaidInput {
  return {
    attackerId: attacker.id,
    defender,
    armyItemIds: attacker.inventory.map((item) => item.id),
    raidId: makeRaidId(attacker.id, defender.id, '1'),
    now: T0,
    config: config.economy,
    rng: fixedRng(0.9),
    ...overrides
  };
}

describe('pvp/raid: допуск к бою', () => {
  it('атака на самого себя отвергается', () => {
    const solo = makeDefender('1');
    const code = errorCode(() =>
      assertAttackable({ attacker: solo, defender: solo, now: T0, config: config.economy })
    );
    expect(code).toBe(ErrorCodes.SELF_ATTACK);
  });

  it('«Щит покоя» защитника снимает его с подбора и от существующей атаки', () => {
    const defender = shielded(makeDefender('2'));
    const attacker = makeAttacker('3', ['drone_cargo_mk1']);
    expect(errorCode(() => assertAttackable({ attacker, defender, now: T0, config: config.economy }))).toBe(
      ErrorCodes.OPPONENT_SHIELDED
    );
    // Щит истёк — база снова законная цель.
    const expired = shielded(makeDefender('4'), -1000);
    expect(() => assertAttackable({ attacker, defender: expired, now: T0, config: config.economy })).not.toThrow();
  });

  it('непроходимая база защитника — отказ, а не бой вслепую', () => {
    const tower = itemOf('tower_laser_mk1');
    const owner = { ...rich(newAccount(config, T0, '5')), inventory: [tower] };
    // Замурованный штаб: Шаг 3 такое сохраняет (нарушение проходимости, не модели данных).
    const sealed = saveLayout(owner, { walls: cells([[6, 7], [8, 7], [7, 6], [7, 8]]) }, T0).account;
    const attacker = makeAttacker('6', ['drone_cargo_mk1']);
    expect(errorCode(() => assertAttackable({ attacker, defender: sealed, now: T0, config: config.economy }))).toBe(
      ErrorCodes.OPPONENT_UNREADY
    );
  });

  it('суточный потолок атак держит, а смена суток обнуляет счётчик', () => {
    const limited = testConfig({ PVP_DAILY_ATTACKS: '2' });
    const attacker = withPvp(makeAttacker('7', ['drone_cargo_mk1']), { day: '2026-10-18', attacksToday: 2 });
    const defender = makeDefender('8');
    expect(attacksRemainingToday(attacker, T0, limited.economy)).toBe(0);
    expect(errorCode(() => assertAttackable({ attacker, defender, now: T0, config: limited.economy }))).toBe(
      ErrorCodes.ATTACK_LIMIT_REACHED
    );
    // Новый день: тот же документ, но счётчик уже не в счёт (ленивый сброс, как у ассистов).
    expect(attacksToday(attacker, addMs(T0, 24 * 3600_000))).toBe(0);
    expect(attacksRemainingToday(attacker, addMs(T0, 24 * 3600_000), limited.economy)).toBe(2);
  });

  it('нулевой лимит в конфиге означает «не ограничивать»', () => {
    const unlimited = testConfig({ PVP_DAILY_ATTACKS: '0' });
    const attacker = withPvp(makeAttacker('9', ['drone_cargo_mk1']), { day: '2026-10-18', attacksToday: 999 });
    expect(attacksRemainingToday(attacker, T0, unlimited.economy)).toBe(-1);
    expect(() =>
      assertAttackable({ attacker, defender: makeDefender('10'), now: T0, config: unlimited.economy })
    ).not.toThrow();
  });
});

describe('pvp/raid: расчёт боя', () => {
  it('энергия списывается, счётчики и рейтинг двигаются, бой идемпотентен по raidId', () => {
    const attacker = makeAttacker('11', ['drone_strike_mk2', 'drone_cargo_mk1']);
    const defender = makeDefender('12');
    const result = resolveRaid(attacker, raidInput(attacker, defender));

    expect(result.attacker.resources.energy).toBe(100 - ATTACK_ENERGY_COST);
    expect(result.energy.cost).toBe(ATTACK_ENERGY_COST);
    expect(result.attacker.pvp).toMatchObject({
      battles: 1,
      attacksToday: 1,
      lastRaidId: result.raidId,
      wins: result.battle.outcome === 'win' ? 1 : 0,
      losses: result.battle.outcome === 'loss' ? 1 : 0,
      draws: result.battle.outcome === 'draw' ? 1 : 0
    });
    // Эло в паре: сумма дельт нулевая, система не печатает рейтинг.
    expect(result.rating.attacker.delta + result.rating.defender.delta).toBe(0);
    expect(result.attacker.pvp.rating).toBe(attacker.pvp.rating + result.rating.attacker.delta);
    expect(result.attacker.pvp.bestRating).toBe(Math.max(attacker.pvp.rating, result.attacker.pvp.rating));
  });

  it('лут и трофеи идут через журнал: по черновику на каждое движение', () => {
    const attacker = makeAttacker('13', ['drone_strike_mk2', 'drone_strike_mk2']);
    const defender = withMined(makeDefender('14'), { ferrum: 1000, silicium: 500 });
    const result = resolveRaid(attacker, raidInput(attacker, defender));

    const reasons = new Set(result.drafts.map((draft) => draft.reason));
    expect(reasons.has('battle_loot')).toBe(true);
    // Трофеи (п.4.1) — только несобранные склады защитника: lootShare × множитель исхода.
    const share = config.economy.lootShare * OUTCOME_STEAL_FACTOR[result.battle.outcome];
    expect(result.stolen.ferrum).toBe(Math.floor(1000 * share));
    if (result.stolen.ferrum > 0) expect(reasons.has('raid_loot')).toBe(true);
    expect(result.attacker.resources.ferrum).toBe(attacker.resources.ferrum + result.stolen.ferrum);
    expect(result.drafts.every((draft) => draft.idempotencyKey !== null)).toBe(true);
    // Повтор того же боя на УЖЕ обновлённом атакующем (raidId в lastRaidId) — отказ
    // резолвера лута, а не второй лут. Именно на этом держатся ретраи клиента.
    expect(errorCode(() => resolveRaid(result.attacker, raidInput(attacker, defender)))).toBe(
      ErrorCodes.DUPLICATE_ORDER
    );
  });

  it('не хватает энергии — рейда нет: ни списаний, ни журнала, ни боя', () => {
    const attacker = withResources(makeAttacker('15', ['drone_cargo_mk1']), { energy: 1 });
    const defender = makeDefender('16');
    expect(errorCode(() => resolveRaid(attacker, raidInput(attacker, defender)))).toBe(
      ErrorCodes.INSUFFICIENT_ENERGY
    );
  });

  it('разрушения не переносятся в базу защитника: карта после боя идентична', () => {
    const attacker = makeAttacker('17', ['drone_cerberus_mk3', 'drone_strike_mk2']);
    const defender = makeDefender('18');
    const result = resolveRaid(attacker, raidInput(attacker, defender));

    expect(result.defender.base).toEqual(defender.base);
    expect(result.defender.inventory).toEqual(defender.inventory);
    // Теряет он только склады и рейтинг — всё остальное при нём.
    expect(result.defender.pvp.battles).toBe(defender.pvp.battles + 1);
  });

  it('станиумное поле защитника замедляет рой: множитель считается по часам рейда', () => {
    const attacker = makeAttacker('25', ['drone_cargo_mk1', 'drone_cargo_mk1']);
    const plain = makeDefender('26');
    const guarded = withStaniumField(plain, addMs(T0, 60 * MINUTE));

    const without = resolveRaid(attacker, raidInput(attacker, plain));
    const withField = resolveRaid(attacker, raidInput(attacker, guarded));

    expect(without.battle.attackerSpeedMultiplier).toBe(1);
    expect(withField.battle.attackerSpeedMultiplier).toBe(STANIUM_SPEED_MULTIPLIER);
    // Поле покупает обороне время, а не право не получать урон: состав армии тот же.
    expect(withField.battle.robots.deployed).toBe(without.battle.robots.deployed);

    // Модуль истёк к моменту боя — атака идёт с полной скоростью: срок проверяется по
    // `now` рейда, а не по факту «игрок когда-то зарядил модуль».
    const late = resolveRaid(attacker, raidInput(attacker, guarded, { now: addMs(T0, 2 * HOUR) }));
    expect(late.battle.attackerSpeedMultiplier).toBe(1);

    // Сам рейд не трогает ни станиум, ни срок модуля: оборона для боя — читаемое состояние.
    expect(withField.defender.materials.stanium).toBe(guarded.materials.stanium);
    expect(withField.defender.materials.staniumFieldUntil).toEqual(guarded.materials.staniumFieldUntil);
  });
});

describe('pvp/raid: редуктор защитника', () => {
  it('считается от ТЕКУЩЕГО состояния, а не от прочитанного бойцом снапшота', () => {
    const attacker = makeAttacker('19', ['drone_strike_mk2', 'drone_strike_mk2']);
    const snapshot = withMined(makeDefender('20'), { ferrum: 1000 });
    const result = resolveRaid(attacker, raidInput(attacker, snapshot));

    // Пока шёл бой, защитник собрал склады: редуктор обязан вычесть не больше остатка.
    const collected = withMined(snapshot, { ferrum: 0 });
    const applied = applyRaidToDefender(collected, result, T0);
    expect(applied.storages.ferrum).toBe(0);
    expect(applied.storages.ferrum).not.toBeLessThan(0);
  });

  it('рейтинг двигается дельтой: параллельный бой другого атакующего не теряется', () => {
    const attacker = makeAttacker('21', ['drone_cargo_mk1']);
    const snapshot = makeDefender('22', 1000);
    const result = resolveRaid(attacker, raidInput(attacker, snapshot));
    const concurrent = withPvp(snapshot, { rating: 1100 });

    const applied = applyRaidToDefender(concurrent, result, T0);
    expect(applied.pvp.rating).toBe(1100 + result.rating.defender.delta);
  });

  it('исход защитника зеркален атакующему: его победа — поражение рейдера', () => {
    const attacker = makeAttacker('23', ['drone_cargo_mk1']);
    const defender = makeDefender('24');
    const result = resolveRaid(attacker, raidInput(attacker, defender));
    const applied = applyRaidToDefender(defender, result, T0);

    expect(applied.pvp.wins).toBe(result.battle.outcome === 'loss' ? 1 : 0);
    expect(applied.pvp.losses).toBe(result.battle.outcome === 'win' ? 1 : 0);
    expect(applied.pvp.draws).toBe(result.battle.outcome === 'draw' ? 1 : 0);
    expect(applied.pvp.streak).toBe(result.battle.outcome === 'loss' ? 1 : 0);
  });
});

describe('pvp/matchmaking: подбор соперника', () => {
  it('коридор расширяется по попыткам, начинаясь с MATCH_BAND_START', () => {
    expect(bandFor(0)).toBe(MATCH_BAND_START);
    expect(bandFor(1)).toBeGreaterThan(bandFor(0));
    expect(bandFor(2)).toBeGreaterThan(bandFor(1));
  });

  it('берёт игрока с проходимой базой, исключая себя, щитоносцев и мёртвые лабиринты', async () => {
    const store = new MemoryUserStore();
    const attacker = makeAttacker('40', ['drone_cargo_mk1'], 1000);
    const ready = makeDefender('41', 1010);
    const withShield = shielded(makeDefender('42', 1005));
    const tower = itemOf('tower_laser_mk1');
    const sealedOwner = { ...rich(newAccount(config, T0, '43')), inventory: [tower] };
    const sealed = saveLayout(sealedOwner, { walls: cells([[6, 7], [8, 7], [7, 6], [7, 8]]) }, T0).account;

    for (const account of [attacker, ready, withShield, sealed]) await store.save(account);

    const pick = await findOpponent(store, attacker, { now: T0, rng: fixedRng(0) });
    expect(pick.defender.id).toBe(ready.id);
    expect(pick.attempt).toBe(0);
    expect(pick.report.ready).toBe(true);
  });

  it('расширяет коридор, если равных нет: дальний соперник находится на поздней попытке', async () => {
    const store = new MemoryUserStore();
    const attacker = makeAttacker('44', ['drone_cargo_mk1'], 1000);
    const far = makeDefender('45', 1400);
    await store.save(attacker);
    await store.save(far);

    const pick = await findOpponent(store, attacker, { now: T0, rng: fixedRng(0) });
    expect(pick.defender.id).toBe(far.id);
    expect(pick.attempt).toBeGreaterThan(0);
    expect(pick.band).toBeGreaterThanOrEqual(400);
  });

  it('NO_OPPONENT, когда в расширенном коридоре некого брать', async () => {
    const store = new MemoryUserStore();
    const attacker = makeAttacker('46', ['drone_cargo_mk1'], 1000);
    await store.save(attacker);

    let code: string | undefined;
    try {
      await findOpponent(store, attacker, { now: T0, rng: fixedRng(0) });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe(ErrorCodes.NO_OPPONENT);
  });

  it('ярлык защитника стабилен и не содержит персональных данных', () => {
    const defender = makeDefender('47');
    const label = defenderLabel(defender);
    expect(label).toBe(defenderLabel(defender));
    expect(label).not.toContain(defender.socialId);
    expect(label).not.toContain(defender.id);
    expect(label.startsWith('Игрок #')).toBe(true);
  });
});

describe('pvp/raid: запись на два документа', () => {
  async function seeded(): Promise<{ store: MemoryUserStore; ledger: MemoryLedgerStore; attacker: UserAccount; defender: UserAccount }> {
    const store = new MemoryUserStore();
    const ledger = new MemoryLedgerStore();
    const attacker = makeAttacker('50', ['drone_strike_mk2', 'drone_strike_mk2']);
    const defender = withMined(makeDefender('51'), { ferrum: 1000 });
    await store.save(attacker);
    await store.save(defender);
    return { store, ledger, attacker, defender };
  }

  it('commitRaid пишет обоих игроков и журнал', async () => {
    const { store, ledger, attacker, defender } = await seeded();
    const commit = await commitRaid(raidInput(attacker, defender), {
      store,
      ledger,
      idFactory: () => nextId('led')
    });

    expect(commit.defenderCommitted).toBe(true);

    const storedAttacker = await store.findById(attacker.id);
    const storedDefender = await store.findById(defender.id);
    expect(storedAttacker?.pvp.battles).toBe(1);
    expect(storedAttacker?.resources.energy).toBeLessThan(attacker.resources.energy);
    expect(storedAttacker?.loot.lastRaidId).toBe(commit.result.raidId);
    // Карта защитника не пострадала — главный инвариант асинхронного PvP (Шаг 4).
    expect(storedDefender?.base).toEqual(defender.base);
    expect(storedDefender?.storages.ferrum).toBeLessThanOrEqual(defender.storages.ferrum);
    expect(storedDefender?.pvp.rating).toBe(defender.pvp.rating + commit.result.rating.defender.delta);

    expect(await ledger.count(attacker.id)).toBeGreaterThan(0);
    if (commit.result.stolen.ferrum > 0) {
      expect((await ledger.list(attacker.id, { reasons: ['raid_loot'] })).length).toBeGreaterThan(0);
    }
  });

  it('ретрай того же боя не выдаёт лут и рейтинг второй раз', async () => {
    const { store, ledger, attacker, defender } = await seeded();
    const input = raidInput(attacker, defender);
    await commitRaid(input, { store, ledger, idFactory: () => nextId('led') });

    const before = await store.findById(attacker.id);
    let code: string | undefined;
    try {
      await commitRaid(input, { store, ledger, idFactory: () => nextId('led') });
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe(ErrorCodes.DUPLICATE_ORDER);
    const after = await store.findById(attacker.id);
    expect(after?.pvp).toEqual(before?.pvp);
    expect(after?.junk).toEqual(before?.junk);
  });

  it('провал записи защитника не откатывает бой атакующего и помечается флагом', async () => {
    const store = new MemoryUserStore();
    const ledger = new MemoryLedgerStore();
    const attacker = makeAttacker('52', ['drone_strike_mk2']);
    // Защитника в сторе нет: его документ удалили между подбором и записью.
    const defender = makeDefender('53');
    await store.save(attacker);

    let errors = 0;
    const commit = await commitRaid(raidInput(attacker, defender), {
      store,
      ledger,
      idFactory: () => nextId('led'),
      onDefenderError: () => {
        errors += 1;
      }
    });

    expect(commit.defenderCommitted).toBe(false);
    expect(errors).toBe(1);
    // Бой засчитан: энергию и лут атакующего не отыгрывают назад — иначе ретрай
    // клиента стал бы вторым боем, а «проигравший» защитник остался бы без потерь
    // и без уведомления.
    expect((await store.findById(attacker.id))?.pvp.battles).toBe(1);
  });
});

describe('pvp/raid: лут защитника за сбитую технику', () => {
  /** Подставляем заведомое число сожжённых дронов: исход боя предсказывать незачем. */
  function withKills(result: ReturnType<typeof resolveRaid>, lost: number): ReturnType<typeof resolveRaid> {
    return { ...result, battle: { ...result.battle, robots: { ...result.battle.robots, lost } } };
  }

  const lootUnits = (loot: MaterialCost): number =>
    Object.values(loot).reduce((total, value) => total + (value ?? 0), 0);

  it('исход зеркален: победа атакующего — поражение хозяина базы', () => {
    expect(mirrorOutcome('win')).toBe('loss');
    expect(mirrorOutcome('loss')).toBe('win');
    expect(mirrorOutcome('draw')).toBe('draw');
  });

  it('защитник получает хлам за сбитые дроны, а не только теряет склады', () => {
    const defender = makeDefender('80');
    const attacker = makeAttacker('81', ['drone_cargo_mk1']);
    const result = resolveRaid(attacker, raidInput(attacker, defender));
    const granted = grantDefenderLoot(defender, withKills(result, 20), T0, config.economy, fixedRng(0.9));

    expect(granted.skipped).toBeNull();
    expect(junkTotal(granted.account.junk)).toBeGreaterThan(0);
    expect(granted.drafts.length).toBeGreaterThan(0);
    expect(granted.drafts.every((draft) => draft.userId === defender.id)).toBe(true);
    expect(granted.drafts.every((draft) => draft.reason === 'battle_loot')).toBe(true);
    expect(granted.drafts.every((draft) => draft.currency.startsWith('junk_'))).toBe(true);
  });

  it('переполненный склад хлама не отменяет бой: лут просто не выдан', () => {
    const strict = testConfig({ JUNK_CAP: '4' }).economy;
    const defender = withJunk(makeDefender('82'), { chips: 4 });
    const attacker = makeAttacker('83', ['drone_cargo_mk1']);
    const result = resolveRaid(attacker, raidInput(attacker, defender));
    const granted = grantDefenderLoot(defender, withKills(result, 20), T0, strict, fixedRng(0.9));

    // Отказ — это `skipped`, а не исключение: бой уже засчитан атакующему, и
    // выбросить здесь сломало бы ему рейтинг и списание складов из-за чужого переполнения.
    expect(granted.skipped).toBe(ErrorCodes.JUNK_CAP_REACHED);
    expect(granted.drafts).toEqual([]);
    expect(granted.account).toBe(defender);
  });

  it('повтор того же боя не выдаёт защитнику второй комплект обломков', () => {
    const defender = makeDefender('84');
    const attacker = makeAttacker('85', ['drone_cargo_mk1']);
    const result = resolveRaid(attacker, raidInput(attacker, defender));
    const killed = withKills(result, 20);
    const first = grantDefenderLoot(defender, killed, T0, config.economy, fixedRng(0.9));
    const second = grantDefenderLoot(first.account, killed, T0, config.economy, fixedRng(0.9));

    expect(second.skipped).toBe(ErrorCodes.DUPLICATE_ORDER);
    expect(second.account.junk).toEqual(first.account.junk);
  });

  it('commitRaid кладёт хлам в живой документ защитника, а дельта равна отчету', async () => {
    const store = new MemoryUserStore();
    const ledger = new MemoryLedgerStore();
    const attacker = makeAttacker('86', ['drone_strike_mk2', 'drone_strike_mk2']);
    const defender = withMined(makeDefender('87'), { ferrum: 1000 });
    await store.save(attacker);
    await store.save(defender);

    const commit = await commitRaid(raidInput(attacker, defender), {
      store,
      ledger,
      idFactory: () => nextId('led')
    });
    expect(commit.defenderCommitted).toBe(true);
    expect(commit.defenderLootSkipped).toBeNull();

    const stored = await store.findById(defender.id);
    if (!stored) throw new Error('документ защитника пропал');
    expect(junkTotal(stored.junk) - junkTotal(defender.junk)).toBe(lootUnits(commit.defenderLoot));
    // Ровно по одной записи на каждый выданный вид хлама — ни лишних, ни потерянных.
    expect(await ledger.count(defender.id)).toBe(Object.keys(commit.defenderLoot).length);
  });

  it('провал записи защитника не оставляет движения без факта', async () => {
    const store = new MemoryUserStore();
    const ledger = new MemoryLedgerStore();
    const attacker = makeAttacker('88', ['drone_strike_mk2']);
    const defender = makeDefender('89');
    await store.save(attacker); // защитника в сторе нет — его удалили между подбором и записью

    const commit = await commitRaid(raidInput(attacker, defender), {
      store,
      ledger,
      idFactory: () => nextId('led'),
      onDefenderError: () => {}
    });

    expect(commit.defenderCommitted).toBe(false);
    expect(commit.defenderLoot).toEqual({});
    expect(commit.defenderLootSkipped).toBe('defender_write_failed');
    expect(await ledger.count(defender.id)).toBe(0);
  });
});

describe('pvp/raid: топливо тяжёлой техники', () => {
  /**
   * Защитник с автономной техникой. Сеть ему не нужна вовсе: у рельсотрона свой
   * реактор, и единственная его граница — бак. Это и проверяется: базы без
   * генерации обязаны уметь держать тяжёлую оборону, иначе «поставь рейлган» стало бы
   * требованием построить весь крио-контур ради одного орудия.
   */
  function heavyDefender(socialId: string, codes: string[], deuterium: number): UserAccount {
    const items = codes.map((code) => itemOf(code));
    let account = withStorages(
      { ...rich(newAccount(config, T0, socialId)), inventory: items },
      { deuterium, plasma: 10_000, nitrogen: 10_000 }
    );
    account = saveLayout(
      account,
      { units: items.map((item, index) => ({ itemId: item.id, x: 5 + index * 3, y: 5 })) },
      T0
    ).account;
    return withPvp(account, { rating: 1000 });
  }

  it('автономная оборона сжигает дейтерий по факту боя, а не по резерву', () => {
    const defender = heavyDefender('60', ['weapon_railgun_mk3'], 1000);
    const attacker = makeAttacker('61', ['drone_strike_mk2', 'drone_strike_mk2']);
    const result = resolveRaid(attacker, raidInput(attacker, defender));

    const burned = result.battle.fuel.defenderDeuterium;
    expect(burned).toBeGreaterThan(0);
    // 18 ед/ч × длительность боя. Горизонт резерва — 180 с (0,9 ед.), и фактический
    // расход обязан быть не больше: платить за секунды, которых не было, нельзя.
    expect(burned).toBeLessThanOrEqual(18 * (RAID_FUEL_HORIZON_MS / 3_600_000));
    expect(result.defender.storages.deuterium).toBeCloseTo(1000 - burned, 6);
  });

  it('списание защитнику идёт дельтой, а не записью снимка', () => {
    // Пока атакующий бился, хозяин базы мог наполнить цистерну. Слепая запись
    // вернула бы ему «деутерий из момента подбора» и стёрла бы приход (см. шапку
    // applyRaidToDefender).
    const defender = heavyDefender('62', ['weapon_railgun_mk3'], 1000);
    const attacker = makeAttacker('63', ['drone_strike_mk2', 'drone_strike_mk2']);
    const result = resolveRaid(attacker, raidInput(attacker, defender));
    const burned = result.battle.fuel.defenderDeuterium;

    const refilled = withStorages(defender, { deuterium: 5000 });
    const applied = applyRaidToDefender(refilled, result, T0);
    expect(applied.storages.deuterium).toBeCloseTo(5000 - burned, 6);
  });

  it('глухая от топлива оборона ничего не сжигает', () => {
    // Бак пуст → техника не в строю → расхода нет. Проверка обратной стороны:
    // списание не должно превратиться в «плату за наличие башни на карте».
    const defender = heavyDefender('64', ['weapon_railgun_mk3'], 0);
    const attacker = makeAttacker('65', ['drone_strike_mk2', 'drone_strike_mk2']);
    const result = resolveRaid(attacker, raidInput(attacker, defender));
    expect(result.battle.fuel.defenderDeuterium).toBe(0);
    expect(result.battle.power.unpowered).toBe(1);
  });

  it('атакующий платит дейтерием за автономных дронов', () => {
    const attacker = withStorages(makeAttacker('66', ['drone_cerberus_mk3']), { deuterium: 1000 });
    const defender = makeDefender('67');
    const result = resolveRaid(attacker, raidInput(attacker, defender));

    const burned = result.battle.fuel.attackerDeuterium;
    expect(burned).toBeGreaterThan(0);
    expect(result.attacker.storages.deuterium).toBeCloseTo(1000 - burned, 6);
    // Лут и топливо независимы: сгоревший дейтерий не вычитается из трофеев.
    expect(result.attacker.resources.ferrum).toBeGreaterThanOrEqual(attacker.resources.ferrum);
  });

  it('рейда без топлива не бывает: рой не вылетает и энергия не списывается', () => {
    // Порядок шагов в резолвере значим: состав армии проверяется ДО списания энергии,
    // иначе игрок терял бы 15 энергии за рейд, которого не было.
    const attacker = withStorages(makeAttacker('68', ['drone_cerberus_mk3']), { deuterium: 0 });
    const defender = makeDefender('69');
    const before = attacker.resources.energy;
    const failure = errorCode(() => resolveRaid(attacker, raidInput(attacker, defender)));
    expect(failure).toBe(ErrorCodes.ARMY_INVALID);
    expect(attacker.resources.energy).toBe(before);
  });
});

