import { describe, expect, it } from 'vitest';

import { SPAWN_CELLS, type Cell } from '../src/config/base.js';
import type { StructureId } from '../src/config/structures.js';
import type { StorageId } from '../src/config/storage.js';
import {
  ATTACK_MAX_ROBOTS,
  DRAW_HQ_DAMAGE_RATIO,
  HQ_HP,
  SIM_MAX_EVENTS,
  SIM_MAX_TICKS,
  THERMAL,
  WALL_HP,
  defenseProfileOf,
  robotProfileOf
} from '../src/config/pvp.js';
import { BLUEPRINTS, getBlueprint } from '../src/config/workshop.js';
import { STANIUM_SPEED_MULTIPLIER } from '../src/config/materials.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { defenseSnapshot, resolveArmy, simulateBattle } from '../src/modules/pvp/battle.js';
import { saveLayout } from '../src/modules/pvp/defense.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { T0, itemOf, newAccount, testConfig, withMetals, withResources, withStorages, withStructures } from './fixtures.js';

/**
 * Симуляция боя (Шаг 4).
 *
 * Проверяются четыре вещи, без которых PvP не работает:
 *  1. детерминированность — одинаковый вход даёт побитово одинаковый отчёт;
 *  2. завершаемость — бой заканчивается за конечное число шагов ЛЮБОЙ базе, включая
 *     намеренно замурованный штаб (непроходимые базы Шаг 3 сохраняет, значит резолвер
 *     обязан уметь воевать и с ними);
 *  3. состав армии считается из инвентаря, а не из слов клиента;
 *  4. боевые профили есть у каждого чертежа каталога (новый чертёж с нулевым уроном —
 *     это непобедимая башня, и ловить её надо на тесте, а не в проде).
 */

const config = testConfig();

const cells = (list: Array<[number, number]>): Cell[] => list.map(([x, y]) => ({ x, y }));

/**
 * Энергетический минимум, которым обязана обладать фикстура «оборона».
 *
 * До интеграции с сетью оборона в этих тестах была просто списком башен, и этого
 * хватало: бой в энергосистему не заглядывал. Теперь заглядывает обязательно —
 * башня без питания глуха (см. DefenseTower.powered), а тяжёлая техника без
 * дейтерия не выезжает. Значит тест «сильная оборона сбивает слабый рейд» обязан
 * описать ЕЩЁ и то, чем эта оборона кормится; иначе он проверяет не свою мысль, а
 * случайность: четыре турели не выстрелили ни разу потому, что игрок не построил
 * реактор, и падение исхода ('army' → 'hq') объясняется чем угодно, кроме баланса.
 *
 * Расчёт под максимальную нагрузку этих тестов: 4 × tower_plasma_mk3 = 360 кВт и
 * 240 кВт-тепла, плюс 150 кВт тепла от самого конвертера. Один Mk.III (800 кВт)
 * закрывает мощность с четырёхкратным запасом, четыре Mk.II-кулера (400 кВт) —
 * теплоотвод за вычетом пассивного радиатора штаба (45 кВт).
 */
const POWERED: { structures: Partial<Record<StructureId, number>>; storages: Partial<Record<StorageId, number>> } = {
  structures: { reactor_plasma_mk3: 1, cooler_loop_mk2: 4 },
  storages: { plasma: 10_000, nitrogen: 10_000, deuterium: 10_000 }
};

/** Защитник с деньгами на стены, заданной планировкой и заведомо рабочей сетью. */
function defenderWith(input: {
  walls?: Cell[];
  units?: Array<{ code: string; x: number; y: number; level?: number }>;
  /** Переопределить энергоснабжение: для тестов «оборона без света». */
  structures?: Partial<Record<StructureId, number>>;
  storages?: Partial<Record<StorageId, number>>;
}): UserAccount {
  let account = withMetals(
    withResources(newAccount(config, T0, '900'), { energy: 100, ferrum: 1_000_000, silicium: 1_000_000, uranium: 100_000, plasma: 100_000 }),
    { black_metal: 100_000, colored_metal: 100_000, precious_metal: 100_000 }
  );
  account = withStructures(account, input.structures ?? POWERED.structures);
  account = withStorages(account, input.storages ?? POWERED.storages);
  if (input.units && input.units.length > 0) {
    account = { ...account, inventory: input.units.map((unit) => itemOf(unit.code, unit.level ?? 1)) };
  }
  return saveLayout(
    account,
    {
      walls: input.walls ?? [],
      units: (input.units ?? []).map((unit, index) => ({
        itemId: account.inventory[index]?.id ?? '',
        x: unit.x,
        y: unit.y
      }))
    },
    T0
  ).account;
}

/** Атакующий: армия — это предметы его инвентаря, поэтому фикстура кладёт дроны туда. */
function armyOf(codes: string[], storages: Partial<Record<StorageId, number>> = {}): UserAccount {
  const account = withResources(newAccount(config, T0, '902'), { energy: 100 });
  return {
    ...account,
    inventory: codes.map((code) => itemOf(code)),
    // Бак по умолчанию полный. Тяжёлые дроны летят только с зарезервированным на весь
    // горизонт топливом (resolveArmy → fuelAvailability), и тестам про спавн, маршрут
    // и исход безразлично, ЧЕМ заправлен рой, но не безразлично, что он вылетел.
    // Пустой бак передаётся явным аргументом там, где проверяется именно он.
    storages: { ...account.storages, deuterium: 10_000, ...storages }
  };
}

/** И код ошибки, и машинный reason из details. */
function failure(fn: () => unknown): { code?: string; reason?: string } {
  try {
    fn();
    return {};
  } catch (error) {
    const candidate = error as { code?: string; details?: { reason?: string } };
    return { code: candidate.code, reason: candidate.details?.reason };
  }
}

describe('pvp/battle: профили единиц', () => {
  it('у каждого чертежа каталога есть боевой профиль по его роли', () => {
    for (const blueprint of BLUEPRINTS) {
      const profile =
        blueprint.kind === 'drone' ? robotProfileOf({ code: blueprint.code, level: 1 }) : defenseProfileOf({ code: blueprint.code, level: 1 });
      expect(profile, `чертёж ${blueprint.code} без боевого профиля`).not.toBeNull();
      expect(profile?.dps ?? 0).toBeGreaterThan(0);
      expect(profile?.hp ?? 0).toBeGreaterThan(0);
    }
  });

  it('силы растут с тиром: и у обороны, и у дронов', () => {
    const lasers = [
      defenseProfileOf({ code: 'tower_laser_mk1', level: 1 }),
      defenseProfileOf({ code: 'tower_rail_mk2', level: 1 }),
      defenseProfileOf({ code: 'tower_plasma_mk3', level: 1 })
    ];
    for (let index = 1; index < lasers.length; index += 1) {
      expect(lasers[index]?.dps ?? 0).toBeGreaterThan(lasers[index - 1]?.dps ?? 0);
      expect(lasers[index]?.hp ?? 0).toBeGreaterThan(lasers[index - 1]?.hp ?? 0);
    }
    const drones = ['drone_cargo_mk1', 'drone_strike_mk2', 'drone_cerberus_mk3'].map((code) =>
      robotProfileOf({ code, level: 1 })
    );
    for (let index = 1; index < drones.length; index += 1) {
      expect(drones[index]?.hp ?? 0).toBeGreaterThan(drones[index - 1]?.hp ?? 0);
    }
  });

  it('уровень предмета увеличивает урон и прочность, но не радиус', () => {
    const one = defenseProfileOf({ code: 'tower_laser_mk1', level: 1 });
    const three = defenseProfileOf({ code: 'tower_laser_mk1', level: 3 });
    expect(three?.dps ?? 0).toBeGreaterThan(one?.dps ?? 0);
    expect(three?.hp ?? 0).toBeGreaterThan(one?.hp ?? 0);
    expect(three?.range).toBe(one?.range);
  });

  it('роля не путаются: башня не воюет в атаке, дрон не стреляет в обороне', () => {
    expect(robotProfileOf({ code: 'tower_laser_mk1', level: 1 })).toBeNull();
    expect(defenseProfileOf({ code: 'drone_cargo_mk1', level: 1 })?.kind).toBe('drone');
    expect(getBlueprint('unknown_code')).toBeUndefined();
    expect(defenseProfileOf({ code: 'unknown_code', level: 1 })).toBeNull();
  });
});

describe('pvp/battle: состав армии', () => {
  it('число дронов = сумма роев предметов, а боевые цифры — из инвентаря, не из запроса', () => {
    const attacker = armyOf(['drone_strike_mk2', 'drone_cargo_mk1']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));

    // strike_mk2 — рой по 2 машины (ROBOT_OVERRIDES), cargo_mk1 — одна.
    expect(army.robots).toBe(3);
    expect(army.dps).toBeGreaterThan(0);
    // Порядок отрядов — по сортировке itemId, а не по порядку запроса: он и есть
    // очередь спавна, поэтому детерминизм здесь равен детерминизму боя.
    expect(army.squads.map((squad) => squad.itemId)).toEqual(
      [...attacker.inventory.map((item) => item.id)].sort()
    );
  });

  it('порядок itemId не влияет на состав: сортировка делает бой воспроизводимым', () => {
    const attacker = armyOf(['drone_strike_mk2', 'drone_cerberus_mk3', 'drone_cargo_mk1']);
    const ids = attacker.inventory.map((item) => item.id);
    const forward = resolveArmy(attacker, ids);
    const backward = resolveArmy(attacker, [...ids].reverse());
    expect(backward.squads).toEqual(forward.squads);
  });

  it('дубликаты itemId схлопываются: один дрон не воюет двумя корпусами', () => {
    const attacker = armyOf(['drone_strike_mk2']);
    const id = attacker.inventory[0]?.id ?? '';
    expect(resolveArmy(attacker, [id, id, id]).robots).toBe(2);
  });

  it('пустой рейд, чужой предмет и не-штурмовик отвергаются', () => {
    const attacker = armyOf(['drone_strike_mk2']);
    expect(failure(() => resolveArmy(attacker, [])).code).toBe(ErrorCodes.ARMY_INVALID);
    expect(failure(() => resolveArmy(attacker, [])).reason).toBe('empty');
    expect(failure(() => resolveArmy(attacker, ['ghost-item'])).code).toBe(ErrorCodes.ITEM_NOT_FOUND);

    // Башня — оборонительный предмет: в атаке не участвует (ATTACK_KINDS = drone).
    const towerOwner = armyOf(['drone_cargo_mk1']);
    const tower = itemOf('tower_laser_mk1');
    const withTower = { ...towerOwner, inventory: [...towerOwner.inventory, tower] };
    const result = failure(() => resolveArmy(withTower, [tower.id]));
    expect(result.code).toBe(ErrorCodes.ARMY_INVALID);
    expect(result.reason).toBe('not_attacker');
  });

  it('потолок рейда держит: больше ATTACK_MAX_ROBOTS машин не выйдет', () => {
    const codes: string[] = [];
    while (codes.length * 2 <= ATTACK_MAX_ROBOTS) codes.push('drone_strike_mk2');
    const attacker = armyOf(codes);
    const ids = attacker.inventory.map((item) => item.id);
    const result = failure(() => resolveArmy(attacker, ids));
    expect(result.code).toBe(ErrorCodes.ARMY_INVALID);
    expect(result.reason).toBe('too_large');
  });
});

describe('pvp/battle: снимок обороны', () => {
  it('призрак на карте (предмет отозван) не попадает в бой', () => {
    const defender = defenderWith({ units: [{ code: 'tower_laser_mk1', x: 6, y: 7 }] });
    expect(defenseSnapshot(defender).towers).toHaveLength(1);

    // Снимаем предмет из инвентаря, не трогая планировку: бой обязан увидеть пустую карту.
    const snapshot = defenseSnapshot({ ...defender, inventory: [] });
    expect(snapshot.towers).toHaveLength(0);
    expect(snapshot.dps).toBe(0);
  });

  it('стены читаются координатами и получают прочность из конфига', () => {
    const defender = defenderWith({ walls: cells([[5, 5], [5, 6], [6, 6]]) });
    const snapshot = defenseSnapshot(defender);
    expect(snapshot.walls).toHaveLength(3);
    expect(snapshot.walls[0]?.maxHp).toBe(WALL_HP);
  });
});

describe('pvp/battle: симуляция', () => {
  it('один и тот же вход даёт побитово одинаковый отчёт', () => {
    const defender = defenderWith({
      walls: cells([[5, 5], [5, 6], [9, 9], [10, 9]]),
      units: [
        { code: 'tower_laser_mk1', x: 6, y: 6 },
        { code: 'tower_rail_mk2', x: 9, y: 6 },
        { code: 'weapon_cannon_mk1', x: 6, y: 9 }
      ]
    });
    const attacker = armyOf(['drone_strike_mk2', 'drone_cargo_mk1']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));

    const first = simulateBattle({ defender, army });
    const second = simulateBattle({ defender, army });
    expect(second).toEqual(first);
  });

  it('пустая база падает: штаб сносится, бой заканчивается победой', () => {
    const defender = defenderWith({});
    const attacker = armyOf(['drone_strike_mk2', 'drone_strike_mk2']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    const result = simulateBattle({ defender, army });

    expect(result.outcome).toBe('win');
    expect(result.endedBy).toBe('hq');
    expect(result.hq.hp).toBe(0);
    expect(result.hq.ratio).toBe(1);
    expect(result.hq.maxHp).toBe(HQ_HP);
    expect(result.ticks).toBeLessThan(SIM_MAX_TICKS);
    // Штаб — тоже уничтоженная техника: именно он даёт счётчику destroyed смысл «пробил».
    expect(result.destroyed).toBeGreaterThanOrEqual(1);
    expect(result.pathTiles).toBeGreaterThan(0);
  });

  it('сильная оборона выбивает слабый рейд, и армия считается потерянной целиком', () => {
    const defender = defenderWith({
      units: [
        { code: 'tower_plasma_mk3', x: 6, y: 6 },
        { code: 'tower_plasma_mk3', x: 9, y: 6 },
        { code: 'tower_plasma_mk3', x: 6, y: 9 },
        { code: 'tower_plasma_mk3', x: 9, y: 9 }
      ]
    });
    const attacker = armyOf(['drone_cargo_mk1', 'drone_cargo_mk1']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    const result = simulateBattle({ defender, army });

    expect(result.endedBy).toBe('army');
    expect(result.robots.lost).toBe(result.robots.deployed);
    expect(result.robots.survivors).toBe(0);
    expect(result.outcome === 'loss' || result.outcome === 'draw').toBe(true);
  });

  it('замурованный штаб не приводит к вечному бою: дроны ломают стену и проходят', () => {
    // Шаг 3 такие планировки сохраняет (нарушение проходимости, а не модели данных),
    // значит резолвер обязан воевать и с ними: иначе рейд висит до таймаута.
    const defender = defenderWith({ walls: cells([[6, 7], [8, 7], [7, 6], [7, 8]]) });
    const attacker = armyOf(['drone_strike_mk2', 'drone_strike_mk2']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    const result = simulateBattle({ defender, army });

    expect(result.defense.wallsDown).toBeGreaterThanOrEqual(1);
    expect(result.ticks).toBeLessThan(SIM_MAX_TICKS);
    expect(result.outcome).toBe('win');
  });

  it('стены замедляют штурм: тот же рейд тратит на них время', () => {
    const open = defenderWith({});
    const walled = defenderWith({
      walls: cells([[6, 7], [8, 7], [7, 6], [7, 8], [5, 5], [5, 6], [10, 10], [10, 11]])
    });
    const attacker = armyOf(['drone_cargo_mk1', 'drone_cargo_mk1', 'drone_cargo_mk1']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));

    const bare = simulateBattle({ defender: open, army });
    const maze = simulateBattle({ defender: walled, army });
    expect(maze.defense.wallsDown).toBeGreaterThan(0);
    expect(maze.ticks).toBeGreaterThanOrEqual(bare.ticks);
  });

  it('инвариант исхода: армия сбита, штаб пробит выше порога — ничья, а не поражение', () => {
    const cases: Array<{ units: Array<{ code: string; x: number; y: number }>; codes: string[] }> = [
      { units: [], codes: ['drone_cargo_mk1'] },
      { units: [{ code: 'tower_laser_mk1', x: 7, y: 6 }], codes: ['drone_strike_mk2'] },
      {
        units: [
          { code: 'tower_rail_mk2', x: 6, y: 6 },
          { code: 'tower_rail_mk2', x: 9, y: 9 }
        ],
        codes: ['drone_cerberus_mk3', 'drone_cargo_mk1']
      }
    ];
    for (const scenario of cases) {
      const defender = defenderWith({ units: scenario.units });
      const attacker = armyOf(scenario.codes);
      const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
      const result = simulateBattle({ defender, army });
      if (result.endedBy === 'army' && result.hq.ratio >= DRAW_HQ_DAMAGE_RATIO) {
        expect(result.outcome).toBe('draw');
      }
      if (result.endedBy === 'hq') expect(result.outcome).toBe('win');
    }
  });

  it('бой заканчивается за конечное число шагов и не раздувает таймлайн', () => {
    const defender = defenderWith({
      walls: cells([[3, 3], [4, 4], [5, 5], [10, 10], [11, 11], [12, 12]]),
      units: [{ code: 'tower_laser_mk1', x: 6, y: 8 }]
    });
    const attacker = armyOf(['drone_strike_mk2', 'drone_cerberus_mk3', 'drone_cargo_mk1']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    const result = simulateBattle({ defender, army });

    expect(result.ticks).toBeGreaterThan(0);
    expect(result.ticks).toBeLessThanOrEqual(SIM_MAX_TICKS);
    expect(result.durationMs).toBe(result.ticks * 200);
    expect(result.timeline.length).toBeLessThanOrEqual(SIM_MAX_EVENTS);
    expect(result.timeline[result.timeline.length - 1]?.type).toBe('end');
  });

  it('дроны стартуют только с конфигурованных ворот', () => {
    const defender = defenderWith({});
    const attacker = armyOf(['drone_cerberus_mk3']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    const result = simulateBattle({ defender, army });

    const spawns = new Set(
      result.timeline.filter((event) => event.type === 'spawn').map((event) => `${event.cell?.x},${event.cell?.y}`)
    );
    const allowed = new Set(SPAWN_CELLS.map((cell) => `${cell.x},${cell.y}`));
    expect(spawns.size).toBeGreaterThan(0);
    for (const cell of spawns) expect(allowed.has(cell)).toBe(true);
    expect(result.robots.deployed).toBe(army.robots);
  });
});

describe('pvp/battle: энергосеть базы в бою', () => {
  const plasma4 = [
    { code: 'tower_plasma_mk3', x: 6, y: 6 },
    { code: 'tower_plasma_mk3', x: 9, y: 6 },
    { code: 'tower_plasma_mk3', x: 6, y: 9 },
    { code: 'tower_plasma_mk3', x: 9, y: 9 }
  ];

  it('оборона без генерации молчит, но с карты не исчезает', () => {
    // Смысл разделения `alive` и `powered`: обесточенная турель — это препятствие,
    // которое ещё и принимает урон, а не бесплатно испарившаяся постройка. Пропади
    // глухая башня с поля, игрок был бы ЗАИНТЕРЕСОВАН держать оборону на голодном
    // пайке: «забыл включить реактор» стало бы выгоднее, чем «построил».
    const dark = defenderWith({ units: plasma4, structures: {}, storages: {} });
    const attacker = armyOf(['drone_cargo_mk1', 'drone_cargo_mk1']);
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    const result = simulateBattle({ defender: dark, army });

    expect(result.defense.towers).toBe(4);
    expect(result.power.unpowered).toBe(4);
    // 20 кВт встроенного генератора штаба не тянут ни одной плазменной турели (90 кВт).
    expect(result.endedBy).toBe('hq');
    expect(result.outcome).toBe('win');

    // Тот же состав, но с реактором и крио-контуром: оборона стреляет, и исход иной.
    const lit = defenderWith({ units: plasma4 });
    const litResult = simulateBattle({ defender: lit, army });
    expect(litResult.power.unpowered).toBe(0);
    expect(litResult.endedBy).toBe('army');
  });

  it('причина отказа сети попадает в снимок и различима для игрока', () => {
    // «Оборона слабая» и «у тебя кончился азот» — разные сообщения для поддержки,
    // и движок обязан уметь назвать второе, а не сводить всё к первому.
    //
    // Сцена собирается так, чтобы ОТКАЗАЛ ИМЕННО ТЕПЛООТВОД, а не мощность: один
    // конвертер Mk.I (120 кВт, 30 кВт-тепла) даёт турели её 90 кВт с запасом, а
    // пассивного радиатора штаба (45 кВт) хватает на сам конвертер (30) — и на ствол
    // уже нет (60). Тянуть сеть до бесконечности не нужно: веер разбирается по
    // приоритетам, и при избытке мощности причина останется ровно одна — cooling.
    const noCoolant = defenderWith({
      units: [{ code: 'tower_plasma_mk3', x: 6, y: 6 }],
      structures: { reactor_plasma_mk1: 1 },
      storages: { plasma: 10_000, nitrogen: 0 }
    });
    const snapshot = defenseSnapshot(noCoolant);
    expect(snapshot.towers[0]?.powered).toBe(false);
    expect(snapshot.denied.tower_plasma_mk3).toBe('cooling');
  });

  it('тяжёлая техника защитника ест дейтерий и не выезжает без бака', () => {
    const armed = defenderWith({
      units: [
        { code: 'weapon_railgun_mk3', x: 6, y: 6 },
        { code: 'weapon_railgun_mk3', x: 9, y: 9 }
      ]
    });
    expect(defenseSnapshot(armed).unpowered).toBe(0);
    // Свой реактор, и сеть базы — 0 кВт: автономная техника в веер не попадает.
    expect(defenseSnapshot(armed).deuteriumPerHour).toBe(36);

    const dry = defenderWith({
      units: [
        { code: 'weapon_railgun_mk3', x: 6, y: 6 },
        { code: 'weapon_railgun_mk3', x: 9, y: 9 }
      ],
      storages: { plasma: 10_000, nitrogen: 10_000, deuterium: 1 }
    });
    const snapshot = defenseSnapshot(dry);
    // Бак на один ствол — значит в строю ровно один, второй стоит живой, но глухой.
    expect(snapshot.unpowered).toBe(1);
    expect(snapshot.denied.weapon_railgun_mk3).toBe('fuel');
  });
});

describe('pvp/battle: тепло ствола', () => {
  it('лазер с нулевым тепловыделением не перегревается никогда', () => {
    // `heat: 0` в UNIT_POWER_PROFILE читается как «пассивного радиатора хватает» —
    // ровно та формулировка, что стоит в комментарии к сети. Перегрев такой турели
    // был бы выдумкой движка, а не свойством её контура.
    const defender = defenderWith({
      units: [
        { code: 'tower_laser_mk1', x: 6, y: 6 },
        { code: 'tower_laser_mk1', x: 9, y: 9 }
      ]
    });
    expect(defenseSnapshot(defender).towers.every((t) => t.heatKw === 0)).toBe(true);

    const attacker = armyOf(['drone_cargo_mk1', 'drone_cargo_mk1', 'drone_cargo_mk1', 'drone_cargo_mk1']);
    const result = simulateBattle({ defender, army: resolveArmy(attacker, attacker.inventory.map((i) => i.id)) });
    expect(result.power.overheatEvents).toBe(0);
    expect(result.timeline.some((event) => event.type === 'overheat')).toBe(false);
  });

  it('плазменная турель на непрерывном огне уходит в упор и возвращается в цикл', () => {
    // Рабочий цикл — следствие, а не штраф: 8 шагов нагрева против 60% отвода дают
    // перегрев после 20 с непрерывного огня (см. THERMAL). Проверяются три числа, и
    // каждое ловит свою поломку: события (не греется?), простои (не остывает?) и
    // потери (а башня стреляла между перегревами, или встала навсегда?).
    //
    // Турели стоят НА ПОДХОДЕ и закрывают штаб со всех четырёх сторон: дрон,
    // которому башня не мешает, пролетает её радиус за 7 секунд и перегреть не
    // успевает — проверка деградировала бы в тест на геометрию карты. Только
    // вынужденный штурм блокера держит машину в радиусе десятками секунд, и нагрев
    // становится непрерывным по построению сцены, а не по случайности маршрута.
    const defender = defenderWith({
      units: [
        { code: 'tower_plasma_mk3', x: 6, y: 7 },
        { code: 'tower_plasma_mk3', x: 8, y: 7 },
        { code: 'tower_plasma_mk3', x: 7, y: 6 },
        { code: 'tower_plasma_mk3', x: 7, y: 8 }
      ]
    });
    const attacker = armyOf(Array.from({ length: ATTACK_MAX_ROBOTS }, () => 'drone_cargo_mk1'));
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    const result = simulateBattle({ defender, army });

    // Бой обязан быть достаточно долгим, чтобы 20-секундный нагрев в него влез.
    expect(result.ticks).toBeGreaterThan(((THERMAL.fillSeconds / (1 - THERMAL.coolRatio)) * 5));
    expect(result.power.overheatEvents).toBeGreaterThan(0);
    expect(result.power.overheatedTicks).toBeGreaterThan(0);
    expect(result.timeline.some((event) => event.type === 'overheat')).toBe(true);
    expect(result.timeline.some((event) => event.type === 'cooled')).toBe(true);
    // Перегрев не обнуляет оборону и не является приговором: дроны всё равно теряются,
    // а башни — живы и снова в строю (иначе 'cooled' в таймлайне просто не было бы).
    expect(result.robots.lost).toBeGreaterThan(0);
    expect(result.power.overheatEvents).toBeLessThanOrEqual(result.defense.towers * 20);
  });

  it('тяжёлый дрон атакующего не вылетает без бака, и это видно в составе армии', () => {
    const loaded = armyOf(['drone_cerberus_mk3']);
    const army = resolveArmy(loaded, loaded.inventory.map((item) => item.id));
    // Цербер — рой из 4 машин, каждая со своим реактором: 40 ед/ч × 0,05 ч = 2 на машину.
    expect(army.robots).toBe(4);
    expect(army.fuel.perHour).toBe(160);
    expect(army.fuel.reserve).toBeCloseTo(8, 6);
    expect(army.fuel.grounded).toBe(0);

    const dry = armyOf(['drone_cerberus_mk3'], { deuterium: 5 });
    const grounded = resolveArmy(dry, dry.inventory.map((item) => item.id));
    expect(grounded.robots).toBe(2);
    expect(grounded.fuel.grounded).toBe(2);
    // Витрина «сила армии» обязана считать по вылетевшим машинам, а не по мечте.
    expect(grounded.dps).toBeCloseTo(army.dps / 2, 6);

    const empty = armyOf(['drone_cerberus_mk3'], { deuterium: 0 });
    const none = resolveArmy(empty, empty.inventory.map((item) => item.id));
    expect(none.robots).toBe(0);
    expect(none.squads).toHaveLength(0);
  });

  it('лёгкие дроны на батарее летают без дейтерия', () => {
    // Граница autonomous/battery проходит по тиру-3, и путаница в ней стоила бы
    // либо бесплатного цербера, либо платного грузовика. Проверяется отсутствием
    // топлива в баке при полном вылете роя.
    const attacker = armyOf(['drone_cargo_mk1', 'drone_strike_mk2'], { deuterium: 0 });
    const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));
    expect(army.fuel.perHour).toBe(0);
    expect(army.fuel.grounded).toBe(0);
    // Грузовик выставляет 1 машину (override squad: 1), ударный — 2.
    expect(army.robots).toBe(3);
  });
});

describe('pvp/battle: станиумное поле защитника', () => {
  const defender = defenderWith({});
  const attacker = armyOf(['drone_cargo_mk1', 'drone_cargo_mk1', 'drone_cargo_mk1', 'drone_cargo_mk1']);
  const army = resolveArmy(attacker, attacker.inventory.map((item) => item.id));

  it('без поля рой идёт с полной скоростью, с полем — те же дроны и более длинный бой', () => {
    const fast = simulateBattle({ defender, army });
    const slowed = simulateBattle({ defender, army, attackerSpeedMultiplier: STANIUM_SPEED_MULTIPLIER });

    expect(fast.attackerSpeedMultiplier).toBe(1);
    expect(slowed.attackerSpeedMultiplier).toBe(STANIUM_SPEED_MULTIPLIER);
    // Поле не меняет состав армии и не добавляет защитнику урона напрямую: оно покупает
    // башням время. Поэтому дронов ровно столько же, а бой — длиннее.
    expect(slowed.robots.deployed).toBe(fast.robots.deployed);
    expect(slowed.ticks).toBeGreaterThan(fast.ticks);
    expect(slowed.outcome).toBe(fast.outcome);
  });

  it('отчёт хранит применённый множитель: разбор боя не угадывает поле по таймингам', () => {
    const first = simulateBattle({ defender, army, attackerSpeedMultiplier: STANIUM_SPEED_MULTIPLIER });
    const second = simulateBattle({ defender, army, attackerSpeedMultiplier: STANIUM_SPEED_MULTIPLIER });

    expect(first.attackerSpeedMultiplier).toBe(STANIUM_SPEED_MULTIPLIER);
    // Детерминированность сохраняется и с множителем: тот же вход — тот же отчёт.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('множитель зажимается в (0.01, 1]: поле не ускоряет и не останавливает рой', () => {
    expect(simulateBattle({ defender, army, attackerSpeedMultiplier: 5 }).attackerSpeedMultiplier).toBe(1);
    expect(simulateBattle({ defender, army, attackerSpeedMultiplier: 0 }).attackerSpeedMultiplier).toBe(0.01);
    expect(simulateBattle({ defender, army, attackerSpeedMultiplier: -3 }).attackerSpeedMultiplier).toBe(0.01);
    expect(simulateBattle({ defender, army, attackerSpeedMultiplier: Number.NaN }).attackerSpeedMultiplier).toBe(1);

    // Нулевая скорость остановила бы рой навсегда, и бой закончился бы timeout'ом на
    // ровном месте — нижняя граница 0.01 делает такую подмену невозможной.
    const crawled = simulateBattle({ defender, army, attackerSpeedMultiplier: 0 });
    expect(crawled.robots.deployed).toBe(army.robots);
  });
});

