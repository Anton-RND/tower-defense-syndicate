import { loadConfig, type AppConfig } from '../src/config/env.js';
import { getBlueprint, type JunkInventory, type MetalsInventory } from '../src/config/workshop.js';
import type { InventoryItem, PvpProfile, ReferralState, ResourceWallet, StoragePools, StructureCounts } from '../src/modules/user/user.types.js';
import type { TechWallet } from '../src/config/materials.js';
import { createAccount, type Entitlement, type UserAccount } from '../src/modules/user/user.types.js';

/**
 * Фикстуры тестов экономики. Конфиг всегда собирается через loadConfig с явным
 * окружением — так тесты проверяют тот же путь валидации, что и продакшн.
 */

export const T0 = new Date('2026-10-18T00:00:00.000Z');
export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export function addMs(date: Date, ms: number): Date {
  return new Date(date.getTime() + ms);
}

let seq = 0;
export function nextId(prefix = 'id'): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

export function testConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({ NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv);
}

export function newAccount(config: AppConfig, now: Date = T0, socialId = '42'): UserAccount {
  return createAccount({ platform: 'vk', socialId, appId: null, groupId: null }, now, config.economy, () =>
    nextId('user')
  );
}

/** Ручная сборка привилегии (для тестов истечения срока, где grantEntitlement уже недостаточен). */
export function entitlement(input: Partial<Entitlement> & Pick<Entitlement, 'kind'>): Entitlement {
  const base: Entitlement = {
    id: nextId('ent'),
    sku: input.kind,
    kind: input.kind,
    value: 1,
    permanent: false,
    expiresAt: null,
    source: 'purchase',
    grantedAt: T0,
    orderId: null
  };
  return { ...base, ...input };
}

// ─── Фикстуры PvP (Шаг 4) ─────────────────────────────────────────────────────

export function withPvp(account: UserAccount, patch: Partial<PvpProfile>): UserAccount {
  return { ...account, pvp: { ...account.pvp, ...patch } };
}

export function withReferral(account: UserAccount, patch: Partial<ReferralState>): UserAccount {
  return { ...account, referral: { ...account.referral, ...patch } };
}

/** Несобранные склады: именно их выносит победитель рейда (п.4.1). */
export function withStorages(account: UserAccount, patch: Partial<StoragePools>): UserAccount {
  return { ...account, storages: { ...account.storages, ...patch } };
}

/** Прежнее имя хелпера до объединения `mined` → `storages`. */
export const withMined = withStorages;

/** Постройки на базе: реакторы, кулеры, цехи, ASIC, цистерны. */
export function withStructures(account: UserAccount, patch: Partial<StructureCounts>): UserAccount {
  return { ...account, structures: { ...account.structures, ...patch } };
}

export function withInventory(account: UserAccount, items: InventoryItem[]): UserAccount {
  return { ...account, inventory: items };
}

let itemSeq = 0;
/** Предмет инвентаря: вид и тир берутся из каталога чертежей, поэтому указан только код. */
export function itemOf(code: string, level = 1): InventoryItem {
  const blueprint = getBlueprint(code);
  if (!blueprint) throw new Error(`фикстура: неизвестный код чертежа ${code}`);
  itemSeq += 1;
  return {
    id: `item-${itemSeq}`,
    kind: blueprint.kind,
    code,
    level,
    acquiredAt: T0,
    source: 'build',
    orderId: null
  };
}

// ─── Фикстуры мастерской и лута ───────────────────────────────────────────────

export function withResources(account: UserAccount, patch: Partial<ResourceWallet>): UserAccount {
  return { ...account, resources: { ...account.resources, ...patch } };
}

export function withJunk(account: UserAccount, patch: Partial<JunkInventory>): UserAccount {
  return { ...account, junk: { ...account.junk, ...patch } };
}

export function withMetals(account: UserAccount, patch: Partial<MetalsInventory>): UserAccount {
  return { ...account, metals: { ...account.metals, ...patch } };
}

export function withAsterium(account: UserAccount, purchased: number, earned: number): UserAccount {
  return { ...account, materials: { ...account.materials, asterium: { purchased, earned } } };
}

/**
 * Ручная выдача сырья (хрониум, вольфрам, станиум).
 *
 * Partial<TechWallet>, а не (id, amount): тесту чаще всего нужно сразу три счётчика,
 * и три вызова отсюда легко разъехались бы с реальностью, где крафт платит пачкой.
 */
export function withTech(account: UserAccount, patch: Partial<TechWallet>): UserAccount {
  return { ...account, materials: { ...account.materials, ...patch } };
}

/** Включение станиумного поля базы на срок до `until` (null — выключено). */
export function withStaniumField(account: UserAccount, until: Date | null): UserAccount {
  return { ...account, materials: { ...account.materials, staniumFieldUntil: until } };
}

/**
 * Детерминированный ГСЧ для тестов дропов: отдаёт значения по порядку, затем
 * последнее. Так таблица хлама и боевой лут проверяются без подкрутки баланса.
 */
export function fixedRng(...values: number[]): () => number {
  let index = 0;
  const last = values.length > 0 ? (values[values.length - 1] as number) : 0;
  return () => {
    if (index >= values.length) return last;
    const value = values[index] as number;
    index += 1;
    return value;
  };
}

/** Код AppError из брошенного значения (или метка «не бросило»). */
export function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    const candidate = error as { code?: string };
    return candidate.code ?? `unexpected:${String(error)}`;
  }
}