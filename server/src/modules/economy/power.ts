import {
  BASE_PASSIVE_COOLING,
  BASE_POWER_SUPPLY,
  HEAT_PER_NITROGEN,
  POWER_PRIORITY,
  STRUCTURES,
  type StructureId
} from '../../config/structures.js';
import { RAID_FUEL_HORIZON_MS } from '../../config/pvp.js';
import { type CoinId, type StorageId } from '../../config/storage.js';
import { getBlueprint } from '../../config/workshop.js';

/**
 * Энергосеть базы: замкнутый баланс мощности и тепла.
 *
 * ПОЧЕМУ ЗДЕСЬ НЕТ ТИКА, ИНТЕГРАЦИИ ПО ВРЕМЕНИ И ЖУРНАЛА
 * ──────────────────────────────────────────────────────
 * Мощность — не запас, а СОСТОЯНИЕ. `supply − demand` вычисляется из состава базы за
 * один проход и ни от чего не зависит, кроме количества сооружений и уровня топлива.
 * Любая попытка «накопить киловатты» создала бы четвёртый по счёту пул с ёмкостью,
 * регеном и журналом там, где физике нужен простой ответ «хватает или нет».
 *
 * Отсюда следствие, ради которого всё и затевалось: витрина сети может считаться на
 * КАЖДОМ запросе без риска утаить начисление. Дешевле, чем один `resolveEntitlements`.
 *
 * ПОЧЕМУ ВЕЕР БИНАРНЫЙ
 * ────────────────────
 * Соблазн — троттлить всех пропорционально (η = 0.73 на каждого). Физика прибора так
 * не работает (лазер не стреляет на 73% напряжения), а экономика тика ломается
 * совсем: ставочная мощность становится дробной функцией от остатков топлива, и
 * замкнутого решения между «жжёт плазму» и «производит мощность» не существует.
 *
 * Бинальность («стойка либо стоит, либо глуха») даёт две вещи:
 *  - все потоковые ставки — точные суммы по работающим экземплярам, тик закрывается
 *    формулой, а не итерацией;
 *  - игроку видно ПРИЧИНУ одним словом, а не mysterией «КПД 73%».
 *
 * ПОРЯДОК ГРАНИЦ (фиксирован, потому что они связаны кольцом)
 * ───────────────────────────────────────────────────────────
 *   1. топливо  → реактор без плазмы не генерирует, мощность падает;
 *   2. мощность → потребителей ранжируем по `priority`, лишние глушим;
 *   3. азот     → кулер без хладагента не охлаждает, горячее отключаем заново;
 *   4. шаг 3 может убрать РЕАКТОР (он тоже греется) → мощность снова упала → повтор.
 *
 * Кольцо 3→4 разрешается монотонно: на каждом витке множество работающих генераторов
 * строго убывает и пустым не становится раньше времени, поэтому цикл заканчивается за
 * ≤ числа экземпляров генерации. Практически — 1–2 витка. `MAX_PASSES` — страховка от
 * теоретической петли при правках конфига.
 */

/** Одна группа однородных экземпляров: 3 одинаковых реактора — это instances: 3. */
export interface GridMember {
  code: string;
  name: string;
  source: 'structure' | 'unit';
  priority: number;
  instances: number;
  /** кВт на экземпляр. Знак: + генерация, − потребление. */
  power: number;
  /** кВт-тепла на экземпляр. */
  heat: number;
  /** кВт отвода на экземпляр. Только у кулеров. */
  cooling: number;
  fuel?: { resource: StorageId; perHour: number };
  output?: { resource: StorageId; perHour: number };
  coin?: { coin: CoinId; perHour: number };
}

export type OfflineReason = 'fuel' | 'power' | 'cooling' | 'output';

export interface GridRow {
  code: string;
  name: string;
  source: 'structure' | 'unit';
  priority: number;
  instances: number;
  /** Сколько экземпляров реально работает. */
  online: number;
  offline: number;
  /** Причина для выключенных; null — все включены. */
  reason: OfflineReason | null;
}

export interface PowerGrid {
  /** Все группы с ненулевым числом экземпляров, с итоговым `online`. */
  rows: GridRow[];
  supplyRated: number;
  supplyOnline: number;
  demandRated: number;
  demandOnline: number;
  /** supplyOnline − demandOnline. Отрицательным не бывает: веер гасит дефицит. */
  reserve: number;
  /** Тепло работающих групп, кВт. */
  heatLoad: number;
  /** Отвод работающих кулеров, кВт. */
  coolingCap: number;
  /** Сколько азота сгорает в час при текущем тепловыделении, ед/ч. */
  nitrogenPerHour: number;
  /** Ставки по ресурсам при текущем составе работающих групп. */
  fuelRate: Record<StorageId, number>;
  outputRate: Record<StorageId, number>;
  coinRate: Record<CoinId, number>;
  /** Кулеры есть, а азота нет — особая диагностика: игрок путает её с дефицитом мощности. */
  starvedCooling: boolean;
  /** Число витков разрешения кольца. 1 — конфликт отсутствует. */
  passes: number;
  isBalanced: boolean;
}

/** Порог «есть ли топливо». Не 0: дробные остатки после тика ≈ 1e-9. */
const FUEL_EPS = 1e-6;

/** Витки кольца «мощность ↔ охлаждение». Зарезервировано: 12 генераторов максимум. */
const MAX_PASSES = 16;

function emptyCoin(): Record<CoinId, number> {
  return { sec: 0 };
}

// ─── Боевые единицы в сети ────────────────────────────────────────────────────

/**
 * Как класс техники подключён к энергосети базы.
 *
 *  - `grid`       — проводная единица: потребляет кВт из сети постоянно (дежурный
 *                   режим) и больше — в бою. Башни всегда проводные: вмонтированы в грунт.
 *  - `autonomous` — тяжёлая техника со СВОИМ реактором: 0 кВт от базы, но жрёт
 *                   дейтерий. Ровно то разделение, что задал заказчик: «вся тяжёлая
 *                   техника работает на своих реакторах и не потребляет электричество
 *                   базы, а расходует дейтерий».
 *  - `battery`    — лёгкий дрон: ходит от базы, но не проводной — «условно заряжается».
 *                   Сеть оплачивает его заряд, только пока есть резерв мощности.
 *
 * Граница autonomous/battery проходит по тиру-3: не произвол, а единственная уже
 * существующая в кодовой базе ось сложности (стоимость, время сборки, DPS). Ввести
 * для сети отдельную энумерацию «тяжести» — значит завести второй источник истины.
 */
export type PowerClass = 'grid' | 'battery' | 'autonomous';

export interface UnitPowerProfile {
  class: PowerClass;
  /** кВт в дежурном режиме (сеть/заряд). Для autonomous — 0 всегда. */
  idle: number;
  /** кВт в бою. Витрина сети показывает дежурный режим; бой — отдельная проверка. */
  combat: number;
  /** кВт-тепла в бою. 0 — азот не требует (лазеру хватает пассивного радиатора). */
  heat: number;
  /** ед./час собственного реактора. Только для autonomous (дейтерий). */
  fuelPerHour: number;
}

/**
 * Профили по кодам каталога (`config/workshop.ts`). Держим здесь, а не в `Blueprint`,
 * потому что чертёж описывает СТОИМОСТЬ и СБОРКУ, а это — ЭКСПЛУАТАЦИЮ. Смешать —
 * значит заставить балансировщика оружия править файл, от которого зависит тик сети.
 */
export const UNIT_POWER_PROFILE: Readonly<Record<string, UnitPowerProfile>> = {
  tower_laser_mk1: { class: 'grid', idle: 5, combat: 15, heat: 0, fuelPerHour: 0 },
  tower_rail_mk2: { class: 'grid', idle: 15, combat: 45, heat: 25, fuelPerHour: 0 },
  tower_plasma_mk3: { class: 'grid', idle: 30, combat: 90, heat: 60, fuelPerHour: 0 },
  weapon_cannon_mk1: { class: 'grid', idle: 8, combat: 20, heat: 0, fuelPerHour: 0 },
  weapon_railgun_mk3: { class: 'autonomous', idle: 0, combat: 0, heat: 40, fuelPerHour: 18 },
  weapon_plasma_cannon_mk3: { class: 'autonomous', idle: 0, combat: 0, heat: 55, fuelPerHour: 24 },
  weapon_railgun_heavy_mk3: { class: 'autonomous', idle: 0, combat: 0, heat: 70, fuelPerHour: 32 },
  drone_cargo_mk1: { class: 'battery', idle: 4, combat: 4, heat: 0, fuelPerHour: 0 },
  drone_strike_mk2: { class: 'battery', idle: 10, combat: 25, heat: 12, fuelPerHour: 0 },
  drone_cerberus_mk3: { class: 'autonomous', idle: 0, combat: 0, heat: 80, fuelPerHour: 40 }
};

/** Профиль по коду; null — предмет не боевая единица либо стена (пассивная конструкция). */
export function unitPowerProfile(code: string): UnitPowerProfile | null {
  return UNIT_POWER_PROFILE[code] ?? null;
}

// ─── Участники сети ───────────────────────────────────────────────────────────

export interface GridInput {
  structures: Partial<Record<StructureId, number>>;
  /** Код боевой единицы → количество. Для обороны — выставленные на карту. */
  units: Readonly<Record<string, number>>;
  /** Остатки в цистернах: определяют, чем вообще может работать кольцо. */
  storages: Record<StorageId, number>;
  /** Бой поднимает потребление проводной обороны с `idle` на `combat`. */
  combat?: boolean;
  /**
   * Накопители, переполненные на данный момент. Цех, которому некуда лить продукцию,
   * обязан встать: иначе он продолжит жрать мощность и топливо ради продукта, который
   * тут же улетучился бы. Сеть о переполнении не догадывается — ёмкость не её забота,
   * — поэтому список передаёт тик (`industry.ts`).
   */
  blockedOutput?: readonly StorageId[];
}

/**
 * Плоский список участников сети из состояния базы.
 *
 * Автономная техника сюда НЕ попадает: у неё свой реактор, и попади она в список —
 * игрок увидел бы расход базы на то, что базой не питается. Её дейтерий учитывается
 * отдельной ставкой в промышленном тике (`industry.ts`).
 */
export function collectMembers(input: GridInput): GridMember[] {
  const members: GridMember[] = [];

  for (const def of STRUCTURES) {
    const n = Math.trunc(input.structures[def.id] ?? 0);
    if (n <= 0) continue;
    members.push({
      code: def.id,
      name: def.name,
      source: 'structure',
      priority: def.priority,
      instances: n,
      power: def.power,
      heat: def.heat,
      cooling: def.cooling ?? 0,
      ...(def.fuel ? { fuel: def.fuel } : {}),
      ...(def.output ? { output: def.output } : {}),
      ...(def.coinOutput ? { coin: { coin: def.coinOutput.coin, perHour: def.coinOutput.perHour } } : {})
    });
  }

  const byCode = new Map<string, number>();
  for (const [code, n] of Object.entries(input.units)) {
    if (n > 0) byCode.set(code, (byCode.get(code) ?? 0) + Math.trunc(n));
  }
  for (const [code, n] of byCode) {
    const profile = UNIT_POWER_PROFILE[code];
    if (!profile || profile.class === 'autonomous') continue;
    const draw = input.combat ? profile.combat : profile.idle;
    if (draw <= 0) continue;
    members.push({
      code,
      name: getBlueprint(code)?.name ?? code,
      source: 'unit',
      priority: POWER_PRIORITY.defense,
      instances: n,
      power: -draw,
      heat: input.combat ? profile.heat : 0,
      cooling: 0
    });
  }

  return members;
}

/** Стабильная сортировка веера: приоритет, затем код — иначе порядок плавает от вызова к вызову. */
function byPriority(a: GridMember, b: GridMember): number {
  return a.priority - b.priority || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

/** Поле допуска при делении остатка мощности на потребление: 1e-9 кВт — шум round6. */
const FIT_EPS = 1e-9;

function fit(budget: number, each: number, instances: number): number {
  if (each <= 0) return instances;
  const n = Math.floor(budget / each + FIT_EPS);
  return Math.max(0, Math.min(instances, n));
}

interface MemberState {
  member: GridMember;
  online: number;
  reason: OfflineReason | null;
}

/**
 * Баланс сети: какие экземпляры работают и каковы итоговые ставки.
 *
 * ЧИТАТЬ ПОРЯДОК ШАГОВ, а не числа: кулеры обслуживаются РАНЬШЕ остальных
 * потребителей именно потому, что их работа определяет бюджет охлаждения для всех
 * последующих. Обратно (сначала нагрузки, потом кулеры) — кольцо без фиксации.
 */
export function computeGrid(input: GridInput): PowerGrid {
  const all = collectMembers(input);
  // Вставшие по переполнению цехи убираются из распределения, но НЕ исчезают из
  // отчёта: игрок должен видеть «азотная станция простаивает: крио-цистерна полна»,
  // а не гадать, куда делась мощность.
  const blocked = new Set<StorageId>(input.blockedOutput ?? []);
  const keyOf = (m: GridMember) => `${m.source}:${m.code}`;
  const stalled = all.filter((m) => m.output !== undefined && blocked.has(m.output.resource));
  const stalledKeys = new Set(stalled.map(keyOf));
  const members = all.filter((m) => !stalledKeys.has(keyOf(m)));
  const generators = members.filter((m) => m.power > 0);
  const coolers = members.filter((m) => m.power <= 0 && m.cooling > 0).sort(byPriority);
  const loads = members.filter((m) => m.power <= 0 && m.cooling <= 0).sort(byPriority);

  const supplyRated = BASE_POWER_SUPPLY + generators.reduce((acc, m) => acc + m.power * m.instances, 0);
  const demandRated = members.reduce((acc, m) => acc + (m.power < 0 ? -m.power * m.instances : 0), 0);

  // Шаг 0 (топливо): генератор без топлива не генерирует — и это не «веер по мощности»,
  // а отсутствие источника. Причина фиксируется отдельно, иначе игрок будет искать
  // сломанный ASIC вместо пустого бункера плазмы.
  //
  // `genFuelCap` — НЕИЗМЕНЯЕМАЯ память о том, сколько экземпляров пускало топливо.
  // Отдельно от `genWanted`, который кольцо ужимает по охлаждению: свалить их в одну
  // карту — значит потом не отличить «кончилась плазма» от «нет азота», и диагностика
  // врёт игроку в самый неподходящий момент.
  const genFuelCap = new Map<string, number>();
  const genWanted = new Map<string, number>();
  for (const g of generators) {
    const fueled = !g.fuel || (input.storages[g.fuel.resource] ?? 0) > FUEL_EPS;
    genFuelCap.set(g.code, fueled ? g.instances : 0);
    genWanted.set(g.code, fueled ? g.instances : 0);
  }
  const nitrogenReady = (input.storages.nitrogen ?? 0) > FUEL_EPS;

  let states: MemberState[] = [];
  let coolingCap = 0;
  let passes = 0;

  // ДВЕ РАЗНЫЕ очерёдности для двух границ — не непоследовательность, а физика:
  //
  //  · МОЩНОСТЬ отдаём сначала обороне (5), затем химии (30), в конце ASIC (50).
  //    В темноте база беззащитна, а потерянный рейд больнее потерянной монеты:
  //    майнинг — то, что отключается первым, и игрок обязан это чувствовать.
  //
  //  · ОХЛАЖДЕНИЕ отдаём сначала ГЕНЕРАЦИИ, затем обороне, химии, ASIC.
  //    Отключённый реактор уносит ВСЮ сеть, поэтому позволить турели съесть его азот —
  //    значит обменять одну башню на все остальные. Именно эта инверсия ловилась в
  //    первом варианте движка: боевое тепло рельсотрона (25 кВт) глушило конвертер,
  //    тот отбирал мощность у самого рельсотрона, и база складывалась сама в себя.
  for (let iteration = 0; iteration < MAX_PASSES; iteration++) {
    passes = iteration + 1;

    let supply = BASE_POWER_SUPPLY;
    for (const g of generators) supply += (genWanted.get(g.code) ?? 0) * g.power;

    // Граница 1 — мощность. Кулеры в общем списке: их 6–14 кВт должны быть оплачены до
    // химии и ASIC, иначе бюджет охлаждения собирался бы из неработающих контуров.
    let powerBudget = supply;
    // Пассивный радиатор штаба работает всегда и азота не ест.
    coolingCap = BASE_PASSIVE_COOLING;
    const powered = new Map<string, MemberState>();
    for (const c of [...coolers, ...loads].sort(byPriority)) {
      const isCooler = c.cooling > 0;
      // Контур без хладагента глушится и ОСВОБОЖДАЕТ мощность: азотное голодание не
      // должно наказывать базу дважды — и теплом, и отключением соседей по сети.
      const online = isCooler && !nitrogenReady ? 0 : fit(powerBudget, -c.power, c.instances);
      powerBudget -= online * -c.power;
      if (isCooler) coolingCap += online * c.cooling;
      const reason: OfflineReason | null =
        online === c.instances ? null : isCooler && !nitrogenReady ? 'cooling' : 'power';
      powered.set(keyOf(c), { member: c, online, reason });
    }

    // Граница 2 — охлаждение, по своей очерёдности (генерация вне конкуренции).
    let coolBudget = coolingCap;
    let scramHappened = false;
    const coolingPool = [...generators, ...loads].sort(
      (a, b) => Number(b.power > 0) - Number(a.power > 0) || byPriority(a, b)
    );

    for (const m of coolingPool) {
      const isGen = m.power > 0;
      const cap = isGen ? (genWanted.get(m.code) ?? 0) : (powered.get(keyOf(m))?.online ?? 0);
      const cooled = m.heat > 0 ? fit(coolBudget, m.heat, cap) : cap;
      coolBudget -= cooled * m.heat;

      if (isGen) {
        if (cooled !== (genWanted.get(m.code) ?? 0)) {
          genWanted.set(m.code, cooled);
          scramHappened = true;
        }
      } else {
        const state = powered.get(keyOf(m));
        if (state) {
          powered.set(keyOf(m), {
            member: m,
            online: cooled,
            reason: state.reason ?? (cooled < state.online ? 'cooling' : null)
          });
        }
      }
    }

    states = [];
    for (const m of [...coolers, ...loads]) {
      const state = powered.get(keyOf(m));
      if (state) states.push(state);
    }
    for (const g of generators) {
      const online = genWanted.get(g.code) ?? 0;
      const fuelCap = genFuelCap.get(g.code) ?? 0;
      states.push({
        member: g,
        online,
        reason: fuelCap < g.instances ? 'fuel' : online < fuelCap ? 'cooling' : null
      });
    }
    if (!scramHappened) break;
  }

  // Финальные ставки — по устоявшемуся составу.
  const fuelRate: Record<StorageId, number> = { ferrum: 0, silicium: 0, uranium: 0, plasma: 0, deuterium: 0, nitrogen: 0 };
  const outputRate: Record<StorageId, number> = { ferrum: 0, silicium: 0, uranium: 0, plasma: 0, deuterium: 0, nitrogen: 0 };
  const coinRate: Record<CoinId, number> = emptyCoin();
  let supplyOnline = BASE_POWER_SUPPLY;
  let demandOnline = 0;
  let heatLoad = 0;

  for (const state of states) {
    const m = state.member;
    if (m.power > 0) supplyOnline += state.online * m.power;
    else demandOnline += state.online * -m.power;
    // Тепло кулера — его собственная компрессорная нагрузка: она сбрасывается на
    // радиатор того же контура и хладагента не ест. Засчитать её в `heatLoad` — значит
    // заставить игрока платить азотом за то, что его же и охлаждает, и загнать систему
    // в петлю, из которой нет выхода кроме как строить больше кулеров ради кулеров.
    if (m.heat > 0 && m.cooling <= 0) heatLoad += state.online * m.heat;
    if (m.fuel) fuelRate[m.fuel.resource] += state.online * m.fuel.perHour;
    if (m.output) outputRate[m.output.resource] += state.online * m.output.perHour;
    if (m.coin) coinRate[m.coin.coin] += state.online * m.coin.perHour;
  }

  const rows: GridRow[] = states.map((s) => ({
    code: s.member.code,
    name: s.member.name,
    source: s.member.source,
    priority: s.member.priority,
    instances: s.member.instances,
    online: s.online,
    offline: s.member.instances - s.online,
    reason: s.reason
  }));
  for (const m of stalled) {
    rows.push({
      code: m.code,
      name: m.name,
      source: m.source,
      priority: m.priority,
      instances: m.instances,
      online: 0,
      offline: m.instances,
      reason: 'output'
    });
  }

  return {
    rows,
    supplyRated,
    supplyOnline,
    demandRated,
    demandOnline,
    reserve: supplyOnline - demandOnline,
    heatLoad,
    coolingCap,
    // Азот сгорает только на то тепло, которое НЕ забрал пассивный радиатор штаба:
    // радиатор сбрасывает тепло в космос бесплатно, и брать за него хладагент — значит
    // заставить новую базу тонуть в азотном голоде с первого такта (тик при нулевом
    // остатке азота обрезал бы горизонт нулём и не произвёл бы ничего).
    nitrogenPerHour: Math.max(0, heatLoad - BASE_PASSIVE_COOLING) / HEAT_PER_NITROGEN,
    fuelRate,
    outputRate,
    coinRate,
    starvedCooling: coolers.length > 0 && !nitrogenReady,
    passes,
    isBalanced: demandOnline <= supplyOnline && heatLoad <= coolingCap
  };
}

// ─── Боеготовность: чем база может закрыть бой ────────────────────────────────

/**
 * Проверка «хватает ли дейтерия тяжёлой технике на весь горизонт боя».
 *
 * Раздача ЖИРНАЯ И ДЕТЕРМИНИРОВАННАЯ: остаток общего бака уходит единицам в порядке
 * кода, а не «пропорционально всем». Пропорциональная раздача дала бы дробное число
 * машин в строю (половина рельсотрона стреляет?), а значит — бой, который нельзя
 * воспроизвести по снимку, что ломает главный инвариант симуляции.
 */
export function fuelAvailability(input: {
  /** код → число МАШИН (для дрона-роя — роев × состав, а не предметов). */
  units: Readonly<Record<string, number>>;
  deuterium: number;
  /** Горизонт, на который резервируется бак. */
  horizonMs: number;
}): { online: Record<string, number>; denied: Record<string, true>; reserve: number; perHour: number } {
  const hours = Math.max(0, input.horizonMs) / 3_600_000;
  const online: Record<string, number> = {};
  const denied: Record<string, true> = {};
  let tank = Math.max(0, input.deuterium);
  let reserve = 0;
  let perHour = 0;

  for (const code of Object.keys(input.units).sort()) {
    const count = Math.trunc(input.units[code] ?? 0);
    if (count <= 0) continue;
    const profile = UNIT_POWER_PROFILE[code];
    if (!profile || profile.class !== 'autonomous') continue;
    const each = profile.fuelPerHour * hours;
    if (each <= 0) {
      online[code] = count;
      perHour += profile.fuelPerHour * count;
      continue;
    }
    // Округление ВНИЗ: 0.99 бака на одну машину — это ноль машин, а не одна.
    const n = Math.max(0, Math.min(count, Math.floor(tank / each + 1e-9)));
    if (n < count) denied[code] = true;
    if (n > 0) {
      online[code] = n;
      perHour += profile.fuelPerHour * n;
      tank -= n * each;
      reserve += n * each;
    }
  }

  return { online, denied, reserve, perHour };
}

export interface CombatReadiness {
  /** Сеть в БОЕВОМ режиме: потребители подняты с `idle` на `combat`. */
  grid: PowerGrid;
  /** код → сколько экземпляров выходит в бой. */
  online: Record<string, number>;
  /** код → причина, по которой техника осталась на земле. */
  denied: Record<string, OfflineReason>;
  /** Дейтерий, зарезервированный под автономную технику на весь горизонт, ед. */
  deuteriumReserve: number;
  /** Суммарный расход дейтерия машинами, что вышли, ед./ч. */
  deuteriumPerHour: number;
}

/**
 * Что оборона защитника СМОЖЕТ выставить против рейда.
 *
 * СВЯЗЬ ДВУХ ОТКАЗОВ В ОДНОМ ЧИСЛЕ. Проводная техника глушится веером сети
 * (`computeGrid`, combat=true) — это границы «мощность» и «теплоотвод». Автономная
 * сеть не трогает вообще: у неё свой реактор, и её граница одна — дейтерий. Оба
 * отказа сводятся здесь в один ответ «сколько экземпляров кода выходит в бой»,
 * потому что для боя разницы между ними нет: башня либо стреляет, либо нет.
 * Причина сохраняется, чтобы игрок получил «не хватило азота», а не «оборона слабая».
 *
 * Функция замкнутая и без I/O: состояние базы на входе → боеготовность на выходе.
 * Это позволяет симуляции оставаться чистой функцией от снимка (см. шапку
 * pvp/battle.ts) и не тащить аккаунт защитника внутрь цикла боя.
 */
export function combatReadiness(input: {
  structures: Partial<Record<StructureId, number>>;
  units: Readonly<Record<string, number>>;
  storages: Record<StorageId, number>;
  horizonMs?: number;
}): CombatReadiness {
  const grid = computeGrid({ ...input, combat: true });
  const fuel = fuelAvailability({
    units: input.units,
    deuterium: input.storages.deuterium ?? 0,
    horizonMs: input.horizonMs ?? RAID_FUEL_HORIZON_MS
  });

  const online: Record<string, number> = {};
  const denied: Record<string, OfflineReason> = {};
  const rowOf = new Map<string, GridRow>();
  for (const row of grid.rows) if (row.source === 'unit') rowOf.set(row.code, row);

  for (const [code, raw] of Object.entries(input.units)) {
    const count = Math.trunc(raw ?? 0);
    if (count <= 0) continue;
    const profile = UNIT_POWER_PROFILE[code];
    if (!profile) continue;

    if (profile.class === 'autonomous') {
      const n = fuel.online[code] ?? 0;
      online[code] = n;
      if (n < count) denied[code] = 'fuel';
      continue;
    }

    const row = rowOf.get(code);
    // Row отсутствует — единица не нагружает сеть (нулевое потребление в бою) и
    // значит стоит в строю всегда; иначе молчаливый `?? 0` отправлял бы в резерв
    // всё, что сеть не видит.
    const n = row ? row.online : count;
    online[code] = n;
    if (n < count) denied[code] = row?.reason ?? 'power';
  }

  return {
    grid,
    online,
    denied,
    deuteriumReserve: fuel.reserve,
    deuteriumPerHour: fuel.perHour
  };
}


