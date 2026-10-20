import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HQ,
  GRID_HEIGHT,
  GRID_WIDTH,
  HQ_PADS,
  MIN_PATH_TILES,
  SPAWN_CELLS,
  type Cell
} from '../src/config/base.js';
import {
  DEFAULT_SPEC,
  analyzeLayout,
  buildRouteField,
  cellCoord,
  cellIndex,
  describeIssue,
  inBounds
} from '../src/modules/pvp/grid.js';

/**
 * Тесты поисковика маршрута. Отдельно от домена: здесь нет ни инвентаря, ни денег,
 * ни БД — только геометрия, и именно она решает, пустят ли матчмейкинг базу
 * и завершится ли бой.
 */

const walls = (cells: Array<[number, number]>): Cell[] => cells.map(([x, y]) => ({ x, y }));

/** Кольцо из стен вокруг клетки: четыре ортогональных соседа. */
function ringAround(center: Cell): Cell[] {
  return walls([
    [center.x - 1, center.y],
    [center.x + 1, center.y],
    [center.x, center.y - 1],
    [center.x, center.y + 1]
  ]);
}

function assertAdjacent(path: readonly Cell[]): void {
  for (let i = 1; i < path.length; i += 1) {
    const prev = path[i - 1] as Cell;
    const next = path[i] as Cell;
    expect(Math.abs(prev.x - next.x) + Math.abs(prev.y - next.y)).toBe(1);
  }
}

describe('pvp/grid: геометрия поля', () => {
  it('индексы клеток обратимы и тотальны', () => {
    for (const cell of [...SPAWN_CELLS, ...HQ_PADS]) {
      const index = cellIndex(DEFAULT_SPEC, cell.x, cell.y);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(cellCoord(DEFAULT_SPEC, index)).toEqual(cell);
      expect(inBounds(DEFAULT_SPEC, cell)).toBe(true);
    }
  });

  it('за пределами поля, с дробью и NaN индекс равен -1, а не исключению', () => {
    expect(cellIndex(DEFAULT_SPEC, -1, 0)).toBe(-1);
    expect(cellIndex(DEFAULT_SPEC, GRID_WIDTH, 0)).toBe(-1);
    expect(cellIndex(DEFAULT_SPEC, 0, GRID_HEIGHT)).toBe(-1);
    expect(cellIndex(DEFAULT_SPEC, 1.5, 2)).toBe(-1);
    expect(cellIndex(DEFAULT_SPEC, Number.NaN, 2)).toBe(-1);
    expect(inBounds(DEFAULT_SPEC, { x: 0, y: Number.NaN })).toBe(false);
  });
});

describe('pvp/grid: проходимость лабиринта', () => {
  it('пустое поле проходимы со всех восьми ворот, путь посчитан от худшего подхода', () => {
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: [] });

    expect(analysis.ok).toBe(true);
    expect(analysis.violations).toEqual([]);
    expect(analysis.totalSpawns).toBe(SPAWN_CELLS.length);
    expect(analysis.connectedSpawns).toBe(SPAWN_CELLS.length);
    expect(analysis.spawnDistances.every((value) => value >= 0)).toBe(true);

    // Худший подход — самый длинный из кратчайших: по нему игрок судит, успеют ли
    // башни снять волну. На пустом поле от дальних ворот до центра — 9 шагов.
    expect(analysis.pathTiles).toBe(Math.max(...analysis.spawnDistances));
    expect(analysis.pathTiles).toBe(9);
    expect(analysis.walkable).toBe(GRID_WIDTH * GRID_HEIGHT);
    expect(analysis.orphans).toBe(0);
  });

  it('пустое поле получает предупреждение о коротком пути, но остаётся готовым к бою', () => {
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: [] });

    // Намеренно: новичок обязан быть играбелен до первой постройки. «Слишком
    // короткий коридор» — совет, а не отказ; отказом становится только отсутствие пути.
    expect(analysis.warnings).toContain('path_too_short');
    expect(analysis.pathTiles).toBeLessThan(MIN_PATH_TILES);
    expect(analysis.ok).toBe(true);
  });

  it('кольцо вокруг штаба убивает путь со всех ворот: ok=false, пути нет', () => {
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: ringAround(DEFAULT_HQ) });

    expect(analysis.ok).toBe(false);
    expect(analysis.violations).toContain('no_path');
    expect(analysis.pathTiles).toBe(-1);
    expect(analysis.path).toBeNull();
    expect(analysis.connectedSpawns).toBe(0);
    expect(analysis.spawnDistances).toEqual(SPAWN_CELLS.map(() => -1));
  });

  it('достаточно закрыть ОДНИ ворота, чтобы база перестала допускаться в PvP', () => {
    // Роботы, не нашедшие маршрут, встали бы навсегда: бой не завершается. Значит
    // матчмейкинг обязан требовать проходимость ОТ КАЖДЫХ ворот, а не «хотя бы откуда-то».
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: [SPAWN_CELLS[0] as Cell] });

    expect(analysis.ok).toBe(false);
    expect(analysis.violations).toContain('spawn_blocked');
    expect(analysis.connectedSpawns).toBe(SPAWN_CELLS.length - 1);
  });

  it('стена на штабе — отдельное нарушение, а не «нет пути»', () => {
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: [DEFAULT_HQ] });

    expect(analysis.violations).toContain('hq_blocked');
    expect(analysis.ok).toBe(false);
  });

  it('дубликаты в списке заблокированных ловятся, а не съедаются молча', () => {
    const duplicated = walls([
      [6, 7],
      [6, 7],
      [8, 7],
      [7, 6],
      [7, 8]
    ]);
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: duplicated });

    expect(analysis.violations).toContain('overlapping_cells');
    expect(analysis.ok).toBe(false);
    // Клетка занята один раз: иначе walkable ушёл бы в минус и orphans врёт.
    expect(analysis.walkable).toBe(GRID_WIDTH * GRID_HEIGHT - 4);
  });

  it('лабиринт удлиняет маршрут, и путь не пересекает стены', () => {
    const barrier = walls(Array.from({ length: GRID_HEIGHT - 1 }, (_, y) => [4, y] as [number, number]));
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: barrier });
    const blocked = new Set(barrier.map((cell) => cellIndex(DEFAULT_SPEC, cell.x, cell.y)));

    expect(analysis.ok).toBe(true);
    expect(analysis.pathTiles).toBeGreaterThan(9);
    expect(analysis.warnings).not.toContain('path_too_short');

    const path = analysis.path;
    expect(path).not.toBeNull();
    if (path) {
      assertAdjacent(path);
      expect(SPAWN_CELLS.some((gate) => gate.x === path[0]?.x && gate.y === path[0]?.y)).toBe(true);
      expect(path[path.length - 1]).toEqual(DEFAULT_HQ);
      expect(path.length - 1).toBe(analysis.pathTiles);
      expect(path.every((cell) => !blocked.has(cellIndex(DEFAULT_SPEC, cell.x, cell.y)))).toBe(true);
    }
  });

  it('замкнутый карман виден как orphans и не ломает основной путь', () => {
    const pocket = ringAround({ x: 2, y: 2 });
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: pocket });

    expect(analysis.ok).toBe(true);
    expect(analysis.orphans).toBe(1);
    expect(analysis.warnings).toContain('orphan_cells');
    expect(analysis.reachable).toBe(analysis.walkable - 1);
  });

  it('один и тот же вход даёт один и тот же выход (детерминизм для реплеев)', () => {
    const barrier = walls([
      [3, 0],
      [3, 1],
      [3, 2],
      [3, 3],
      [11, 11],
      [11, 12],
      [11, 13]
    ]);
    const first = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: barrier });
    const second = analyzeLayout({ spawns: SPAWN_CELLS, hq: DEFAULT_HQ, blocked: barrier.map((c) => ({ ...c })) });

    expect(second).toEqual(first);
  });

  it('поле другого размера и свой порог: параметризация работает', () => {
    const spec = { width: 4, height: 4 };
    const open = analyzeLayout({
      spec,
      spawns: [{ x: 0, y: 0 }],
      hq: { x: 3, y: 3 },
      blocked: [],
      minPathTiles: 6
    });
    expect(open.pathTiles).toBe(6);
    expect(open.warnings).not.toContain('path_too_short');
    expect(open.walkable).toBe(16);

    const sealed = analyzeLayout({
      spec,
      spawns: [{ x: 0, y: 0 }],
      hq: { x: 3, y: 3 },
      blocked: walls([
        [1, 0],
        [0, 1]
      ]),
      minPathTiles: 0
    });
    expect(sealed.ok).toBe(false);
    expect(sealed.pathTiles).toBe(-1);
    // Порог 0 — предупреждение о длине отключено совсем.
    expect(sealed.warnings).not.toContain('path_too_short');
  });

  it('ни одних ворот — это «нет пути», а не «всё свободно»', () => {
    const analysis = analyzeLayout({ spawns: [], hq: DEFAULT_HQ, blocked: [] });

    expect(analysis.ok).toBe(false);
    expect(analysis.violations).toContain('no_path');
    expect(analysis.totalSpawns).toBe(0);
  });

  it('каждое нарушение имеет человекочитаемое описание', () => {
    const codes = ['overlapping_cells', 'spawn_blocked', 'hq_blocked', 'no_path', 'path_too_short', 'orphan_cells'] as const;
    for (const code of codes) {
      expect(describeIssue(code).length).toBeGreaterThan(10);
    }
  });
});

describe('pvp/grid: поле маршрутов для симуляции', () => {
  const hq = DEFAULT_HQ;

  it('согласуется с analyzeLayout до числа: один BFS на двоих, расхождения быть не может', () => {
    const blocked = walls([[5, 5], [5, 6], [6, 7], [9, 4]]);
    const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq, blocked });
    const field = buildRouteField({ hq, blocked });

    SPAWN_CELLS.forEach((cell, index) => {
      expect(field.distance(cell)).toBe(analysis.spawnDistances[index] ?? -1);
    });
  });

  it('шаг по полю ведёт строго к штабу и укладывается в расстояние', () => {
    const field = buildRouteField({ hq, blocked: [] });
    for (const spawn of SPAWN_CELLS) {
      const distance = field.distance(spawn);
      expect(distance).toBeGreaterThan(0);

      let cell = spawn;
      let steps = 0;
      for (;;) {
        const next = field.next(cell);
        if (!next) break;
        cell = next;
        steps += 1;
        expect(steps).toBeLessThanOrEqual(distance);
      }
      expect(steps).toBe(distance);
      expect(cell).toEqual(hq);
    }
  });

  it('замурованный штаб даёт пустое поле: ни расстояния, ни шага', () => {
    const blocked = walls([[6, 7], [8, 7], [7, 6], [7, 8]]);
    const field = buildRouteField({ hq, blocked });

    expect(field.distance(hq)).toBe(0);
    expect(field.next(hq)).toBeNull();
    for (const spawn of SPAWN_CELLS) {
      expect(field.distance(spawn)).toBe(-1);
      expect(field.next(spawn)).toBeNull();
    }
    expect(field.isBlocked({ x: 6, y: 7 })).toBe(true);
    expect(field.isBlocked({ x: 5, y: 7 })).toBe(false);
  });

  it('клетки вне поля тотальны: -1 и null, а не исключение', () => {
    const field = buildRouteField({ hq, blocked: [] });
    const outside = { x: -3, y: 99 };
    expect(field.distance(outside)).toBe(-1);
    expect(field.next(outside)).toBeNull();
    expect(field.isBlocked(outside)).toBe(false);
    expect(field.route(outside)).toBeNull();
  });

  it('маршрут из точки совпадает с длиной поля (реплей строится по тем же шагам)', () => {
    const field = buildRouteField({ hq, blocked: walls([[6, 7]]) });
    const start = { x: 3, y: 7 };
    const route = field.route(start);
    expect(route).not.toBeNull();
    expect(route?.[0]).toEqual(start);
    expect(route?.[route.length - 1]).toEqual(hq);
    expect((route?.length ?? 0) - 1).toBe(field.distance(start));
  });
});

