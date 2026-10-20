import {
  BLOCKS_MOVEMENT,
  HQ_PADS,
  MAX_DEPLOYED_UNITS,
  MAX_WALLS,
  SPAWN_CELLS,
  WALL_COST,
  WALL_SALVAGE_COST,
  cellEquals,
  formatCell,
  isDeployableKind,
  scaleMaterial,
  type Cell
} from '../../config/base.js';
import { type MaterialCost } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { gainMaterials, payMaterials } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { BaseState, DeployedUnit, InventoryItem, UserAccount } from '../user/user.types.js';
import { analyzeLayout, cellIndex, describeIssue, DEFAULT_SPEC, type GridSpec, type LayoutAnalysis } from './grid.js';

/**
 * Планировка обороны: валидация сетки, постановка единиц и стены, их снятие (Шаг 3).
 *
 * Чистые функции, редуктор — в HTTP-слое (`UserStore.transact`), деньги — только
 * через черновики журнала. Тот же контракт, что у workshop/craft и raid/loot.
 *
 * ГЛАВНЫЙ ПРИНЦИП РАЗДЕЛЕНИЯ ОШИБОК. Два класса отказов здесь принципиально разные,
 * и смешивать их — значит то терять данные игрока, то пропускать битую базу в PvP:
 *
 *  1. Нарушения модели данных (координата вне поля, две сущности на одной клетке,
 *     стена на воротах, чужой предмет, превышение лимита) → AppError 400/404/409.
 *     Такое нельзя сохранить: документ с дублем клетки или ссылкой на чужой предмет
 *     разъедется с инвентарем при первом же чтении.
 *
 *  2. Нарушения проходимости (роботы не дойдут до штаба, маршрут слишком короткий)
 *     → НЕ ошибка, а поле `report` в успешном ответе. Планировка сохраняется, игрок
 *     не теряет сорок минут работы из-за одного касания, а матчмейкинг такую базу не
 *     берёт, потому что проходимость — производная, она пересчитывается на чтении.
 *     Именно поэтому в состоянии базы нет поля `isValid`: хранимый флаг устаревает
 *     в тот момент, когда у игрока отзывают предмет, и PvP получает «валидную» базу
 *     с несуществующей турелью.
 */

export interface UnitPlacementInput {
  itemId: string;
  x: number;
  y: number;
}

/**
 * Желаемое состояние базы.
 *
 * Стены и единицы — PATCH-семантика: поле отсутствует (undefined) = не трогать,
 * пустой массив = снести всё. Full-replace здесь стоил бы дорогих ошибок: клиент,
 * забывший дослать `units` вместе со `walls`, молча снял бы всю оборону с карты и
 * списал бы заново материалы на стены.
 */
export interface LayoutInput {
  /** Версия снапшота, который правил клиент; null/undefined — проверка не требуется (первое сохранение). */
  version?: number | null;
  /** null/undefined — оставить текущий штаб. */
  hq?: Cell | null;
  walls?: readonly Cell[];
  units?: readonly UnitPlacementInput[];
}

export interface BaseReport {
  analysis: LayoutAnalysis;
  /** true — база допускается в матчмейкинг: сетка проходима от всех ворот до штаба. */
  ready: boolean;
  /**
   * Коды-подсказки для UI: нарушения проходимости (`analysis.violations`) плюс
   * состояние состава — 'no_units' (некому стрелять) и 'unbound_units' (ссылки на
   * несуществующие предметы). Не блокирующие: сохранённая база с подсказками —
   * нормальная рабочая ситуация редактора.
   */
  notices: string[];
  /** Сколько стен и единиц стоит на поле сейчас. */
  walls: number;
  units: number;
  /** Ссылки на предметы, которых уже нет в инвентаре (отозван рефандом, снят админом). */
  unbound: number;
  maxWalls: number;
  maxUnits: number;
}

const SPEC: GridSpec = DEFAULT_SPEC;

/** Структурный отказ планировки. `reason` — машинный код, по нему фронт подсвечивает клетку. */
function invalid(reason: string, message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError(ErrorCodes.PLACEMENT_INVALID, 400, message, { reason, ...details });
}

function assertCell(spec: GridSpec, cell: unknown, what: string): Cell {
  const candidate = cell as Partial<Cell> | null | undefined;
  if (!candidate || typeof candidate !== 'object') {
    throw invalid('cell_shape', `Некорректная клетка ${what}`, { cell });
  }
  const index = cellIndex(spec, Number(candidate.x), Number(candidate.y));
  if (index < 0) {
    throw invalid('out_of_bounds', `Клетка ${what} вне поля ${spec.width}×${spec.height}`, {
      x: candidate.x,
      y: candidate.y,
      field: { width: spec.width, height: spec.height }
    });
  }
  return { x: Number(candidate.x), y: Number(candidate.y) };
}

function isSpawn(cell: Cell): boolean {
  return SPAWN_CELLS.some((spawn) => cellEquals(spawn, cell));
}

function isHqPad(cell: Cell): boolean {
  return HQ_PADS.some((pad) => cellEquals(pad, cell));
}

/** Индексы занятых клеток: Set чисел, а не строк «x,y» — без аллокаций на ключ и без коллизий формата. */
function indicesOf(spec: GridSpec, cells: readonly Cell[]): Set<number> {
  const result = new Set<number>();
  for (const cell of cells) {
    const index = cellIndex(spec, cell.x, cell.y);
    if (index >= 0) result.add(index);
  }
  return result;
}


// ─── Чтение: всё производно от документа ──────────────────────────────────────

/**
 * Единицы на карте, ссылки на которые ещё живы.
 *
 * Призрак (предмет отозван рефандом, снят админом, пропал при разборе) не должен
 * ронять ни валидатор, ни бой: он вырезается здесь же, на чтении, и наружу
 * возвращается счётчик `unbound` — его видно в витрине, и поддержка понимает,
 * почему у игрока «пропала башня с карты».
 */
export function liveUnits(base: BaseState, inventory: readonly InventoryItem[]): { units: DeployedUnit[]; unbound: number } {
  const owned = new Set(inventory.map((item) => item.id));
  const units = base.units.filter((unit) => owned.has(unit.itemId));
  return { units, unbound: base.units.length - units.length };
}

/** Клетки, непроходимые для роботов, — с уважением к флагу конфига на каждый тип элемента. */
export function blockingCells(account: UserAccount): Cell[] {
  const cells: Cell[] = [];
  if (BLOCKS_MOVEMENT.wall) for (const wall of account.base.walls) cells.push({ ...wall });
  if (BLOCKS_MOVEMENT.unit) {
    const { units } = liveUnits(account.base, account.inventory);
    for (const unit of units) cells.push({ x: unit.x, y: unit.y });
  }
  return cells;
}

/** Проходимость текущей базы. Дёшево (≤256 клеток) и всегда актуально — см. шапку модуля. */
export function analyzeAccount(account: UserAccount): LayoutAnalysis {
  return analyzeLayout({ spawns: SPAWN_CELLS, hq: account.base.hq, blocked: blockingCells(account), spec: SPEC });
}

/** Отчёт о базе для витрины и для матчмейкинга (Шаг 4). */
export function describeBase(account: UserAccount): BaseReport {
  const analysis = analyzeAccount(account);
  const { units, unbound } = liveUnits(account.base, account.inventory);

  const notices: string[] = [...analysis.violations, ...analysis.warnings];
  if (units.length === 0) notices.push('no_units');
  if (unbound > 0) notices.push('unbound_units');

  return {
    analysis,
    ready: analysis.ok,
    notices,
    walls: account.base.walls.length,
    units: units.length,
    unbound,
    maxWalls: MAX_WALLS,
    maxUnits: MAX_DEPLOYED_UNITS
  };
}

/** Текстовые подсказки к отчёту — фронт может показать их дословно. */
export function issueTexts(report: BaseReport): string[] {
  return [...report.analysis.violations, ...report.analysis.warnings].map((issue) => describeIssue(issue));
}

export function deployedItemIds(account: UserAccount): ReadonlySet<string> {
  return new Set(liveUnits(account.base, account.inventory).units.map((unit) => unit.itemId));
}

export function placementOf(account: UserAccount, itemId: string): DeployedUnit | null {
  return liveUnits(account.base, account.inventory).units.find((unit) => unit.itemId === itemId) ?? null;
}

export function isItemDeployed(account: UserAccount, itemId: string): boolean {
  return deployedItemIds(account).has(itemId);
}

/** Какие предметы игрок вправе выставить: свой, нужного вида, ещё не занят на карте. */
export function deployableItems(account: UserAccount): InventoryItem[] {
  const taken = deployedItemIds(account);
  return account.inventory.filter((item) => isDeployableKind(item.kind) && !taken.has(item.id));
}

/** Стоимость установки `count` клеток стены (цену считает сервер, не клиент). */
export function quoteWallCost(count: number): MaterialCost {
  return scaleMaterial(WALL_COST, Math.max(0, Math.trunc(count)));
}

/**
 * Каноническая подпись планировки. Порядок клеток фиксирован сортировкой, поэтому две
 * одинаковые по составу сетки дают одну строку: на ней держится признак «изменение есть».
 */
export function layoutSignature(base: BaseState): string {
  const walls = base.walls.map((cell) => `${cell.x}.${cell.y}`).sort().join(',');
  const units = base.units.map((unit) => `${unit.itemId}@${unit.x}.${unit.y}`).sort().join(',');
  return `${base.hq.x}.${base.hq.y}|${walls}|${units}`;
}

/**
 * Короткий хеш подписи — для ключей идемпотентности журнала.
 *
 * В журнал нельзя положить саму подпись: на 120 стенах это ~1000 символов, а индекс
 * ключа в Mongo ограничен 1024 байтами — вставка записи журнала упала бы на самой
 * крупной планировке, то есть ровно там, где игрок вложил больше всего денег.
 * Коллизия 32-битного хеша означала бы «второе действие отброшено как дубль», но
 * ключ содержит ещё номер версии и материал, а вероятность столкновения в пределах
 * одной серии версий пренебрежимо мала (и, в отличие от длинного ключа, безопасна).
 */
export function layoutHash(base: BaseState): string {
  const text = layoutSignature(base);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// ─── Запись: валидация модели данных ──────────────────────────────────────────

interface ValidatedLayout {
  hq: Cell;
  walls: Cell[];
  units: DeployedUnit[];
}

/**
 * Проверка желаемой планировки на то, что её вообще можно сохранить.
 *
 * Всё, что здесь отклоняется, — не «плохая тактика», а битые данные: сохранение
 * создало бы документ, расходящийся с инвентарем (чужой предмет), с картой (две
 * сущности на клетке) или с конфигом (стена поверх ворот). Такое невозможно ни
 * починить позже, ни объяснить тикетом поддержки.
 */
function validateLayout(account: UserAccount, input: LayoutInput): ValidatedLayout {
  const previous = account.base;

  if (input.version !== undefined && input.version !== null && input.version !== previous.version) {
    throw new AppError(ErrorCodes.STALE_LAYOUT, 409, 'Планировка изменилась: редактор открыт по устаревшему снапшоту', {
      expected: previous.version,
      received: input.version
    });
  }

  const hq = input.hq === undefined || input.hq === null ? { ...previous.hq } : assertCell(SPEC, input.hq, 'штаба');
  if (!isHqPad(hq)) {
    throw invalid('hq_off_pad', 'Штаб можно поставить только на одну из подготовленных площадок', {
      hq: formatCell(hq),
      pads: HQ_PADS.map((pad) => formatCell(pad))
    });
  }

  const rawWalls = input.walls === undefined ? previous.walls.map((cell) => ({ ...cell })) : input.walls;
  if (rawWalls.length > MAX_WALLS) {
    throw invalid('too_many_walls', `Стен на поле не может быть больше ${MAX_WALLS}`, {
      count: rawWalls.length,
      limit: MAX_WALLS
    });
  }

  const walls: Cell[] = [];
  const occupied = new Set<number>();
  const hqIndex = cellIndex(SPEC, hq.x, hq.y);
  for (const cell of rawWalls) {
    const wall = assertCell(SPEC, cell, 'стены');
    const index = cellIndex(SPEC, wall.x, wall.y);
    if (index < 0) throw invalid('out_of_bounds', `Клетка стены ${formatCell(wall)} вне поля`, { cell: formatCell(wall) });
    if (occupied.has(index)) {
      throw invalid('duplicate_cell', `Клетка ${formatCell(wall)} заявлена в планировке дважды`, { cell: formatCell(wall) });
    }
    if (index === hqIndex) throw invalid('reserved_hq', `Нельзя замуровать штаб (${formatCell(wall)})`, { cell: formatCell(wall) });
    if (isSpawn(wall)) throw invalid('reserved_spawn', `Нельзя замуровать ворота роботов (${formatCell(wall)})`, { cell: formatCell(wall) });
    occupied.add(index);
    walls.push(wall);
  }

  return validateUnits(account, input, { hq, walls, units: [] }, occupied, hqIndex);
}

/** Вторая половина проверки: единицы и их связь с инвентарём (отдельно, чтобы обе читались за один присест). */
function validateUnits(
  account: UserAccount,
  input: LayoutInput,
  layout: ValidatedLayout,
  occupied: Set<number>,
  hqIndex: number
): ValidatedLayout {
  const previous = account.base;
  const rawUnits =
    input.units === undefined
      ? liveUnits(previous, account.inventory).units.map((unit) => ({ ...unit }))
      : input.units;

  if (rawUnits.length > MAX_DEPLOYED_UNITS) {
    throw invalid('too_many_units', `Единиц на поле не может быть больше ${MAX_DEPLOYED_UNITS}`, {
      count: rawUnits.length,
      limit: MAX_DEPLOYED_UNITS
    });
  }

  const byId = new Map<string, InventoryItem>(account.inventory.map((item) => [item.id, item]));
  const units: DeployedUnit[] = [];
  const placedItems = new Set<string>();

  for (const candidate of rawUnits) {
    if (!candidate || typeof candidate !== 'object') {
      throw invalid('unit_shape', 'Некорректная запись единицы', { unit: candidate });
    }
    const itemId = typeof candidate.itemId === 'string' ? candidate.itemId.trim() : '';
    if (itemId.length === 0) throw invalid('unit_shape', 'Единица обязана ссылаться на itemId предмета инвентаря');

    // Код, тир и уровень сервер берёт ОТ ПРЕДМЕТА, а не из запроса. В драфте `codeName`
    // приходил с клиента: прислать «heavy_wall» вместо купленной турели было так же
    // легко, как указать координату.
    const item = byId.get(itemId);
    if (!item) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 404, 'Предмета нет в инвентаре — на карту ставят только своё', { itemId });
    }
    if (!isDeployableKind(item.kind)) {
      throw new AppError(ErrorCodes.UNIT_NOT_DEPLOYABLE, 409, 'Этот предмет не обороняет базу', {
        itemId,
        code: item.code,
        kind: item.kind
      });
    }
    if (placedItems.has(itemId)) throw invalid('duplicate_item', `Предмет ${itemId} поставлен на карту дважды`, { itemId });

    const cell = assertCell(SPEC, candidate, `единицы ${itemId}`);
    const index = cellIndex(SPEC, cell.x, cell.y);
    if (index < 0) throw invalid('out_of_bounds', `Клетка единицы ${formatCell(cell)} вне поля`, { cell: formatCell(cell) });
    if (occupied.has(index)) {
      throw invalid('duplicate_cell', `Клетка ${formatCell(cell)} уже занята стеной или другой единицей`, { cell: formatCell(cell) });
    }
    if (index === hqIndex) {
      throw invalid('reserved_hq', `Нельзя поставить единицу на клетку штаба (${formatCell(cell)})`, { cell: formatCell(cell) });
    }
    if (isSpawn(cell)) {
      throw invalid('reserved_spawn', `Ворота роботов техникой не занимают (${formatCell(cell)})`, { cell: formatCell(cell) });
    }

    occupied.add(index);
    placedItems.add(itemId);
    units.push({ itemId, x: cell.x, y: cell.y });
  }

  return { ...layout, units };
}

// ─── Запись: сохранение планировки ────────────────────────────────────────────

export interface LayoutSaveResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  base: BaseState;
  report: BaseReport;
  /** true — сетка отличается от хранимой. false — запрос-повтор: ни денег, ни версии. */
  effective: boolean;
  wallsAdded: number;
  wallsRemoved: number;
  /** В том числе переставленные: клетка изменилась — развёртывание новое (денег не стоит). */
  unitsDeployed: number;
  unitsRecalled: number;
  /** Что реально списано и начислено (после нормализации конфига), а не «сколько стен × цена». */
  charged: MaterialCost;
  refunded: MaterialCost;
}

/**
 * Сохранить планировку: стены оплачиваются дифференциально, единицы только меняют
 * привязку, проходимость возвращается отчётом (не ошибкой).
 *
 * Дифференциальная оплата — не удобства ради. Full-replace с списанием «всего»
 * означал бы, что каждое сохранение сжигает материалы заново: игрок, передумавший
 * один раз, теряет стену, за которую заплатил минуту назад, и идёт писать в поддержку.
 * Худший вариант того же рода — списание до проверки: «деньги ушли, карта не принята».
 * Здесь порядок обратный и он транзакционный: сначала валидация модели данных,
 * затем деньги, и всё это — один редуктор, который HTTP-слой оборачивает в
 * `UserStore.transact`.
 */
export function saveLayout(account: UserAccount, input: LayoutInput, now: Date): LayoutSaveResult {
  const previous = account.base;
  const layout = validateLayout(account, input);

  const prevWalls = indicesOf(SPEC, previous.walls);
  const nextWalls = indicesOf(SPEC, layout.walls);
  let wallsAdded = 0;
  let wallsRemoved = 0;
  for (const index of nextWalls) if (!prevWalls.has(index)) wallsAdded += 1;
  for (const index of prevWalls) if (!nextWalls.has(index)) wallsRemoved += 1;

  const prevUnits = new Map(liveUnits(previous, account.inventory).units.map((unit) => [unit.itemId, unit]));
  const nextUnits = new Map(layout.units.map((unit) => [unit.itemId, unit]));
  let unitsDeployed = 0;
  let unitsRecalled = 0;
  for (const [id, unit] of nextUnits) {
    const before = prevUnits.get(id);
    if (!before || before.x !== unit.x || before.y !== unit.y) unitsDeployed += 1;
  }
  for (const id of prevUnits.keys()) if (!nextUnits.has(id)) unitsRecalled += 1;

  const nextBase: BaseState = {
    hq: layout.hq,
    walls: layout.walls,
    units: layout.units,
    version: previous.version,
    updatedAt: previous.updatedAt
  };

  // Повтор того же запроса (сеть дрогнула, игрок двойной тап) не должен ни списывать
  // материалы, ни двигать версию: состав сетки тот же — значит и делать нечего.
  if (layoutSignature(nextBase) === layoutSignature(previous)) {
    return {
      account,
      drafts: [],
      base: previous,
      report: describeBase(account),
      effective: false,
      wallsAdded: 0,
      wallsRemoved: 0,
      unitsDeployed: 0,
      unitsRecalled: 0,
      charged: {},
      refunded: {}
    };
  }

  nextBase.version = previous.version + 1;
  nextBase.updatedAt = now;

  const fingerprint = layoutHash(nextBase);
  // Ключ обязан различать направление движения по одному и тому же материалу: снос и
  // установка стены — два разных события для одного и того же железа в одной пачке.
  const keyFor = (direction: 'on' | 'off') => (material: string) =>
    makeIdempotencyKey('deploy', `${direction}:v${nextBase.version}:${fingerprint}:${material}`);
  const meta = {
    version: nextBase.version,
    walls_added: wallsAdded,
    walls_removed: wallsRemoved,
    units: layout.units.length
  };

  let next: UserAccount = { ...account, base: nextBase };
  const drafts: LedgerDraft[] = [];
  let refunded: MaterialCost = {};
  let charged: MaterialCost = {};

  // Возврат за снесённое — ДО оплаты нового. Иначе игрок, перегораживающий восток
  // ради запада, словит «не хватает железа» в операции, которая по итогу не стоит
  // ничего: оба движения живут внутри одного редуктора, утечки нет.
  if (wallsRemoved > 0) {
    const gained = gainMaterials(next, scaleMaterial(WALL_SALVAGE_COST, wallsRemoved), {
      ts: now,
      reason: 'undeploy',
      refType: 'base_cell',
      refId: null,
      idempotencyKeyFor: keyFor('off'),
      meta
    });
    next = gained.account;
    refunded = gained.moved;
    drafts.push(...gained.drafts);
  }

  if (wallsAdded > 0) {
    const paid = payMaterials(next, scaleMaterial(WALL_COST, wallsAdded), {
      ts: now,
      reason: 'deploy',
      refType: 'base_cell',
      refId: null,
      idempotencyKeyFor: keyFor('on'),
      meta
    });
    next = paid.account;
    charged = paid.moved;
    drafts.push(...paid.drafts);
  }

  return {
    account: next,
    drafts,
    base: nextBase,
    report: describeBase(next),
    effective: true,
    wallsAdded,
    wallsRemoved,
    unitsDeployed,
    unitsRecalled,
    charged,
    refunded
  };
}

/**
 * Снять оборону целиком: единицы возвращаются в запас (они не расходовались), стены
 * идут в материалы по доле сноса. Операция боевая — «эвакуация» перед рейдом — и
 * потому отдельная: клиент не обязан слать двести координат, чтобы сказать «снять всё».
 */
export function clearLayout(account: UserAccount, now: Date): LayoutSaveResult {
  return saveLayout(account, { walls: [], units: [] }, now);
}



