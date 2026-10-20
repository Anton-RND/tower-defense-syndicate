import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HQ,
  HQ_PADS,
  MAX_DEPLOYED_UNITS,
  MAX_WALLS,
  SPAWN_CELLS,
  WALL_COST,
  WALL_SALVAGE_COST,
  type Cell
} from '../src/config/base.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { describeEconomy, describeUser, publicConfig } from '../src/modules/economy/view.js';
import { PVP_RATING_START } from '../src/config/pvp.js';
import {
  clearLayout,
  deployableItems,
  describeBase,
  isItemDeployed,
  liveUnits,
  placementOf,
  quoteWallCost,
  saveLayout,
  type LayoutInput
} from '../src/modules/pvp/defense.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { InventoryItem, UserAccount } from '../src/modules/user/user.types.js';
import { dismantleItem } from '../src/modules/workshop/dismantle.js';
import { MINUTE, T0, addMs, errorCode, newAccount, testConfig, withMetals, withResources } from './fixtures.js';

/**
 * Тесты планировки обороны.
 *
 * Три инварианта, на которых держится весь модуль, проверяются здесь же и повторно:
 *  1. деньги списываются ДИФФЕРЕНЦИАЛЬНО и только после валидации модели данных;
 *  2. непроходимая сетка СОХРАНЯЕТСЯ (игрок не теряет работу) и лишь не допускается
 *     в матчмейкинг — в отличие от структурной неправки, которая отказывает;
 *  3. ссылка на предмет инвентаря двусторонняя: стоящую на карте башню нельзя
 *     разобрать, а призрак на карте вычищается на чтении.
 */

const config = testConfig();
let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${++seq}`;

/** Цена двух клеток стены (ferrum 40 + black_metal 2 за штуку) — литералом, чтобы тест ловил правку баланса. */
const TWO_WALLS = { ferrum: 80, black_metal: 4 };

function unitItem(kind: 'tower' | 'weapon' | 'drone' = 'tower', code = 'tower_laser_mk1'): InventoryItem {
  return {
    id: nextId(kind),
    kind,
    code,
    level: 1,
    acquiredAt: T0,
    source: 'build',
    orderId: null
  };
}

const cells = (list: Array<[number, number]>): Cell[] => list.map(([x, y]) => ({ x, y }));

/** Свободные от ворот и площадок штаба клетки — построчно, детерминированно. */
function freeCells(count: number): Cell[] {
  const reserved = new Set([...SPAWN_CELLS, ...HQ_PADS, DEFAULT_HQ].map((cell) => `${cell.x},${cell.y}`));
  const result: Cell[] = [];
  for (let y = 0; y < 16 && result.length < count; y += 1) {
    for (let x = 0; x < 16 && result.length < count; x += 1) {
      if (!reserved.has(`${x},${y}`)) result.push({ x, y });
    }
  }
  return result;
}

function accountWith(items: InventoryItem[], funds: Partial<Record<'ferrum' | 'black_metal', number>> = {}): UserAccount {
  const funded = withMetals(
    withResources(newAccount(config), {
      energy: 100,
      ferrum: 100_000,
      silicium: 100_000,
      uranium: 10_000,
      plasma: 10_000
    }),
    { black_metal: 10_000, colored_metal: 1_000, precious_metal: 1_000 }
  );
  return {
    ...funded,
    inventory: items,
    resources: { ...funded.resources, ...(funds.ferrum === undefined ? {} : { ferrum: funds.ferrum }) },
    metals: { ...funded.metals, ...(funds.black_metal === undefined ? {} : { black_metal: funds.black_metal }) }
  };
}

/** И код ошибки, и машинный `reason` из details: фронт ветвится по reason, а не по тексту. */
function placementFailure(fn: () => unknown): { code?: string; reason?: string } {
  try {
    fn();
    return {};
  } catch (error) {
    const candidate = error as { code?: string; details?: { reason?: string } };
    return { code: candidate.code, reason: candidate.details?.reason };
  }
}

describe('pvp/defense: деньги и версии', () => {
  it('первое сохранение списывает материалы по числу новых стен и забирает единицу на карту', () => {
    const tower = unitItem('tower');
    const account = accountWith([tower]);
    const input: LayoutInput = { walls: cells([[1, 1], [1, 2]]), units: [{ itemId: tower.id, x: 2, y: 1 }] };

    const result = saveLayout(account, input, T0);

    expect(result.effective).toBe(true);
    expect(result.wallsAdded).toBe(2);
    expect(result.wallsRemoved).toBe(0);
    expect(result.unitsDeployed).toBe(1);
    expect(result.unitsRecalled).toBe(0);
    expect(result.charged).toEqual(TWO_WALLS);
    expect(result.account.resources.ferrum).toBe(account.resources.ferrum - 80);
    expect(result.account.metals.black_metal).toBe(account.metals.black_metal - 4);
    expect(result.account.base.version).toBe(1);
    expect(result.account.base.updatedAt).toEqual(T0);
    expect(result.report.ready).toBe(true);
    expect(isItemDeployed(result.account, tower.id)).toBe(true);

    expect(result.drafts.map((draft) => draft.reason)).toEqual(['deploy', 'deploy']);
    expect(result.drafts.every((draft) => draft.refType === 'base_cell')).toBe(true);
    expect(new Set(result.drafts.map((draft) => draft.idempotencyKey)).size).toBe(result.drafts.length);
    expect(result.drafts[0]?.idempotencyKey).toMatch(/^deploy:on:v1:/);
  });

  it('повтор того же запроса — ни списания, ни версии (сеть дрогнула, игрок двойной тап)', () => {
    const tower = unitItem('tower');
    const account = accountWith([tower]);
    const input: LayoutInput = { walls: cells([[1, 1], [1, 2]]), units: [{ itemId: tower.id, x: 2, y: 1 }] };

    const first = saveLayout(account, input, T0);
    const again = saveLayout(first.account, input, addMs(T0, MINUTE));

    expect(again.effective).toBe(false);
    expect(again.drafts).toEqual([]);
    expect(again.account).toBe(first.account);
    expect(again.base.version).toBe(1);
  });

  it('перестановка стены платит разницу, а не всю сетку заново', () => {
    const account = accountWith([]);
    const first = saveLayout(account, { walls: cells([[1, 1], [1, 2]]) }, T0);
    expect(first.account.resources.ferrum).toBe(account.resources.ferrum - 80);

    const second = saveLayout(first.account, { walls: cells([[1, 1], [2, 2], [3, 3]]) }, addMs(T0, MINUTE));

    expect(second.wallsAdded).toBe(2);
    expect(second.wallsRemoved).toBe(1);
    expect(second.charged).toEqual(TWO_WALLS);
    expect(second.refunded).toEqual({ ...WALL_SALVAGE_COST });
    // Итог с начала: −80 за первые две, −80 за две новых, +20 за снесённую одну.
    expect(second.account.resources.ferrum).toBe(account.resources.ferrum - 140);
    expect(second.account.base.walls).toEqual(cells([[1, 1], [2, 2], [3, 3]]));
    expect(second.account.base.version).toBe(2);
    expect(second.drafts.map((draft) => draft.reason)).toEqual(['undeploy', 'undeploy', 'deploy', 'deploy']);
    // Направления движения различаются ключом: иначе уникальный индекс журнала
    // отбросил бы возврат как «дубль» списания того же железа.
    expect(second.drafts.every((draft) => draft.idempotencyKey !== null)).toBe(true);
    expect(new Set(second.drafts.map((draft) => draft.idempotencyKey)).size).toBe(4);
    expect(second.drafts.map((draft) => draft.idempotencyKey?.split(':')[1])).toEqual(['off', 'off', 'on', 'on']);
  });

  it('возврат за снесённое покрывает новые стены в том же сохранении', () => {
    // Игрок перегораживает восток ради запада. Если списывать до начисления, он
    // получит «не хватает железа» в операции, которая по итогу не стоит ничего.
    const start = accountWith([], { ferrum: 160, black_metal: 100 });
    const built = saveLayout(start, { walls: freeCells(3) }, T0);
    expect(built.account.resources.ferrum).toBe(40);

    const kept = built.base.walls[2] as Cell;
    const moved = saveLayout(built.account, { walls: [kept, { x: 12, y: 12 }, { x: 13, y: 13 }] }, addMs(T0, MINUTE));

    expect(moved.wallsRemoved).toBe(2);
    expect(moved.wallsAdded).toBe(2);
    // 40 + возврат за две клетки (2 × 20) = 80 — ровно цена двух новых стен.
    // Осталось бы 0, плати мы по полному составу сетки, ничего бы не вышло.
    expect(moved.account.resources.ferrum).toBe(0);
    expect(moved.charged).toEqual(TWO_WALLS);
    expect(moved.refunded).toEqual({ ferrum: 40, black_metal: 2 });
  });

  it('не хватило материалов — INSUFFICIENT_FUNDS, и редуктор не трогает ни сетку, ни версию', async () => {
    const poor = accountWith([], { ferrum: 40, black_metal: 100 });
    const store = new MemoryUserStore();
    await store.save(poor);

    expect(errorCode(() => saveLayout(poor, { walls: freeCells(2) }, T0))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);

    await expect(
      store.transact(poor.id, (current) => saveLayout(current, { walls: freeCells(2) }, T0).account)
    ).rejects.toThrow();

    const failed = await store.findById(poor.id);
    expect(failed?.resources.ferrum).toBe(40);
    expect(failed?.base.walls).toEqual([]);
    expect(failed?.base.version).toBe(0);
    expect(failed?.revision).toBe(poor.revision);
  });
});



describe('pvp/defense: структурная неправка отказывает (сохранять такое нельзя)', () => {
  const tower = () => unitItem('tower');

  it.each([
    ['клетка вне поля', { walls: [{ x: -1, y: 0 }] }, 'out_of_bounds'],
    ['дробная клетка', { walls: [{ x: 1.5, y: 0 }] }, 'out_of_bounds'],
    ['клетка-призрак', { walls: [null as unknown as Cell] }, 'cell_shape'],
    ['одна клетка дважды', { walls: cells([[1, 1], [1, 1]]) }, 'duplicate_cell'],
    ['стена на воротах', { walls: [SPAWN_CELLS[0] as Cell] }, 'reserved_spawn'],
    ['стена на штабе', { walls: [{ ...DEFAULT_HQ }] }, 'reserved_hq'],
    ['штаб вне площадки', { hq: { x: 0, y: 0 } }, 'hq_off_pad']
  ])('%s → PLACEMENT_INVALID/%s', (_label, input, reason) => {
    const failure = placementFailure(() => saveLayout(accountWith([tower()]), input as LayoutInput, T0));
    expect(failure.code).toBe(ErrorCodes.PLACEMENT_INVALID);
    expect(failure.reason).toBe(reason);
  });

  it('потолок стен не прощается даже «на один лишку»', () => {
    const account = accountWith([]);
    const failure = placementFailure(() => saveLayout(account, { walls: freeCells(MAX_WALLS + 1) }, T0));
    expect(failure.code).toBe(ErrorCodes.PLACEMENT_INVALID);
    expect(failure.reason).toBe('too_many_walls');

    const ok = saveLayout(account, { walls: freeCells(MAX_WALLS) }, T0);
    expect(ok.account.base.walls).toHaveLength(MAX_WALLS);
  });

  it('потолок единиц считается по постановке, а не по инвентарю', () => {
    const items = Array.from({ length: MAX_DEPLOYED_UNITS + 1 }, () => unitItem('tower'));
    const account = accountWith(items);
    const units = items.map((item, index) => ({ itemId: item.id, x: index % 16, y: Math.floor(index / 16) + 2 }));

    const failure = placementFailure(() => saveLayout(account, { units }, T0));
    expect(failure.code).toBe(ErrorCodes.PLACEMENT_INVALID);
    expect(failure.reason).toBe('too_many_units');
  });

  it('чужой предмет, недопустимый вид и двойная постановка ловятся отдельно', () => {
    const mine = unitItem('tower');
    const drone = unitItem('drone', 'drone_cargo_mk1');
    const account = accountWith([mine, drone]);

    expect(errorCode(() => saveLayout(account, { units: [{ itemId: 'no-such-item', x: 1, y: 1 }] }, T0))).toBe(
      ErrorCodes.ITEM_NOT_FOUND
    );
    expect(errorCode(() => saveLayout(account, { units: [{ itemId: drone.id, x: 1, y: 1 }] }, T0))).toBe(
      ErrorCodes.UNIT_NOT_DEPLOYABLE
    );

    const doubled = placementFailure(() =>
      saveLayout(account, { units: [{ itemId: mine.id, x: 1, y: 1 }, { itemId: mine.id, x: 2, y: 1 }] }, T0)
    );
    expect(doubled.code).toBe(ErrorCodes.PLACEMENT_INVALID);
    expect(doubled.reason).toBe('duplicate_item');

    expect(placementFailure(() => saveLayout(account, { units: [{ itemId: mine.id, x: 0, y: 7 }] }, T0)).reason).toBe(
      'reserved_spawn'
    );
  });

  it('код и тир единицы сервер берёт из инвентаря: в документе планировки их нет', () => {
    const mine = unitItem('weapon', 'weapon_railgun_heavy_mk3');
    const result = saveLayout(accountWith([mine]), { units: [{ itemId: mine.id, x: 3, y: 3 }] }, T0);

    expect(result.account.base.units).toEqual([{ itemId: mine.id, x: 3, y: 3 }]);
    expect(JSON.stringify(result.account.base)).not.toContain('railgun');
  });

  it('устаревший снапшот редактора — STALE_LAYOUT, а не тихий откат новой планировки', () => {
    const account = accountWith([]);
    const first = saveLayout(account, { walls: cells([[1, 1]]) }, T0);

    expect(errorCode(() => saveLayout(first.account, { version: 0, walls: cells([[5, 5]]) }, T0))).toBe(
      ErrorCodes.STALE_LAYOUT
    );

    const fresh = saveLayout(first.account, { version: 1, walls: cells([[5, 5]]) }, addMs(T0, MINUTE));
    expect(fresh.account.base.walls).toEqual(cells([[5, 5]]));
    expect(fresh.account.base.version).toBe(2);
  });

  it('ключи идемпотентности остаются короткими на полной сетке', () => {
    // Подпись планировки из 120 стен в ключ журнала не кладётся: уникальный индекс
    // Mongo падает на ключах длиннее 1024 байт.
    const result = saveLayout(accountWith([]), { walls: freeCells(MAX_WALLS) }, T0);
    expect(result.drafts.length).toBeGreaterThan(0);
    for (const draft of result.drafts) {
      expect((draft.idempotencyKey ?? '').length).toBeLessThan(96);
    }
  });
});


describe('pvp/defense: проходимость — отчёт, а не отказ', () => {
  const RING: Cell[] = [
    { x: 6, y: 7 },
    { x: 8, y: 7 },
    { x: 7, y: 6 },
    { x: 7, y: 8 }
  ];

  it('замурованный штаб сохраняется: игрок не теряет работу из-за одного касания', () => {
    const result = saveLayout(accountWith([]), { walls: RING }, T0);

    expect(result.effective).toBe(true);
    expect(result.account.base.walls).toHaveLength(4);
    expect(result.report.ready).toBe(false);
    expect(result.report.analysis.violations).toContain('no_path');
    expect(result.report.notices).toContain('no_path');
    // Стены физически стоят — материалы списаны. Отказ означал бы «вычти деньги и
    // верни игроку его же работу несданной», что хуже обоих вариантов.
    expect(result.charged).toEqual({ ferrum: 160, black_metal: 8 });
  });

  it('готовность пересчитывается на чтении: освободил одну клетку — база снова в PvP', () => {
    const sealed = saveLayout(accountWith([]), { walls: RING }, T0);
    expect(sealed.report.ready).toBe(false);

    const opened = saveLayout(sealed.account, { walls: RING.slice(0, 3) }, addMs(T0, MINUTE));
    expect(opened.report.ready).toBe(true);
    expect(opened.report.notices).not.toContain('no_path');
    // Хранимого флага isValid нет ни на одном шаге — именно поэтому он не устаревает.
    expect(JSON.stringify(opened.account.base)).not.toContain('isValid');
  });

  it('два сохранения через transact: revision растёт, разница считается по факту', async () => {
    const store = new MemoryUserStore();
    const seed = accountWith([]);
    await store.save(seed);

    await store.transact(seed.id, (current) => saveLayout(current, { walls: cells([[1, 1]]) }, T0).account);
    const second = await store.transact(seed.id, (current) =>
      saveLayout(current, { walls: cells([[2, 2]]) }, addMs(T0, MINUTE)).account
    );

    expect(second.revision).toBe(seed.revision + 2);
    expect(second.base.version).toBe(2);
    expect(second.base.walls).toEqual(cells([[2, 2]]));
    // −40 за первую, +20 за снос, −40 за вторую.
    expect(second.resources.ferrum).toBe(seed.resources.ferrum - 60);
  });
});

describe('pvp/defense: связь с инвентарём', () => {
  const idFactory = (): string => nextId('gen');

  it('поля PATCH опциональны: стены без единиц не трогают постановку', () => {
    const tower = unitItem('tower');
    const first = saveLayout(accountWith([tower]), { walls: cells([[1, 1]]), units: [{ itemId: tower.id, x: 2, y: 2 }] }, T0);
    const wallsOnly = saveLayout(first.account, { walls: cells([[1, 1], [3, 3]]) }, addMs(T0, MINUTE));

    expect(wallsOnly.account.base.units).toEqual(first.account.base.units);
    expect(wallsOnly.wallsAdded).toBe(1);
    expect(wallsOnly.unitsDeployed).toBe(0);
  });

  it('стоящую на карте башню разобрать нельзя, снятую — можно', () => {
    const tower = unitItem('tower');
    const deployed = saveLayout(accountWith([tower]), { units: [{ itemId: tower.id, x: 2, y: 2 }] }, T0).account;

    expect(errorCode(() => dismantleItem(deployed, tower.id, 'salvage', T0, idFactory))).toBe(ErrorCodes.ITEM_DEPLOYED);
    expect(placementOf(deployed, tower.id)).toEqual({ itemId: tower.id, x: 2, y: 2 });

    const recalled = saveLayout(deployed, { units: [] }, addMs(T0, MINUTE)).account;
    expect(isItemDeployed(recalled, tower.id)).toBe(false);
    expect(errorCode(() => dismantleItem(recalled, tower.id, 'salvage', addMs(T0, MINUTE), idFactory))).toBeUndefined();
  });

  it('призрак (ссылка на пропавший предмет) виден на чтении и вычищается сохранением', () => {
    const tower = unitItem('tower');
    const account = accountWith([tower]);
    const haunted: UserAccount = {
      ...account,
      base: {
        ...account.base,
        units: [
          { itemId: tower.id, x: 1, y: 1 },
          { itemId: 'ghost-item', x: 2, y: 2 }
        ]
      }
    };

    const report = describeBase(haunted);
    expect(report.unbound).toBe(1);
    expect(report.notices).toContain('unbound_units');
    expect(report.units).toBe(1);
    expect(liveUnits(haunted.base, haunted.inventory).units).toHaveLength(1);

    const saved = saveLayout(haunted, { walls: cells([[4, 4]]) }, T0);
    expect(saved.account.base.units).toEqual([{ itemId: tower.id, x: 1, y: 1 }]);
    expect(describeBase(saved.account).unbound).toBe(0);
  });

  it('drone на карту не ставят, и deployableItems показывает это клиенту заранее', () => {
    const tower = unitItem('tower');
    const gun = unitItem('weapon', 'weapon_plasma_cannon_mk3');
    const drone = unitItem('drone', 'drone_cargo_mk1');
    const account = accountWith([tower, gun, drone]);

    expect(deployableItems(account).map((item) => item.id)).toEqual([tower.id, gun.id]);

    const deployed = saveLayout(account, { units: [{ itemId: gun.id, x: 5, y: 5 }] }, T0).account;
    expect(deployableItems(deployed).map((item) => item.id)).toEqual([tower.id]);
  });

  it('clearLayout снимает оборону, возвращает материалы и отпускает единицы', () => {
    const tower = unitItem('tower');
    const built = saveLayout(
      accountWith([tower]),
      { walls: cells([[1, 1], [1, 2]]), units: [{ itemId: tower.id, x: 2, y: 2 }] },
      T0
    );
    const cleared = clearLayout(built.account, addMs(T0, MINUTE));

    expect(cleared.wallsRemoved).toBe(2);
    expect(cleared.unitsRecalled).toBe(1);
    expect(cleared.refunded).toEqual({ ferrum: 40, black_metal: 2 });
    expect(cleared.account.base.walls).toEqual([]);
    expect(cleared.account.base.units).toEqual([]);
    expect(cleared.report.ready).toBe(true);
    expect(isItemDeployed(cleared.account, tower.id)).toBe(false);

    const again = clearLayout(cleared.account, addMs(T0, 2 * MINUTE));
    expect(again.effective).toBe(false);
    expect(again.drafts).toEqual([]);
  });

  it('цену пачки стен считает сервер, а не клиент', () => {
    expect(quoteWallCost(3)).toEqual({
      ferrum: (WALL_COST.ferrum ?? 0) * 3,
      black_metal: (WALL_COST.black_metal ?? 0) * 3
    });
    expect(quoteWallCost(0)).toEqual({});
    expect(quoteWallCost(-5)).toEqual({});
  });
});

describe('pvp/defense: витрина', () => {
  it('base в снапшоте экономики: координаты, имена и свободные лимиты', () => {
    const tower = unitItem('tower', 'tower_laser_mk1');
    const built = saveLayout(
      accountWith([tower]),
      { walls: cells([[1, 1]]), units: [{ itemId: tower.id, x: 2, y: 2 }] },
      T0
    );
    const view = describeEconomy(built.account, T0, config);

    expect(view.base.version).toBe(1);
    expect(view.base.hq).toEqual(DEFAULT_HQ);
    expect(view.base.walls).toEqual(cells([[1, 1]]));
    expect(view.base.units[0]).toMatchObject({
      itemId: tower.id,
      code: 'tower_laser_mk1',
      name: 'Лазерная турель Mk.I',
      tier: 1,
      kind: 'tower',
      x: 2,
      y: 2
    });
    expect(view.base.report.ready).toBe(true);
    expect(view.base.freeWalls).toBe(MAX_WALLS - 1);
    expect(view.base.freeUnits).toBe(MAX_DEPLOYED_UNITS - 1);
  });

  it('publicConfig отдаёт правила карты, чтобы редактор не угадывал константы', () => {
    const published = publicConfig(config).base as {
      grid: { width: number; height: number };
      spawns: Cell[];
      hqPads: Cell[];
      wall: { cost: Record<string, number>; salvage: Record<string, number>; max: number };
      units: { max: number };
      path: { minTiles: number };
    };

    expect(published.spawns).toEqual(SPAWN_CELLS.map((cell) => ({ ...cell })));
    expect(published.hqPads).toHaveLength(HQ_PADS.length);
    expect(published.wall.cost).toEqual({ ...WALL_COST });
    expect(published.wall.salvage).toEqual({ ...WALL_SALVAGE_COST });
    expect(published.wall.max).toBe(MAX_WALLS);
    expect(published.units.max).toBe(MAX_DEPLOYED_UNITS);
    expect(published.path.minTiles).toBeGreaterThan(0);
    expect(published.grid.width * published.grid.height).toBeLessThanOrEqual(256);
  });

  it('витрина отдаёт PvP-профиль, а publicConfig — правила боя, чтобы фронт не угадывал', () => {
    const account = newAccount(config, T0, '700');
    const view = describeEconomy(account, T0, config);

    expect(view.pvp.rating).toBe(PVP_RATING_START);
    expect(view.pvp.ladder.code).toBe('bronze');
    expect(view.pvp.attackCost).toBeGreaterThan(0);
    expect(view.pvp.attacksToday).toBe(0);
    expect(describeUser(account, T0, config).pvp.rating).toBe(view.pvp.rating);

    const published = publicConfig(config);
    const pvp = published.pvp as { attack: { energyCost: number }; rating: { start: number }; sim: { hqHp: number } };
    // Одно и то же число в двух местах ответа: клиент сравнивает стоимость атаки с тем,
    // что видит в профиле, и расхождение читается как обман.
    expect(pvp.attack.energyCost).toBe(view.pvp.attackCost);
    expect(pvp.rating.start).toBe(view.pvp.rating);
    expect(pvp.sim.hqHp).toBeGreaterThan(0);
    expect((published.referral as { rewardEnergy: number }).rewardEnergy).toBeGreaterThan(0);
  });
});

