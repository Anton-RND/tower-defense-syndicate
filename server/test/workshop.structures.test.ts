import { describe, expect, it } from 'vitest';

import { MAX_INVENTORY_ITEMS, getBlueprint } from '../src/config/workshop.js';
import { MAX_STRUCTURE_TOTAL, STRUCTURES, getStructure } from '../src/config/structures.js';
import { unitPowerProfile } from '../src/modules/economy/power.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { settleBuilds, startBuild } from '../src/modules/workshop/craft.js';
import { describeSpeedup } from '../src/modules/workshop/craft.js';
import {
  HOUR,
  MINUTE,
  T0,
  addMs,
  errorCode,
  itemOf,
  newAccount,
  testConfig,
  withJunk,
  withMetals,
  withResources,
  withStructures
} from './fixtures.js';
import type { UserAccount } from '../src/modules/user/user.types.js';

/**
 * Путь постройки сооружений: очередь роботов → счётчик на базе.
 *
 * Здесь проверяется не баланс (он — в `config/structures.ts` и виден витриной), а
 * ГРАНИЦЫ между двумя контрактами: предмет ложится в инвентарь и занимает клетку,
 * здание — нет. Именно на стыке этих двух механик обычно и теряют код: например,
 * начинают требовать слот инвентаря для реактора или ставят сооружение в лабиринт.
 */

const config = testConfig();
let seq = 0;
const idFactory = () => `s-${++seq}`;

const REACTOR = 'reactor_plasma_mk1';
const NITRO = 'nitro_plant_mk1';
const CRYO = 'cryo_tank_mk1';

/** Игрок, у которого есть на всё: реактор (железо/кремний/чипы/чермет) и цистерны. */
function funded(): UserAccount {
  return withJunk(
    withMetals(withResources(newAccount(config), { ferrum: 20_000, silicium: 20_000 }), {
      black_metal: 5_000,
      colored_metal: 5_000,
      precious_metal: 5_000
    }),
    { chips: 5_000, boards: 5_000, engines: 100, transmissions: 100, batteries: 100, ammo_casings: 100 }
  );
}

describe('workshop/structures: стройка здания', () => {
  it('реактор принимается в очередь как работа вида `structure`, а не как предмет', () => {
    const started = startBuild(funded(), REACTOR, T0, idFactory);
    expect(started.job.kind).toBe('structure');
    expect(started.structure?.id).toBe(REACTOR);
    expect(started.blueprint).toBeNull();
    expect(started.account.builds).toHaveLength(1);
  });

  it('материалы списываются в момент старта, по одному движению на позицию', () => {
    const account = funded();
    const def = getStructure(REACTOR)!;
    const started = startBuild(account, REACTOR, T0, idFactory);
    expect(started.account.resources.ferrum).toBe(account.resources.ferrum - (def.cost.ferrum ?? 0));
    expect(started.drafts.length).toBe(Object.keys(def.cost).length);
    expect(started.drafts.every((d) => d.reason === 'craft')).toBe(true);
    expect(started.drafts.every((d) => d.refType === 'structure')).toBe(true);
  });

  it('по завершении счётчик вырос, а инвентарь НЕ пополнился', () => {
    const started = startBuild(funded(), REACTOR, T0, idFactory);
    const buildMs = getStructure(REACTOR)!.buildMs;
    const settled = settleBuilds(started.account, addMs(T0, buildMs), idFactory);
    expect(settled.account.structures[REACTOR]).toBe(1);
    expect(settled.items).toHaveLength(0);
    expect(settled.account.inventory).toHaveLength(0);
    expect(settled.account.builds).toHaveLength(0);
    expect(settled.gained).toEqual({ [REACTOR]: 1 });
  });

  it('полный инвентарь не мешает строить здание', () => {
    // Смысл разделения контрактов: рюкзак из 400 башен не должен блокировать энергетику.
    const crowded: UserAccount = {
      ...funded(),
      inventory: Array.from({ length: MAX_INVENTORY_ITEMS }, () => itemOf('tower_laser_mk1'))
    };
    const started = startBuild(crowded, REACTOR, T0, idFactory);
    expect(started.account.builds).toHaveLength(1);
  });

  it('второе здание на одного робота — NO_FREE_BUILDER', () => {
    // По умолчанию робота два, поэтому фиксируем одного: иначе тест проверял бы не
    // занятость, а количество роботов.
    const solo: UserAccount = { ...funded(), buildRobots: 1 };
    const first = startBuild(solo, REACTOR, T0, idFactory);
    expect(errorCode(() => startBuild(first.account, CRYO, T0, idFactory))).toBe(ErrorCodes.NO_FREE_BUILDER);
  });
});

describe('workshop/structures: границы реестра', () => {
  it('азотная станция без крио-цистерны не строится', () => {
    // Без предпосылки игрок получил бы станцию, которая встаёт по переполнению сразу:
    // отказ на входе дешевле разочарования через час.
    expect(errorCode(() => startBuild(funded(), NITRO, T0, idFactory))).toBe(ErrorCodes.STRUCTURE_REQUIRES);
  });

  it('после крио-цистерны станция строится', () => {
    const withTank = withStructures(funded(), { [CRYO]: 1 });
    const started = startBuild(withTank, NITRO, T0, idFactory);
    expect(started.job.kind).toBe('structure');
  });

  it('потолок экземпляров вида отсекает лишнее ДО списания материалов', () => {
    const def = getStructure(REACTOR)!;
    const maxed = withStructures(funded(), { [REACTOR]: def.maxPerBase });
    const before = maxed.resources.ferrum;
    expect(errorCode(() => startBuild(maxed, REACTOR, T0, idFactory))).toBe(ErrorCodes.STRUCTURE_LIMIT);
    expect(maxed.resources.ferrum).toBe(before);
  });
});

describe('workshop/structures: целостность реестра', () => {
  it('в `requires` нет циклов: иначе прогрессия непроходима, а типы об этом молчат', () => {
    // TS проверяет, что ссылка ведёт на существующий код, но не что граф ацикличен.
    // A↔B — валидный по типам конфиг, который невозможно построить ни при каком порядке,
    // и заметят это только игроки (то есть никогда).
    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (id: string, path: string[]): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Цикл requires: ${[...path, id].join(' → ')}`);
      }
      visiting.add(id);
      for (const need of Object.keys(getStructure(id)?.requires ?? {})) walk(need, [...path, id]);
      visiting.delete(id);
      done.add(id);
    };
    for (const def of STRUCTURES) expect(() => walk(def.id, [])).not.toThrow();
    expect(done.size).toBe(STRUCTURES.length);
  });

  it('каждое здание достижимо от видов без предпосылок', () => {
    const roots = STRUCTURES.filter((def) => !def.requires || Object.keys(def.requires).length === 0).map((d) => d.id);
    expect(roots.length).toBeGreaterThan(0);
    const reached = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const def of STRUCTURES) {
        if (def.requires && Object.keys(def.requires).includes(id)) queue.push(def.id);
      }
    }
    expect(reached.size).toBe(STRUCTURES.length);
  });

  it('лимиты вида не противоречат общему потолку базы', () => {
    // Сумма потолков всех видов заведомо больше MAX_STRUCTURE_TOTAL — иначе общий
    // потолок недостижим и является декорацией, а не защитой документа.
    const sum = STRUCTURES.reduce((acc, def) => acc + (def.maxPerBase > 0 ? def.maxPerBase : 0), 0);
    expect(sum).toBeGreaterThan(MAX_STRUCTURE_TOTAL);
  });

  it('тяжёлая техника не висит на сети базы', () => {
    // Прямая проверка твоего требования: «вся тяжёлая техника работает на своих
    // реакторах и не потребляет электроэнергию базы». Тир-3 дроны и орудия обязаны
    // быть `autonomous`, иначе они молча начнут жрать кВт и обесценят дейтерий.
    for (const code of ['drone_cerberus_mk3', 'weapon_railgun_mk3', 'weapon_plasma_cannon_mk3', 'weapon_railgun_heavy_mk3']) {
      expect(unitPowerProfile(code)?.class).toBe('autonomous');
      expect(unitPowerProfile(code)?.idle).toBe(0);
    }
    for (const code of ['tower_laser_mk1', 'tower_rail_mk2', 'tower_plasma_mk3']) {
      expect(unitPowerProfile(code)?.class).toBe('grid');
    }
  });
});

describe('workshop/structures: ускорение здания', () => {
  it('полный инвентарь не блокирует ускорение постройки здания', () => {
    const crowded: UserAccount = {
      ...funded(),
      materials: { ...funded().materials, chronium: 10_000 },
      inventory: Array.from({ length: MAX_INVENTORY_ITEMS }, () => itemOf('tower_laser_mk1'))
    };
    const started = startBuild(crowded, REACTOR, T0, idFactory);
    // Предмет в тех же условиях получил бы `inventory_full`, здание — `ok`.
    expect(describeSpeedup(started.account, started.job.id, T0).reason).toBe('ok');
  });

  it('предмет в тех же условиях всё ещё упирается в инвентарь', () => {
    // Порядок важен: при 399 предметах и одной работе в полёте свободен ровно один
    // слот — и он как раз для результата этой работы, поэтому `ok` был бы верным
    // ответом. Забиваем инвентарь ПОСЛЕ старта стройки: тогда ускорять некуда.
    const almostFull: UserAccount = {
      ...funded(),
      materials: { ...funded().materials, chronium: 10_000 },
      inventory: Array.from({ length: MAX_INVENTORY_ITEMS - 1 }, () => itemOf('tower_laser_mk1'))
    };
    const started = startBuild(almostFull, 'tower_laser_mk1', T0, idFactory);
    const full: UserAccount = { ...started.account, inventory: Array.from({ length: MAX_INVENTORY_ITEMS }, () => itemOf('tower_laser_mk1')) };
    expect(describeSpeedup(full, started.job.id, T0).reason).toBe('inventory_full');
  });
});
