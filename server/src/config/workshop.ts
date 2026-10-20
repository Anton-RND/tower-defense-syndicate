import { MINING_RESOURCES, type MiningResource } from './env.js';
import { isCraftTechId, type CraftTechId } from './materials.js';

/** Тот же guard, что в config/materials.ts, под именем ряда остальных guard'ов мастерской. */
export { isCraftTechId as isCraftTechMaterialId };

/**
 * Мастерская: материалы, чертежи, цех переработки и таблицы боевого лута.
 *
 * Почему это НЕ окружение (в отличие от LimitsConfig): эти значения меняют ради
 * баланса игры, а значит они обязаны проходить ревью в PR и фиксироваться тегом
 * релиза. «Подкрутить дроп хлама в проде правкой .env без ревью» — путь к слитой
 * экономике и к невозможности объяснить игрокам, откуда взялся нерф.
 *
 * Почему здесь же и цены строителей: они являются балансной величиной (поток
 * критания в игру), а не антифрод-лимитом. Антифрод живёт в limits.ts.
 */

// ─── Материалы ────────────────────────────────────────────────────────────────

/** Боевой и разборный хлам — то, что копится и сдаётся в цехе переработки. */
export const JUNK_IDS = ['chips', 'boards', 'engines', 'transmissions', 'batteries', 'ammo_casings'] as const;
export type JunkId = (typeof JUNK_IDS)[number];

/** Продукты переработки — сырьё для чертежей среднего и верхнего тира. */
export const METAL_IDS = ['black_metal', 'colored_metal', 'precious_metal'] as const;
export type MetalId = (typeof METAL_IDS)[number];

export const ITEM_KINDS = ['tower', 'drone', 'weapon'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/**
 * Вид СТРОИТЕЛЬНОЙ РАБОТЫ: штучный предмет либо сооружение-счётчик.
 *
 * Отдельный тип, а не расширение `ItemKind`, потому что `ItemKind` описывает то, что
 * лежит в `inventory` и имеет координату на карте. `'structure'` ни тому ни другому не
 * соответствует, и попасть ему в `ITEM_KINDS` означало бы позволить `saveLayout`
 * поставить реактор в клетку лабиринта — ошибка, которую тесты проходимости поймали бы
 * не сразу, а бой — тем более.
 */
export const BUILD_KINDS = [...ITEM_KINDS, 'structure'] as const;
export type BuildKind = (typeof BUILD_KINDS)[number];

/**
 * Всё, чем можно заплатить по чертежу и что чертеж может вернуть.
 * Энергия сюда намеренно не входит: она тратится отдельным маршрутом
 * (spendEnergy) со своими лимитами и своим регеном.
 *
 * Астерия здесь тоже нет: это деньги, а не сырьё (см. config/materials.ts).
 * Хрониум, вольфрам и станиум — настоящие материалы производства, поэтому
 * чертеж может требовать их и возвращать их при разборе.
 */
export type MaterialId = MiningResource | MetalId | JunkId | CraftTechId;

/** Расход/возврат по материалам. Отсутствие ключа = 0. */
export type MaterialCost = Partial<Record<MaterialId, number>>;

export type JunkInventory = Record<JunkId, number>;
export type MetalsInventory = Record<MetalId, number>;

const junkSet: ReadonlySet<string> = new Set(JUNK_IDS);
const metalSet: ReadonlySet<string> = new Set(METAL_IDS);
const kindSet: ReadonlySet<string> = new Set(ITEM_KINDS);
const miningSet: ReadonlySet<string> = new Set<string>(MINING_RESOURCES);

/** Guard'ы ниже — не формальность: их вызывает HTTP-слой на параметрах из запроса. */
export function isJunkId(value: string): value is JunkId {
  return junkSet.has(value);
}
export function isMetalId(value: string): value is MetalId {
  return metalSet.has(value);
}
export function isMiningResource(value: string): value is MiningResource {
  return miningSet.has(value);
}
export function isItemKind(value: string): value is ItemKind {
  return kindSet.has(value);
}
export function isMaterialId(value: string): value is MaterialId {
  return isJunkId(value) || isMetalId(value) || isCraftTechId(value) || isMiningResource(value);
}

export function emptyJunk(): JunkInventory {
  return { chips: 0, boards: 0, engines: 0, transmissions: 0, batteries: 0, ammo_casings: 0 };
}

export function emptyMetals(): MetalsInventory {
  return { black_metal: 0, colored_metal: 0, precious_metal: 0 };
}

/** Сколько всего единиц хлама лежит у игрока (для складского потолка). */
export function junkTotal(junk: JunkInventory): number {
  let total = 0;
  for (const id of JUNK_IDS) total += junk[id] ?? 0;
  return total;
}

/**
 * Нормализация стоимости: только известные материалы, целые, строго положительные.
 * Конфиг может содержать опечатку — молча выбросить её безопаснее, чем списать −5 железа.
 */
export function materialEntries(cost: MaterialCost): Array<[MaterialId, number]> {
  const result: Array<[MaterialId, number]> = [];
  for (const [key, value] of Object.entries(cost) as Array<[string, number | undefined]>) {
    if (!isMaterialId(key) || value === undefined) continue;
    const amount = Math.floor(value);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    result.push([key, amount]);
  }
  return result;
}

export function costIsEmpty(cost: MaterialCost): boolean {
  return materialEntries(cost).length === 0;
}

// ─── Чертежи ──────────────────────────────────────────────────────────────────

/** Что выпадает при разборе в режиме «утилизация» (scrap). */
export interface ScrapDrop {
  junk: JunkId;
  /** Шанс 0..1, проверяется независимо по каждой позиции таблицы. 1 — гарантия. */
  chance: number;
  min: number;
  max: number;
}

export interface Blueprint {
  code: string;
  kind: ItemKind;
  /** Человекочитаемое имя для витрины; код — стабильный, имя — нет. */
  name: string;
  tier: 1 | 2 | 3;
  /** Что списывается со склада материалов при старте стройки. */
  cost: MaterialCost;
  /** Длительность стройки, мс. Один робот строит одну вещь за раз. */
  buildMs: number;
  /** Доля возвращаемых материалов в режиме «salvage». Не указана — общая. */
  salvageRate?: number;
  /** Таблица хлама в режиме «scrap». */
  scrap: ScrapDrop[];
}

/** Доля возврата по умолчанию: 50% от вложенного — классический «разобрал и начал заново». */
export const SALVAGE_RATE_DEFAULT = 0.5;
/** Надбавка за уровень предмета: разбор прокачанной башни возвращает больше вложенного. */
export const SALVAGE_LEVEL_STEP = 0.5;
/** Потолок уникальных предметов в документе игрока (16 МБ на документ — не бесконечность). */
export const MAX_INVENTORY_ITEMS = 400;
/** Потолок очереди стройки: больше — значит игрок не пользуется результатами. */
export const MAX_BUILD_QUEUE = 20;
/** Максимум хлама за одну сдачу в цех: защита от «переработать 10^9» одним запросом. */
export const RECYCLE_MAX_BATCH = 10_000;

/**
 * Масштаб времени продвинутых чертежей (сек → мс).
 *
 * Балансный драфт задавал сборку продвинутого оружия в 180/300/600 секунд. На фоне
 * существующей лестницы тиров (10 мин – 3 ч) это на 1–2 порядка быстрее, и ломает
 * сразу две вещи: (а) драгметалл перестаёт быть дефицитом, потому что очередь из
 * двух роботов выдаёт тир-3 по десять штук в час; (б) исчезает спрос на слоты
 * строителей и на ускорение — то, за что игрок должен платить астерием.
 *
 * Множитель сохраняет РЯД чертежа (3 : 5 : 10 → 45 мин : 75 мин : 150 мин), поэтому
 * продуктовое решение дизайнера («Цербер быстрее плазмагана») не теряется, а
 * абсолюты приводятся к тир-3 полке. Одна правка здесь — и драфтовые секунды
 * вернутся дословно.
 */
export const ADVANCED_TIME_SCALE = 15;

/** Сек из балансного драфта → мс стройки с приведением к лестнице тиров. */
function advancedMs(seconds: number): number {
  return seconds * ADVANCED_TIME_SCALE * 1000;
}

export const BLUEPRINTS: readonly Blueprint[] = [
  {
    code: 'tower_laser_mk1',
    kind: 'tower',
    name: 'Лазерная турель Mk.I',
    tier: 1,
    cost: { ferrum: 200, silicium: 100, chips: 2 },
    buildMs: 10 * 60_000,
    scrap: [
      { junk: 'chips', chance: 0.9, min: 1, max: 3 },
      { junk: 'boards', chance: 0.35, min: 1, max: 1 },
      { junk: 'ammo_casings', chance: 1, min: 2, max: 5 }
    ]
  },
  {
    code: 'tower_rail_mk2',
    kind: 'tower',
    name: 'Рельсотрон Mk.II',
    tier: 2,
    cost: { ferrum: 600, silicium: 250, black_metal: 120, wolfram: 25, boards: 4 },
    buildMs: 45 * 60_000,
    scrap: [
      { junk: 'boards', chance: 0.9, min: 1, max: 4 },
      { junk: 'transmissions', chance: 0.4, min: 1, max: 1 },
      { junk: 'ammo_casings', chance: 1, min: 4, max: 10 }
    ]
  },
  {
    code: 'tower_plasma_mk3',
    kind: 'tower',
    name: 'Плазменный резонатор Mk.III',
    tier: 3,
    cost: { ferrum: 1200, uranium: 300, colored_metal: 200, precious_metal: 80, wolfram: 40, engines: 2 },
    buildMs: 3 * 60 * 60_000,
    salvageRate: 0.6,
    scrap: [
      { junk: 'engines', chance: 0.8, min: 1, max: 2 },
      { junk: 'chips', chance: 0.9, min: 2, max: 5 },
      { junk: 'batteries', chance: 0.5, min: 1, max: 2 }
    ]
  },
  {
    code: 'drone_cargo_mk1',
    kind: 'drone',
    name: 'Грузовой дрон',
    tier: 1,
    cost: { ferrum: 150, silicium: 150, batteries: 2 },
    buildMs: 20 * 60_000,
    scrap: [
      { junk: 'batteries', chance: 0.9, min: 1, max: 3 },
      { junk: 'transmissions', chance: 0.3, min: 1, max: 1 }
    ]
  },
  {
    code: 'drone_strike_mk2',
    kind: 'drone',
    name: 'Ударный дрон Mk.II',
    tier: 2,
    cost: { ferrum: 400, silicium: 300, colored_metal: 90, chips: 3, transmissions: 2 },
    buildMs: 60 * 60_000,
    scrap: [
      { junk: 'chips', chance: 0.9, min: 1, max: 4 },
      { junk: 'engines', chance: 0.5, min: 1, max: 1 },
      { junk: 'batteries', chance: 0.6, min: 1, max: 2 }
    ]
  },
  {
    code: 'weapon_cannon_mk1',
    kind: 'weapon',
    name: 'Автоматическая пушка',
    tier: 1,
    cost: { ferrum: 400, ammo_casings: 6 },
    buildMs: 30 * 60_000,
    scrap: [
      { junk: 'ammo_casings', chance: 1, min: 5, max: 12 },
      { junk: 'engines', chance: 0.3, min: 1, max: 1 }
    ]
  },
  {
    code: 'weapon_railgun_mk3',
    kind: 'weapon',
    name: 'Корабельный рельсган',
    tier: 3,
    // Вольфрам вместо драгметалла: корабельный рельсган — это тяжёлая индуктивность
    // и упоры, а не электроника. Драгметалл остаётся там, где без него не обойтись
    // (проводника, чипы), а «суровая» часть ушла в промышленный вольфрам.
    cost: { ferrum: 900, uranium: 150, black_metal: 250, wolfram: 80, boards: 3 },
    buildMs: 2 * 60 * 60_000,
    salvageRate: 0.55,
    scrap: [
      { junk: 'boards', chance: 0.9, min: 2, max: 5 },
      { junk: 'engines', chance: 0.7, min: 1, max: 2 },
      { junk: 'transmissions', chance: 0.7, min: 1, max: 2 }
    ]
  },

  // ─── Продвинутое оружие тир-3: оплата металлами и вольфрамом, без железа ──────
  //
  // Смысл этих трёх чертежей — замкнуть петлю «бой → хлам → цех → металлы → тир-3».
  // Пока металлы принимались вдобавок к железу, игрок мог собрать тир-3 на майнинге
  // и не ходить в переработку вовсе. Здесь железа нет вообще: без цветмета и
  // драгмета эта полка недостижима, и у накопленных металлов появляется куда течь.
  {
    code: 'weapon_plasma_cannon_mk3',
    kind: 'weapon',
    name: 'Плазменная пушка P-1',
    tier: 3,
    cost: { black_metal: 20, colored_metal: 80, precious_metal: 15 },
    buildMs: advancedMs(300),
    salvageRate: 0.6,
    scrap: [
      { junk: 'chips', chance: 0.9, min: 2, max: 6 },
      { junk: 'batteries', chance: 0.7, min: 1, max: 3 },
      { junk: 'engines', chance: 0.35, min: 1, max: 1 }
    ]
  },
  {
    code: 'weapon_railgun_heavy_mk3',
    kind: 'weapon',
    name: 'Тяжёлый рельсотрон',
    tier: 3,
    // Упор в чёрный металл и вольфрам: «тяжёлое» железо, а не электроника.
    // Драгметалл из рецепта выведен полностью — его место занял промышленный вольфрам.
    cost: { black_metal: 150, colored_metal: 40, wolfram: 50 },
    buildMs: advancedMs(600),
    salvageRate: 0.6,
    scrap: [
      { junk: 'ammo_casings', chance: 1, min: 6, max: 14 },
      { junk: 'transmissions', chance: 0.8, min: 1, max: 3 },
      { junk: 'engines', chance: 0.6, min: 1, max: 2 }
    ]
  },
  {
    code: 'drone_cerberus_mk3',
    kind: 'drone',
    name: 'Боевой дрон «Цербер»',
    tier: 3,
    // Упор в драгоценный металл: проводника и чипы заменой не обходятся.
    // Вольфрам — ключевые узлы (упоры гирокольцев, ствольная группа роя).
    cost: { black_metal: 10, colored_metal: 50, precious_metal: 25, wolfram: 20 },
    buildMs: advancedMs(180),
    salvageRate: 0.6,
    scrap: [
      { junk: 'chips', chance: 0.9, min: 2, max: 5 },
      { junk: 'boards', chance: 0.6, min: 1, max: 3 },
      { junk: 'batteries', chance: 0.5, min: 1, max: 2 }
    ]
  }
];

const BLUEPRINT_BY_CODE: ReadonlyMap<string, Blueprint> = new Map(BLUEPRINTS.map((bp) => [bp.code, bp]));

export function getBlueprint(code: string): Blueprint | undefined {
  return BLUEPRINT_BY_CODE.get(code);
}

export function salvageRateOf(blueprint: Blueprint): number {
  return blueprint.salvageRate ?? SALVAGE_RATE_DEFAULT;
}

// ─── Цех переработки ──────────────────────────────────────────────────────────

export interface RecycleRecipe {
  /** Выход металлов на одну единицу хлама. */
  yields: Partial<Record<MetalId, number>>;
  /**
   * Выход высокотехнологичного сырья на одну единицу хлама.
   *
   * Это единственная игровая (не покупная) кран материала, и он намеренно узкий:
   * хрониум дают только микросхемы, станиум — только батарейки. Широкий кран
   * обнулил бы смысл покупать их в магазине, а нулевой — сделал бы тяжёлые
   * чертежи и станиумный модуль недостижимыми для неплатящего игрока.
   */
  tech?: Partial<Record<CraftTechId, number>>;
  /** Дополнительно: энергия на одну единицу (батарейки — это ещё и химия/заряд). */
  energyEach?: number;
}

/**
 * Рецепты заданы на 1 единицу, чтобы доход был линеен по объёму сдачи:
 * игрок может прикинуть выгоду, а антифрод — заметить аномалию в балансе.
 */
export const RECYCLE_RECIPES: Readonly<Record<JunkId, RecycleRecipe>> = {
  chips: { yields: { precious_metal: 2, colored_metal: 1 }, tech: { chronium: 1 } },
  boards: { yields: { precious_metal: 1, colored_metal: 3 } },
  engines: { yields: { black_metal: 5, colored_metal: 2 }, tech: { wolfram: 1 } },
  transmissions: { yields: { black_metal: 4, colored_metal: 1 }, tech: { wolfram: 1 } },
  batteries: { yields: { colored_metal: 4 }, tech: { stanium: 1 }, energyEach: 2 },
  ammo_casings: { yields: { black_metal: 2 }, tech: { wolfram: 1 } }
};

// ─── Боевой лут ───────────────────────────────────────────────────────────────

export const BATTLE_OUTCOMES = ['win', 'draw', 'loss'] as const;
export type BattleOutcome = (typeof BATTLE_OUTCOMES)[number];

export function isBattleOutcome(value: string): value is BattleOutcome {
  return value === 'win' || value === 'draw' || value === 'loss';
}

/** Исход боя — общий множитель: проигравший собирает обломки, а не трофеи. */
export const LOOT_OUTCOME_MULTIPLIER: Readonly<Record<BattleOutcome, number>> = {
  win: 1,
  draw: 0.5,
  loss: 0.2
};

/** Базовая выдача за сам факт боя (до множителя разрушений), шт. */
export const LOOT_BASE: Readonly<Record<JunkId, { min: number; max: number }>> = {
  chips: { min: 0, max: 2 },
  boards: { min: 0, max: 3 },
  engines: { min: 0, max: 1 },
  transmissions: { min: 0, max: 1 },
  batteries: { min: 0, max: 2 },
  ammo_casings: { min: 1, max: 6 }
};

/** Прибавка к количеству за каждую уничтоженную единицу техники противника. */
export const LOOT_PER_DESTROYED: Readonly<Record<JunkId, number>> = {
  chips: 0.15,
  boards: 0.2,
  engines: 0.05,
  transmissions: 0.05,
  batteries: 0.1,
  ammo_casings: 0.4
};

/** Потолок «уничтожено» в одном отчёте: масштаб разрушений считает сервер, а не клиент. */
export const MAX_DESTROYED_PER_REPORT = 200;

// ─── Роботы-строители (магазин) ───────────────────────────────────────────────

/** Жёсткий потолок слотов: дальше дефицит времени игрока перестаёт быть продаваемым. */
export const MAX_BUILDERS = 5;

/**
 * Лестница цен: ключ — сколько строителей у игрока СЕЙЧАС, значение — цена следующего.
 * 2 → 500 (третий), 3 → 1000 (четвёртый), 4 → 2000 (пятый).
 * Растущая цена — единственный рабочий способ продать 5-й слот, не обесценив 3-й.
 */
export const BUILDER_PRICE_LADDER: Readonly<Record<number, number>> = {
  2: 500,
  3: 1000,
  4: 2000
};

export const BUILDER_SLOT_SKU = 'robot_slot_permanent';

/** null — покупать нечего (достигнут потолок либо в лестнице нет этой ступени). */
export function builderPrice(currentMax: number): number | null {
  const price = BUILDER_PRICE_LADDER[currentMax];
  return typeof price === 'number' && price > 0 ? price : null;
}

// ─── Мгновенное ускорение стройки ──────────────────────────────────────────────
// Цены ускорения (хрониум) живут в config/materials.ts: это балансная величина
// того же ряда, что и роли четырёх материалов, и править их обязаны разные люди
// в одном месте, а не двух конфигах.


