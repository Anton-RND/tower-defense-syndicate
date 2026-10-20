import type { CoinId, OreId, StorageId } from './storage.js';
import type { MaterialCost } from './workshop.js';

/**
 * Сооружения базы: реакторы, ASIC-стойки, цехи и цистерны.
 *
 * КЛЮЧЕВОЕ ОТЛИЧИЕ ОТ БАШЕН И ДРОНОВ
 * ──────────────────────────────────
 * Башня (`config/workshop.ts`) — ШТУЧНОЙ предмет: у неё есть id, она стоит на клетке
 * сетки, её можно улучшить, снять и разобрать. Сооружение — СЧЁТЧИК: три реактора —
 * это `reactor_plasma_mk1: 3`, а не три записи инвентаря.
 *
 * Это не экономия на документе, а другая физика:
 *  - сооружение не занимает клетку и не участвует в лабиринте и проходимости;
 *  - его нельзя «снять с карты», значит `InventoryItem` для него — ложная сущность;
 *  - его вклад в экономику аддитивен: 3 реактора дают ровно 3 × мощности.
 * Смешать их в одном реестре означало бы заставить `pvp/defense.ts` фильтровать
 * инвентарь по признаку «а это вообще не боевая единица», и тогда ошибка в фильтре
 * превращается в реактор на карте боя.
 *
 * ПОЧЕМУ ВСЁ ФИЗИЧЕСКОЕ — ДЕКЛАРАЦИЕЙ
 * ────────────────────────────────────
 * `power`, `heat`, `cooling`, `fuel`, `output`, `storage` — данные, а не код. Движок
 * (`modules/economy/power.ts`, `industry.ts`) не содержит ни одного
 * `if (id === 'reactor...')`. Иначе каждый новый цех требовал бы правки тика, а тик —
 * единственное место, где ошибка даёт тихо напечатанные ресурсы.
 */

export const STRUCTURE_IDS = [
  'reactor_plasma_mk1',
  'reactor_plasma_mk2',
  'reactor_plasma_mk3',
  'cooler_loop_mk1',
  'cooler_loop_mk2',
  'nitro_plant_mk1',
  'nitro_plant_mk2',
  'centrifuge_mk1',
  'centrifuge_mk2',
  'asic_rack_mk1',
  'asic_rack_mk2',
  'asic_rack_mk3',
  'silo_mk1',
  'gasometer_mk1',
  'cryo_tank_mk1'
] as const;

export type StructureId = (typeof STRUCTURE_IDS)[number];

const structureSet: ReadonlySet<string> = new Set<string>(STRUCTURE_IDS);

/** Guard для параметров HTTP: коды сооружений приходят из тела запроса. */
export function isStructureId(value: string): value is StructureId {
  return structureSet.has(value);
}

/**
 * Очередность отключения при дефиците мощности. Меньше — важнее, отключается позже.
 *
 * Порядок физически осмыслен, а не назначен произвольно:
 *  - `cooling` держится выше всего, что греется: отключение кулера глушит реактор,
 *    а потеря реактора хуже потери цикла охлаждения (реактор нечем заменить);
 *  - `chemistry` ниже обороны, но выше майнинга: азот и дейтерий — хладагент и
 *    топливо, их остановка каскадом валит и реакторы, и тяжи;
 *  - `compute` отключается ПЕРВЫМ из производящих ценность: SEC — роскошь, и игрок
 *    должен чувствовать дефицит мощности именно на нём, а не на обороне.
 */
export const POWER_PRIORITY = {
  defense: 5,
  cooling: 10,
  generation: 20,
  chemistry: 30,
  storage: 40,
  compute: 50
} as const;
export type PowerPriority = (typeof POWER_PRIORITY)[keyof typeof POWER_PRIORITY];

/** Топливо: что сгорает, чтобы сооружение работало. Ед./час при полной нагрузке. */
export interface FuelSpec {
  resource: StorageId;
  perHour: number;
}

/** Продукция: что наливается в накопитель. Ед./час при полной нагрузке. */
export interface OutputSpec {
  resource: StorageId;
  perHour: number;
}

/** Валютный выход: капает прямо в кошелёк (SEC), минуя цистерны. */
export interface CoinOutputSpec {
  coin: CoinId;
  perHour: number;
}

/** Прирост ёмкости накопителя. Применяется к каждому ресурсу из списка. */
export interface StorageSpec {
  resources: readonly StorageId[];
  capacity: number;
}

export interface StructureDef {
  id: StructureId;
  name: string;
  tier: 1 | 2 | 3;
  /** Что списывается с материалов при старте стройки (роботы-строители, п.3.1). */
  cost: MaterialCost;
  /** Длительность стройки, мс. Занимает одного робота, как и чертёж. */
  buildMs: number;
  /** Потолок экземпляров на базе. 0 — не ограничен (кроме общего `MAX_STRUCTURE_TOTAL`). */
  maxPerBase: number;
  /**
   * Вклад в сеть, кВт. Положительный — генерация, отрицательный — потребление.
   * Генераторы никогда не отключаются веером: они и есть источник снабжения.
   */
  power: number;
  /** Тепловыделение, кВт-тепла. 0 — сооружение не греется и азот не требует. */
  heat: number;
  /** Способность отводить чужое тепло, кВт-тепла. Только у кулеров. */
  cooling?: number;
  fuel?: FuelSpec;
  output?: OutputSpec;
  coinOutput?: CoinOutputSpec;
  storage?: StorageSpec;
  priority: PowerPriority;
  /**
   * Требуемые сооружения-предшественники (код → количество). Проверяется при старте
   * стройки: без цистерны азот производить некуда, и честнее отказать сразу, чем
   * дать построить станцию, которая мгновенно встанет по переполнению.
   */
  requires?: Partial<Record<StructureId, number>>;
  /**
   * Денежная компонента цены, SEC. Отсутствует или 0 — стойка строится без монеты.
   *
   * ПОЧЕМУ ОТДЕЛЬНОЕ ПОЛЕ, А НЕ КЛЮЧ В `cost`
   * ─────────────────────────────────────────
   * Казалось бы естественнее дописать `sec: 350` в `cost`, и тогда оплата пошла бы
   * общим `payMaterials`. Это ловушка на два отказа, и оба молчаливые:
   *
   *   1. `MaterialCost` = `Partial<Record<MaterialId, number>>`, а `MaterialId` денег
   *      не содержит (см. config/workshop.ts:45 — «Астерия здесь нет намеренно»).
   *      `materialEntries` на неизвестном ключе делает `continue`, то есть опечатка
   *      `sec: 350` в конфиге НЕ упала бы и НЕ завалила бы сборку — она бы просто
   *      перестала взимать деньги. Игра, в которой цену можно потерять молча,
   *      теряет цену.
   *   2. `cost` двусторонняя: `salvageYield` возвращает игроку ДОЛЮ от неё при
   *      разборе. Попав в `cost`, SEC начал бы печататься из ничего каждым
   *      «разобрать в материалы», и любой лимит эмиссии перестал бы существовать.
   *
   * Здесь же деньги односторонние: списались при старте стройки и не возвращаются.
   * Сооружение — счётчик, его нельзя разобрать (`dismantleItem` работает только по
   * `InventoryItem`), поэтому и обратного пути у монеты нет by construction.
   */
  secCost?: number;
  /**
   * Множитель роста `secCost` от числа уже стоящих экземпляров (1 — не растёт).
   *
   * Это та самая «нелинейная цена каждого нового ASIC» из ТЗ (`TD_.md:1907`). Без
   * неё стойка окупалась бы одинаково и на двадцатом экземпляре, и на первом, а
   * значит единственной причиной строить их больше десяти был бы баг в веере сети.
   * Растёт только денежная часть: сырьё (`cost`) не дорожает, иначе рост пришлось бы
   * считать и для витрины склада, и для возврата при разборе, а это два новых
   * источника расхождений.
   */
  secCostGrowth?: number;
}

/**
 * Цена сооружения в SEC с учётом числа уже стоящих экземпляров.
 *
 * Целое и округление ВВЕРХ: монета в кошельке дробная (ставка 25/ч × часы), но
 * цена — деньги, а не запас, и `123.4` в прайсе игрок прочитает как «123». Вверх —
 * потому что округление вниз подарило бы десятую долю монеты на каждом экземпляре,
 * а на двадцатой стойке это уже целый SEC, нарисованный из правила округления.
 */
export function structureSecCost(def: StructureDef, owned: number): number {
  const base = def.secCost ?? 0;
  if (base <= 0) return 0;
  const growth = def.secCostGrowth ?? 1;
  const n = Math.max(0, Math.trunc(owned));
  return Math.ceil(base * Math.pow(growth, n));
}

/**
 * Сколько тепла отводит одна единица жидкого азота, кВт-тепла на ед.
 *
 * Единая константа на все сооружения: иначе «где вырабатывается тепло, туда тратится
 * азот» превратилось бы в N отдельных коэффициентов, расходящихся с каждым балансным
 * патчем. 1 азот = 6,67 кВт-тепла ⇒ кулер на 40 кВт сжигает 6 азота/ч.
 */
export const HEAT_PER_NITROGEN = 6.67;

/** Встроенный генератор штаба, кВт. Не сооружение: есть у базы всегда, строить не надо. */
export const BASE_POWER_SUPPLY = 20;

/**
 * Пассивный радиатор штаба, кВт-тепла. Не сооружение и азота не требует: это штатный
 * радиатор, которым изначально оснащён любой ангар.
 *
 * Число развязывает СТАРТОВОЕ КОЛЬЦО: азот добывается станцией, которая сама греется,
 * а её тепло нужно отводить. При радиаторе 30 первый конвертер (тепло 30) съедал бюджет
 * целиком, станция встала по причине `cooling` — и получается, что азот нужен, чтобы
 * получить азот. Игрок не смог бы выйти из этой точки никогда.
 *
 * 45 кВт закрывают стартовую связку «один конвертер (30) + одна станция (10) = 40» с
 * небольшим запасом, но не закрывают ничего тяжелее: ASIC-стойка (60) и вся химия
 * выше первого тира по-прежнему требуют настоящий крио-контур. То есть поблазка есть
 * только у онбординга, а правило «греется → жрёт азот» остаётся без исключений —
 * вместо спец-флага в данных.
 */
export const BASE_PASSIVE_COOLING = 45;

/**
 * Общий потолок сооружений всех видов.
 *
 * Назначение — НЕ размер документа (как было в первой версии комментария): счётчики
 * живут в `Record` с фиксированным набором из 15 ключей, и «10^9 реакторов» уткнулись
 * бы в `maxPerBase` своего вида задолго до любого лимита байтов. Настоящая функция —
 * страховка на будущее: если в реестр добавят вид с `maxPerBase: 0` (без личного
 * потолка), он окажется под общим лимитом автоматически.
 *
 * Число ЗАВЕДОМО меньше суммы личных потолков (180), иначе лимит недостижим и
 * декоративен — это проверяет тест `workshop.structures.test.ts`.
 */
export const MAX_STRUCTURE_TOTAL = 150;

/**
 * ─── ASIC: лестница тиров ─────────────────────────────────────────────────────
 *
 * Тир здесь и есть «уровень ASIC» из ТЗ (`TD_.md:1775 asicLevel`). Три ряда, и их
 * расхождение — предметное решение, а не округление:
 *
 *   доход  25 → 50 → 75   (×1 : ×2,0 : ×3,0)
 *   мощн.  40 → 71 → 104  (×1 : ×1,8 : ×2,6)
 *   тепло  60 → 114 → 198 (×1 : ×1,9 : ×3,3)   ← РАСТЁТ БЫСТРЕЕ ДОХОДА
 *
 * Именно нелинейность тепла делает апгрейд осмысленным: на Mk.III стойка удваивает
 * доход, но требует в 3,3 раза больше азота. Без перекоса повышение тира было бы
 * бесплатным, и весь контур охлаждения потерял бы смысл за неделю.
 */
const ASIC: Readonly<Record<1 | 2 | 3, { hash: number; power: number; heat: number }>> = {
  1: { hash: 25, power: 40, heat: 60 },
  2: { hash: 50, power: 71, heat: 114 },
  3: { hash: 75, power: 104, heat: 198 }
};

export const STRUCTURES: readonly StructureDef[] = [
  // ─── Энергетика: плазменные конвертеры ──────────────────────────────────────
  // КПВ (кВт на единицу плазмы) растёт с тиром слабее масштаба: 15 → 16,8 → 18,2.
  // Эффективность — не право тира-3 на бесконечное топливо, иначе реактор обесценил
  // бы и добычу плазмы, и саму потребность строить несколько конвертеров.
  {
    id: 'reactor_plasma_mk1',
    name: 'Плазменный конвертер Mk.I',
    tier: 1,
    cost: { ferrum: 1200, silicium: 600, chips: 8, black_metal: 150 },
    buildMs: 60 * 60_000,
    maxPerBase: 12,
    power: 120,
    heat: 30,
    fuel: { resource: 'plasma', perHour: 8 },
    priority: POWER_PRIORITY.generation
  },
  {
    id: 'reactor_plasma_mk2',
    name: 'Плазменный конвертер Mk.II',
    tier: 2,
    cost: { ferrum: 3000, silicium: 1400, black_metal: 600, colored_metal: 250, boards: 20, wolfram: 40 },
    buildMs: 4 * 60 * 60_000,
    maxPerBase: 8,
    power: 320,
    heat: 70,
    fuel: { resource: 'plasma', perHour: 19 },
    priority: POWER_PRIORITY.generation,
    requires: { reactor_plasma_mk1: 1 }
  },
  {
    id: 'reactor_plasma_mk3',
    name: 'Плазменный конвертер Mk.III',
    tier: 3,
    cost: {
      ferrum: 7000,
      silicium: 3000,
      black_metal: 1200,
      colored_metal: 800,
      precious_metal: 300,
      wolfram: 150,
      stanium: 20
    },
    buildMs: 12 * 60 * 60_000,
    maxPerBase: 5,
    power: 800,
    heat: 150,
    fuel: { resource: 'plasma', perHour: 44 },
    priority: POWER_PRIORITY.generation,
    requires: { reactor_plasma_mk2: 1 }
  },

  // ─── Охлаждение ─────────────────────────────────────────────────────────────
  // Сам кулер греется на ~8% от своей способности отводить: насос и компрессор тоже
  // тратят энергию. Без этой поправки «контур, охлаждающий сам себя до бесконечности»
  // стал бы равновесием, и азот перестал бы быть дефицитом.
  {
    id: 'cooler_loop_mk1',
    name: 'Крио-контур Mk.I',
    tier: 1,
    cost: { ferrum: 400, colored_metal: 120, boards: 4 },
    buildMs: 30 * 60_000,
    maxPerBase: 24,
    power: -6,
    heat: 3,
    cooling: 40,
    priority: POWER_PRIORITY.cooling
  },
  {
    id: 'cooler_loop_mk2',
    name: 'Крио-контур Mk.II',
    tier: 2,
    cost: { ferrum: 900, colored_metal: 400, precious_metal: 80, boards: 12 },
    buildMs: 90 * 60_000,
    maxPerBase: 16,
    power: -14,
    heat: 8,
    cooling: 100,
    priority: POWER_PRIORITY.cooling,
    requires: { cooler_loop_mk1: 1 }
  },

  // ─── Химия ──────────────────────────────────────────────────────────────────
  // Станция греется и ест общий бюджет охлаждения наравне со всеми: исключений из
  // правила «греется → жрёт азот» в движке нет намеренно. От ASIC её отличает только
  // масштаб — 10 кВт влезают в пассивный радиатор штаба вместе с первым конвертером,
  // поэтому первую крио-цепочку можно запустить БЕЗ готового азота. См. BASE_PASSIVE_COOLING.
  {
    id: 'nitro_plant_mk1',
    name: 'Азотная станция Mk.I',
    tier: 1,
    cost: { ferrum: 800, silicium: 400, black_metal: 200, chips: 6 },
    buildMs: 45 * 60_000,
    maxPerBase: 10,
    power: -30,
    heat: 10,
    output: { resource: 'nitrogen', perHour: 40 },
    priority: POWER_PRIORITY.chemistry,
    requires: { cryo_tank_mk1: 1 }
  },
  {
    id: 'nitro_plant_mk2',
    name: 'Азотная станция Mk.II',
    tier: 2,
    cost: { ferrum: 2000, silicium: 900, colored_metal: 350, boards: 15, wolfram: 30 },
    buildMs: 3 * 60 * 60_000,
    maxPerBase: 6,
    power: -70,
    heat: 25,
    output: { resource: 'nitrogen', perHour: 110 },
    priority: POWER_PRIORITY.chemistry,
    requires: { nitro_plant_mk1: 1, cryo_tank_mk1: 2 }
  },
  {
    id: 'centrifuge_mk1',
    name: 'Центрифуга Mk.I',
    tier: 1,
    cost: { ferrum: 1000, silicium: 500, black_metal: 300, chips: 10 },
    buildMs: 90 * 60_000,
    maxPerBase: 8,
    power: -50,
    heat: 15,
    fuel: { resource: 'uranium', perHour: 6 },
    output: { resource: 'deuterium', perHour: 12 },
    priority: POWER_PRIORITY.chemistry,
    requires: { gasometer_mk1: 1 }
  },
  {
    id: 'centrifuge_mk2',
    name: 'Центрифуга Mk.II',
    tier: 2,
    cost: { ferrum: 2500, silicium: 1200, colored_metal: 400, boards: 18, wolfram: 45 },
    buildMs: 5 * 60 * 60_000,
    maxPerBase: 5,
    power: -120,
    heat: 35,
    fuel: { resource: 'uranium', perHour: 24 },
    output: { resource: 'deuterium', perHour: 50 },
    priority: POWER_PRIORITY.chemistry,
    requires: { centrifuge_mk1: 1, gasometer_mk1: 2 }
  },

  // ─── ASIC ──────────────────────────────────────────────────────────────────
  // Единственные сооружения с денежной компонентой (`secCost`) и единственные, чья
  // цена растёт от количества.
  //
  // Mk.I СПЕЦИАЛЬНО БЕСПЛАТЕН В SEC. Монета капает только с ASIC, поэтому цена
  // первой стойки в монете — это замкнутое кольцо: чтобы начать зарабатывать, надо
  // уже зарабатывать. Ровно тот же класс ошибки, что и «хлам нужен, чтобы производить
  // хлам», который починен стартовым комплектом (config/starter.ts): новичок обязан
  // иметь возможность сделать первое действие в системе, не имея её результатов.
  // Денежный вход в экономику открывается на Mk.II — то есть после того, как у игрока
  // физически появился источник дохода.
  {
    id: 'asic_rack_mk1',
    name: 'ASIC-стойка Mk.I',
    tier: 1,
    cost: { ferrum: 500, silicium: 300, chips: 12, colored_metal: 60 },
    buildMs: 40 * 60_000,
    maxPerBase: 20,
    power: -ASIC[1].power,
    heat: ASIC[1].heat,
    coinOutput: { coin: 'sec', perHour: ASIC[1].hash },
    priority: POWER_PRIORITY.compute,
    secCost: 0
  },
  {
    id: 'asic_rack_mk2',
    name: 'ASIC-стойка Mk.II',
    tier: 2,
    cost: { ferrum: 1200, silicium: 700, chips: 40, boards: 20, precious_metal: 60 },
    buildMs: 2 * 60 * 60_000,
    maxPerBase: 14,
    power: -ASIC[2].power,
    heat: ASIC[2].heat,
    coinOutput: { coin: 'sec', perHour: ASIC[2].hash },
    priority: POWER_PRIORITY.compute,
    requires: { asic_rack_mk1: 1 },
    // 350 SEC при доходе 50/ч — окупаемость 7 часов на первом экземпляре и 30 часов
    // на четырнадцатом (350 × 1,12^13 ≈ 1530). Стойка живёт дольше недели, поэтому
    // монета всё ещё покупает темп, а не превращается в штраф за рост.
    secCost: 350,
    secCostGrowth: 1.12
  },
  {
    id: 'asic_rack_mk3',
    name: 'ASIC-стойка Mk.III',
    tier: 3,
    cost: { ferrum: 2600, silicium: 1500, chips: 90, boards: 45, precious_metal: 180, wolfram: 60 },
    buildMs: 6 * 60 * 60_000,
    maxPerBase: 8,
    power: -ASIC[3].power,
    heat: ASIC[3].heat,
    coinOutput: { coin: 'sec', perHour: ASIC[3].hash },
    priority: POWER_PRIORITY.compute,
    requires: { asic_rack_mk2: 1 },
    secCost: 1500,
    secCostGrowth: 1.12
  },

  // ─── Ёмкости ────────────────────────────────────────────────────────────────
  // Ёмкость добавляется ПОВЕРХ базовой (`account.storageCapacity`), а не заменяет её:
  // иначе первая же постройка отняла бы у игрока склад, который у него уже был.
  {
    id: 'silo_mk1',
    name: 'Рудный силос',
    tier: 1,
    cost: { ferrum: 300, black_metal: 100 },
    buildMs: 20 * 60_000,
    maxPerBase: 20,
    power: 0,
    heat: 0,
    storage: { resources: ['ferrum', 'silicium', 'uranium', 'plasma'], capacity: 1500 },
    priority: POWER_PRIORITY.storage
  },
  {
    id: 'gasometer_mk1',
    name: 'Газгольдер дейтерия',
    tier: 1,
    cost: { ferrum: 600, colored_metal: 200, boards: 5 },
    buildMs: 35 * 60_000,
    maxPerBase: 12,
    power: 0,
    heat: 0,
    storage: { resources: ['deuterium'], capacity: 800 },
    priority: POWER_PRIORITY.storage
  },
  {
    id: 'cryo_tank_mk1',
    name: 'Крио-цистерна',
    tier: 1,
    cost: { ferrum: 600, colored_metal: 250, boards: 6 },
    buildMs: 35 * 60_000,
    maxPerBase: 12,
    power: 0,
    heat: 0,
    storage: { resources: ['nitrogen'], capacity: 800 },
    priority: POWER_PRIORITY.storage
  }
];

const byId: ReadonlyMap<string, StructureDef> = new Map(STRUCTURES.map((def) => [def.id, def]));

export function getStructure(id: string): StructureDef | undefined {
  return byId.get(id);
}

/** Виды, не требующие предшественников: «что можно построить новичку» для витрины. */
export function entryStructures(): readonly StructureDef[] {
  return STRUCTURES.filter((def) => !def.requires || Object.keys(def.requires).length === 0);
}

/** Нулевой набор сооружений — стартовое состояние и база для миграций. */
export function emptyStructures(): Record<StructureId, number> {
  const result = {} as Record<StructureId, number>;
  for (const id of STRUCTURE_IDS) result[id] = 0;
  return result;
}

/** Сколько сооружений всех видов стоит на базе (для `MAX_STRUCTURE_TOTAL`). */
export function structuresTotal(counts: Partial<Record<StructureId, number>>): number {
  let total = 0;
  for (const id of STRUCTURE_IDS) total += counts[id] ?? 0;
  return total;
}

/** Прирост ёмкости накопителя от построек, ед. на каждый ресурс. */
export function storageBonus(counts: Partial<Record<StructureId, number>>): Record<StorageId, number> {
  const bonus: Record<StorageId, number> = { ferrum: 0, silicium: 0, uranium: 0, plasma: 0, deuterium: 0, nitrogen: 0 };
  for (const def of STRUCTURES) {
    const n = counts[def.id] ?? 0;
    if (n <= 0 || !def.storage) continue;
    for (const resource of def.storage.resources) bonus[resource] += def.storage.capacity * n;
  }
  return bonus;
}

/** Суммарное тепловыделение построек, кВт-тепла при полной нагрузке. */
export function heatOutput(counts: Partial<Record<StructureId, number>>): number {
  let heat = 0;
  for (const def of STRUCTURES) {
    const n = counts[def.id] ?? 0;
    if (n > 0) heat += def.heat * n;
  }
  return heat;
}

/** Суммарная способность отводить тепло, кВт-тепла. */
export function coolingCapacity(counts: Partial<Record<StructureId, number>>): number {
  let cap = 0;
  for (const def of STRUCTURES) {
    const n = counts[def.id] ?? 0;
    if (n > 0 && def.cooling) cap += def.cooling * n;
  }
  return cap;
}

/** Руды, которые сооружение способно наполнить (хелпер для витрины ёмкостей). */
export function storesOres(def: StructureDef): readonly OreId[] {
  if (!def.storage) return [];
  const ores: readonly OreId[] = ['ferrum', 'silicium', 'uranium', 'plasma'];
  return def.storage.resources.filter((r): r is OreId => ores.includes(r as OreId));
}

