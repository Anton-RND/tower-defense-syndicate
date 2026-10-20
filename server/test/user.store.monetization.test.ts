import { describe, expect, it } from 'vitest';

import { grantEntitlement } from '../src/modules/economy/entitlements.js';
import { describeEconomy } from '../src/modules/economy/view.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import { T0, addMs, newAccount, testConfig } from './fixtures.js';

const config = testConfig({ ADS_ENABLED: 'true' });

describe('монетизация сквозь стор и DTO', () => {
  it('новый игрок стартует без астерия и привилегий', async () => {
    const store = new MemoryUserStore();
    const { account, created } = await store.getOrCreate(
      { platform: 'vk', socialId: '77', appId: '1', groupId: null },
      T0,
      (identity, now) => newAccount(config, now, identity.socialId)
    );

    expect(created).toBe(true);
    expect(account.materials.asterium).toEqual({ purchased: 0, earned: 0 });
    expect(account.entitlements).toEqual([]);
    expect(account.ads).toMatchObject({ claimed: 0, lastClaimAt: null, pending: null });
  });

  it('transact атомарно сохраняет привилегию и не отдаёт внутренние ссылки', async () => {
    const store = new MemoryUserStore();
    const seed = newAccount(config);
    await store.save(seed);

    const updated = await store.transact(seed.id, (current) =>
      grantEntitlement(
        current,
        { sku: 'robot_slot_3', kind: 'builder_slot', value: 1, source: 'purchase', durationMs: null, orderId: 'order-9' },
        T0,
        { idFactory: () => 'ent-9', maxActive: 5 }
      )
    );

    expect(updated.revision).toBe(seed.revision + 1);
    expect(updated.entitlements).toHaveLength(1);

    // Копия, отданная наружу, не должна мутировать хранилище.
    updated.entitlements.push({ ...updated.entitlements[0]!, id: 'fake', sku: 'fake' });
    const reread = await store.findById(seed.id);
    expect(reread?.entitlements).toHaveLength(1);
    expect(reread?.entitlements[0]?.sku).toBe('robot_slot_3');
  });

  it('неудачный редуктор не оставляет следов (всё или ничего)', async () => {
    const store = new MemoryUserStore();
    const seed = { ...newAccount(config), materials: { ...newAccount(config).materials, asterium: { purchased: 10, earned: 0 } } };
    await store.save(seed);

    await expect(
      store.transact(seed.id, () => {
        throw new Error('упали посреди транзакции');
      })
    ).rejects.toThrow('упали посреди транзакции');

    const reread = await store.findById(seed.id);
    expect(reread?.materials.asterium).toEqual({ purchased: 10, earned: 0 });
    expect(reread?.revision).toBe(seed.revision);
  });

  it('DTO отдаёт витрине астериев, бусты и состояние рекламы', () => {
    const base = newAccount(config);
    const account = {
      ...base,
      materials: { ...base.materials, asterium: { purchased: 100, earned: 25 } },
      entitlements: [
        {
          id: 'ent-1',
          sku: 'warehouse_x2_7d',
          kind: 'warehouse_boost' as const,
          value: 2,
          permanent: false,
          expiresAt: addMs(T0, 24 * 3_600_000),
          source: 'purchase' as const,
          grantedAt: T0,
          orderId: 'order-1'
        }
      ],
      ads: { day: T0.toISOString().slice(0, 10), claimed: 2, lastClaimAt: T0, pending: null }
    };

    const view = describeEconomy(account, T0, config);
    expect(view.asterium).toEqual({ purchased: 100, earned: 25, total: 125, blocked: false });
    expect(view.storageCapacityBase).toBe(base.storageCapacity);
    expect(view.storageCapacity).toBe(base.storageCapacity * 2);
    expect(view.entitlements[0]?.remainingMs).toBe(24 * 3_600_000);
    expect(view.ads).toMatchObject({ enabled: true, claimedToday: 2, dailyLimit: 6, remainingToday: 4 });
    expect(view.shieldUntil).toBeNull();
  });

  it('долг по возврату подсвечивается в DTO как blocked', () => {
    const account = { ...newAccount(config), materials: { ...newAccount(config).materials, asterium: { purchased: -5, earned: 0 } } };
    const view = describeEconomy(account, T0, config);
    expect(view.asterium.blocked).toBe(true);
    expect(view.asterium.total).toBe(-5);
  });
});