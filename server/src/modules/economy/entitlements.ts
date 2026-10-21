import { STORAGE_IDS, type StorageId } from '../../config/storage.js';
import { miningBonus, storageBonus } from '../../config/structures.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import {
  emptyStorages,
  type Entitlement,
  type EntitlementKind,
  type EntitlementSource,
  type StoragePools,
  type UserAccount
} from '../user/user.types.js';

/**
 * Привилегии игрока: то, за что он платит деньгами или временем (просмотром рекламы).
 * Чистые функции — домен не знает ни про Mongo, ни про VK Pay.
 */

/** Потолок суммарного множителя: защита от «буста буста» в экономическом балансе. */
export const MAX_STACK_MULTIPLIER = 8;

export interface EntitlementEffects {
  /** Сколько дополнительных роботов-строителей дали привилегии. */
  extraBuilders: number;
  warehouseMultiplier: number;
  mineMultiplier: number;
  energyRegenMultiplier: number;
  /** До какого момента база неуязвима для рейдов (null — щита нет). */
  shieldUntil: Date | null;
  activeCount: number;
}

export function isEntitlementActive(entitlement: Entitlement, now: Date): boolean {
  if (entitlement.permanent) return true;
  return entitlement.expiresAt !== null && entitlement.expiresAt.getTime() > now.getTime();
}

export function activeEntitlements(account: UserAccount, now: Date): Entitlement[] {
  return account.entitlements.filter((entitlement) => isEntitlementActive(entitlement, now));
}

/**
 * Однотипные множители СКЛАДЫВАЮТСЯ (1 + Σ(x−1)), а не перемножаются: два буста x2
 * дают x3, а не x4. Иначе продакшн-баланс ломается за неделю акционных паков.
 */
function stack(values: number[]): number {
  const total = values.reduce((acc, value) => acc + (value - 1), 1);
  return Math.round(Math.min(MAX_STACK_MULTIPLIER, Math.max(0, total)) * 1e6) / 1e6;
}

export function resolveEntitlements(account: UserAccount, now: Date): EntitlementEffects {
  const active = activeEntitlements(account, now);
  const warehouse: number[] = [];
  const mine: number[] = [];
  const energy: number[] = [];
  let extraBuilders = 0;
  let shieldUntil: Date | null = null;

  for (const entitlement of active) {
    switch (entitlement.kind) {
      case 'builder_slot':
        extraBuilders += Math.trunc(entitlement.value);
        break;
      case 'warehouse_boost':
        warehouse.push(entitlement.value);
        break;
      case 'mine_boost':
        mine.push(entitlement.value);
        break;
      case 'energy_boost':
        energy.push(entitlement.value);
        break;
      case 'shield':
        if (entitlement.expiresAt && (!shieldUntil || entitlement.expiresAt > shieldUntil)) {
          shieldUntil = entitlement.expiresAt;
        }
        break;
    }
  }

  return {
    extraBuilders,
    warehouseMultiplier: stack(warehouse),
    mineMultiplier: stack(mine),
    energyRegenMultiplier: stack(energy),
    shieldUntil,
    activeCount: active.length
  };
}

/**
 * БАЗОВАЯ ёмкость склада, ед. — без учёта построек.
 *
 * Сохранена отдельной функцией именно как «базовая»: старый контракт (одно число на
 * все ресурсы, умноженное на буст) используется в витрине и в тестах баланса, и
 * подмешивать в неё ёмкость цистерн — значит сделать нечитаемым вопрос «сколько даёт
 * купленный буст складов». Ответ на него должен оставаться одним числом.
 */
export function effectiveStorageCapacity(
  account: UserAccount,
  now: Date,
  effects = resolveEntitlements(account, now)
): number {
  return Math.floor(account.storageCapacity * effects.warehouseMultiplier);
}

/**
 * Полная ёмкость КОНКРЕТНОГО накопителя: базовый склад × буст + построенные ёмкости.
 *
 * Порядок важен: множитель буста применяется только к базовой части, а не к силосам и
 * газгольдерам. Иначе купленный «Склады ×2» удваивал бы капитальные постройки, и
 * игрок мог бы купить себе бесконечный газгольдер — продажа, которую нельзя ни
 * сбалансировать, ни отозвать.
 */
export function storageCapacityFor(
  account: UserAccount,
  resource: StorageId,
  now: Date,
  effects = resolveEntitlements(account, now)
): number {
  return effectiveStorageCapacity(account, now, effects) + (storageBonus(account.structures)[resource] ?? 0);
}

/** Ёмкости всех накопителей одним снимком — для витрины и тика. */
export function storageCapacities(
  account: UserAccount,
  now: Date,
  effects = resolveEntitlements(account, now)
): Record<StorageId, number> {
  const base = effectiveStorageCapacity(account, now, effects);
  const bonus = storageBonus(account.structures);
  const result = {} as Record<StorageId, number>;
  for (const resource of STORAGE_IDS) result[resource] = base + (bonus[resource] ?? 0);
  return result;
}

export function effectiveBuildRobots(
  account: UserAccount,
  now: Date,
  effects = resolveEntitlements(account, now)
): number {
  return account.buildRobots + effects.extraBuilders;
}

export function effectiveMiningRates(
  account: UserAccount,
  now: Date,
  effects = resolveEntitlements(account, now)
): StoragePools {
  const rates = emptyStorages();
  // Граница та же, что у ёмкостей в `storageCapacities`: множитель привилегии
  // касается БАЗОВОЙ ставки, а буры добавляются сверх неё. Иначе купленный
  // «Добыча ×2» молча удваивал бы доходность станков, построенных однажды, и
  // долгосрочное вложение в завод зависело бы от срока акции.
  const bonus = miningBonus(account.structures);
  for (const resource of STORAGE_IDS) {
    rates[resource] = (account.miningRates[resource] ?? 0) * effects.mineMultiplier + (bonus[resource] ?? 0);
  }
  return rates;
}

export function effectiveEnergyRegenPerHour(account: UserAccount, now: Date, base: number): number {
  return base * resolveEntitlements(account, now).energyRegenMultiplier;
}

/** «Щит покоя»: используется в рейд-логике (Шаг 4) как безусловный отказ. */
export function isShielded(account: UserAccount, now: Date): boolean {
  return resolveEntitlements(account, now).shieldUntil !== null;
}


export interface NewEntitlement {
  sku: string;
  kind: EntitlementKind;
  /** Слоты — целое >= 1; множители — > 1; щит — 0 (важен срок). */
  value: number;
  source: EntitlementSource;
  /** null => бессрочно. */
  durationMs: number | null;
  orderId?: string | null;
}

export interface GrantOptions {
  idFactory: () => string;
  /** Потолок активных привилегий в документе игрока (LimitsConfig.purchases). */
  maxActive: number;
}

/**
 * Выдаёт привилегию. Идемпотентность по orderId: повторный вебхук провайдера
 * не создаст второй слот/второй щит.
 */
export function grantEntitlement(
  account: UserAccount,
  input: NewEntitlement,
  now: Date,
  options: GrantOptions
): UserAccount {
  const orderId = input.orderId ?? null;
  if (orderId && account.entitlements.some((entitlement) => entitlement.orderId === orderId)) {
    return account;
  }
  if (options.maxActive > 0 && activeEntitlements(account, now).length >= options.maxActive) {
    throw new AppError(ErrorCodes.ENTITLEMENT_LIMIT, 409, 'Достигнут предел активных усилений', {
      maxActive: options.maxActive
    });
  }

  const entitlement: Entitlement = {
    id: options.idFactory(),
    sku: input.sku,
    kind: input.kind,
    value: input.value,
    permanent: input.durationMs === null,
    expiresAt: input.durationMs === null ? null : new Date(now.getTime() + input.durationMs),
    source: input.source,
    grantedAt: now,
    orderId
  };

  return { ...account, entitlements: [...account.entitlements, entitlement] };
}

/** Отзыв привилегий по заказу — половина механизма возврата платежа (refund). */
export function revokeEntitlementsByOrder(account: UserAccount, orderId: string): UserAccount {
  return {
    ...account,
    entitlements: account.entitlements.filter((entitlement) => entitlement.orderId !== orderId)
  };
}

/** Удаляет протухшие (бессрочные не трогает). Вызывается из экономического тика. */
export function pruneExpiredEntitlements(account: UserAccount, now: Date): UserAccount {
  const kept = account.entitlements.filter((entitlement) => isEntitlementActive(entitlement, now));
  if (kept.length === account.entitlements.length) return account;
  return { ...account, entitlements: kept };
}
