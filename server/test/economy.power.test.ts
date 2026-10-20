import { describe, expect, it } from 'vitest';

import { BASE_PASSIVE_COOLING, BASE_POWER_SUPPLY, HEAT_PER_NITROGEN } from '../src/config/structures.js';
import { emptyStorage } from '../src/config/storage.js';
import { computeGrid, type GridInput } from '../src/modules/economy/power.js';

/**
 * Энергосеть базы. Тестируется `computeGrid` напрямую, без документа игрока: сеть —
 * чистая функция от состава базы и остатков, и обёртка аккаунта добавила бы здесь только
 * шум. Что реально проверяется — порядок веера и сходимость кольца «мощность ↔ охлаждение».
 */

function input(patch: Partial<GridInput> = {}): GridInput {
  return { structures: {}, units: {}, storages: emptyStorage(), ...patch };
}

function row(grid: ReturnType<typeof computeGrid>, code: string) {
  return grid.rows.find((r) => r.code === code);
}

describe('economy/power: голая база', () => {
  it('штаб даёт базовую мощность и ничего не потребляет', () => {
    const grid = computeGrid(input());
    expect(grid.supplyOnline).toBe(BASE_POWER_SUPPLY);
    expect(grid.demandOnline).toBe(0);
    expect(grid.reserve).toBe(BASE_POWER_SUPPLY);
    expect(grid.rows).toHaveLength(0);
    expect(grid.isBalanced).toBe(true);
  });

  it('пассивный радиатор штаба закрывает тепло первого конвертера', () => {
    const grid = computeGrid(input({ structures: { reactor_plasma_mk1: 1 }, storages: { ...emptyStorage(), plasma: 100 } }));
    expect(grid.coolingCap).toBe(BASE_PASSIVE_COOLING);
    expect(row(grid, 'reactor_plasma_mk1')?.online).toBe(1);
    expect(grid.supplyOnline).toBe(BASE_POWER_SUPPLY + 120);
    expect(grid.isBalanced).toBe(true);
  });
});

describe('economy/power: топливо', () => {
  it('реактор без плазмы не генерирует и отвечает причиной `fuel`', () => {
    const grid = computeGrid(input({ structures: { reactor_plasma_mk1: 1 } }));
    expect(row(grid, 'reactor_plasma_mk1')?.online).toBe(0);
    expect(row(grid, 'reactor_plasma_mk1')?.reason).toBe('fuel');
    expect(grid.supplyOnline).toBe(BASE_POWER_SUPPLY);
    // Ставка топлива на стоявшем реакторе — ноль: иначе тик сжёг бы то, чего нет.
    expect(grid.fuelRate.plasma).toBe(0);
  });

  it('работающий конвертер жжёт ровно свою ставку, а не ставку всех экземпляров', () => {
    const grid = computeGrid(
      input({ structures: { reactor_plasma_mk1: 3 }, storages: { ...emptyStorage(), plasma: 100 } })
    );
    // Три конвертера, а пассивный радиатор накрывает один → ставка топлива = 8, не 24.
    expect(row(grid, 'reactor_plasma_mk1')?.online).toBe(1);
    expect(grid.fuelRate.plasma).toBe(8);
    expect(grid.supplyOnline).toBe(BASE_POWER_SUPPLY + 120);
  });
});

describe('economy/power: кольцо мощность ↔ охлаждение', () => {
  it('второй реактор без контура не охлаждается и гаснет, потянув за собой мощность', () => {
    const grid = computeGrid(
      input({ structures: { reactor_plasma_mk1: 2 }, storages: { ...emptyStorage(), plasma: 100 } })
    );
    const reactor = row(grid, 'reactor_plasma_mk1');
    expect(reactor?.instances).toBe(2);
    // Пассивный радиатор (30) накрывает ровно один конвертер (тепло 30).
    expect(reactor?.online).toBe(1);
    expect(reactor?.reason).toBe('cooling');
    expect(grid.supplyOnline).toBe(BASE_POWER_SUPPLY + 120);
    // Кольцо развернулось: генератор погас → мощность упала → пересчёт. Значит >1 витка.
    expect(grid.passes).toBeGreaterThan(1);
  });

  it('ASIC без азотного контура глушится по причине `cooling`, а не `power`', () => {
    const grid = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1, asic_rack_mk1: 1 },
        storages: { ...emptyStorage(), plasma: 100 }
      })
    );
    expect(row(grid, 'reactor_plasma_mk1')?.online).toBe(1);
    expect(row(grid, 'asic_rack_mk1')?.online).toBe(0);
    expect(row(grid, 'asic_rack_mk1')?.reason).toBe('cooling');
    // Мощности хватает (140 кВт против 40) — значит отказал именно теплоотвод.
    expect(grid.supplyOnline).toBe(140);
    expect(grid.coinRate.sec).toBe(0);
  });

  it('два контура и азот разблокируют стойку; азот считается от отведённого тепла', () => {
    const grid = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1, cooler_loop_mk1: 2, asic_rack_mk1: 1 },
        storages: { ...emptyStorage(), plasma: 100, nitrogen: 500 }
      })
    );
    expect(row(grid, 'asic_rack_mk1')?.online).toBe(1);
    expect(grid.coolingCap).toBe(BASE_PASSIVE_COOLING + 80);
    expect(grid.heatLoad).toBe(30 + 60);
    expect(grid.coinRate.sec).toBe(25);
    expect(grid.nitrogenPerHour).toBeCloseTo((30 + 60 - BASE_PASSIVE_COOLING) / HEAT_PER_NITROGEN, 6);
    expect(grid.isBalanced).toBe(true);
  });

  it('кончились азот — контуры встают и ОСВОБОЖДАЮТ мощность, а не жрут её впустую', () => {
    const grid = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1, cooler_loop_mk1: 2, asic_rack_mk1: 1 },
        storages: { ...emptyStorage(), plasma: 100, nitrogen: 0 }
      })
    );
    expect(row(grid, 'cooler_loop_mk1')?.online).toBe(0);
    expect(row(grid, 'cooler_loop_mk1')?.reason).toBe('cooling');
    expect(row(grid, 'asic_rack_mk1')?.online).toBe(0);
    expect(row(grid, 'reactor_plasma_mk1')?.online).toBe(1);
    expect(grid.demandOnline).toBe(0);
    expect(grid.starvedCooling).toBe(true);
  });
});

describe('economy/power: очередность веера', () => {
  it('оборона запитана раньше ASIC: дефицит мощности всегда бьёт по майнингу, не по башням', () => {
    const grid = computeGrid(
      input({
        structures: { asic_rack_mk1: 1 },
        units: { tower_laser_mk1: 2 },
        storages: emptyStorage()
      })
    );
    // 20 кВт штаба: 2 лазера по 5 кВт влезают (10), стойка на 40 кВт — нет.
    expect(row(grid, 'tower_laser_mk1')?.online).toBe(2);
    expect(row(grid, 'asic_rack_mk1')?.online).toBe(0);
    expect(row(grid, 'asic_rack_mk1')?.reason).toBe('power');
    expect(grid.demandOnline).toBe(10);
  });

  it('азот — условие боя тяжёлой обороной, а не бонус к урону', () => {
    const peace = computeGrid(input({ units: { tower_rail_mk2: 1 } }));
    const bareWar = computeGrid(input({ units: { tower_rail_mk2: 1 }, combat: true }));
    expect(peace.demandOnline).toBe(15);
    // 45 кВт в бою против 20 кВт штаба: веер гасит орудие целиком, а не «режет» на 44%.
    expect(row(bareWar, 'tower_rail_mk2')?.online).toBe(0);
    expect(bareWar.demandOnline).toBe(0);

    // Реактор дал мощность, но боевое тепло рельсотрона (25 кВт) в пассивный радиатор
    // уже не влезает: 45 − 30 (реактор) = 15. Орудие глушится по охлаждению. Именно
    // здесь азот из «приятного буста урона» становится условием боеспособности.
    const unfueledWar = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1 },
        units: { tower_rail_mk2: 1 },
        storages: { ...emptyStorage(), plasma: 100 },
        combat: true
      })
    );
    expect(row(unfueledWar, 'reactor_plasma_mk1')?.online).toBe(1);
    expect(row(unfueledWar, 'tower_rail_mk2')?.online).toBe(0);
    expect(row(unfueledWar, 'tower_rail_mk2')?.reason).toBe('cooling');

    // С крио-контуром и азотом орудие воюет.
    const war = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1, cooler_loop_mk1: 1 },
        units: { tower_rail_mk2: 1 },
        storages: { ...emptyStorage(), plasma: 100, nitrogen: 200 },
        combat: true
      })
    );
    expect(row(war, 'tower_rail_mk2')?.online).toBe(1);
    // 45 кВт орудия + 6 кВт крио-контура: кулер сам сидит на сети, и это правильно —
    // иначе охлаждение досталось бы игроку бесплатно, а бесплатный хладагент убивает
    // весь смысл азотной экономики.
    expect(war.demandOnline).toBe(51);
    expect(war.isBalanced).toBe(true);
  });

  it('в мирное время оборона не ест азот: боевого тепла просто нет', () => {
    const grid = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1 },
        units: { tower_plasma_mk3: 2 },
        storages: { ...emptyStorage(), plasma: 100 }
      })
    );
    expect(row(grid, 'tower_plasma_mk3')?.online).toBe(2);
    expect(grid.heatLoad).toBe(30);
    // Всё тепло реактора (30) закрывает пассивный радиатор (45) — азот не расходуется.
    // Именно это и позволяет новичку запустить базу без единой цистерны хладагента.
    expect(grid.nitrogenPerHour).toBe(0);
  });
});

describe('economy/power: тяжёлая техника', () => {
  it('дрон «Цербер» со своим реактором не нагружает сеть базы', () => {
    const grid = computeGrid(input({ units: { drone_cerberus_mk3: 5 } }));
    expect(grid.rows).toHaveLength(0);
    expect(grid.demandOnline).toBe(0);
    expect(grid.demandRated).toBe(0);
  });

  it('лёгкий дрон, наоборот, садится на зарядку базы', () => {
    const grid = computeGrid(input({ units: { drone_cargo_mk1: 2 } }));
    expect(row(grid, 'drone_cargo_mk1')?.online).toBe(2);
    expect(grid.demandOnline).toBe(8);
  });
});

describe('economy/power: переполнение накопителей', () => {
  it('станция с полным баком встаёт по причине `output` и не жрёт мощность', () => {
    const grid = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1, nitro_plant_mk1: 1, cryo_tank_mk1: 1 },
        storages: { ...emptyStorage(), plasma: 100, nitrogen: 800 },
        blockedOutput: ['nitrogen']
      })
    );
    const plant = row(grid, 'nitro_plant_mk1');
    expect(plant?.online).toBe(0);
    expect(plant?.reason).toBe('output');
    expect(grid.outputRate.nitrogen).toBe(0);
    // Станция исключена из распределения, поэтому её 30 кВт остались реактору.
    expect(grid.demandOnline).toBe(0);
  });

  it('тот же состав при неполном баке производит', () => {
    const grid = computeGrid(
      input({
        structures: { reactor_plasma_mk1: 1, nitro_plant_mk1: 1, cryo_tank_mk1: 1 },
        storages: { ...emptyStorage(), plasma: 100, nitrogen: 10 }
      })
    );
    expect(row(grid, 'nitro_plant_mk1')?.online).toBe(1);
    expect(grid.outputRate.nitrogen).toBe(40);
  });
});

