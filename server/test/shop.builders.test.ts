import { describe, expect, it } from 'vitest';

import { MAX_BUILDERS } from '../src/config/workshop.js';
import {
  effectiveBuildRobots,
  grantEntitlement,
  revokeEntitlementsByOrder
} from '../src/modules/economy/entitlements.js';
import { refundAsterium } from '../src/modules/economy/wallet.js';
import { buildersOwned, buyBuilder, describeBuilderShop } from '../src/modules/shop/builders.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { T0, errorCode, newAccount, testConfig, withAsterium } from './fixtures.js';

const config = testConfig();
const rules = config.economy;

let seq = 0;
const idFactory = () => `ent-${++seq}`;

/** Три покупки подряд: 3-й, 4-й и 5-й робот. */
function buyThree(account: ReturnType<typeof newAccount>) {
  const first = buyBuilder(account, T0, rules, { idFactory });
  const second = buyBuilder(first.account, T0, rules, { idFactory });
  const third = buyBuilder(second.account, T0, rules, { idFactory });
  return [first, second, third] as const;
}

describe('магазин: роботы-строители за астериев', () => {
  it('лестница цен 500 → 1000 → 2000 и потолок в 5 слотов', () => {
    const account = withAsterium(newAccount(config), 4000, 0);
    const [first, second, third] = buyThree(account);

    expect([first.price, second.price, third.price]).toEqual([500, 1000, 2000]);
    expect(first.nextPrice).toBe(1000);
    expect(second.nextPrice).toBe(2000);
    // Последний слот продаётся без «следующего» — витрина обязана это показать.
    expect(third.nextPrice).toBeNull();
    expect(buildersOwned(third.account)).toBe(MAX_BUILDERS);
    expect(third.account.materials.asterium.purchased).toBe(500);
    expect(errorCode(() => buyBuilder(third.account, T0, rules, { idFactory }))).toBe(ErrorCodes.BUILDER_LIMIT_REACHED);
  });

  it('слот — привилегия, а не поле: рефанд откатывает его одной операцией', () => {
    const account = withAsterium(newAccount(config), 1000, 0);
    const purchase = buyBuilder(account, T0, rules, { idFactory, orderId: 'vk-order-1' });
    expect(effectiveBuildRobots(purchase.account, T0)).toBe(3);
    expect(purchase.account.entitlements[0]?.permanent).toBe(true);

    const refunded = refundAsterium(purchase.account, 500, { ts: T0, reason: 'refund' });
    const revoked = revokeEntitlementsByOrder(refunded.account, 'vk-order-1');

    expect(revoked.entitlements).toHaveLength(0);
    expect(effectiveBuildRobots(revoked, T0)).toBe(2);
    expect(buildersOwned(revoked)).toBe(2);
    expect(revoked.materials.asterium.purchased).toBe(0);
  });

  it('повторный вебхук с тем же orderId не продаёт слот дважды', () => {
    const account = withAsterium(newAccount(config), 2000, 0);
    const first = buyBuilder(account, T0, rules, { idFactory, orderId: 'vk-duplicate' });

    expect(errorCode(() => buyBuilder(first.account, T0, rules, { idFactory, orderId: 'vk-duplicate' }))).toBe(
      ErrorCodes.DUPLICATE_ORDER
    );
    expect(first.account.materials.asterium.purchased).toBe(1500);
    expect(first.account.entitlements).toHaveLength(1);
  });

  it('детерминированный orderId слота защищает от ретрая без внешнего заказа', () => {
    const account = withAsterium(newAccount(config), 2000, 0);
    const first = buyBuilder(account, T0, rules, { idFactory });
    // Тот же (аккаунт, позиция на лестнице) → тот же orderId → отказ.
    expect(
      errorCode(() => buyBuilder(first.account, T0, rules, { idFactory, orderId: `builder:${account.id}:3` }))
    ).toBe(ErrorCodes.DUPLICATE_ORDER);
  });

  it('тратится сначала заработанный астериев, купленный не трогается', () => {
    const account = withAsterium(newAccount(config), 1000, 500);
    const purchase = buyBuilder(account, T0, rules, { idFactory });

    expect(purchase.account.materials.asterium).toEqual({ purchased: 1000, earned: 0 });
    expect(purchase.drafts.map((draft) => draft.currency)).toEqual(['asterium_earned']);
    expect(purchase.drafts[0]?.reason).toBe('builder_purchase');
    expect(purchase.drafts[0]?.delta).toBe(-500);
  });

  it('не хватило — INSUFFICIENT_FUNDS, и состояние не изменилось', () => {
    const account = withAsterium(newAccount(config), 100, 0);
    expect(errorCode(() => buyBuilder(account, T0, rules, { idFactory }))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
    expect(account.materials.asterium).toEqual({ purchased: 100, earned: 0 });
    expect(account.entitlements).toHaveLength(0);
  });

  it('долг по донату: заработанный — можно, купленный — PURCHASES_BLOCKED', () => {
    const withEarned = withAsterium(newAccount(config), -300, 600);
    const ok = buyBuilder(withEarned, T0, rules, { idFactory });
    expect(ok.account.materials.asterium.earned).toBe(100);

    const withoutEarned = withAsterium(newAccount(config), -300, 100);
    expect(errorCode(() => buyBuilder(withoutEarned, T0, rules, { idFactory }))).toBe(ErrorCodes.PURCHASES_BLOCKED);
  });

  it('временный буст не сдвигает лестницу цен постоянного слота', () => {
    const base = withAsterium(newAccount(config), 5000, 0);
    const boosted = grantEntitlement(
      base,
      { sku: 'builder_temp_1h', kind: 'builder_slot', value: 1, source: 'ad_reward', durationMs: 3_600_000 },
      T0,
      { idFactory, maxActive: 10 }
    );
    expect(effectiveBuildRobots(boosted, T0)).toBe(3);
    expect(buildersOwned(boosted)).toBe(2);

    const purchase = buyBuilder(boosted, T0, rules, { idFactory });
    expect(purchase.price).toBe(500);
    expect(purchase.ownedAfter).toBe(3);
    expect(purchase.buildersMax).toBe(4);
  });

  it('витрина отдаёт UI причину отказа без исключений', () => {
    const rich = withAsterium(newAccount(config), 5000, 0);
    expect(describeBuilderShop(rich, T0)).toMatchObject({
      canBuy: true,
      reason: 'ok',
      price: 500,
      owned: 2,
      limit: MAX_BUILDERS
    });

    expect(describeBuilderShop(withAsterium(newAccount(config), 100, 0), T0).reason).toBe('funds');
    expect(describeBuilderShop(withAsterium(newAccount(config), -1000, 0), T0).reason).toBe('debt');

    const [, , third] = buyThree(withAsterium(newAccount(config), 4000, 0));
    expect(describeBuilderShop(third.account, T0)).toMatchObject({ canBuy: false, reason: 'limit', price: null });
  });
});

