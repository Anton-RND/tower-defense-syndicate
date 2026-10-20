import { ITEM_KINDS, getBlueprint, type Blueprint, type ItemKind } from './workshop.js';

/**
 * PvP-баланс (Шаг 4): рейтинг, матчмейкинг, состав армий и параметры симуляции боя.
 *
 * Почему это отдельный конфиг, а не продолжение других:
 *  - `base.ts` описывает ГЕОМЕТРИЮ поля (она не меняется от патча к патчу),
 *  - `workshop.ts` — что предмет стоит и как долго строится,
 *  - `limits.ts` — антифрод-потолки, которые правят без ревью баланса.
 * Здесь — числа, которые правят ради ощущения боя («турель слишком сильная»,
 * «дроны дохнут за три секунды»). Они серверные: витрина получает только
 * производные (см. publicPvpConfig в конце файла).
 *
 * ДВА ИНВАРИАНТА, на которых держится модуль:
 *
 *  1. Симуляция НЕ использует случайность. Исход боя — чистая функция от
 *     (планировка защитника, состав атакующего). Одна и та же пара игроков даёт
 *     один и тот же бой, поэтому повторная жалоба пересчитывается дословно, а
 *     «реплей» — это вход, а не запись кадров. Случаен только выбор соперника и
 *     бросок лута — туда ГСЧ передаётся параметром.
 *
 *  2. Разрушения НЕ переносятся в состояние защитника. Стены и башни на его карте
 *     остаются целыми: асинхронный PvP (п.4 ТЗ) — штурм копии, а не реальный урон.
 *     Иначе каждый вход в игру начинался бы с починки, а инвариант Шага 3 «на карте
 *     только живые предметы инвентаря» развалился бы первым. Защитник теряет только
 *     то, что и должно теряться: несобранные склады (п.4.1) и рейтинг.
 */

/** Тир чертежа — производная от каталога, а не своя энумерация: правка в одном месте. */
type Tier = Blueprint['tier'];

// ─── Рейтинг ──────────────────────────────────────────────────────────────────

/** Стартовый рейтинг новичка. 1000 — шахматная традиция: игроку понятно «я середина». */
export const PVP_RATING_START = 1000;

/** Пол, ниже которого рейтинг не падает. Долг по рейтингу — верный способ бросить игру. */
export const PVP_RATING_FLOOR = 0;

/** K-фактор Эло: насколько сильно один бой двигает рейтинг. */
export const RATING_K_BASE = 32;

/** Первые бои играют с повышенным K: сила игрока ещё неизвестна, ошибка дорога. */
export const RATING_K_PROVISIONAL = 48;

/** Сколько боёв игрок считается «необкатанным» (K = RATING_K_PROVISIONAL). */
export const RATING_PROVISIONAL_BATTLES = 10;

/** Диапазоны лестницы для витрины. `min` — нижняя граница включительно. */
export interface LadderTier {
  code: 'bronze' | 'silver' | 'gold' | 'platinum' | 'diamond';
  name: string;
  min: number;
}

export const LADDER_TIERS: readonly LadderTier[] = [
  { code: 'bronze', name: 'Бронза', min: 0 },
  { code: 'silver', name: 'Серебро', min: 1200 },
  { code: 'gold', name: 'Золото', min: 1500 },
  { code: 'platinum', name: 'Платина', min: 1800 },
  { code: 'diamond', name: 'Алмаз', min: 2200 }
];

/** Лестничная ступень рейтинга (для значка в профиле). */
export function ladderTierOf(rating: number): LadderTier {
  let current = LADDER_TIERS[0] as LadderTier;
  for (const tier of LADDER_TIERS) {
    if (rating >= tier.min) current = tier;
  }
  return current;
}

// ─── Матчмейкинг ──────────────────────────────────────────────────────────────

/**
 * Ширина коридора поиска, ±рейтинг. Узкий коридор — честный бой: расширяем по
 * попыткам, а не ищем «кого угодно в базе», иначе игрок с 1200 стабильно получает
 * ботана с 2400 и теряет интерес к лестнице.
 */
export const MATCH_BAND_START = 150;
export const MATCH_BAND_STEP = 100;
/** Сколько раз расширить коридор, прежде чем признать «соперников нет». */
export const MATCH_BAND_MAX_ATTEMPTS = 5;
/** Сколько кандидатов тянуть из стора за попытку: больше — дороже, толку меньше. */
export const MATCH_POOL_SIZE = 40;
/**
 * Минимум живой обороны у кандидата в приоритетной выборке. Атаковать пустую базу —
 * бесплатный лут, то есть стимул держать алтов с нулевой обороной. База без единиц
 * подбирается, только когда в коридоре вообще никого нет: новичок против новичка
 * честнее, чем фарм.
 */
export const MATCH_PREFER_MIN_UNITS = 1;

// ─── Стоимость атаки ──────────────────────────────────────────────────────────

/**
 * Цена выхода в рейд, энергия (п.2.3: энергия — главный тормоз активности и главный
 * покупатель доната). 15 при капе 100 ≈ шесть атак с полной шкалы.
 */
export const ATTACK_ENERGY_COST = 15;

/** Потолок дронов в рейде: 48 — это уже весь инвентарь, больше считать незачем. */
export const ATTACK_MAX_ROBOTS = 48;
/** Минимум техники: одна машина — не рейд, а разведка боем, энергию не тратим. */
export const ATTACK_MIN_ROBOTS = 1;

/** Виды предметов, которые воюют на стороне атакующего. */
export const ATTACK_KINDS: readonly ItemKind[] = ['drone'];

/** true — предмет этого вида можно отправить в атаку. */
export function isAttackKind(kind: string): kind is ItemKind {
  return (ATTACK_KINDS as readonly string[]).includes(kind);
}

// ─── Симуляция ────────────────────────────────────────────────────────────────

/**
 * Шаг симуляции, мс. 200 Гц — компромисс: при 10 Гц робот «перепрыгивает» клетку и
 * промахивается мимо стены, при 1 кГц трёхминутный бой становится дорогим по CPU.
 * 200 мс даёт точность хода 1/5 клетки на скорости 1.5 кл/с.
 */
export const SIM_TICK_MS = 200;
/** Потолок шагов: 900 × 200 мс = 3 минуты. Дольше бой не длится ни при каких числах. */
export const SIM_MAX_TICKS = 900;
/** Пауза между вылетами дронов с ворот: волна, а не точка. */
export const SIM_SPAWN_INTERVAL_MS = 400;
/** Потолок событий таймлайна: реплей нужен для разбора, а не для хранения 10^5 кадров. */
export const SIM_MAX_EVENTS = 400;

/** Прочность стены: 400 ед. ≈ 12 с на дрона тир-1 (34 dps) — «замедлить», а не «остановить». */
export const WALL_HP = 400;
/** Прочность штаба: 3000 ед. ≈ 4 с под огнём двадцати дронов тир-1. Пал — поражение защиты. */
export const HQ_HP = 3000;

/**
 * Порог «пробил, но не снёс»: армия сбита, а штаб разрушен хотя бы наполовину —
 * это ничья, а не поражение. Без неё любой бой с исходом «не дошли» обнуляет
 * заслугу атакующего, и игрок, снявший 90% штаба ценой всех дронов, получает
 * ровно то же, что и тот, кто слил атаку на воротах.
 */
export const DRAW_HQ_DAMAGE_RATIO = 0.5;

// ─── Эксплуатация обороны: тепло и топливо ────────────────────────────────────

/**
 * Термодинамика ствола внутри боя.
 *
 * Сеть базы (modules/economy/power.ts) решает вопрос «чем оборона МОЖЕТ запитаться»,
 * и это состояние на момент входа в бой. Здесь — второй вопрос, на который сеть
 * ответить не может в принципе: орудие греётся, ПОКА СТРЕЛЯЕТ. За 180 секунд боя
 * азотный контур базы не успевает ничего, зато ствол успевает раскраснеться, и
 * игрок обязан получать «рейлган встал на 6-й секунде», а не «рейлган бил втрое
 * медленнее всегда» — второе неотличимо от вранья в витрине.
 *
 * Модель нормированная (тепло 0..1) и одинаковая для всех орудий ровно потому, что
 * ёмкость радиатора подбирается под теплоотвод: иными словами, «секунд до перегрева»
 * у скорострельной лайт-турели и у тяжёлого рельсотрона совпадают по построению, а
 * различает их `heat` в `UNIT_POWER_PROFILE` — он решает, греется единица вообще.
 */
export const THERMAL = {
  /**
   * Базовый шаг нагрева: столько секунд ОГНЯ при нулевом отводе довели бы контур до
   * упора. Отвод работает и во время стрельбы, поэтому реальное время до первого
   * перегрева — `fillSeconds / (1 − coolRatio)` = 8/0,4 = 20 с непрерывного огня.
   * Число выбирается из длины боя: 20 с — это 100 тактов из 900, то есть орудие
   * успевает раскрыться в бою несколько раз, но не встать в первый же такт.
   */
  fillSeconds: 8,
  /**
   * Доля боевого тепла, которую пассивный радиатор отводит непрерывно. 0.6 означает
   * установившийся рабочий цикл 60%: на длинной дистанции орудие стреляет ровно
   * столько времени, сколько успевает остыть, — `стрельба/цикл = отвод/нагрев`.
   * Из-за гистерезиса реальный цикл чуть выше (20 с огня против 8,7 с простоя ≈ 70%),
   * и это правильно: мягкий порог заставил бы башню дёргаться на каждом такте.
   */
  coolRatio: 0.6,
  /**
   * Ниже какой доли упора остывшее орудие возвращается в строй. Гистерезис обязателен:
   * без него при `heat == 1` башня стреляла бы один тик, остывала на один тик и
   * мигала с частотой тика — бой читался бы как поломка, а не как рабочий цикл.
   */
  recoverRatio: 0.35
} as const;

/**
 * Горизонт бронирования топлива: максимальная длительность боя (`SIM_MAX_TICKS ×
 * SIM_TICK_MS` = 180 с). Тяжёлая техника выезжает «с полным баком» — запас резервируется
 * ДО боя, потому что длительность становится известна только из его итога, а
 * резервировать по факту означало бы позволить рейд, который техника не дотянет.
 *
 * Списывается потом ПО ФАКТУ: отсидевшие в засаде 20 секунд из зарезервированных
 * 180 игрок не платит. Разница между резервом и расходом — сознательная цена
 * неопределённости, и она видна в отчёте боя обоими числами.
 */
export const RAID_FUEL_HORIZON_MS = SIM_MAX_TICKS * SIM_TICK_MS;

// ─── Профили единиц ───────────────────────────────────────────────────────────

/** Чем стреляет оборона и сколько живёт. */
export interface DefenseProfile {
  /** Урон в секунду по одной цели (башни не бьют «по площади» — см. range). */
  dps: number;
  /** Радиус поражения в клетках (евклидов). */
  range: number;
  /** Прочность: башню можно снести, если она мешает проходу. */
  hp: number;
}

/** Чем воюет атакующий. Скорость — клетки в секунду. */
export interface RobotProfile {
  hp: number;
  dps: number;
  speed: number;
  range: number;
  /** Сколько машин выставляет один предмет инвентаря (дрон — рой, а не одна штука). */
  squad: number;
}

/**
 * Базовые профили по ТИРУ чертежа, а не по коду.
 *
 * Сознательно: в каталоге девять чертежей, и они прибавляются. Таблица «код → статы»
 * молча даёт новому предмету нулевой урон — то есть непобедимую башню и неуязвимого
 * дрона, и обнаруживается это только в бою. Тир же гарантирует, что любой новый
 * чертеж попадает в существующую лестницу силы, а вкусовые отличия выписываются
 * явно в `*_OVERRIDES` ниже.
 */
export const DEFENSE_BY_TIER: Readonly<Record<Tier, DefenseProfile>> = {
  1: { dps: 24, range: 3.2, hp: 900 },
  2: { dps: 60, range: 3.8, hp: 1800 },
  3: { dps: 130, range: 4.4, hp: 3200 }
};

export const ROBOTS_BY_TIER: Readonly<Record<Tier, RobotProfile>> = {
  1: { hp: 260, dps: 34, speed: 1.5, range: 0.9, squad: 2 },
  2: { hp: 520, dps: 62, speed: 1.3, range: 1.2, squad: 2 },
  3: { hp: 900, dps: 110, speed: 1.1, range: 1.6, squad: 3 }
};

/** Отклонения конкретных башен от тира: вкус в пределах ±25% полки, а не новая балансировка. */
export const DEFENSE_OVERRIDES: Readonly<Record<string, Partial<DefenseProfile>>> = {
  tower_laser_mk1: { dps: 20 },
  tower_rail_mk2: { dps: 55 },
  tower_plasma_mk3: { dps: 120, range: 4.6 },
  // Орудия бьют сильнее башен того же тира, но короче: они занимают клетку в
  // лабиринте и потому должны быть уязвимее, а не безопаснее.
  weapon_cannon_mk1: { dps: 30, range: 2.6, hp: 800 },
  weapon_railgun_mk3: { dps: 150, range: 5.2, hp: 2600 },
  weapon_plasma_cannon_mk3: { dps: 110, range: 3.6 },
  weapon_railgun_heavy_mk3: { dps: 170, range: 5.6, hp: 3600 }
};

/** Отклонения конкретных дронов. Грузовой — «мясо»: живой, но почти не бьёт. */
export const ROBOT_OVERRIDES: Readonly<Record<string, Partial<RobotProfile>>> = {
  drone_cargo_mk1: { squad: 1, hp: 420, dps: 10, speed: 1.2 },
  drone_strike_mk2: { squad: 2, hp: 480, dps: 70 },
  drone_cerberus_mk3: { squad: 4, hp: 760, dps: 90, speed: 1.3 }
};

/**
 * Прибавка за уровень предмета: +25% урона и прочности за уровень.
 * Предметы прокачиваются (`InventoryItem.level`), и бой обязан это видеть, иначе
 * улучшение остаётся витринной механикой без влияния на оборону.
 */
export const LEVEL_DPS_STEP = 0.25;
export const LEVEL_HP_STEP = 0.25;

export interface ResolvedDefense extends DefenseProfile {
  code: string;
  name: string;
  tier: Tier;
  kind: ItemKind;
  level: number;
}

export interface ResolvedRobot extends RobotProfile {
  code: string;
  name: string;
  tier: Tier;
  kind: ItemKind;
  level: number;
}

/**
 * Боевой профиль обороняющегося предмета.
 * null — не чертёж каталога: такой предмет на карте уже считается призраком
 * (`liveUnits` в pvp/defense) и до боя не доходит.
 */
export function defenseProfileOf(item: { code: string; level: number }): ResolvedDefense | null {
  const blueprint = getBlueprint(item.code);
  if (!blueprint) return null;
  const tier = blueprint.tier;
  const base = DEFENSE_BY_TIER[tier];
  const override = DEFENSE_OVERRIDES[item.code] ?? {};
  const level = Math.max(1, Math.trunc(item.level) || 1);
  return {
    code: blueprint.code,
    name: blueprint.name,
    tier,
    kind: blueprint.kind,
    level,
    dps: round2((override.dps ?? base.dps) * (1 + LEVEL_DPS_STEP * (level - 1))),
    range: override.range ?? base.range,
    hp: Math.round((override.hp ?? base.hp) * (1 + LEVEL_HP_STEP * (level - 1)))
  };
}

/**
 * Боевой профиль атакующего предмета.
 * null — предмет не штурмовик (вид не в ATTACK_KINDS либо вне каталога).
 */
export function robotProfileOf(item: { code: string; level: number }): ResolvedRobot | null {
  const blueprint = getBlueprint(item.code);
  if (!blueprint) return null;
  if (!isAttackKind(blueprint.kind)) return null;
  const tier = blueprint.tier;
  const base = ROBOTS_BY_TIER[tier];
  const override = ROBOT_OVERRIDES[item.code] ?? {};
  const level = Math.max(1, Math.trunc(item.level) || 1);
  return {
    code: blueprint.code,
    name: blueprint.name,
    tier,
    kind: blueprint.kind,
    level,
    squad: Math.max(1, Math.trunc(override.squad ?? base.squad)),
    dps: round2((override.dps ?? base.dps) * (1 + LEVEL_DPS_STEP * (level - 1))),
    hp: Math.round((override.hp ?? base.hp) * (1 + LEVEL_HP_STEP * (level - 1))),
    speed: Math.round((override.speed ?? base.speed) * 1000) / 1000,
    range: override.range ?? base.range
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── Трофеи ───────────────────────────────────────────────────────────────────

/**
 * Доля трофея по исходу. База — `EconomyConfig.lootShare` (п.4.1: доля несобранных
 * складов), множитель отвечает на вопрос «насколько пробил оборону».
 *
 * Проигравший уносит горсть (0.1) сознательно: рейд с нулевым результатом и нулём
 * добычи ощущается как украденная энергия, а не как поражение в бою.
 */
export const OUTCOME_STEAL_FACTOR: Readonly<Record<'win' | 'draw' | 'loss', number>> = {
  win: 1,
  draw: 0.5,
  loss: 0.1
};

// ─── Витрина ──────────────────────────────────────────────────────────────────

/**
 * Публичная часть PvP-правил: то, что фронт показывает без угадывания констант.
 * Профили единиц отдаём целиком — карточка башни рисуется по тем же цифрам, по каким
 * сервер считает бой; расхождение читается как обман игрока.
 */
export function publicPvpConfig(): Record<string, unknown> {
  return {
    rating: {
      start: PVP_RATING_START,
      floor: PVP_RATING_FLOOR,
      kBase: RATING_K_BASE,
      kProvisional: RATING_K_PROVISIONAL,
      provisionalBattles: RATING_PROVISIONAL_BATTLES
    },
    ladder: LADDER_TIERS,
    attack: {
      energyCost: ATTACK_ENERGY_COST,
      minRobots: ATTACK_MIN_ROBOTS,
      maxRobots: ATTACK_MAX_ROBOTS,
      kinds: [...ATTACK_KINDS]
    },
    matchmaking: {
      bandStart: MATCH_BAND_START,
      bandStep: MATCH_BAND_STEP,
      maxAttempts: MATCH_BAND_MAX_ATTEMPTS
    },
    sim: { tickMs: SIM_TICK_MS, maxTicks: SIM_MAX_TICKS, wallHp: WALL_HP, hqHp: HQ_HP },
    defense: DEFENSE_BY_TIER,
    robots: ROBOTS_BY_TIER,
    stealFactor: OUTCOME_STEAL_FACTOR,
    levels: { dpsStep: LEVEL_DPS_STEP, hpStep: LEVEL_HP_STEP }
  };
}

/** Все виды предметов каталога — реэкспорт для проверок целостности в тестах. */
export const ALL_ITEM_KINDS: readonly ItemKind[] = ITEM_KINDS;
