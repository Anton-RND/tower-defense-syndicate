import { BLOCKS_MOVEMENT, SPAWN_CELLS, type Cell } from '../../config/base.js';
import {
  ATTACK_MAX_ROBOTS,
  DRAW_HQ_DAMAGE_RATIO,
  HQ_HP,
  RAID_FUEL_HORIZON_MS,
  SIM_MAX_EVENTS,
  SIM_MAX_TICKS,
  SIM_SPAWN_INTERVAL_MS,
  SIM_TICK_MS,
  THERMAL,
  WALL_HP,
  defenseProfileOf,
  robotProfileOf,
  type ResolvedDefense,
  type ResolvedRobot
} from '../../config/pvp.js';
import type { BattleOutcome } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { combatReadiness, fuelAvailability, unitPowerProfile, type OfflineReason } from '../economy/power.js';
import { deployedUnitCodes, type InventoryItem, type UserAccount } from '../user/user.types.js';
import { isItemDeployed, liveUnits } from './defense.js';
import { DEFAULT_SPEC, NEIGHBOR_OFFSETS, buildRouteField, cellCoord, cellIndex, type RouteField } from './grid.js';

/**
 * Симуляция штурма (Шаг 4, п.4 ТЗ).
 *
 * ЧИСТАЯ ФУНКЦИЯ БЕЗ СЛУЧАЙНОСТИ: исход — единственное значение от (планировка
 * защитника, состав атакующего). Отсюда три свойства, которые держат весь PvP:
 *  - воспроизводимость: жалоба «бой был честным, а засчитали другое» пересчитывается
 *    дословно, без логов и без «а что там было в памяти»;
 *  - отсутствие клиента-источника истины: фронт не сообщает ни урон, ни исход, он
 *    показывает то, что посчитал сервер (в драфте ТЗ армия приходила с `hp` и
 *    `speed` от клиента — то есть игрок мог прислать `hp: 10^9`);
 *  - один и тот же лабиринт в валидаторе и в бою: оба ходят через `buildRouteField`
 *    (тот же BFS, что и `analyzeLayout`), поэтому «проходимая на сохранении» база
 *    физически не может оказаться «застревающей в бою».
 *
 * Чего здесь НЕТ: состояния. Ни очередей, ни таймеров, ни записи боя. Рейд живёт
 * столько, сколько стоит запрос: подбор → симуляция → редукторы аккаунтов.
 */

const SPEC = DEFAULT_SPEC;
const DT_SEC = SIM_TICK_MS / 1000;

function armyInvalid(reason: string, message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError(ErrorCodes.ARMY_INVALID, 400, message, { reason, ...details });
}

// ─── Армия атакующего ─────────────────────────────────────────────────────────

/** Одна партия дронов: предмет инвентаря и сколько машин он выставляет. */
export interface ArmySquad {
  itemId: string;
  profile: ResolvedRobot;
  count: number;
}

export interface ArmyFuel {
  /** Дейтерий на всё автономное звено, ед./ч (по машинам, что вылетели). */
  perHour: number;
  /** Сколько дейтерия зарезервировано под горизонт боя, ед. Списывается по факту. */
  reserve: number;
  /** Сколько машин не вылетело из-за пустого бака. */
  grounded: number;
}

export interface ArmyResolution {
  squads: ArmySquad[];
  /** Всего машин в рейде (сумма роев). */
  robots: number;
  /** Суммарный потенциал урона в секунду (для витрины «сила армии»). */
  dps: number;
  hp: number;
  /** Топливо тяжёлых дронов: резерв на горизонт и посадка недозаправленных. */
  fuel: ArmyFuel;
}

/**
 * Разворачивает список itemId в состав армии.
 *
 * Клиент присылает ТОЛЬКО идентификаторы предметов. Код, тир, уровень, а значит и все
 * боевые цифры, сервер берёт из инвентаря атакующего — по той же причине, по которой
 * Шах 3 отказался принимать `codeName` единицы: прислать «Цербера» вместо грузового
 * дрона так же легко, как придумать себе hp.
 *
 * Отказывает на: чужом/несуществующем предмете, предмете не-штурмовике, дроне,
 * стоящем на собственной обороне (нельзя воевать двумя ролями одновременно),
 * и на выходе за потолок рейда.
 */
export function resolveArmy(attacker: UserAccount, itemIds: readonly string[]): ArmyResolution {
  const unique = [...new Set(itemIds.map((id) => String(id ?? '').trim()).filter((id) => id.length > 0))];
  if (unique.length === 0) {
    throw armyInvalid('empty', 'В рейд нужно вывести хотя бы одного дрона', {
      min: 1,
      received: itemIds.length
    });
  }
  // Сортировка до обхода: состав армии не зависит от того, в каком порядке клиент
  // перечислил предметы. Порядок влияет на очередь спавна, значит и на исход боя.
  unique.sort();

  const byId = new Map(attacker.inventory.map((item) => [item.id, item]));
  const squads: ArmySquad[] = [];
  // Счётчик ЗАПРОШЕННЫХ машин: потолок рейда (ATTACK_MAX_ROBOTS) проверяется по нему,
  // а не по тому, что осталось после раздачи дейтерия. Ограничение на размер рейда —
  // антифрод и защита симуляции от O(машин), и оно не имеет права становиться мягче
  // от того, что у игрока пустой бак.
  let requested = 0;

  for (const itemId of unique) {
    const item = byId.get(itemId);
    if (!item) {
      throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 404, 'Дрона нет в вашем инвентаре — в рейд отправляют только своё', {
        itemId
      });
    }
    const profile = robotProfileOf(item);
    if (!profile) {
      throw armyInvalid('not_attacker', 'Этот предмет не участвует в атаке', {
        itemId,
        code: item.code,
        kind: item.kind
      });
    }
    if (isItemDeployed(attacker, itemId)) {
      throw armyInvalid('deployed', 'Дрон стоит на вашей обороне — сначала снимите его с карты', { itemId });
    }
    requested += profile.squad;
    if (requested > ATTACK_MAX_ROBOTS) {
      throw armyInvalid('too_large', `В одном рейде не больше ${ATTACK_MAX_ROBOTS} дронов`, {
        requested,
        limit: ATTACK_MAX_ROBOTS
      });
    }
    squads.push({ itemId, profile, count: profile.squad });
  }

  // ─── Дейтерий тяжёлых дронов ────────────────────────────────────────────────
  // Автономная техника летит только с зарезервированным на ВЕСЬ ГОРИЗОНТ БОЯ баком.
  // Резерв, а не фактический расход: длительность становится известна лишь из итога,
  // и разрешить рейд «на 180 секунд, которых может и не быть» значило бы отправить
  // рой на посадку посреди чужой базы — то есть подарить защитнику беспомощные мишени
  // и отнять у атакующего право на трезвый расчёт.
  const fuel: ArmyFuel = { perHour: 0, reserve: 0, grounded: 0 };
  const autonomous: Record<string, number> = {};
  for (const squad of squads) {
    if (unitPowerProfile(squad.profile.code)?.class === 'autonomous') {
      autonomous[squad.profile.code] = (autonomous[squad.profile.code] ?? 0) + squad.count;
    }
  }
  if (Object.keys(autonomous).length > 0) {
    const availability = fuelAvailability({
      units: autonomous,
      deuterium: attacker.storages.deuterium ?? 0,
      horizonMs: RAID_FUEL_HORIZON_MS
    });
    fuel.perHour = availability.perHour;
    fuel.reserve = availability.reserve;
    // Тот же порядок раздачи, что и в обороне: по идентификатору предмета, стабильно.
    const budget: Record<string, number> = { ...availability.online };
    for (const squad of [...squads].sort((a, b) => (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0))) {
      const code = squad.profile.code;
      if (unitPowerProfile(code)?.class !== 'autonomous') continue;
      const allowed = Math.max(0, budget[code] ?? 0);
      const fly = Math.min(squad.count, allowed);
      budget[code] = allowed - fly;
      fuel.grounded += squad.count - fly;
      squad.count = fly;
    }
    for (let i = squads.length - 1; i >= 0; i -= 1) {
      if ((squads[i]?.count ?? 0) <= 0) squads.splice(i, 1);
    }
  }

  // Итоги пересчитываются по уцелевшим машинам, а не по тому, что было до раздачи:
  // витрина «сила армии» обязана описывать тот рой, который действительно вылетел.
  let robots = 0;
  let dps = 0;
  let hp = 0;
  for (const squad of squads) {
    robots += squad.count;
    dps += squad.profile.dps * squad.count;
    hp += squad.profile.hp * squad.count;
  }

  return { squads, robots, dps: Math.round(dps * 100) / 100, hp, fuel };
}

// ─── Оборона защитника ────────────────────────────────────────────────────────

export interface DefenseTower {
  itemId: string;
  profile: ResolvedDefense;
  hp: number;
  maxHp: number;
  /** Плоский индекс клетки: в бою клетки адресуются числами, парами координат — только на выходе. */
  cell: number;
  alive: boolean;
  /**
   * Обесточена ли башня на момент входа в бой (сеть не тянет, азота нет, дейтерий
   * кончился). `alive` и `powered` — РАЗНЫЕ флаги, и в этом весь смысл интеграции:
   * мёртвая башня исчезла с дороги, а глухая стоит, принимает урон и не стреляет.
   * Игрок, потерявший питание, должен получить дыру в ПВО, а не бесплатный снос
   * построек — иначе обесточивать свою оборону было бы выгодно.
   */
  powered: boolean;
  /** Причина, по которой башня глуха: витрина разбора боя показывает её дословно. */
  powerReason: OfflineReason | null;
  /** Боевое тепловыделение из `UNIT_POWER_PROFILE`, кВт. 0 — контур не греется. */
  heatKw: number;
  /** Нормированное тепло ствола 0..1 (см. THERMAL в config/pvp.ts). */
  heat: number;
  /** true — ствол ушёл в упор и молчит, пока не остынет до `THERMAL.recoverRatio`. */
  overheated: boolean;
}

export interface DefenseWall {
  cell: number;
  hp: number;
  maxHp: number;
  alive: boolean;
}

export interface DefenseSnapshot {
  hq: Cell;
  hqIndex: number;
  towers: DefenseTower[];
  walls: DefenseWall[];
  /**
   * Индексы клеток → башня/стена. Клетки за бой не меняются, поэтому карта строится
   * один раз: поиск `.find()` по соседям в каждом тике на 48 дронах × 900 тиков
   * стоил бы миллионов сравнений там, где хватает двух хеш-управлений.
   */
  towerAt: Map<number, DefenseTower>;
  wallAt: Map<number, DefenseWall>;
  /** Суммарный dps живой обороны на старте — «сила обороны» для витрины и матчмейкинга. */
  dps: number;
  hp: number;
  /** Сколько башен встретили бой обесточенными (сеть, азот, дейтерий). */
  unpowered: number;
  /** Причины отказов по кодам — для разбора боя («у тебя рейлганы без дейтерия стояли»). */
  denied: Record<string, OfflineReason>;
  /**
   * Дейтерий, который автономная техника защитника сожжёт за бой, ед./ч. Нулевой
   * горизонт резерва (`deuteriumReserve`) уже учтён в `unpowered`: в строю только
   * то, что чем-то заправлено.
   */
  deuteriumPerHour: number;
}

/**
 * Боевой снимок базы защитника.
 *
 * `liveUnits` вырезает призраков (предмет отозван рефандом, снят админом) — те же
 * самые, что вырезает валидатор Шага 3. Один источник правды обязателен: иначе бой
 * идёт по турели, которой нет, и защитник проигрывает рейд из-за чужой отмены платежа.
 *
 * Порядок башен и стен — по индексу клетки. Обход в недетерминированном порядке
 * (Map-вставка, порядок инвентаря) сделал бы бой разным при одинаковых базах.
 */
export function defenseSnapshot(defender: UserAccount): DefenseSnapshot {
  const hq = defender.base.hq;
  const hqIndex = cellIndex(SPEC, hq.x, hq.y);
  const items = new Map(defender.inventory.map((item) => [item.id, item as InventoryItem]));

  const towers: DefenseTower[] = [];
  for (const unit of liveUnits(defender.base, defender.inventory).units) {
    const item = items.get(unit.itemId);
    if (!item) continue;
    const profile = defenseProfileOf(item);
    if (!profile) continue;
    const cell = cellIndex(SPEC, unit.x, unit.y);
    if (cell < 0) continue;
    towers.push({
      itemId: unit.itemId,
      profile,
      hp: profile.hp,
      maxHp: profile.hp,
      cell,
      alive: true,
      // Значения перетираются ниже, после расчёта боеготовности. Инициализация здесь
      // обязательна: `powered: undefined` прошёл бы проверку `!tower.powered` и
      // отправил бы всю оборону в резерв молча.
      powered: true,
      powerReason: null,
      heatKw: 0,
      heat: 0,
      overheated: false
    });
  }
  towers.sort((a, b) => a.cell - b.cell);

  // Сеть и общий бак решают, ЧТО ИЗ ЭТОГО СТРЕЛЯЕТ. Раздача идёт в порядке клетки
  // (towers уже отсортированы), поэтому «две одинаковые турели, одна глухая» — всегда
  // одна и та же, а не лотерея от порядка инвентаря.
  const readiness = combatReadiness({
    structures: defender.structures,
    units: deployedUnitCodes(defender),
    storages: defender.storages
  });
  const issued: Record<string, number> = {};
  let unpowered = 0;
  for (const tower of towers) {
    const code = tower.profile.code;
    tower.heatKw = unitPowerProfile(code)?.heat ?? 0;
    const allowed = readiness.online[code] ?? 0;
    const taken = issued[code] ?? 0;
    if (taken < allowed) {
      issued[code] = taken + 1;
      tower.powered = true;
      tower.powerReason = null;
    } else {
      tower.powered = false;
      tower.powerReason = readiness.denied[code] ?? 'power';
      unpowered += 1;
    }
  }

  const walls: DefenseWall[] = [];
  const seen = new Set<number>();
  for (const wall of defender.base.walls) {
    const cell = cellIndex(SPEC, wall.x, wall.y);
    if (cell < 0 || cell === hqIndex || seen.has(cell)) continue;
    seen.add(cell);
    walls.push({ cell, hp: WALL_HP, maxHp: WALL_HP, alive: true });
  }
  walls.sort((a, b) => a.cell - b.cell);

  let dps = 0;
  let hp = 0;
  for (const tower of towers) {
    // Номинальная сумма, включая обесточенные башни: это «сила обороны» для
    // матчмейкинга, то есть сколько у базы потенциальной стали. Реальная эффективность в бою —
    //отдельное число в отчёте (`power.unpowered`), и смешивать их нельзя: иначе
    //подбор по силе начал бы наказывать игрока за аварию в сети, а витрина —
    //показывать «оборона 0 dps» на базе с шестью башнями.
    dps += tower.profile.dps;
    hp += tower.maxHp;
  }

  return {
    hq: { ...hq },
    hqIndex,
    towers,
    walls,
    towerAt: new Map(towers.map((tower) => [tower.cell, tower])),
    wallAt: new Map(walls.map((wall) => [wall.cell, wall])),
    dps: Math.round(dps * 100) / 100,
    hp,
    unpowered,
    denied: readiness.denied,
    deuteriumPerHour: readiness.deuteriumPerHour
  };
}

// ─── Ход боя ──────────────────────────────────────────────────────────────────

interface RobotState {
  id: number;
  itemId: string;
  code: string;
  hp: number;
  maxHp: number;
  dps: number;
  speed: number;
  range: number;
  /** Индекс клетки; -1 — ещё не вылетел. */
  cell: number;
  /** Доля пройденной клетки (0..1): скорость дробная, клетка — нет. */
  progress: number;
  spawnTick: number;
  spawnCell: number;
  alive: boolean;
}

export type BattleEventType =
  | 'spawn'
  | 'robot_lost'
  | 'wall_down'
  | 'unit_down'
  | 'hq_down'
  /** Ствол ушёл в упор: башня стоит живая, но молчит. */
  | 'overheat'
  /** Остыла до порога гистерезиса и вернулась в строй. */
  | 'cooled'
  | 'end';

/** Кадр таймлайна: не для анимации, а для разбора («почему я проиграл»). */
export interface BattleEvent {
  tick: number;
  atMs: number;
  type: BattleEventType;
  cell?: Cell;
  itemId?: string;
  /** Остаток hp объекта события (штаб, башня, дрон) — по нему строится график боя. */
  hp?: number;
}

export interface BattleInput {
  defender: UserAccount;
  army: ArmyResolution;
  /**
   * Множитель скорости наступающих роботов: 1 — поля нет, STANIUM_SPEED_MULTIPLIER —
   * над базой защитника активно станиумное поле (config/materials.ts).
   *
   * Приходит ИЗВНЕ, а не вычисляется здесь: боевая симуляция обязана оставаться
   * чистой функцией от снимка обороны и состава армии, иначе её нельзя ни прогнать
   * по реплею, ни покрыть тестами без подделки часов. Ответственность за то, чтобы
   * заглянуть в кошелёк защитника и перевести срок поля в число, несёт резолвер
   * рейда.
   */
  attackerSpeedMultiplier?: number;

  /** Переопределение потолка тиков — для тестов («бой на 3 шага»). */
  maxTicks?: number;
}

export interface BattleResult {
  outcome: BattleOutcome;
  /** Чем закончился бой: штаб пал, армия сбита, время вышло. */
  endedBy: 'hq' | 'army' | 'timeout';
  ticks: number;
  durationMs: number;
  hq: { hp: number; maxHp: number; damage: number; ratio: number };
  robots: { deployed: number; lost: number; survivors: number; hpLeft: number };
  defense: { towers: number; towersDown: number; walls: number; wallsDown: number; dps: number };
  /**
   * Сеть и тепло в бою. Часть отчёта, а не деталь реализации: «оборона молчала»
   * обязана объясняться игроку так же явно, как станиумное поле (`attackerSpeedMultiplier`),
   * иначе рейд, проигранный из-за пустой крио-цистерны, читается как поломка боя.
   */
  power: {
    /** Сколько башен встретили бой обесточенными. */
    unpowered: number;
    /** Сколько раз орудия уходили в перегрев за бой. */
    overheatEvents: number;
    /** Сколько секунд суммарно орудия провели перегретыми. */
    overheatedTicks: number;
  };
  /**
   * Дейтерий, сожжённый автономной техникой ПО ФАКТУ боя (не по резерву). Нулевой
   * у обеих сторон, если тяжёлой техники в бою не было.
   */
  fuel: { defenderDeuterium: number; attackerDeuterium: number };
  /** Сколько единиц техники противника уничтожено: вход для generateBattleLoot (п.4). */
  destroyed: number;
  /** Длина худшего маршрута на старте, шагов (0 — пути не было вовсе). */
  pathTiles: number;
  /**
   * Применённый множитель скорости роботов — часть отчёта, а не деталь реализации:
   * разбор боя («почему я не дошёл до штаба») обязан видеть, что оборона включала
   * станиумное поле, а не догадываться по таймингам.
   */
  attackerSpeedMultiplier: number;
  timeline: BattleEvent[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** То же, что round6 в промышленном тике: дробный дейтерий хранится с той же точностью. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Живые блокеры движения — с уважением к флагу конфига на каждый тип элемента. */
function collectBlockers(defense: DefenseSnapshot): Cell[] {
  const cells: Cell[] = [];
  if (BLOCKS_MOVEMENT.wall) {
    for (const wall of defense.walls) if (wall.alive) cells.push(cellCoord(SPEC, wall.cell));
  }
  if (BLOCKS_MOVEMENT.unit) {
    for (const tower of defense.towers) if (tower.alive) cells.push(cellCoord(SPEC, tower.cell));
  }
  return cells;
}

interface BattleAccumulators {
  hqHp: number;
  towersDown: number;
  wallsDown: number;
  robotsLost: number;
  /** Сколько раз за бой орудия уходили в упор по теплу. */
  overheatEvents: number;
  /** Сколько тактов суммарно техника простояла перегретой. */
  overheatedTicks: number;
  dirty: boolean;
}

/** Всё, что фазы одного тика читают и между собой разделяют. */
interface BattleCtx {
  defense: DefenseSnapshot;
  robots: RobotState[];
  /** Поле маршрутов на ТЕКУЩИЙ момент: пересобирается после каждого падения стены. */
  route: RouteField;
  acc: BattleAccumulators;
  push: (tick: number, type: BattleEventType, extra: { cell?: Cell; itemId?: string; hp?: number }) => void;
}

const euclid = (a: number, b: number): number => {
  const ca = cellCoord(SPEC, a);
  const cb = cellCoord(SPEC, b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
};

const manhattan = (a: number, b: number): number => {
  const ca = cellCoord(SPEC, a);
  const cb = cellCoord(SPEC, b);
  return Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y);
};

/** Урон по башне с обработкой смерти: один код на «в радиусе» и «в тупике». Урон вносит вызывающий. */
function hitTower(ctx: BattleCtx, tick: number, tower: DefenseTower): void {
  if (tower.hp > 0) return;
  tower.alive = false;
  ctx.acc.towersDown += 1;
  ctx.acc.dirty = true;
  ctx.push(tick, 'unit_down', { cell: cellCoord(SPEC, tower.cell), itemId: tower.itemId, hp: 0 });
}

function hitWall(ctx: BattleCtx, tick: number, wall: DefenseWall, damage: number): void {
  wall.hp -= damage;
  if (wall.hp > 0) return;
  wall.alive = false;
  ctx.acc.wallsDown += 1;
  ctx.acc.dirty = true;
  ctx.push(tick, 'wall_down', { cell: cellCoord(SPEC, wall.cell), hp: 0 });
}

/**
 * Фаза дронов.
 *
 * Порядок фаз внутри тика фиксирован, и он важнее точности физики:
 *  1. спавн — иначе дрон, вылетевший на этом же шаге, стреляет «из будущего»;
 *  2. дроны — атакующий ходит первым: он инициировал бой, и защитник, отбивая
 *     последнего дрона, не должен «успеть» выстрелить по мёртвому;
 *  3. оборона — стреляет по тому, что осталось после хода дронов;
 *  4. проверка завершения.
 * Перестановка фаз меняет исход на пограничных числах, а значит ломает
 * воспроизводимость уже проведённых боёв: эти фазы меняются только вместе с
 * версией правил, а не «на ходу».
 */
function robotPhase(ctx: BattleCtx, tick: number): void {
  for (const robot of ctx.robots) {
    if (!robot.alive || robot.cell >= 0) continue;
    if (robot.spawnTick > tick) continue;
    robot.cell = robot.spawnCell;
    robot.progress = 0;
    if (robot.cell >= 0) ctx.push(tick, 'spawn', { cell: cellCoord(SPEC, robot.cell), itemId: robot.itemId });
  }

  for (const robot of ctx.robots) {
    if (!robot.alive || robot.cell < 0) continue;

    if (robot.cell === ctx.defense.hqIndex) {
      ctx.acc.hqHp -= robot.dps * DT_SEC;
      continue;
    }

    // 1. Башня в радиусе — приоритет над маршем: дрон, пролетающий мимо турели и
    // получающий по спине, выглядит багом, а не тактикой.
    let target: DefenseTower | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const tower of ctx.defense.towers) {
      if (!tower.alive) continue;
      const distance = euclid(robot.cell, tower.cell);
      if (distance > robot.range) continue;
      if (distance < bestDistance - 1e-9) {
        bestDistance = distance;
        target = tower;
      } else if (Math.abs(distance - bestDistance) <= 1e-9 && target !== null && tower.cell < target.cell) {
        target = tower;
      }
    }
    if (target) {
      target.hp -= robot.dps * DT_SEC;
      hitTower(ctx, tick, target);
      continue;
    }

    // 2. Дорога к штабу: `route.next` — тот же градиент, по которому Шаг 3 считает
    // проходимость. Расхождения «проходимо на сохранении / застряло в бою» здесь не
    // возникает по построению.
    // Прогресс копится КАЖДЫЙ тик, даже когда до клетки ещё далеко: иначе дрон со
    // скоростью 1.5 кл/с при шаге 0.2 с никогда не сдвинулся бы с места.
    const step = ctx.route.next(cellCoord(SPEC, robot.cell));
    if (step) {
      robot.progress += robot.speed * DT_SEC;
      let next: Cell | null = step;
      while (robot.progress >= 1 && next !== null) {
        const index = cellIndex(SPEC, next.x, next.y);
        if (index < 0) break;
        robot.cell = index;
        robot.progress -= 1;
        next = ctx.route.next(cellCoord(SPEC, robot.cell));
      }
      continue;
    }

    // 3. Градиента нет (лабиринт замурован либо отрезан): дальше — жадный ход к штабу
    // по Манхэттену, а если на пути стена или башня, то её ломаем. Без этой ветки
    // непроходимая база (её Шаг 3 сохраняет намеренно) дала бы бой длиной ровно в
    // таймаут, без единого выстрела: роботы стояли бы у ворот и ждали конца света.
    const here = cellCoord(SPEC, robot.cell);
    let blockerTower: DefenseTower | null = null;
    let blockerWall: DefenseWall | null = null;
    let blockerScore = Number.POSITIVE_INFINITY;
    let freeStep = -1;
    let freeScore = Number.POSITIVE_INFINITY;
    for (const { dx, dy } of NEIGHBOR_OFFSETS) {
      const index = cellIndex(SPEC, here.x + dx, here.y + dy);
      if (index < 0) continue;
      const score = manhattan(index, ctx.defense.hqIndex);
      const tower = ctx.defense.towerAt.get(index);
      const wall = ctx.defense.wallAt.get(index);
      if ((tower !== undefined && tower.alive) || (wall !== undefined && wall.alive)) {
        if (score < blockerScore) {
          blockerScore = score;
          blockerTower = tower !== undefined && tower.alive ? tower : null;
          blockerWall = wall !== undefined && wall.alive ? wall : null;
        }
        continue;
      }
      if (score < freeScore) {
        freeScore = score;
        freeStep = index;
      }
    }
    // Ломать, только если препятствие ближе к штабу, чем свободный обход: иначе стена
    // у ворот превращалась бы в «непреодолимую», хотя вокруг неё есть дорога.
    if (blockerScore <= freeScore && (blockerTower || blockerWall)) {
      if (blockerTower) {
        blockerTower.hp -= robot.dps * DT_SEC;
        hitTower(ctx, tick, blockerTower);
      } else if (blockerWall) {
        hitWall(ctx, tick, blockerWall, robot.dps * DT_SEC);
      }
      continue;
    }
    if (freeStep >= 0) {
      robot.progress += robot.speed * DT_SEC;
      if (robot.progress >= 1) {
        robot.cell = freeStep;
        robot.progress -= 1;
      }
    }
  }
}

/**
 * Фаза обороны: каждая живая и обеспеченная башня стреляет по одному дрону за тик.
 *
 * ПОРЯДОК ВНУТРИ ТАКТА значим, и вот почему: остывание применяется ДО проверки на
 * перегрев, а нагрев — после нанесения урона. Обратный порядок сдвигал бы рабочий
 * цикл орудия на целый тик (0.2 с) в обе стороны, и бой перестал бы воспроизводиться
 * по отчёту, где события проставлены в этих же тактах.
 */
function defensePhase(ctx: BattleCtx, tick: number): void {
  for (const tower of ctx.defense.towers) {
    if (!tower.alive) continue;
    const heats = tower.heatKw > 0;

    // Пассивный радиатор работает всегда, даже когда орудие молчит: остывание — не
    // привилегия стрелявшего, а свойство контура.
    if (heats) {
      tower.heat = Math.max(0, tower.heat - (DT_SEC * THERMAL.coolRatio) / THERMAL.fillSeconds);
    }

    // Обесточенная башня стоит на дороге и принимает урон, но не стреляет. Именно
    // поэтому `alive` и `powered` — разные флаги: снятие с сети должно наказывать
    // игрока дырой в ПВО, а не бесплатным исчезновением построек (см. DefenseTower).
    if (!tower.powered) continue;

    if (heats && tower.overheated) {
      if (tower.heat > THERMAL.recoverRatio) {
        ctx.acc.overheatedTicks += 1;
        continue;
      }
      tower.overheated = false;
      ctx.push(tick, 'cooled', { cell: cellCoord(SPEC, tower.cell), itemId: tower.itemId });
    }

    let target: RobotState | null = null;
    let bestUrgency = Number.POSITIVE_INFINITY;
    for (const robot of ctx.robots) {
      if (!robot.alive || robot.cell < 0) continue;
      if (euclid(tower.cell, robot.cell) > tower.profile.range) continue;
      // Цель — ближайший к ШТАБУ, а не ближайший к башне: оборона защищает штаб,
      // иначе «мясо» из грузовых дронов танкует её бесплатно, а стрельба по своим
      // воротам превращается в гонку по дальности.
      const distance = ctx.route.distanceAt(robot.cell);
      const urgency = distance < 0 ? Number.MAX_SAFE_INTEGER : distance;
      if (urgency < bestUrgency || (urgency === bestUrgency && target !== null && robot.id < target.id)) {
        bestUrgency = urgency;
        target = robot;
      }
    }
    if (!target) continue;
    target.hp -= tower.profile.dps * DT_SEC;

    // Нагрев — по факту выстрела, а не по факту наличия цели: башня, стоящая под
    // холостым прицеливанием, ствол не раскочегаривает.
    if (heats) {
      tower.heat += DT_SEC / THERMAL.fillSeconds;
      if (tower.heat >= 1) {
        tower.heat = 1;
        tower.overheated = true;
        ctx.acc.overheatEvents += 1;
        ctx.push(tick, 'overheat', { cell: cellCoord(SPEC, tower.cell), itemId: tower.itemId });
      }
    }

    if (target.hp > 0) continue;
    target.alive = false;
    ctx.acc.robotsLost += 1;
    ctx.push(tick, 'robot_lost', {
      cell: cellCoord(SPEC, Math.max(0, target.cell)),
      itemId: target.itemId,
      hp: 0
    });
  }
}

/**
 * Главный цикл. Возвращает полный отчёт боя — от исхода до счётчика уничтоженной
 * техники, который уходит в `generateBattleLoot` (п.4).
 */
export function simulateBattle(input: BattleInput): BattleResult {
  const defense = defenseSnapshot(input.defender);
  const maxTicks = Math.max(1, Math.trunc(input.maxTicks ?? SIM_MAX_TICKS));
  // Множитель зажимаем в (0.01, 1]: прийти может что угодно (конфиг, баг вызывающего),
  // а ускорять атаку станиумное поле не умеет по определению — отсюда верхняя граница,
  // и нижняя, потому что speed = 0 остановил бы рой навсегда и бой кончился бы timeout'ом.
  const rawMultiplier = input.attackerSpeedMultiplier ?? 1;
  const speedMultiplier = Number.isFinite(rawMultiplier)
    ? Math.min(1, Math.max(0.01, rawMultiplier))
    : 1;
  const intervalTicks = Math.max(1, Math.round(SIM_SPAWN_INTERVAL_MS / SIM_TICK_MS));

  const spawnCells = SPAWN_CELLS.map((cell) => cellIndex(SPEC, cell.x, cell.y))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);

  // Армия разворачивается из отрядов в машины: отряды — в порядке, который вернул
  // resolveArmy (сортировка по itemId), внутри — по номеру в рое. id дрона = очередь
  // вылета = tie-break во всех обходах, поэтому двух одинаковых входов не бывает.
  const robots: RobotState[] = [];
  let nextId = 0;
  for (const squad of input.army.squads) {
    for (let copy = 0; copy < squad.count; copy += 1) {
      const profile = squad.profile;
      robots.push({
        id: nextId,
        itemId: squad.itemId,
        code: profile.code,
        hp: profile.hp,
        maxHp: profile.hp,
        dps: profile.dps,
        speed: profile.speed * speedMultiplier,
        range: profile.range,
        cell: -1,
        progress: 0,
        spawnTick: nextId * intervalTicks,
        spawnCell: spawnCells.length > 0 ? (spawnCells[nextId % spawnCells.length] as number) : -1,
        alive: true
      });
      nextId += 1;
    }
  }

  const timeline: BattleEvent[] = [];
  const ctx: BattleCtx = {
    defense,
    robots,
    route: buildRouteField({ hq: defense.hq, blocked: collectBlockers(defense) }),
    acc: {
      hqHp: HQ_HP,
      towersDown: 0,
      wallsDown: 0,
      robotsLost: 0,
      overheatEvents: 0,
      overheatedTicks: 0,
      dirty: false
    },
    push: (tick, type, extra) => {
      // Потолок кадров: десятки дронов на 900 тиков дали бы тысячи событий, а таймлайн
      // уходит в ответ HTTP и в лог. Хвост отсекаем, счётчики — никогда.
      if (timeline.length >= SIM_MAX_EVENTS) return;
      timeline.push({ tick, atMs: tick * SIM_TICK_MS, type, ...extra });
    }
  };

  let pathTiles = 0;
  for (const index of spawnCells) {
    const distance = ctx.route.distanceAt(index);
    if (distance > pathTiles) pathTiles = distance;
  }

  let outcome: BattleOutcome = 'loss';
  let endedBy: BattleResult['endedBy'] = 'timeout';
  let ticks = 0;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    ticks = tick + 1;
    if (ctx.acc.dirty) {
      // Пересборка поля — единственный O(256) шаг на падение стены: дешевле, чем
      // чинить маршрут инкрементально, и дешевле, чем держать поле на каждый тик.
      ctx.route = buildRouteField({ hq: defense.hq, blocked: collectBlockers(defense) });
      ctx.acc.dirty = false;
    }

    robotPhase(ctx, tick);
    defensePhase(ctx, tick);

    if (ctx.acc.hqHp <= 0) {
      endedBy = 'hq';
      outcome = 'win';
      ctx.push(tick, 'hq_down', { cell: { ...defense.hq }, hp: 0 });
      break;
    }
    if (ctx.acc.robotsLost >= robots.length && robots.length > 0) {
      endedBy = 'army';
      const ratio = clamp01((HQ_HP - ctx.acc.hqHp) / HQ_HP);
      outcome = ratio >= DRAW_HQ_DAMAGE_RATIO ? 'draw' : 'loss';
      break;
    }
  }

  const finalRatio = clamp01((HQ_HP - ctx.acc.hqHp) / HQ_HP);
  let hpLeft = 0;
  for (const robot of robots) if (robot.alive) hpLeft += Math.max(0, robot.hp);
  ctx.push(ticks, 'end', { hp: Math.round(ctx.acc.hqHp) });

  // Топливо — ПО ФАКТУ боя, а не по резерву. Зарезервировано было на 180 секунд, а
  // штаб пал на 40-й: платить за оставшиеся 140 игрок не должен, иначе «строить
  // тяжёлую технику» стало бы наказанием за быструю победу. Резерв при этом остался
  // единственным допуском к бою (см. fuelAvailability) — списывается меньшее из того,
  // что разрешено, и это честная пара «граница / расход».
  const durationHours = (ticks * SIM_TICK_MS) / 3_600_000;
  const fuel = {
    defenderDeuterium: round6(defense.deuteriumPerHour * durationHours),
    attackerDeuterium: round6(input.army.fuel.perHour * durationHours)
  };

  return {
    outcome,
    endedBy,
    ticks,
    durationMs: ticks * SIM_TICK_MS,
    hq: {
      hp: Math.max(0, round2(ctx.acc.hqHp)),
      maxHp: HQ_HP,
      damage: round2(HQ_HP * finalRatio),
      ratio: Math.round(finalRatio * 1e4) / 1e4
    },
    robots: {
      deployed: robots.length,
      lost: ctx.acc.robotsLost,
      survivors: robots.length - ctx.acc.robotsLost,
      hpLeft: Math.round(hpLeft)
    },
    defense: {
      towers: defense.towers.length,
      towersDown: ctx.acc.towersDown,
      walls: defense.walls.length,
      wallsDown: ctx.acc.wallsDown,
      dps: defense.dps
    },
    power: {
      unpowered: defense.unpowered,
      overheatEvents: ctx.acc.overheatEvents,
      overheatedTicks: ctx.acc.overheatedTicks
    },
    fuel,
    // Уничтоженная техника противника: башни + стены + сам штаб. Верхняя граница —
    // 24 башни + 120 стен + 1 = 145, что укладывается в MAX_DESTROYED_PER_REPORT (200),
    // поэтому резолвер лута никогда не отбрасывает бой по потолку разрушений.
    destroyed: ctx.acc.towersDown + ctx.acc.wallsDown + (endedBy === 'hq' ? 1 : 0),
    pathTiles,
    attackerSpeedMultiplier: speedMultiplier,
    timeline
  };
}
