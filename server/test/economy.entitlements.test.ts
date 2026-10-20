import { describe, expect, it } from 'vitest';

import {
  effectiveBuildRobots,
  effectiveMiningRates,
  effectiveStorageCapacity,
  grantEntitlement,
  isEntitlementActive,
  isShielded,
  pruneExpiredEntitlements,
  resolveEntitlements
} from '../src/modules/economy/entitlements.js';
import { computeEnergyTick } from '../src/modules/economy/energy.js';
import { computeMiningTick } from '../src/modules/economy/mining.js';
import { applyEconomyTick } from '../src/modules/economy/tick.js';
import { AppError, ErrorCodes } from '../src/lib/errors.js';
import { HOUR, T0, addMs, entitlement, newAccount, testConfig } from './fixtures.js';

const config = testConfig();
const rules = config.economy;

describe('entitlements: резолв эффектов', () => {
  it('без привилегий даёт нейтральные множители', () => {
    const account = newAccount(config);
    const effects = resolveEntitlements(account, T0);
    expect(effects.warehouseMultiplier).toBe(1);
    expect(effects.mineMultiplier).toBe(1);
    expect(effects.energyRegenMultiplier).toBe(1);
    expect(effects.extraBuilders).toBe(0);
    expect(effects.shieldUntil).toBeNull();
  });

  it('буст склада x2 удваивает эффективную ёмкость', () => {
    const base = newAccount(config);
    const account = {
      ...base,
      entitlements: [entitlement({ kind: 'warehouse_boost', value: 2, expiresAt: addMs(T0, HOUR) })]
    };
    expect(effectiveStorageCapacity(account, T0)).toBe(base.storageCapacity * 2);
  });

  it('однотипные бусты складываются, а не перемножаются (x2 + x2 = x3)', () => {
    const base = newAccount(config);
    const account = {
      ...base,
      entitlements: [
        entitlement({ kind: 'warehouse_boost', value: 2, expiresAt: addMs(T0, HOUR) }),
        entitlement({ kind: 'warehouse_boost', value: 2, expiresAt: addMs(T0, HOUR) })
      ]
    };
    expect(resolveEntitlements(account, T0).warehouseMultiplier).toBe(3);
  });

  it('истёкшая привилегия не считается активной', () => {
    const base = newAccount(config);
    const expired = entitlement({ kind: 'mine_boost', value: 3, expiresAt: addMs(T0, -1) });
    expect(isEntitlementActive(expired, T0)).toBe(false);
    const account = { ...base, entitlements: [expired] };
    expect(effectiveMiningRates(account, T0).ferrum).toBe(base.miningRates.ferrum);
  });

  it('бессрочная привилегия активна всегда', () => {
    const slot = entitlement({ kind: 'builder_slot', value: 1, permanent: true, expiresAt: null });
    expect(isEntitlementActive(slot, addMs(T0, 100 * 365 * 24 * HOUR))).toBe(true);
  });

  it('щит берёт самый поздний expiresAt', () => {
    const base = newAccount(config);
    const account = {
      ...base,
      entitlements: [
        entitlement({ kind: 'shield', value: 0, expiresAt: addMs(T0, HOUR) }),
        entitlement({ kind: 'shield', value: 0, expiresAt: addMs(T0, 5 * HOUR) })
      ]
    };
    expect(resolveEntitlements(account, T0).shieldUntil).toEqual(addMs(T0, 5 * HOUR));
    expect(isShielded(account, T0)).toBe(true);
    expect(isShielded(account, addMs(T0, 6 * HOUR))).toBe(false);
  });
});

describe('entitlements: влияние на экономику', () => {
  it('буст добычи ускоряет офлайн-майнинг', () => {
    const base = newAccount(config);
    const account = {
      ...base,
      entitlements: [entitlement({ kind: 'mine_boost', value: 2, expiresAt: addMs(T0, 24 * HOUR) })]
    };
    const plain = computeMiningTick(base, addMs(T0, HOUR), rules);
    const boosted = computeMiningTick(account, addMs(T0, HOUR), rules);
    expect(boosted.gained.ferrum).toBe(plain.gained.ferrum * 2);
  });

  it('буст склада поднимает потолок накопления', () => {
    // Игрок офлайн 48 часов: без буста ferrum упёрся бы в базовую ёмкость склада.
    const base = newAccount(config, addMs(T0, -48 * HOUR));
    const account = {
      ...base,
      entitlements: [entitlement({ kind: 'warehouse_boost', value: 4, expiresAt: addMs(T0, 24 * HOUR) })]
    };
    const plain = computeMiningTick(base, T0, rules);
    const boosted = computeMiningTick(account, T0, rules);

    expect(effectiveStorageCapacity(account, T0)).toBe(base.storageCapacity * 4);
    expect(plain.storages.ferrum).toBe(base.storageCapacity);
    expect(plain.full).toContain('ferrum');
    // С бустом добыча продолжает идти и не упирается в склад.
    expect(boosted.storages.ferrum).toBeGreaterThan(plain.storages.ferrum);
    expect(boosted.full).not.toContain('ferrum');
  });

  it('буст регена энергии ускоряет восстановление', () => {
    const base = newAccount(config);
    const drained = { ...base, resources: { ...base.resources, energy: 0 } };
    const boosted = {
      ...drained,
      entitlements: [entitlement({ kind: 'energy_boost', value: 3, expiresAt: addMs(T0, 24 * HOUR) })]
    };
    const plain = computeEnergyTick(drained, addMs(T0, HOUR), rules);
    const fast = computeEnergyTick(boosted, addMs(T0, HOUR), rules);
    expect(fast.energy).toBe(plain.energy * 3);
  });

  it('тик вычищает протухшие привилегии', () => {
    const base = newAccount(config);
    const account = {
      ...base,
      entitlements: [
        entitlement({ kind: 'warehouse_boost', value: 2, expiresAt: addMs(T0, -HOUR) }),
        entitlement({ kind: 'builder_slot', value: 1, permanent: true })
      ]
    };
    const pruned = pruneExpiredEntitlements(account, T0);
    expect(pruned.entitlements).toHaveLength(1);
    expect(pruned.entitlements[0]?.kind).toBe('builder_slot');
    expect(applyEconomyTick(account, T0, rules).account.entitlements).toHaveLength(1);
  });
});

describe('entitlements: выдача', () => {
  const options = { idFactory: () => 'ent-fixed', maxActive: 5 };
  const input = {
    sku: 'robot_slot_3',
    kind: 'builder_slot' as const,
    value: 1,
    source: 'purchase' as const,
    durationMs: null,
    orderId: 'order-1'
  };

  it('идемпотентна по orderId — двойной вебхук не даст второй слот', () => {
    const base = newAccount(config);
    const once = grantEntitlement(base, input, T0, options);
    const twice = grantEntitlement(once, input, T0, options);
    expect(twice.entitlements).toHaveLength(1);
    expect(effectiveBuildRobots(twice, T0)).toBe(base.buildRobots + 1);
  });

  it('превышение лимита активных привилегий — ENTITLEMENT_LIMIT', () => {
    const base = newAccount(config);
    const filled = {
      ...base,
      entitlements: [
        entitlement({ kind: 'builder_slot', value: 1, permanent: true }),
        entitlement({ kind: 'mine_boost', value: 2, expiresAt: addMs(T0, HOUR) })
      ]
    };
    try {
      grantEntitlement(
        filled,
        { sku: 'shield_24h', kind: 'shield', value: 0, source: 'purchase', durationMs: HOUR },
        T0,
        { idFactory: () => 'ent-3', maxActive: 2 }
      );
      throw new Error('ожидался ENTITLEMENT_LIMIT');
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.ENTITLEMENT_LIMIT);
    }
  });
});
