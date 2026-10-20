import { GRID_HEIGHT, GRID_WIDTH, MIN_PATH_TILES, ORPHAN_TOLERANCE, type Cell } from '../../config/base.js';

/**
 * Геометрия поля и поисковик маршрута (Шаг 3).
 *
 * Чистый модуль: никаких знаний про инвентарь, стены, пользователя и БД. Вход —
 * клетки, выход — отчёт. Благодаря этому одни и те же функции используют
 * (а) валидатор планировки на сохранении и (б) будущий резолвер боя. Совместное ядро
 * здесь не экономия, а требование: если симуляция и валидатор посчитают проходимость
 * разными алгоритмами, сервер пропустит в PvP базу, в которой роботы встают в тупик,
 * и бой придётся завершать по таймауту.
 *
 * Почему BFS, а не A*: маршрут нужен не «быстрее», а «детерминированно и всегда
 * одинаково». A* раскрывает узлы по эвристике, и любое расхождение tie-break между
 * версиями меняет запись боя. BFS по полю 16×16 — ≤256 итераций и Int32Array на 1 КБ.
 */

export interface GridSpec {
  width: number;
  height: number;
}

/** Поле по умолчанию — то самое 16×16 из конфига баланса. */
export const DEFAULT_SPEC: GridSpec = { width: GRID_WIDTH, height: GRID_HEIGHT };

/**
 * Порядок обхода соседей: вверх, вправо, вниз, влево.
 * Фиксированный он затем, что по нему же восстанавливается сам маршрут: при равных
 * расстояниях робот всегда сворачивает одинаково, и бой с той же базой проигрывается
 * одинаково (повторы, реплеи, разбор тикетов).
 */
const NEIGHBORS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: 0, dy: -1 },
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 }
];

/**
 * Тот же список направлений — наружу.
 *
 * Экспортируется ради резолвера боя (pvp/battle): там, где путь перекрыт, робот бьёт
 * соседа по тому же списку и в том же порядке. Своя копия направлений в двух модулях —
 * это гарантированное расхождение при правке одного из них.
 */
export const NEIGHBOR_OFFSETS = NEIGHBORS;


export function inBounds(spec: GridSpec, cell: Cell): boolean {
  return (
    Number.isInteger(cell.x) &&
    Number.isInteger(cell.y) &&
    cell.x >= 0 &&
    cell.x < spec.width &&
    cell.y >= 0 &&
    cell.y < spec.height
  );
}

/** Плоский индекс клетки либо -1, если та вне поля. Строгий: NaN и дроби дают -1. */
export function cellIndex(spec: GridSpec, x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= spec.width || y >= spec.height) return -1;
  return y * spec.width + x;
}

export function cellCoord(spec: GridSpec, index: number): Cell {
  return { x: index % spec.width, y: Math.floor(index / spec.width) };
}

/** Распознаваемые коды проблем. Клиент по ним рисует подсказку в редакторе, а не разбор текста. */
export type LayoutViolation = 'spawn_blocked' | 'hq_blocked' | 'no_path' | 'overlapping_cells';
export type LayoutWarning = 'path_too_short' | 'orphan_cells';

export interface AnalyzeInput {
  /** Точки входа роботов (серверный конфиг, не данные клиента). */
  spawns: readonly Cell[];
  /** Штаб — цель обороны. */
  hq: Cell;
  /** Клетки, непроходимые для роботов: стены и (по флагу конфига) сами единицы. */
  blocked: readonly Cell[];
  spec?: GridSpec;
  /** Переопределение порога длины пути — для тестов и карт другого размера. */
  minPathTiles?: number;
}

export interface LayoutAnalysis {
  spec: GridSpec;
  /** true — бой на этой базе возможен: от каждых ворот есть маршрут к штабу. */
  ok: boolean;
  violations: LayoutViolation[];
  warnings: LayoutWarning[];
  /** Длина худшего из кратчайших маршрутов, шагов; -1 — пути нет. */
  pathTiles: number;
  /** Маршрут худшего подхода (для превью в редакторе и для резолвера боя). */
  path: Cell[] | null;
  /** Кратчайшее расстояние от каждых ворот до штаба, по порядку `spawns`; -1 — недостижимы. */
  spawnDistances: number[];
  /** Проходимых клеток всего (поле минус занятые). */
  walkable: number;
  /** Из них тех, куда роботы способны попасть хотя бы с одних ворот. */
  reachable: number;
  /** Проходимые «карманы», отрезанные от ворот: башни там не стреляют ни по кому. */
  orphans: number;
  connectedSpawns: number;
  totalSpawns: number;
}

const readI32 = (array: Int32Array, index: number): number => array[index] ?? -1;

/**
 * Расстояния от каждой клетки до штаба (BFS от ЦЕЛИ, а не от ворот).
 *
 * Обратный обход выбран не вкусовщиной: один проход отдаёт расстояния до цели сразу
 * для ВСЕХ точек входа, тогда как BFS от ворот пришлось бы запускать по разу на каждые
 * ворота (8 запусков на той же карте). Заодно `dist` целиком определяет маршрут: путь
 * из любой клетки — шаг к соседу с расстоянием на единицу меньше.
 */
function distanceField(spec: GridSpec, blockedMask: Uint8Array, hqIndex: number): Int32Array {
  const size = spec.width * spec.height;
  const dist = new Int32Array(size).fill(-1);
  if (hqIndex < 0 || hqIndex >= size || blockedMask[hqIndex] === 1) return dist;

  // Очередь с указателем головы: shift() на массиве — O(n). На 256 клетках ещё терпимо,
  // но ровно этот код будет вызываться на каждый бой в сутки.
  const queue = new Int32Array(size);
  let head = 0;
  let tail = 0;

  dist[hqIndex] = 0;
  queue[tail++] = hqIndex;

  while (head < tail) {
    const current = queue[head++] ?? -1;
    if (current < 0) break;
    const currentDist = readI32(dist, current);
    const cx = current % spec.width;
    const cy = Math.floor(current / spec.width);

    for (const { dx, dy } of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= spec.width || ny >= spec.height) continue;
      const next = ny * spec.width + nx;
      if (blockedMask[next] === 1) continue;
      if (readI32(dist, next) !== -1) continue;
      dist[next] = currentDist + 1;
      queue[tail++] = next;
    }
  }
  return dist;
}


/** Восстановление маршрута из поля расстояний: из каждой клетки — сосед с dist-1, порядок фиксирован. */
function tracePath(spec: GridSpec, dist: Int32Array, from: Cell): Cell[] | null {
  let index = cellIndex(spec, from.x, from.y);
  if (index < 0 || readI32(dist, index) < 0) return null;

  const path: Cell[] = [cellCoord(spec, index)];
  let guard = spec.width * spec.height;
  while (readI32(dist, index) !== 0 && guard-- > 0) {
    const remaining = readI32(dist, index);
    const cx = index % spec.width;
    const cy = Math.floor(index / spec.width);
    let found = -1;
    for (const { dx, dy } of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= spec.width || ny >= spec.height) continue;
      const candidate = ny * spec.width + nx;
      if (readI32(dist, candidate) === remaining - 1) {
        found = candidate;
        break;
      }
    }
    if (found < 0) return null;
    index = found;
    path.push(cellCoord(spec, index));
  }
  return path;
}

/** Канонический порядок нарушений в отчёте — стабильный ответ на один и тот же ввод. */
const VIOLATION_ORDER: readonly LayoutViolation[] = ['overlapping_cells', 'spawn_blocked', 'hq_blocked', 'no_path'];

/**
 * Единственный анализатор планировки. Возвращает отчёт, а не бросает: «путь перекрыт»
 * — штатная ситуация редактора (игрок просто поставил не ту стену), и превращать её в
 * exception означало бы потерять несохранённую работу из-за одного касания. Вызывающий
 * слой сам решает, что ошибка, а что предупреждение.
 */
export function analyzeLayout(input: AnalyzeInput): LayoutAnalysis {
  const spec = input.spec ?? DEFAULT_SPEC;
  const minPathTiles = input.minPathTiles ?? MIN_PATH_TILES;
  const size = spec.width * spec.height;
  const mask = new Uint8Array(size);
  const found = new Set<LayoutViolation>();

  let blockedCount = 0;
  for (const cell of input.blocked) {
    const index = cellIndex(spec, cell.x, cell.y);
    // Клетки вне поля сюда не попадают: структурные нарушения ловит defense.ts (400),
    // а геометрия обязана остаться тотальной — иначе один кривой x уронит BFS.
    if (index < 0) continue;
    if (mask[index] === 1) found.add('overlapping_cells');
    else {
      mask[index] = 1;
      blockedCount += 1;
    }
  }

  const hqIndex = cellIndex(spec, input.hq.x, input.hq.y);
  if (hqIndex >= 0 && mask[hqIndex] === 1) found.add('hq_blocked');

  const spawnIndices: number[] = [];
  for (const cell of input.spawns) {
    const index = cellIndex(spec, cell.x, cell.y);
    if (index < 0) continue;
    if (mask[index] === 1) found.add('spawn_blocked');
    spawnIndices.push(index);
  }
  if (spawnIndices.length === 0) found.add('no_path');

  const dist = distanceField(spec, mask, hqIndex);
  const spawnDistances = spawnIndices.map((index) => readI32(dist, index));
  const connected = spawnDistances.filter((value) => value >= 0);
  if (connected.length !== spawnDistances.length) found.add('no_path');

  const violations = VIOLATION_ORDER.filter((code) => found.has(code));
  const ok = violations.length === 0;

  let pathTiles = -1;
  let path: Cell[] | null = null;
  if (connected.length > 0) {
    // Худший подход = самый длинный из кратчайших: именно по нему игрок судит,
    // успеют ли башни снять волну до штаба.
    let worst = 0;
    let worstSpawn: Cell | null = null;
    spawnIndices.forEach((index, position) => {
      const value = readI32(dist, index);
      if (value >= 0 && value > worst) {
        worst = value;
        worstSpawn = input.spawns[position] ?? null;
      }
    });
    pathTiles = worst;
    // worst === 0 возможно лишь если штаб стоит на клетке ворот; конфигурация этого не даёт.
    if (worstSpawn) path = tracePath(spec, dist, worstSpawn);
  }

  let reachable = 0;
  for (let index = 0; index < size; index += 1) {
    if (readI32(dist, index) >= 0) reachable += 1;
  }
  const walkable = size - blockedCount;
  const orphans = Math.max(0, walkable - reachable);

  const warnings: LayoutWarning[] = [];
  if (ok && minPathTiles > 0 && pathTiles >= 0 && pathTiles < minPathTiles) warnings.push('path_too_short');
  if (orphans > ORPHAN_TOLERANCE) warnings.push('orphan_cells');

  return {
    spec,
    ok,
    violations,
    warnings,
    pathTiles,
    path,
    spawnDistances,
    walkable,
    reachable,
    orphans,
    connectedSpawns: connected.length,
    totalSpawns: spawnIndices.length
  };
}

/** Человекочитаемое описание проблемы: HTTP-слой отдаёт его в details, фронт — в подсказке редактора. */
export function describeIssue(issue: LayoutViolation | LayoutWarning): string {
  switch (issue) {
    case 'overlapping_cells':
      return 'Несколько элементов заявлены на одной клетке';
    case 'spawn_blocked':
      return 'Ворота роботов перекрыты — путь начинается в стене';
    case 'hq_blocked':
      return 'Штаб перекрыт собственным строением';
    case 'no_path':
      return 'Лабиринт не проходим: хотя бы с одних ворот до штаба нет маршрута';
    case 'path_too_short':
      return `Маршрут короче ${MIN_PATH_TILES} клеток: атакующий дойдёт до штаба почти сразу`;
    case 'orphan_cells':
      return 'Есть проходимые клетки, отрезанные от ворот: башни там не стреляют ни по кому';
  }
}

// ─── Поле маршрутов для симуляции боя (Шаг 4) ─────────────────────────────────

export interface RouteFieldInput {
  hq: Cell;
  /** Непроходимые клетки на ТЕКУЩИЙ момент боя (стены + башни, что ещё живы). */
  blocked: readonly Cell[];
  spec?: GridSpec;
}

/**
 * Снимок поля расстояний «от любой клетки до штаба», по которому роботы идут в бою.
 *
 * ОТДЕЛЬНАЯ ФУНКЦИЯ, а не часть analyzeLayout, по двум причинам:
 *  1. Бой пересчитывает поле каждый раз, когда падает стена или башня, — отчёты
 *     о нарушениях при этом не нужны вовсе, и платить за них лишними аллокациями
 *     резолвер не обязан;
 *  2. `analyzeLayout` отвечает на вопрос «проходима ли база», этот — «куда идти
 *     прямо сейчас». Разные вопросы, разные контракты.
 *
 * Инвариант, за которым надо следить: и валидатор, и симулятор вызывают ОДИН и тот
 * же BFS (`distanceField` ниже). Расхождение здесь даёт базу, которая «проходима»
 * на сохранении и застревает в бою — то есть рейд, который не заканчивается никогда.
 */
export interface RouteField {
  spec: GridSpec;
  /** Расстояние до штаба из клетки, шагов; -1 — недостижима либо вне поля. */
  distance(cell: Cell): number;
  /** То же по плоскому индексу клетки (резолвер держит индексы, а не пары чисел). */
  distanceAt(index: number): number;
  /** Следующая клетка маршрута к штабу; null — штаб здесь либо тупик. */
  next(cell: Cell): Cell | null;
  /** Занята ли клетка блокером (стена/башня) — по ней и бьют, когда путь перекрыт. */
  isBlocked(cell: Cell): boolean;
  isBlockedAt(index: number): boolean;
  /** Полный маршрут из клетки до штаба (для реплея и отладки), либо null. */
  route(cell: Cell): Cell[] | null;
}

export function buildRouteField(input: RouteFieldInput): RouteField {
  const spec = input.spec ?? DEFAULT_SPEC;
  const size = spec.width * spec.height;
  const mask = new Uint8Array(size);
  for (const cell of input.blocked) {
    const index = cellIndex(spec, cell.x, cell.y);
    if (index >= 0) mask[index] = 1;
  }
  const hqIndex = cellIndex(spec, input.hq.x, input.hq.y);
  const dist = distanceField(spec, mask, hqIndex);

  return {
    spec,
    distance: (cell) => readI32(dist, cellIndex(spec, cell.x, cell.y)),
    distanceAt: (index) => readI32(dist, index),
    isBlocked: (cell) => {
      const index = cellIndex(spec, cell.x, cell.y);
      return index >= 0 && mask[index] === 1;
    },
    isBlockedAt: (index) => index >= 0 && index < size && mask[index] === 1,
    next: (cell) => {
      const index = cellIndex(spec, cell.x, cell.y);
      const remaining = readI32(dist, index);
      if (index < 0 || remaining <= 0) return null;
      const cx = index % spec.width;
      const cy = Math.floor(index / spec.width);
      for (const { dx, dy } of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= spec.width || ny >= spec.height) continue;
        const candidate = ny * spec.width + nx;
        if (readI32(dist, candidate) === remaining - 1) return cellCoord(spec, candidate);
      }
      return null;
    },
    route: (cell) => {
      const index = cellIndex(spec, cell.x, cell.y);
      if (index < 0 || readI32(dist, index) < 0) return null;
      return tracePath(spec, dist, cell);
    }
  };
}
