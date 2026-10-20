import { type AppConfig } from '../../config/env.js';
import { ORE_IDS, STORAGE_IDS, STORAGE_LABEL, type StorageId } from '../../config/storage.js';
import { MAX_DEPLOYED_UNITS, MAX_WALLS, publicBaseConfig, type Cell } from '../../config/base.js';
import {
  ATTACK_ENERGY_COST,
  publicPvpConfig
} from '../../config/pvp.js';
import { describeBase, type BaseReport } from '../pvp/defense.js';
import { ratingProgress } from '../pvp/rating.js';
import { attacksRemainingToday, attacksToday } from '../pvp/raid.js';
import { REFERRAL_REWARD_ASTERIUM, REFERRAL_REWARD_ENERGY } from '../social/referral.js';
import {
  CHRONIUM_BUNDLE_DISCOUNT,
  CHRONIUM_MIN_COST,
  CHRONIUM_MS_PER_UNIT,
  STANIUM_MS_PER_UNIT,
  STANIUM_FIELD_MAX_MS,
  TECH_LABEL,
  TECH_MATERIAL_IDS
} from '../../config/materials.js';
import { getBlueprint, junkTotal as junkUnitsTotal, type BuildKind, type ItemKind, type JunkInventory, type MetalsInventory } from '../../config/workshop.js';
import { getStructure, structureSecCost, STRUCTURES, type StructureId } from '../../config/structures.js';
import type { SessionClaims } from '../auth/token.js';
import { describeBuilderShop, type BuilderShopView } from '../shop/builders.js';
import { deployedUnitCodes, type EntitlementKind, type EntitlementSource, type ItemSource, type UserAccount } from '../user/user.types.js';
import {
  buildersBusy,
  buildersFree,
  buildersMax,
  describeSpeedup,
  describeSpeedupAll,
  nextBuilderFreeAt,
  type SpeedupAllQuote,
  type SpeedupQuote
} from '../workshop/craft.js';
import { describeStaniumField, type StaniumFieldView } from '../materials/service.js';
import {
  effectiveMiningRates,
  effectiveStorageCapacity,
  isEntitlementActive,
  resolveEntitlements,
  storageCapacities
} from './entitlements.js';
import { computeGrid } from './power.js';
import { assistGainUnits, computeEnergyTick, dayKey } from './energy.js';
import { computeMiningTick, lootableEstimate } from './mining.js';
import { isPurchaseBlocked, asteriumTotal } from './wallet.js';

/**
 * DTO, который уходит в SPA. Клиент (Phaser/Pixi) не считает экономику сам:
 * сервер отдаёт готовый снапшот + прогнозы «когда что заполнится», чтобы UI
 * показывал таймеры и дергал пуши по local-notifications.
 */
export interface WarehouseView {
  resource: StorageId;
  name: string;
  /** Целое число на складе (то, что реально соберёт игрок — только для руд). */
  stored: number;
  /** Точное (дробное) значение — для прогресс-баров. */
  storedExact: number;
  /** Ёмкость ЭТОГО накопителя: базовый склад × буст + построенные ёмкости. */
  capacity: number;
  fillRatio: number;
  /** Приход, ед/час: добыча экстракторов либо выпуск цеха. */
  ratePerHour: number;
  /** Автоматический расход промышленностью, ед/час. Для руд — 0. */
  consumePerHour: number;
  /** Когда склад станет полным (null — ставка 0 / уже полон). */
  nextFillAt: Date | null;
  isFull: boolean;
  /** true — собирается рукой игрока; false — расходуется базой автоматически. */
  collectible: boolean;
}

/** Снимок энергосети: то, чего в витрине не было никогда — сеть не запас, а состояние. */
export interface PowerView {
  /** Встроенный генератор штаба + все работающие реакторы, кВт. */
  supplyOnline: number;
  /** То, что давала бы вся генерация при полном снабжении, кВт. */
  supplyRated: number;
  /** Потребление работающих потребителей, кВт. */
  demandOnline: number;
  /** Резерв сети, кВт. Отрицательным не бывает: веер гасит дефицит. */
  reserve: number;
  /** Тепловыделение работающих, кВт-тепла. */
  heatLoad: number;
  /** Отвод работающих крио-контуров, кВт-тепла. */
  coolingCap: number;
  /** Сжигание азота при текущем тепловыделении, ед/час. */
  nitrogenPerHour: number;
  /** Потенциал SEC при текущем составе работающих, ед/час. */
  secPerHour: number;
  /** true — сеть и тепло уравновешены, ничего не глушится. */
  isBalanced: boolean;
  /** Кулеры есть, а азота нет: отдельная диагностика, не путать с дефицитом мощности. */
  starvedCooling: boolean;
  rows: PowerRowView[];
}

export interface PowerRowView {
  code: string;
  name: string;
  source: 'structure' | 'unit';
  instances: number;
  online: number;
  offline: number;
  /** Причина для выключенных: игрок должен видеть ПРИЧИНУ, а не «КПД 73%». */
  reason: 'fuel' | 'power' | 'cooling' | 'output' | null;
}

/** Сооружение в витрине: сколько стоит, что даёт, сколько построено. */
export interface StructureView {
  id: StructureId;
  name: string;
  tier: number;
  count: number;
  power: number;
  heat: number;
  buildMs: number;
  cost: Record<string, number>;
  /**
   * Цена в SEC на СЛЕДУЮЩИЙ экземпляр — уже с учётом того, сколько стоек стоит на
   * базе. Не базовая `def.secCost`: `secCostGrowth` делает их разными числами, и
   * витрина с базовой ценой обещала бы игроку 350, а взяла бы 1530.
   */
  secCost: number;
  /** Выполнены ли предпосылки (`requires`) — кнопка «строить» активна только при true. */
  unlocked: boolean;
}

export interface EnergyView {
  /** Целое значение для UI. */
  value: number;
  exact: number;
  cap: number;
  regenPerHour: number;
  fullAt: Date | null;
  msToNextUnit: number | null;
  assist: {
    units: number;
    percent: number;
    usedToday: number;
    limitPerDay: number;
    remainingToday: number;
  };
}

export interface AsteriumView {
  /** Куплен за реальные деньги. Может быть отрицательным после возврата платежа. */
  purchased: number;
  /** Заработан (реклама, ассисты, события). Тратится первым. */
  earned: number;
  total: number;
  /** true => платёжный маршрут обязан отказать (долг по возврату). */
  blocked: boolean;
}

/**
 * Сырьевые материалы + состояние станиумного модуля.
 *
 * Отдельная секция, а не четыре поля в корне EconomyView: фронт рисует по ней
 * один блок «Материалы» (иконка, баланс, роль), и добавлять пятый материал —
 * правка одного места, а не правка контракта витрины во всех её потребителях.
 */
export interface MaterialsView {
  chronium: number;
  wolfram: number;
  stanium: number;
  /** Состояние станиумного модуля базы: активно, до когда, насколько замедляет. */
  staniumField: StaniumFieldView;
  /** Публичные правила: 1 хрониум = столько-то мс таймера, 1 станиум = столько-то мс поля. */
  rules: {
    chroniumMsPerUnit: number;
    staniumMsPerUnit: number;
    staniumMaxMs: number;
  };
  /** Подписи и роли материалов — чтобы клиент не держал свою копию словаря. */
  labels: Array<{ id: (typeof TECH_MATERIAL_IDS)[number]; label: string; role: string }>;
}

export interface BuildersView {
  /** Постоянных слотов куплено (позиция на лестнице цен). */
  owned: number;
  /** Эффективное число роботов: база + купленные слоты + временные бусты. */
  max: number;
  /** Сколько занято (выведено из очереди стройки, не хранится отдельно). */
  busy: number;
  free: number;
  limit: number;
  /** Когда освободится ближайший робот (null — есть свободные). */
  nextFreeAt: Date | null;
  /** Цена следующего постоянного слота; null — продавать нечего. */
  nextPrice: number | null;
}

export interface InventoryItemView {
  id: string;
  kind: ItemKind;
  code: string;
  name: string;
  tier: number;
  level: number;
  acquiredAt: Date;
  source: ItemSource;
}

export interface BuildView {
  id: string;
  code: string;
  name: string;
  /** `'structure'` — стройка здания (реактор, цех, цистерна); остальное — предмет. */
  kind: BuildKind;
  level: number;
  startedAt: Date;
  endsAt: Date;
  /** Остаток в мс; 0 — готово, но ещё не снято с очереди (инвентарь забит). */
  remainingMs: number;
  done: boolean;
  /** Цена и доступность кнопки «Ускорить» для этой работы — расчёт сервера, не клиента. */
  speedup: SpeedupQuote;
}

/** Правила и состояние кнопки «Ускорить всё» (пачка). */
export interface SpeedupView {
  /** Мс таймера за 1 хрониум. */
  msPerChronium: number;
  /** Минимальный чек: дешевле не бывает, даже если осталась секунда. */
  minCost: number;
  /** Множитель скидки на пачку (0.9 = «минус 10% от суммы кнопок»). */
  bundleDiscount: number;
  all: SpeedupAllQuote;
}

export interface EntitlementView {
  id: string;
  sku: string;
  kind: EntitlementKind;
  value: number;
  source: EntitlementSource;
  permanent: boolean;
  expiresAt: Date | null;
  /** Остаток в мс; null — бессрочно. Клиент рисует по нему таймер «осталось 3 дня». */
  remainingMs: number | null;
}

export interface AdsView {
  enabled: boolean;
  claimedToday: number;
  dailyLimit: number;
  /** -1 — лимит отключён. */
  remainingToday: number;
  minIntervalMs: number;
  /** Когда можно снова (null — прямо сейчас). */
  nextAvailableAt: Date | null;
  /** Незакрытая сессия показа (клиент продолжит/отменит её). */
  pendingSessionId: string | null;
  pendingExpiresAt: Date | null;
}

/** Выставленная на карту единица: координата + всё, что о ней знает инвентарь и чертеж. */
export interface DeployedUnitView {
  itemId: string;
  code: string;
  name: string;
  tier: number;
  kind: ItemKind;
  level: number;
  x: number;
  y: number;
}

/**
 * Состояние оборонительной сетки (Шаг 3).
 *
 * Проходимость передаётся отчётом, а не булевым `isValid`: игрок в редакторе обязан
 * видеть ПРИЧИНУ («с этих ворот пути нет», а не «карта красная»), а матчмейкингу
 * хватит `report.ready`. Оба считаются на сервере одними и теми же функциями.
 */
export interface BaseView {
  version: number;
  updatedAt: Date;
  hq: Cell;
  walls: Cell[];
  units: DeployedUnitView[];
  report: BaseReport;
  freeWalls: number;
  freeUnits: number;
}

export interface EconomyView {
  /**
   * Кошелёк. `sec` — дробный (капает ставкой 25/ч × часы), поэтому рядом лежит
   * `secSpendable`: тратить разрешено целое, а дробный остаток продолжает назреть.
   * Тот же дуэт, что `stored`/`storedExact` в складах, — единая для проекта пара
   * «точное число для расчёта / целое для руки игрока».
   */
  resources: {
    energy: number;
    ferrum: number;
    silicium: number;
    uranium: number;
    plasma: number;
    sec: number;
    secSpendable: number;
  };
  warehouses: WarehouseView[];
  /** Ближайший момент заполнения любого склада — триггер push (п.2.2). */
  storageFullAt: Date | null;
  /** Оценка трофеев нападающего (п.4.1): до 30% несобранного. */
  lootable: Record<StorageId, number>;
  /** Ставки добычи руды УЖЕ с учётом бустов. */
  miningRates: Record<StorageId, number>;
  /** Базовая ёмкость склада (до бустов и построек) — витрине нужны обе, чтобы показать «+100%». */
  storageCapacityBase: number;
  storageCapacity: number;
  /** Энергосеть и тепло: мгновенный баланс базы. */
  power: PowerView;
  /** Построенные сооружения — «что стоит и что можно достроить». */
  structures: StructureView[];
  lastLootTime: Date;
  energy: EnergyView;
  /** Роботы-строители: максимум/занято/свободно + цена следующего слота. */
  builders: BuildersView;
  /** Астерий: купленный и заработанный раздельно + признак блокировки покупок. */
  asterium: AsteriumView;
  /** Хрониум, вольфрам, станиум и состояние станиумного модуля базы. */
  materials: MaterialsView;
  /** Состояние витрины строителей (состояние кнопки «Купить робота»). */
  shop: BuilderShopView;
  /** Готовые предметы: башни, дроны, оружие. */
  inventory: InventoryItemView[];
  /** Очередь стройки (включая «готово, но инвентарь забит»). */
  builds: BuildView[];
  /** Ускорение стройки за хрониум: правила цен и состояние кнопки «Ускорить всё». */
  speedup: SpeedupView;
  /** Хлам на складе и его потолок (limits.loot.junkCap). */
  junk: JunkInventory;
  junkUnits: number;
  junkCap: number;
  /** Переработанные металлы — сырьё чертежей 2–3 тира. */
  metals: MetalsInventory;
  /** Активные привилегии с остатком срока — то, что игрок купил или выиграл. */
  entitlements: EntitlementView[];
  /** Состояние rewarded-рекламы (кнопка «+50 энергии за просмотр» и её лимиты). */
  ads: AdsView;
  /** Оборонительная сетка базы: штаб, стены, выставленные единицы и отчёт о проходимости. */
  base: BaseView;
  /** PvP (Шаг 4): рейтинг, лестница, статистика боёв и остаток атак на сегодня. */
  pvp: PvpView;

  /** До какого момента база неуязвима (null — щита нет). */
  shieldUntil: Date | null;
}

export interface PublicUser {
  id: string;
  platform: 'vk' | 'tg';
  socialId: string;
  groupId: string | null;
  createdAt: Date;
  lastLoginAt: Date;
  revision: number;
  /** PvP-профиль: рейтинг, лестница, статистика боёв, остаток атак на сегодня. */
  pvp: PvpView;
}

/**
 * PvP-витрина (Шаг 4).
 *
 * `attacksRemaining` выводится от `now`, а не хранится: суточный лимит сбрасывается
 * лениво, при первом бою нового дня (тот же приём, что у assist и loot), и показывать
 * «0 осталось» игроку, который просто не заходил со вчера, нельзя.
 */
export interface PvpView {
  rating: number;
  bestRating: number;
  battles: number;
  wins: number;
  draws: number;
  losses: number;
  streak: number;
  ladder: {
    code: string;
    name: string;
    min: number;
    next: { code: string; name: string; min: number } | null;
    toNext: number | null;
    ratio: number;
  };
  attackCost: number;
  attacksToday: number;
  /** Остаток атак на сегодня; -1 — лимит отключён конфигом. */
  attacksRemaining: number;
  lastRaidId: string | null;
  lastBattleAt: Date | null;
}

export function describePvp(account: UserAccount, now: Date, config: AppConfig): PvpView {
  const progress = ratingProgress(account.pvp.rating);
  return {
    rating: account.pvp.rating,
    bestRating: account.pvp.bestRating,
    battles: account.pvp.battles,
    wins: account.pvp.wins,
    draws: account.pvp.draws,
    losses: account.pvp.losses,
    streak: account.pvp.streak,
    ladder: {
      code: progress.tier.code,
      name: progress.tier.name,
      min: progress.tier.min,
      next: progress.next ? { code: progress.next.code, name: progress.next.name, min: progress.next.min } : null,
      toNext: progress.toNext,
      ratio: progress.ratio
    },
    attackCost: ATTACK_ENERGY_COST,
    attacksToday: attacksToday(account, now),
    attacksRemaining: attacksRemainingToday(account, now, config.economy),
    lastRaidId: account.pvp.lastRaidId,
    lastBattleAt: account.pvp.lastBattleAt
  };
}

/**
 * Снимок оборонительной сетки.
 *
 * Стены отдаются координатами, единицы — развёрнутыми до имени и тира: редактор
 * рисует по ним поле одним проходом, и ни одна константа баланса (цена стены, потолок
 * клеток, размер поля) не продублирована на клиенте.
 */
export function describeBaseView(account: UserAccount): BaseView {
  const report: BaseReport = describeBase(account);
  const byId = new Map(account.inventory.map((item) => [item.id, item]));

  const units: DeployedUnitView[] = [];
  for (const unit of account.base.units) {
    const item = byId.get(unit.itemId);
    // Призрак (предмет отозван) сюда не попадает: его видно в report.unbound, и
    // клиент не нарисует турель, которой нет.
    if (!item) continue;
    const blueprint = getBlueprint(item.code);
    units.push({
      itemId: unit.itemId,
      code: item.code,
      name: blueprint?.name ?? item.code,
      tier: blueprint?.tier ?? 1,
      kind: item.kind,
      level: item.level,
      x: unit.x,
      y: unit.y
    });
  }

  return {
    version: account.base.version,
    updatedAt: account.base.updatedAt,
    hq: { ...account.base.hq },
    walls: account.base.walls.map((cell) => ({ ...cell })),
    units,
    report,
    freeWalls: Math.max(0, MAX_WALLS - account.base.walls.length),
    freeUnits: Math.max(0, MAX_DEPLOYED_UNITS - units.length)
  };
}

/**
 * Сколько выставленных на карту единиц каждого кода. См. `deployedUnitCodes` в
 * домене (`user/user.types.ts`) — хелпер общий с промышленным тиком.
 */

export function describeEconomy(account: UserAccount, now: Date, config: AppConfig): EconomyView {
  const rules = config.economy;
  const effects = resolveEntitlements(account, now);
  /** Ёмкости по каждому накопителю: базовый склад × буст + силосы/газгольдеры/цистерны. */
  const capacities = storageCapacities(account, now, effects);
  const rates = effectiveMiningRates(account, now, effects);
  const mining = computeMiningTick(account, now, rules);
  const energy = computeEnergyTick(account, now, rules);
  const shop = describeBuilderShop(account, now);
  // Переполненные цистерны глушат свои цехи и в витрине: игрок должен видеть ту же
  // картину, что получит после тика, а не «всё работает» перед сном и аврал утром.
  const blockedOutput = STORAGE_IDS.filter(
    (resource) => (capacities[resource] ?? 0) > 0 && (account.storages[resource] ?? 0) >= (capacities[resource] ?? 0)
  );
  const grid = computeGrid({
    structures: account.structures,
    units: deployedUnitCodes(account),
    storages: account.storages,
    blockedOutput
  });

  /** Имя и тир берём из чертежа либо из реестра сооружений; неизвестный код не роняет витрину. */
  const blueprintOf = (code: string): { name: string; tier: number } => {
    const blueprint = getBlueprint(code);
    if (blueprint) return { name: blueprint.name, tier: blueprint.tier };
    const structure = getStructure(code);
    if (structure) return { name: structure.name, tier: structure.tier };
    return { name: code, tier: 1 };
  };

  const warehouses: WarehouseView[] = STORAGE_IDS.map((resource) => {
    const storedExact = account.storages[resource] ?? 0;
    const capacity = capacities[resource] ?? 0;
    const collectible = (ORE_IDS as readonly string[]).includes(resource);
    return {
      resource,
      name: STORAGE_LABEL[resource],
      stored: Math.floor(storedExact),
      storedExact,
      capacity,
      fillRatio: capacity > 0 ? storedExact / capacity : 1,
      // Приход: руда — от экстрактора, газ — от цеха. Один источник на ресурс.
      ratePerHour: collectible ? (rates[resource] ?? 0) : (grid.outputRate[resource] ?? 0),
      consumePerHour: (grid.fuelRate[resource] ?? 0) + (resource === 'nitrogen' ? grid.nitrogenPerHour : 0),
      nextFillAt: mining.nextFillAt[resource] ?? null,
      isFull: storedExact >= capacity,
      collectible
    };
  });

  const structures: StructureView[] = STRUCTURES.map((def) => {
    const count = account.structures[def.id] ?? 0;
    return {
      id: def.id,
      name: def.name,
      tier: def.tier,
      count,
      power: def.power,
      heat: def.heat,
      buildMs: def.buildMs,
      cost: { ...def.cost } as Record<string, number>,
      secCost: structureSecCost(def, count),
      unlocked: Object.entries(def.requires ?? {}).every(
        ([code, need]) => (account.structures[code as StructureId] ?? 0) >= (need ?? 0)
      )
    };
  });

  const power: PowerView = {
    supplyOnline: grid.supplyOnline,
    supplyRated: grid.supplyRated,
    demandOnline: grid.demandOnline,
    reserve: grid.reserve,
    heatLoad: grid.heatLoad,
    coolingCap: grid.coolingCap,
    nitrogenPerHour: grid.nitrogenPerHour,
    secPerHour: grid.coinRate.sec,
    isBalanced: grid.isBalanced,
    starvedCooling: grid.starvedCooling,
    rows: grid.rows.map((row) => ({
      code: row.code,
      name: row.name,
      source: row.source,
      instances: row.instances,
      online: row.online,
      offline: row.offline,
      reason: row.reason
    }))
  };

  const today = dayKey(now);
  const assistLimits = rules.limits.assist;
  const usedToday = account.assist.day === today ? account.assist.count : 0;

  const adsLimits = rules.limits.ads;
  const adsClaimed = account.ads.day === today ? account.ads.claimed : 0;
  const cooldownEndsAt =
    adsLimits.minIntervalMs > 0 && adsClaimed > 0 && account.ads.lastClaimAt
      ? new Date(account.ads.lastClaimAt.getTime() + adsLimits.minIntervalMs)
      : null;
  const pendingActive = account.ads.pending && account.ads.pending.expiresAt.getTime() > now.getTime();

  const entitlements: EntitlementView[] = account.entitlements
    .filter((entitlement) => isEntitlementActive(entitlement, now))
    .map((entitlement) => ({
      id: entitlement.id,
      sku: entitlement.sku,
      kind: entitlement.kind,
      value: entitlement.value,
      source: entitlement.source,
      permanent: entitlement.permanent,
      expiresAt: entitlement.expiresAt,
      remainingMs: entitlement.expiresAt ? Math.max(0, entitlement.expiresAt.getTime() - now.getTime()) : null
    }));

  return {
    resources: {
      energy: Math.floor(energy.energy),
      ferrum: account.resources.ferrum,
      silicium: account.resources.silicium,
      uranium: account.resources.uranium,
      plasma: account.resources.plasma,
      sec: account.resources.sec,
      secSpendable: Math.floor(account.resources.sec)
    },
    warehouses,
    storageFullAt: mining.storageFullAt,
    lootable: lootableEstimate(account, rules),
    miningRates: rates,
    storageCapacityBase: account.storageCapacity,
    storageCapacity: effectiveStorageCapacity(account, now, effects),
    power,
    structures,
    lastLootTime: account.lastLootTime,
    energy: {
      value: Math.floor(energy.energy),
      exact: energy.energy,
      cap: rules.energyCap,
      regenPerHour: rules.energyRegenPerHour * effects.energyRegenMultiplier,
      fullAt: energy.fullAt,
      msToNextUnit: energy.msToNextUnit,
      assist: {
        units: assistGainUnits(rules),
        percent: assistLimits.percent,
        usedToday,
        limitPerDay: assistLimits.dailyLimit,
        remainingToday: assistLimits.dailyLimit > 0 ? Math.max(0, assistLimits.dailyLimit - usedToday) : -1
      }
    },
    builders: {
      owned: shop.owned,
      max: buildersMax(account, now),
      busy: buildersBusy(account, now),
      free: buildersFree(account, now),
      limit: shop.limit,
      nextFreeAt: nextBuilderFreeAt(account, now),
      nextPrice: shop.price
    },
    asterium: {
      purchased: account.materials.asterium.purchased,
      earned: account.materials.asterium.earned,
      total: asteriumTotal(account),
      blocked: isPurchaseBlocked(account)
    },
    materials: {
      chronium: account.materials.chronium,
      wolfram: account.materials.wolfram,
      stanium: account.materials.stanium,
      staniumField: describeStaniumField(account, now),
      rules: {
        chroniumMsPerUnit: CHRONIUM_MS_PER_UNIT,
        staniumMsPerUnit: STANIUM_MS_PER_UNIT,
        staniumMaxMs: STANIUM_FIELD_MAX_MS
      },
      labels: TECH_MATERIAL_IDS.map((id) => ({ id, label: TECH_LABEL[id].label, role: TECH_LABEL[id].role }))
    },
    shop,
    inventory: account.inventory.map((item) => ({
      id: item.id,
      kind: item.kind,
      code: item.code,
      ...blueprintOf(item.code),
      level: item.level,
      acquiredAt: item.acquiredAt,
      source: item.source
    })),
    builds: account.builds.map((job) => ({
      id: job.id,
      code: job.code,
      ...blueprintOf(job.code),
      kind: job.kind,
      level: job.level,
      startedAt: job.startedAt,
      endsAt: job.endsAt,
      remainingMs: Math.max(0, job.endsAt.getTime() - now.getTime()),
      done: job.endsAt.getTime() <= now.getTime(),
      speedup: describeSpeedup(account, job.id, now)
    })),
    speedup: {
      msPerChronium: CHRONIUM_MS_PER_UNIT,
      minCost: CHRONIUM_MIN_COST,
      bundleDiscount: CHRONIUM_BUNDLE_DISCOUNT,
      all: describeSpeedupAll(account, now)
    },
    junk: { ...account.junk },
    junkUnits: junkUnitsTotal(account.junk),
    junkCap: rules.limits.loot.junkCap,
    metals: { ...account.metals },
    entitlements,
    ads: {
      enabled: adsLimits.enabled,
      claimedToday: adsClaimed,
      dailyLimit: adsLimits.dailyRewards,
      remainingToday: adsLimits.dailyRewards > 0 ? Math.max(0, adsLimits.dailyRewards - adsClaimed) : -1,
      minIntervalMs: adsLimits.minIntervalMs,
      nextAvailableAt: cooldownEndsAt && cooldownEndsAt.getTime() > now.getTime() ? cooldownEndsAt : null,
      pendingSessionId: pendingActive ? (account.ads.pending?.id ?? null) : null,
      pendingExpiresAt: pendingActive ? (account.ads.pending?.expiresAt ?? null) : null
    },
    base: describeBaseView(account),
    pvp: describePvp(account, now, config),
    shieldUntil: effects.shieldUntil
  };
}

export function describeUser(account: UserAccount, now: Date, config: AppConfig): PublicUser {
  return {
    id: account.id,
    platform: account.platform,
    socialId: account.socialId,
    groupId: account.groupId,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
    revision: account.revision,
    pvp: describePvp(account, now, config)
  };
}

export function describeSession(claims: SessionClaims, expiresAt: Date): Record<string, unknown> {
  return {
    subject: claims.sub,
    platform: claims.platform,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt
  };
}

/** Публичные правила экономики — чтобы клиент рисовал таймеры без угадывания констант. */
export function publicConfig(config: AppConfig): Record<string, unknown> {
  const limits = config.economy.limits;
  return {
    platform: { vk: config.vk.appId > 0, tg: config.tg.botToken !== null },
    store: config.store.driver,
    economy: {
      ...config.economy,
      assistUnits: Math.floor((config.economy.energyCap * limits.assist.percent) / 100)
    },
    // Лимиты отдаём отдельно: клиент по ним рисует состояние кнопки «Смотреть рекламу».
    limits,
    // Правила оборонительной сетки: размер поля, ворота, площадки штаба, цена стены.
    // Редактор не должен угадывать константы — иначе валидатор и клиент разойдутся.
    base: publicBaseConfig(),
    // Правила PvP (Шаг 4): рейтинг, лестница, стоимость атаки, профили единиц.
    pvp: publicPvpConfig(),
    // Награда «пригласи друга» — публичная: игрок обязан видеть, за что зовёт друга.
    referral: {
      rewardEnergy: REFERRAL_REWARD_ENERGY,
      rewardAsterium: REFERRAL_REWARD_ASTERIUM,
      dailyMax: limits.referral.dailyMax
    },
    session: { ttlSec: config.jwt.ttlSec }
  };
}
