import { Schema, type Connection, type Model } from 'mongoose';

import type { Platform } from '../../config/env.js';
import { DEFAULT_HQ } from '../../config/base.js';
import { PVP_RATING_FLOOR, PVP_RATING_START } from '../../config/pvp.js';
import { STORAGE_IDS } from '../../config/storage.js';
import { STRUCTURE_IDS } from '../../config/structures.js';
import { emptyJunk, emptyMetals, type JunkInventory, type MetalsInventory } from '../../config/workshop.js';
import type { SocialIdentity } from '../auth/vk.adapter.js';
import {
  emptyBase,
  normalizeStorages,
  normalizeStructures,
  type BaseState,
  type StoragePools,
  type StructureCounts,
  type UserAccount
} from './user.types.js';
import type {
  AdState,
  BuildJob,
  Entitlement,
  InventoryItem,
  LootState,
  MaterialsState,
  PurchaseOrder,
  PvpProfile,
  ReferralState,
  ResourceWallet
} from './user.types.js';

/**
 * Вложенные док-типы. Поля `eid`/`sid` вместо `id`: в Mongoose `id` — служебный
 * виртуальный путь, и переопределять его своими данными мы сознательно не стали.
 */
interface AsteriumDoc {
  purchased: number;
  earned: number;
}

interface EntitlementDoc {
  eid: string;
  sku: string;
  kind: string;
  value: number;
  permanent: boolean;
  expiresAt: Date | null;
  source: string;
  grantedAt: Date;
  orderId: string | null;
}

interface AdPendingDoc {
  sid: string;
  sku: string;
  createdAt: Date;
  expiresAt: Date;
}

interface AdUsedDoc {
  /** `reward_id` площадки, по которому награда уже выдана. */
  rid: string;
  at: Date;
}

interface AdsDoc {
  day: string;
  claimed: number;
  lastClaimAt: Date | null;
  pending: AdPendingDoc | null;
  /** Исполненные `reward_id` (анти-реплей постбэка), от старых к новым. */
  used: AdUsedDoc[];
}

/** Предмет инвентаря. `iid` — наш id, а не Mongo ObjectId: стор абстрактный (memory/mongo). */
interface InventoryItemDoc {
  iid: string;
  kind: string;
  code: string;
  level: number;
  acquiredAt: Date;
  source: string;
  orderId: string | null;
}

/** Работа в очереди стройки. `buildersBusy` выводится отсюда и отдельно не хранится. */
interface BuildJobDoc {
  jid: string;
  code: string;
  kind: string;
  level: number;
  startedAt: Date;
  endsAt: Date;
}

interface LootDoc {
  day: string;
  events: number;
  totalUnits: number;
  lastRaidId: string | null;
}

/** PvP-профиль (Шаг 4). `rating` — единственное поле здесь, по которому идёт поиск соперников. */
interface PvpDoc {
  rating: number;
  day: string;
  attacksToday: number;
  battles: number;
  wins: number;
  draws: number;
  losses: number;
  bestRating: number;
  streak: number;
  lastRaidId: string | null;
  lastBattleAt: Date | null;
}

/** Реферальная связка. `invited` — короткий список: награда одна на человека, история длиннее не нужна. */
interface ReferralDoc {
  invitedBy: string | null;
  creditedAt: Date | null;
  day: string;
  count: number;
  invited: string[];
}

/**
 * Заказ на покупку (Часть 1). `oid` — наш id заказа, а не Mongo ObjectId: стор
 * абстрактный, и memory-драйвер обязан отдавать те же строковые id, что и mongo.
 */
interface OrderDoc {
  oid: string;
  sku: string;
  amount: number;
  priceRub: number;
  status: string;
  createdAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  refundedAt: Date | null;
  providerOrderId: string | null;
  note: string | null;
}

/** Клетка оборонительной сетки. `x`/`y` — целые координаты, проверяет их modules/pvp/defense. */
interface CellDoc {
  x: number;
  y: number;
}

/** Выставленная единица. Только ссылка на предмет: код и тир — в инвентаре, дублировать их здесь значит разойтись с ним. */
interface DeployedUnitDoc {
  iid: string;
  x: number;
  y: number;
}

interface BaseDoc {
  hq: CellDoc;
  walls: CellDoc[];
  units: DeployedUnitDoc[];
  version: number;
  updatedAt: Date;
}

/** Хлам и металлы — взаимозаменяемые единицы, поэтому плоские счётчики, а не массивы. */
type JunkDoc = JunkInventory;
type MetalsDoc = MetalsInventory;

/**
 * Четыре высокотехнологичных материала (config/materials.ts) в документе игрока.
 *
 * Астерий — единственный с парой кошельков: только его покупают за рубли, и только
 * по нему рефанд обязан снимать купленное, не трогая заработанное. Остальные —
 * плоские счётчики. `staniumFieldUntil` хранится сроком, а не флагом: витрина по
 * нему рисует «осталось 12 минут», а рейд-резолвер однозначно отвечает на вопрос,
 * было ли поле замедления активно в момент конкретного боя.
 */
interface MaterialsDoc {
  asterium: AsteriumDoc;
  chronium: number;
  wolfram: number;
  stanium: number;
  staniumFieldUntil: Date | null;
}

/** Документ `users` в Mongo. `_id` — наш строковый id (UUID), генерирует стор. */
export interface UserDoc {
  _id: string;
  platform: Platform;
  socialId: string;
  appId: string | null;
  groupId: string | null;
  createdAt: Date;
  lastLoginAt: Date;
  resources: ResourceWallet;
  storages: StoragePools;
  storageCapacity: number;
  miningRates: StoragePools;
  structures: StructureCounts;
  lastLootTime: Date;
  energyUpdatedAt: Date;
  assist: { day: string; count: number; helpers: string[] };
  buildRobots: number;
  inventory: InventoryItemDoc[];
  builds: BuildJobDoc[];
  /** Планировка обороны (Шаг 3). Вложенная, а не отдельная коллекция — см. комментарий в user.types. */
  base: BaseDoc;
  junk: JunkDoc;
  metals: MetalsDoc;
  loot: LootDoc;
  pvp: PvpDoc;
  referral: ReferralDoc;
  /** Четыре материала: астерий, хрониум, вольфрам, станиум + срок станиумного модуля. */
  materials: MaterialsDoc;
  /**
   * LEGACY: кошелёк донатной валюты в документах, созданных до перехода на четыре
   * материала. Читается при загрузке (materialsFromDoc) и больше НИКОГДА не пишется:
   * `$set` его не содержит, поэтому он постепенно исчезает сам, по мере записи
   * документов. Полнотекстовой скрипт миграции не нужен — и это осознанно: менять
   * чужие деньги скриптом опаснее, чем честно мигрировать на чтении.
   */
  premium?: AsteriumDoc;
  entitlements: EntitlementDoc[];
  ads: AdsDoc;
  /** Заказы на покупку (Часть 1). История ограничена limits.purchases.orderHistory. */
  orders: OrderDoc[];
  /** Клан (Часть 2): строковый id, кэш членства; истина — в документе клана. */
  clanId: string | null;
  revision: number;
}

/**
 * Кошелёк. `sec` помечен `default: 0`, а не `required` без дефолта: документ,
 * созданный до появления ASIC, поля не имеет, и `required: true` без значения по
 * умолчанию заставил бы mongoose валидировать в пустоту. Чтение старого документа
 * добирает поле в `resourcesFromDoc` — схема и чтение обязаны знать об одном и том
 * же, иначе «0» и «нет поля» разъедутся на первом же апгреде без миграции.
 */
const walletSchema = new Schema<ResourceWallet>(
  {
    energy: { type: Number, required: true },
    ferrum: { type: Number, required: true, default: 0 },
    silicium: { type: Number, required: true, default: 0 },
    uranium: { type: Number, required: true, default: 0 },
    plasma: { type: Number, required: true, default: 0 },
    sec: { type: Number, required: true, default: 0, min: 0 }
  },
  { _id: false }
);

/**
 * Накопители: руды + промышленные газы. Строится по `STORAGE_IDS`, а не руками —
 * иначе добавление седьмого ресурса потребует правки в трёх местах, и четвёртое
 * (тип) молча разъедется со схемой.
 */
const storageSchema = new Schema<StoragePools>(
  Object.fromEntries(
    STORAGE_IDS.map((id) => [id, { type: Number, required: true, default: 0, min: 0 }])
  ) as never,
  { _id: false }
);

/**
 * Сооружения — счётчики экземпляров. `min: 0` обязателен: отрицательный реактор в
 * документе означал бы отрицательную генерацию, и веер сети сошёл бы с ума.
 */
const structureSchema = new Schema<StructureCounts>(
  Object.fromEntries(
    STRUCTURE_IDS.map((id) => [id, { type: Number, required: true, default: 0, min: 0 }])
  ) as never,
  { _id: false }
);

const assistSchema = new Schema<UserDoc['assist']>(
  {
    day: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    helpers: { type: [String], default: [] }
  },
  { _id: false }
);

const asteriumSchema = new Schema<AsteriumDoc>(
  {
    purchased: { type: Number, required: true, default: 0 },
    earned: { type: Number, required: true, default: 0 }
  },
  { _id: false }
);

const materialsSchema = new Schema<MaterialsDoc>(
  {
    asterium: { type: asteriumSchema, required: true, default: () => ({ purchased: 0, earned: 0 }) },
    chronium: { type: Number, required: true, default: 0 },
    wolfram: { type: Number, required: true, default: 0 },
    stanium: { type: Number, required: true, default: 0 },
    staniumFieldUntil: { type: Date, default: null }
  },
  { _id: false }
);

const entitlementSchema = new Schema<EntitlementDoc>(
  {
    eid: { type: String, required: true },
    sku: { type: String, required: true },
    kind: { type: String, required: true },
    value: { type: Number, required: true, default: 0 },
    permanent: { type: Boolean, required: true, default: false },
    expiresAt: { type: Date, default: null },
    source: { type: String, required: true },
    grantedAt: { type: Date, required: true },
    orderId: { type: String, default: null }
  },
  { _id: false }
);

const adPendingSchema = new Schema<AdPendingDoc>(
  {
    sid: { type: String, required: true },
    sku: { type: String, required: true },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true }
  },
  { _id: false }
);

const adUsedSchema = new Schema<AdUsedDoc>(
  {
    rid: { type: String, required: true },
    at: { type: Date, required: true }
  },
  { _id: false }
);

const adsSchema = new Schema<AdsDoc>(
  {
    day: { type: String, required: true },
    claimed: { type: Number, required: true, default: 0 },
    lastClaimAt: { type: Date, default: null },
    pending: { type: adPendingSchema, default: null },
    used: { type: [adUsedSchema], default: [] }
  },
  { _id: false }
);

const inventoryItemSchema = new Schema<InventoryItemDoc>(
  {
    iid: { type: String, required: true },
    kind: { type: String, enum: ['tower', 'drone', 'weapon'], required: true },
    code: { type: String, required: true },
    level: { type: Number, required: true, default: 1, min: 1 },
    acquiredAt: { type: Date, required: true },
    source: { type: String, enum: ['build', 'purchase', 'event', 'admin'], required: true, default: 'build' },
    orderId: { type: String, default: null }
  },
  { _id: false }
);

const buildJobSchema = new Schema<BuildJobDoc>(
  {
    jid: { type: String, required: true },
    code: { type: String, required: true },
    kind: { type: String, enum: ['tower', 'drone', 'weapon'], required: true },
    level: { type: Number, required: true, default: 1, min: 1 },
    startedAt: { type: Date, required: true },
    endsAt: { type: Date, required: true }
  },
  { _id: false }
);

const junkSchema = new Schema<JunkDoc>(
  {
    chips: { type: Number, required: true, default: 0 },
    boards: { type: Number, required: true, default: 0 },
    engines: { type: Number, required: true, default: 0 },
    transmissions: { type: Number, required: true, default: 0 },
    batteries: { type: Number, required: true, default: 0 },
    ammo_casings: { type: Number, required: true, default: 0 }
  },
  { _id: false }
);

const metalsSchema = new Schema<MetalsDoc>(
  {
    black_metal: { type: Number, required: true, default: 0 },
    colored_metal: { type: Number, required: true, default: 0 },
    precious_metal: { type: Number, required: true, default: 0 }
  },
  { _id: false }
);

const lootSchema = new Schema<LootDoc>(
  {
    day: { type: String, required: true },
    events: { type: Number, required: true, default: 0 },
    totalUnits: { type: Number, required: true, default: 0 },
    lastRaidId: { type: String, default: null }
  },
  { _id: false }
);

const pvpSchema = new Schema<PvpDoc>(
  {
    rating: { type: Number, required: true, default: PVP_RATING_START, min: PVP_RATING_FLOOR },
    day: { type: String, required: true },
    attacksToday: { type: Number, required: true, default: 0, min: 0 },
    battles: { type: Number, required: true, default: 0, min: 0 },
    wins: { type: Number, required: true, default: 0, min: 0 },
    draws: { type: Number, required: true, default: 0, min: 0 },
    losses: { type: Number, required: true, default: 0, min: 0 },
    bestRating: { type: Number, required: true, default: PVP_RATING_START, min: PVP_RATING_FLOOR },
    streak: { type: Number, required: true, default: 0, min: 0 },
    lastRaidId: { type: String, default: null },
    lastBattleAt: { type: Date, default: null }
  },
  { _id: false }
);

const referralSchema = new Schema<ReferralDoc>(
  {
    invitedBy: { type: String, default: null },
    creditedAt: { type: Date, default: null },
    day: { type: String, required: true },
    count: { type: Number, required: true, default: 0, min: 0 },
    invited: { type: [String], default: [] }
  },
  { _id: false }
);

const orderSchema = new Schema<OrderDoc>(
  {
    oid: { type: String, required: true },
    sku: { type: String, required: true },
    amount: { type: Number, required: true, default: 0, min: 0 },
    priceRub: { type: Number, required: true, default: 0, min: 0 },
    status: { type: String, required: true, enum: ['pending', 'paid', 'fulfilled', 'void', 'refunded'] },
    createdAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    paidAt: { type: Date, default: null },
    fulfilledAt: { type: Date, default: null },
    refundedAt: { type: Date, default: null },
    providerOrderId: { type: String, default: null },
    note: { type: String, default: null }
  },
  { _id: false }
);

const cellSchema = new Schema<CellDoc>(
  {
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const deployedUnitSchema = new Schema<DeployedUnitDoc>(
  {
    iid: { type: String, required: true },
    x: { type: Number, required: true, min: 0 },
    y: { type: Number, required: true, min: 0 }
  },
  { _id: false }
);

const baseSchema = new Schema<BaseDoc>(
  {
    hq: { type: cellSchema, required: true },
    walls: { type: [cellSchema], default: [] },
    units: { type: [deployedUnitSchema], default: [] },
    version: { type: Number, required: true, default: 0, min: 0 },
    updatedAt: { type: Date, required: true }
  },
  { _id: false }
);

export const userSchema = new Schema<UserDoc>(
  {
    _id: { type: String, required: true },
    platform: { type: String, enum: ['vk', 'tg'], required: true },
    socialId: { type: String, required: true },
    appId: { type: String, default: null },
    groupId: { type: String, default: null },
    createdAt: { type: Date, required: true },
    lastLoginAt: { type: Date, required: true },
    resources: { type: walletSchema, required: true },
    storages: { type: storageSchema, required: true, default: () => ({}) },
    storageCapacity: { type: Number, required: true },
    miningRates: { type: storageSchema, required: true, default: () => ({}) },
    structures: { type: structureSchema, required: true, default: () => ({}) },
    lastLootTime: { type: Date, required: true },
    energyUpdatedAt: { type: Date, required: true },
    assist: { type: assistSchema, required: true },
    buildRobots: { type: Number, required: true, default: 2 },
    inventory: { type: [inventoryItemSchema], default: [] },
    builds: { type: [buildJobSchema], default: [] },
    base: {
      type: baseSchema,
      required: true,
      default: () => ({ hq: { ...DEFAULT_HQ }, walls: [], units: [], version: 0, updatedAt: new Date() })
    },
    junk: { type: junkSchema, required: true, default: () => emptyJunk() },
    metals: { type: metalsSchema, required: true, default: () => emptyMetals() },
    loot: { type: lootSchema, required: true, default: () => ({ day: '1970-01-01', events: 0, totalUnits: 0, lastRaidId: null }) },
    pvp: {
      type: pvpSchema,
      required: true,
      default: () => ({
        rating: PVP_RATING_START,
        day: '1970-01-01',
        attacksToday: 0,
        battles: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        bestRating: PVP_RATING_START,
        streak: 0,
        lastRaidId: null,
        lastBattleAt: null
      })
    },
    referral: {
      type: referralSchema,
      required: true,
      default: () => ({ invitedBy: null, creditedAt: null, day: '1970-01-01', count: 0, invited: [] })
    },
    materials: {
      type: materialsSchema,
      required: true,
      default: () => ({
        asterium: { purchased: 0, earned: 0 },
        chronium: 0,
        wolfram: 0,
        stanium: 0,
        staniumFieldUntil: null
      })
    },
    entitlements: { type: [entitlementSchema], default: [] },
    ads: { type: adsSchema, required: true, default: () => ({ day: '1970-01-01', claimed: 0, lastClaimAt: null, pending: null, used: [] }) },
    orders: { type: [orderSchema], default: [] },
    clanId: { type: String, default: null },
    revision: { type: Number, required: true, default: 0 }
  },
  { collection: 'users', versionKey: false }
);

// Главный инвариант онбординга: один человек = один аккаунт на платформу.
userSchema.index({ platform: 1, socialId: 1 }, { unique: true, name: 'uniq_platform_social' });
// Под выборки «у кого склады полны» (будущий воркер push-уведомлений, Шаг 6).
userSchema.index({ lastLootTime: 1 }, { name: 'idx_last_loot' });

/**
 * Матчмейкинг (Шаг 4): «соперники платформы X с рейтингом в коридоре [a, b]».
 *
 * Индекс обязателен по той же причине, по которой `uniq_platform_social` обязателен для
 * онбординга: без него поиск соперника — COLLECTION SCAN по всей коллекции, то есть
 * самая дорогая операция в игре, запускаемая несколько раз на рейд (коридор расширяют
 * до пяти попыток). Префикс `platform` держим первым: пулы VK и TG не смешиваются,
 * а направление сортировки роли не играет — выборка внутри коридора случайная.
 */
userSchema.index({ platform: 1, 'pvp.rating': 1 }, { name: 'idx_platform_rating' });

/**
 * «Показать клан игрока» и разбор членства (Часть 2): выборка по одному полю, без
 * скана коллекции. Индекс не уникальный: в клане обязаны быть десятки участников.
 */
userSchema.index({ clanId: 1 }, { name: 'idx_clan' });

function entitlementFromDoc(doc: EntitlementDoc): Entitlement {
  return {
    id: doc.eid,
    sku: doc.sku,
    kind: doc.kind as Entitlement['kind'],
    value: doc.value,
    permanent: doc.permanent,
    expiresAt: doc.expiresAt ? new Date(doc.expiresAt) : null,
    source: doc.source as Entitlement['source'],
    grantedAt: new Date(doc.grantedAt),
    orderId: doc.orderId ?? null
  };
}

function entitlementToDoc(entitlement: Entitlement): EntitlementDoc {
  return {
    eid: entitlement.id,
    sku: entitlement.sku,
    kind: entitlement.kind,
    value: entitlement.value,
    permanent: entitlement.permanent,
    expiresAt: entitlement.expiresAt,
    source: entitlement.source,
    grantedAt: entitlement.grantedAt,
    orderId: entitlement.orderId
  };
}

function adsFromDoc(doc: AdsDoc | undefined): AdState {
  return {
    day: doc?.day ?? '1970-01-01',
    claimed: doc?.claimed ?? 0,
    lastClaimAt: doc?.lastClaimAt ? new Date(doc.lastClaimAt) : null,
    pending: doc?.pending
      ? {
          id: doc.pending.sid,
          sku: doc.pending.sku,
          createdAt: new Date(doc.pending.createdAt),
          expiresAt: new Date(doc.pending.expiresAt)
        }
      : null,
    // Legacy-документы без памяти реплея читаются как «ничего не помним», а не как
    // падение схемы: поле появилось позже Части 1.5, и живые игроки его не имеют.
    used: (doc?.used ?? []).map((used) => ({ id: used.rid, at: new Date(used.at) }))
  };
}

function adsToDoc(state: AdState): AdsDoc {
  return {
    day: state.day,
    claimed: state.claimed,
    lastClaimAt: state.lastClaimAt,
    pending: state.pending
      ? {
          sid: state.pending.id,
          sku: state.pending.sku,
          createdAt: state.pending.createdAt,
          expiresAt: state.pending.expiresAt
        }
      : null,
    used: state.used.map((used) => ({ rid: used.id, at: used.at }))
  };
}

function itemFromDoc(doc: InventoryItemDoc): InventoryItem {
  return {
    id: doc.iid,
    kind: doc.kind as InventoryItem['kind'],
    code: doc.code,
    level: doc.level,
    acquiredAt: new Date(doc.acquiredAt),
    source: doc.source as InventoryItem['source'],
    orderId: doc.orderId ?? null
  };
}

function itemToDoc(item: InventoryItem): InventoryItemDoc {
  return {
    iid: item.id,
    kind: item.kind,
    code: item.code,
    level: item.level,
    acquiredAt: item.acquiredAt,
    source: item.source,
    orderId: item.orderId
  };
}

function jobFromDoc(doc: BuildJobDoc): BuildJob {
  return {
    id: doc.jid,
    code: doc.code,
    kind: doc.kind as BuildJob['kind'],
    level: doc.level,
    startedAt: new Date(doc.startedAt),
    endsAt: new Date(doc.endsAt)
  };
}

function jobToDoc(job: BuildJob): BuildJobDoc {
  return {
    jid: job.id,
    code: job.code,
    kind: job.kind,
    level: job.level,
    startedAt: job.startedAt,
    endsAt: job.endsAt
  };
}

function baseFromDoc(doc: BaseDoc | undefined, fallbackAt: Date): BaseState {
  if (!doc) return emptyBase(fallbackAt);
  return {
    hq: { x: doc.hq?.x ?? DEFAULT_HQ.x, y: doc.hq?.y ?? DEFAULT_HQ.y },
    walls: (doc.walls ?? []).map((cell) => ({ x: cell.x, y: cell.y })),
    units: (doc.units ?? []).map((unit) => ({ itemId: unit.iid, x: unit.x, y: unit.y })),
    version: doc.version ?? 0,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt) : fallbackAt
  };
}

function baseToDoc(base: BaseState): BaseDoc {
  return {
    hq: { x: base.hq.x, y: base.hq.y },
    walls: base.walls.map((cell) => ({ x: cell.x, y: cell.y })),
    units: base.units.map((unit) => ({ iid: unit.itemId, x: unit.x, y: unit.y })),
    version: base.version,
    updatedAt: base.updatedAt
  };
}

function lootFromDoc(doc: LootDoc | undefined): LootState {
  return {
    day: doc?.day ?? '1970-01-01',
    events: doc?.events ?? 0,
    totalUnits: doc?.totalUnits ?? 0,
    lastRaidId: doc?.lastRaidId ?? null
  };
}

/**
 * PvP-профиль из документа.
 *
 * Миграция по чтению, а не скриптом: документы, созданные до Шага 4, поля `pvp` не
 * имеют, и выдавать за них null означало бы ветку «рейтинга нет» в матчмейкинге,
 * в витрине и в резолвере боя. Стартовый рейтинг + нули — ровно то состояние, в котором
 * игрок и так был бы до первого боя.
 */
function pvpFromDoc(doc: PvpDoc | undefined, fallbackDay: string): PvpProfile {
  const rating = doc?.rating ?? PVP_RATING_START;
  return {
    rating,
    day: doc?.day ?? fallbackDay,
    attacksToday: doc?.attacksToday ?? 0,
    battles: doc?.battles ?? 0,
    wins: doc?.wins ?? 0,
    draws: doc?.draws ?? 0,
    losses: doc?.losses ?? 0,
    // bestRating старше профиля не имеет: считаем текущий, а не 0, иначе витрина
    // достижений показала бы «лучший рейтинг 0» у игрока с 1500.
    bestRating: Math.max(rating, doc?.bestRating ?? rating),
    streak: doc?.streak ?? 0,
    lastRaidId: doc?.lastRaidId ?? null,
    lastBattleAt: doc?.lastBattleAt ? new Date(doc.lastBattleAt) : null
  };
}

/** Ключ суток UTC по дате документа — fallback-день для миграции по чтению (Шаг 4). */
function docDay(value: Date | string | undefined | null): string {
  if (!value) return '1970-01-01';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '1970-01-01' : date.toISOString().slice(0, 10);
}

function referralFromDoc(doc: ReferralDoc | undefined, fallbackDay: string): ReferralState {  return {
    invitedBy: doc?.invitedBy ?? null,
    creditedAt: doc?.creditedAt ? new Date(doc.creditedAt) : null,
    day: doc?.day ?? fallbackDay,
    count: doc?.count ?? 0,
    invited: [...(doc?.invited ?? [])]
  };
}

/**
 * Миграция по чтению для четырёх материалов.
 *
 * Документы, созданные до перехода с единой донатной валюты, секции `materials` не
 * имеют вовсе, а её астерий лежит в legacy-поле `premium`. Читаем оба и пишем всегда
 * новый формат — так старый документ «мигрируется» первым же своим сохранением, без
 * скрипта по коллекции и без риска задвоить/потерять деньги на половине прогона.
 */
function materialsFromDoc(doc: UserDoc): MaterialsState {
  const current = doc.materials;
  const legacy = doc.premium;
  const asterium = current?.asterium ?? legacy;
  return {
    asterium: { purchased: asterium?.purchased ?? 0, earned: asterium?.earned ?? 0 },
    chronium: current?.chronium ?? 0,
    wolfram: current?.wolfram ?? 0,
    stanium: current?.stanium ?? 0,
    staniumFieldUntil: current?.staniumFieldUntil ? new Date(current.staniumFieldUntil) : null
  };
}

function orderFromDoc(doc: OrderDoc): PurchaseOrder {
  return {
    id: doc.oid,
    sku: doc.sku,
    amount: doc.amount,
    priceRub: doc.priceRub,
    status: doc.status as PurchaseOrder['status'],
    createdAt: new Date(doc.createdAt),
    expiresAt: new Date(doc.expiresAt),
    paidAt: doc.paidAt ? new Date(doc.paidAt) : null,
    fulfilledAt: doc.fulfilledAt ? new Date(doc.fulfilledAt) : null,
    refundedAt: doc.refundedAt ? new Date(doc.refundedAt) : null,
    providerOrderId: doc.providerOrderId ?? null,
    note: doc.note ?? null
  };
}

function orderToDoc(order: PurchaseOrder): OrderDoc {
  return {
    oid: order.id,
    sku: order.sku,
    amount: order.amount,
    priceRub: order.priceRub,
    status: order.status,
    createdAt: order.createdAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt ?? null,
    fulfilledAt: order.fulfilledAt ?? null,
    refundedAt: order.refundedAt ?? null,
    providerOrderId: order.providerOrderId ?? null,
    note: order.note ?? null
  };
}

export function toAccount(doc: UserDoc): UserAccount {
  return {
    id: String(doc._id),
    platform: doc.platform,
    socialId: doc.socialId,
    appId: doc.appId ?? null,
    groupId: doc.groupId ?? null,
    createdAt: new Date(doc.createdAt),
    lastLoginAt: new Date(doc.lastLoginAt),
    // Миграция по чтению: `sec` добавлен вместе с промышленным контуром, и документы
    // старше его поля не имеют. Spread одного `doc.resources` не покрывает такой случай
    // (в старом документе ключа просто нет → в новом аккаунте было бы `undefined`, а
    // `undefined` в арифметике тика даёт `NaN`, который уехал бы в журнал как сумма).
    resources: { ...doc.resources, sec: doc.resources?.sec ?? 0 },
    // Миграция по чтению: документы до промышленного контура хранят запасы под именем
    // `mined` и содержат только четыре руды. Приведение здесь, а не в домене — тот же
    // приём, что для `base`/`pvp` ниже: читатель тика не должен знать про три исторические
    // формы документа.
    storages: normalizeStorages(doc.storages ?? (doc as unknown as { mined?: unknown }).mined),
    storageCapacity: doc.storageCapacity,
    miningRates: normalizeStorages(doc.miningRates),
    structures: normalizeStructures(doc.structures),
    lastLootTime: new Date(doc.lastLootTime),
    energyUpdatedAt: new Date(doc.energyUpdatedAt),
    assist: { day: doc.assist.day, count: doc.assist.count, helpers: [...(doc.assist.helpers ?? [])] },
    buildRobots: doc.buildRobots,
    // `?? []` и spread над emptyJunk() — миграция по чтению: документы, созданные до
    // Шага 1.6, этих полей не имеют, и перечитывать всю коллекцию ради этого незачем.
    inventory: (doc.inventory ?? []).map(itemFromDoc),
    builds: (doc.builds ?? []).map(jobFromDoc),
    base: baseFromDoc(doc.base, new Date(doc.createdAt)),
    junk: { ...emptyJunk(), ...(doc.junk ?? {}) },
    metals: { ...emptyMetals(), ...(doc.metals ?? {}) },
    loot: lootFromDoc(doc.loot),
    pvp: pvpFromDoc(doc.pvp, docDay(doc.createdAt)),
    referral: referralFromDoc(doc.referral, docDay(doc.createdAt)),
    materials: materialsFromDoc(doc),
    entitlements: (doc.entitlements ?? []).map(entitlementFromDoc),
    ads: adsFromDoc(doc.ads),
    orders: (doc.orders ?? []).map(orderFromDoc),
    clanId: doc.clanId ?? null,
    revision: doc.revision
  };
}

/** Поля для `$set` (без `_id`). */
export function toSetPayload(account: UserAccount): Omit<UserDoc, '_id'> {
  return {
    platform: account.platform,
    socialId: account.socialId,
    appId: account.appId,
    groupId: account.groupId,
    createdAt: account.createdAt,
    lastLoginAt: account.lastLoginAt,
    resources: { ...account.resources },
    storages: { ...account.storages },
    storageCapacity: account.storageCapacity,
    miningRates: { ...account.miningRates },
    structures: { ...account.structures },
    lastLootTime: account.lastLootTime,
    energyUpdatedAt: account.energyUpdatedAt,
    assist: { ...account.assist, helpers: [...account.assist.helpers] },
    buildRobots: account.buildRobots,
    inventory: account.inventory.map(itemToDoc),
    builds: account.builds.map(jobToDoc),
    base: baseToDoc(account.base),
    junk: { ...account.junk },
    metals: { ...account.metals },
    loot: { ...account.loot },
    pvp: { ...account.pvp },
    referral: { ...account.referral, invited: [...account.referral.invited] },
    materials: {
      asterium: { ...account.materials.asterium },
      chronium: account.materials.chronium,
      wolfram: account.materials.wolfram,
      stanium: account.materials.stanium,
      staniumFieldUntil: account.materials.staniumFieldUntil
    },
    entitlements: account.entitlements.map(entitlementToDoc),
    ads: adsToDoc(account.ads),
    orders: account.orders.map(orderToDoc),
    clanId: account.clanId,
    revision: account.revision
  };
}

export type UserModel = Model<UserDoc>;

export function createUserModel(connection: Connection): UserModel {
  return connection.model<UserDoc>('User', userSchema);
}
