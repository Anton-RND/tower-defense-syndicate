import { ORE_IDS, type StorageId } from '../../config/storage.js';
import type { EconomyConfig } from '../../config/env.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import {
  effectiveMiningRates,
  resolveEntitlements,
  storageCapacities,
  type EntitlementEffects
} from './entitlements.js';
import { credit, resource as walletResource } from './wallet.js';
import { emptyStorages, type StoragePools, type UserAccount } from '../user/user.types.js';

export const HOUR_MS = 3_600_000;

/**
 * Офлайн-псевдомайнинг (п.2.1–2.2).
 *
 * Модель: у каждого ресурса свой экстрактор (X ед/час) и свой склад (ёмкость Y).
 * Склад заполняется до Y и добыча «встаёт» — сервер при этом знает момент
 * заполнения и по нему шлёт push («Склады полны! Заберите ресурсы…»).
 *
 * Все функции чистые: вход — состояние игрока + «сейчас», выход — новое состояние.
 * Это даёт тривиальные юнит-тесты и переиспользование в веб-сокете/коне (Шаг 6).
 *
 * Ёмкость теперь РАЗНАЯ по ресурсам (базовый склад + построенные силосы/газгольдеры/
 * крио-цистерны), поэтому тик не может больше опираться на одно число `capacity`:
 * переполнение азота и переполнение железа — разные события с разными последствиями.
 */
export interface MiningTickResult {
  /** Новое содержимое накопителей (дробное). */
  storages: StoragePools;
  /** Сколько начислено за этот шаг. */
  gained: StoragePools;
  /** Ресурсы, чей склад упёрся в ёмкость (добыча остановлена). */
  full: StorageId[];
  /** Когда каждый склад заполнится полностью (null — бесконечно/ставка 0). */
  nextFillAt: Partial<Record<StorageId, Date | null>>;
  /** Ближайший момент, когда хоть один склад станет полным — триггер push. */
  storageFullAt: Date | null;
  /** Учтённое время (мс) с учётом MAX_OFFLINE_HOURS. */
  countedMs: number;
  /** Сколько времени отрезали лимитом офлайна (мс). */
  truncatedMs: number;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function computeMiningTick(account: UserAccount, now: Date, config: EconomyConfig): MiningTickResult {
  const elapsedMs = Math.max(0, now.getTime() - account.lastLootTime.getTime());
  const maxMs = config.maxOfflineHours * HOUR_MS;
  const countedMs = Math.min(elapsedMs, maxMs);
  const hours = countedMs / HOUR_MS;
  // Ёмкость склада и ставки добычи — с учётом купленных/выигранных бустов.
  const effects: EntitlementEffects = resolveEntitlements(account, now);
  const capacities = storageCapacities(account, now, effects);
  const rates = effectiveMiningRates(account, now, effects);

  const storages = emptyStorages();
  const gained = emptyStorages();
  const nextFillAt: Partial<Record<StorageId, Date | null>> = {};
  const full: StorageId[] = [];

  // Копируем нетронутые остатки (газы промышленность двигает своим тиком).
  for (const resource of Object.keys(account.storages) as StorageId[]) {
    storages[resource] = account.storages[resource] ?? 0;
  }

  for (const resource of ORE_IDS) {
    const rate = rates[resource] ?? 0;
    const capacity = capacities[resource] ?? 0;
    const before = account.storages[resource] ?? 0;
    const raw = before + rate * hours;
    const value = Math.min(raw, capacity);

    storages[resource] = round6(value);
    gained[resource] = round6(value - before);

    if (value >= capacity) {
      full.push(resource);
      nextFillAt[resource] = now;
    } else if (rate > 0) {
      nextFillAt[resource] = new Date(now.getTime() + ((capacity - value) / rate) * HOUR_MS);
    } else {
      nextFillAt[resource] = null;
    }
  }

  const timestamps = Object.values(nextFillAt)
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime())
    .sort((a, b) => a - b);

  return {
    storages,
    gained,
    full,
    nextFillAt,
    storageFullAt: timestamps.length > 0 ? new Date(timestamps[0] as number) : null,
    countedMs,
    truncatedMs: Math.max(0, elapsedMs - countedMs)
  };
}

/** Начисляет добытое и сдвигает `lastLootTime`. Идемпотентно: повторный зов в тот же момент = 0. */
export function applyMiningTick(account: UserAccount, now: Date, config: EconomyConfig): UserAccount {
  const tick = computeMiningTick(account, now, config);
  return {
    ...account,
    storages: tick.storages,
    lastLootTime: now
  };
}

export interface CollectResult {
  account: UserAccount;
  /** Движения накопителя в кошелёк — по одному на каждый ресурс с целой частью (reason = 'collect'). */
  drafts: LedgerDraft[];
  /** Целые единицы, перенесённые на склад в кошелёк. */
  collected: StoragePools;
  /** Остаток дробей в накопителях (не сгорает). */
  storages: StoragePools;
}

/**
 * Ручной сбор с рудных складов (п.2.1: «хранятся до ручного сбора»).
 * Обязательное предварительное условие: тик майнинга уже применён (см. applyMiningTick).
 *
 * Собираются ТОЛЬКО руды. Дейтерий и азот в кошелёк не переезжают: это не товар, а
 * рабочая жидкость промышленности, она расходуется автоматически. Разрешить их ручной
 * сбор — значит дать игроку возможность обнулить себе охлаждение реакторов по ошибке.
 */
export function collectWarehouse(account: UserAccount, now: Date): CollectResult {
  const collected = emptyStorages();
  const storages = { ...account.storages };

  for (const resource of ORE_IDS) {
    const stored = account.storages[resource] ?? 0;
    const whole = Math.floor(stored);
    collected[resource] = whole;
    storages[resource] = round6(stored - whole);
  }

  // Ключ по моменту сбора и валюте: повторный клик не задвоит ресурсы в журнале,
  // а разные ресурсы одного сбора не будут считаться дублями друг друга.
  const collectKey = (currency: string, ts: number): string => makeIdempotencyKey('collect', `${account.id}:${ts}:${currency}`);
  let next: UserAccount = { ...account, storages };
  const drafts: LedgerDraft[] = [];

  for (const resource of ORE_IDS) {
    const whole = collected[resource];
    if (whole <= 0) continue;
    const movement = credit(next, walletResource(resource), whole, {
      ts: now,
      reason: 'collect',
      idempotencyKey: collectKey(resource, now.getTime()),
      meta: { warehouse: true }
    });
    next = movement.account;
    drafts.push(movement.draft);
  }

  return {
    account: { ...next, storages, lastLootTime: now },
    drafts,
    collected,
    storages
  };
}

/**
 * Прикидка «что достанется нападающему» (п.4.1: до 30% несобранных ресурсов).
 * Используется клиентом для отображения риска и пуш-текстов; реальный рейд — Шаг 4.
 */
export function lootableEstimate(account: UserAccount, config: EconomyConfig): StoragePools {
  const estimate = emptyStorages();
  for (const resource of ORE_IDS) {
    estimate[resource] = Math.floor((account.storages[resource] ?? 0) * config.lootShare);
  }
  return estimate;
}

