import { describe, expect, it } from 'vitest';

import {
  abandonAdSession,
  AD_USED_IDS_CAP,
  claimAdReward,
  noteAdRewardId,
  openAdSession,
  type AdOffer
} from '../src/modules/ads/rewarded.js';
import { isAdPostbackReplay } from '../src/modules/ads/postback.js';
import { effectiveStorageCapacity } from '../src/modules/economy/entitlements.js';
import { AppError, ErrorCodes } from '../src/lib/errors.js';
import { MINUTE, T0, addMs, newAccount, testConfig, withAsterium } from './fixtures.js';

const config = testConfig({
  ADS_ENABLED: 'true',
  ADS_DAILY_REWARDS: '3',
  ADS_MIN_INTERVAL_SEC: '60',
  ADS_SESSION_TTL_SEC: '120'
});
const rules = config.economy;

/** Строгий режим: интервал 5 минут, TTL сессии 10 минут — чтобы лимиты было за что поймать. */
const strict = testConfig({
  ADS_ENABLED: 'true',
  ADS_DAILY_REWARDS: '2',
  ADS_MIN_INTERVAL_SEC: '300',
  ADS_SESSION_TTL_SEC: '600'
}).economy;

/** Узкое окно памяти реплея (2 минуты): проверяем, что документ не разрастается. */
const narrow = testConfig({
  ADS_ENABLED: 'true',
  ADS_MIN_INTERVAL_SEC: '60',
  ADS_SESSION_TTL_SEC: '120',
  ADS_REPLAY_WINDOW_SEC: '120'
}).economy;

const energyOffer: AdOffer = { sku: 'ad_energy_20', label: '+20 энергии', reward: { kind: 'energy', units: 20 } };
const asteriumOffer: AdOffer = {
  sku: 'ad_asterium_5',
  label: '+5 астерия',
  reward: { kind: 'asterium', amount: 5 }
};
/** Сырьё за рекламу — всегда мелкие единицы: крупные паки продаются в магазине. */
const chroniumOffer: AdOffer = {
  sku: 'ad_chronium_1',
  label: '+1 хрониум',
  reward: { kind: 'material', material: 'chronium', amount: 1 }
};
const boostOffer: AdOffer = {
  sku: 'ad_warehouse_x2_1h',
  label: 'Склады x2 на час',
  reward: {
    kind: 'entitlement',
    entitlement: { sku: 'warehouse_x2_1h', kind: 'warehouse_boost', value: 2, durationMs: 60 * MINUTE }
  }
};

let seq = 0;
const idFactory = () => `ad-${++seq}`;

/** Игрок с полной энергией: удобно проверять «не переполнили кап» и точные дельты. */
function withEnergy(energy: number) {
  const account = newAccount(config);
  return { ...account, resources: { ...account.resources, energy } };
}

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof AppError ? error.code : `unexpected:${String(error)}`;
  }
}

describe('ads: открытие сессии', () => {
  it('выключенная монетизация рекламой — ADS_DISABLED', () => {
    const off = testConfig({ ADS_ENABLED: 'false' });
    expect(codeOf(() => openAdSession(newAccount(off), energyOffer, T0, off.economy, idFactory))).toBe(
      ErrorCodes.ADS_DISABLED
    );
  });

  it('долг по возврату платежа блокирует выдачу наград', () => {
    const account = withAsterium(withEnergy(50), -10, 0);
    expect(codeOf(() => openAdSession(account, energyOffer, T0, rules, idFactory))).toBe(ErrorCodes.PURCHASES_BLOCKED);
  });

  it('второе открытие при живой сессии — AD_SESSION_REQUIRED', () => {
    const opened = openAdSession(withEnergy(50), energyOffer, T0, rules, idFactory);
    expect(opened.account.ads.pending?.id).toBe(opened.session.id);
    expect(codeOf(() => openAdSession(opened.account, energyOffer, addMs(T0, MINUTE), rules, idFactory))).toBe(
      ErrorCodes.AD_SESSION_REQUIRED
    );
  });

  it('abandonAdSession освобождает слот показа', () => {
    const opened = openAdSession(withEnergy(50), energyOffer, T0, rules, idFactory);
    const abandoned = abandonAdSession(opened.account, opened.session.id);
    expect(abandoned.ads.pending).toBeNull();
    expect(() => openAdSession(abandoned, energyOffer, addMs(T0, MINUTE), rules, idFactory)).not.toThrow();
  });
});

describe('ads: выдача награды', () => {
  it('энергия пополняется, счётчик растёт, сессия закрывается', () => {
    const account = withEnergy(50);
    const opened = openAdSession(account, energyOffer, T0, rules, idFactory);
    const claimed = claimAdReward(opened.account, opened.session.id, energyOffer, addMs(T0, MINUTE), rules);

    expect(claimed.account.resources.energy).toBe(70);
    expect(claimed.account.ads.claimed).toBe(1);
    expect(claimed.account.ads.pending).toBeNull();
    expect(claimed.drafts[0]?.reason).toBe('ad_reward');
    expect(claimed.drafts[0]?.idempotencyKey).toBe(`ad:${opened.session.id}`);
  });

  it('награда не переполняет кап энергии', () => {
    const account = withEnergy(rules.energyCap - 5);
    const opened = openAdSession(account, energyOffer, T0, rules, idFactory);
    const claimed = claimAdReward(opened.account, opened.session.id, energyOffer, T0, rules);
    expect(claimed.account.resources.energy).toBe(rules.energyCap);
    expect(claimed.drafts[0]?.delta).toBe(5);
  });

  it('астериев падает в заработанный кошелёк, купленный не трогается', () => {
    const account = withAsterium(withEnergy(50), 100, 0);
    const opened = openAdSession(account, asteriumOffer, T0, rules, idFactory);
    const claimed = claimAdReward(opened.account, opened.session.id, asteriumOffer, T0, rules);
    expect(claimed.account.materials.asterium).toEqual({ purchased: 100, earned: 5 });
    expect(claimed.drafts[0]?.currency).toBe('asterium_earned');
  });

  it('сырьё падает плоским счётчиком, астерий не трогается', () => {
    const account = withAsterium(withEnergy(50), 100, 7);
    const opened = openAdSession(account, chroniumOffer, T0, rules, idFactory);
    const claimed = claimAdReward(opened.account, opened.session.id, chroniumOffer, T0, rules);

    expect(claimed.account.materials.chronium).toBe(1);
    expect(claimed.account.materials.asterium).toEqual({ purchased: 100, earned: 7 });
    expect(claimed.granted).toBe('chronium:1');
    expect(claimed.drafts[0]?.currency).toBe('chronium');
    expect(claimed.drafts[0]?.reason).toBe('ad_reward');
    expect(claimed.drafts[0]?.idempotencyKey).toBe(`ad:${opened.session.id}`);
  });

  it('буст из рекламы поднимает ёмкость склада и истекает по сроку', () => {
    const base = withEnergy(50);
    const opened = openAdSession(base, boostOffer, T0, rules, idFactory);
    const claimed = claimAdReward(opened.account, opened.session.id, boostOffer, T0, rules);
    expect(claimed.account.entitlements).toHaveLength(1);
    expect(effectiveStorageCapacity(claimed.account, T0)).toBe(base.storageCapacity * 2);
    expect(effectiveStorageCapacity(claimed.account, addMs(T0, 61 * MINUTE))).toBe(base.storageCapacity);
  });
});

describe('ads: антифрод-лимы', () => {
  /** Полный цикл: открытие показа -> выдача награды. */
  function flow(account: Parameters<typeof openAdSession>[0], offer: AdOffer, openAt: Date, claimAt: Date, cfg = rules) {
    const opened = openAdSession(account, offer, openAt, cfg, idFactory);
    return claimAdReward(opened.account, opened.session.id, offer, claimAt, cfg);
  }

  it('чужой id сессии — AD_SESSION_REQUIRED', () => {
    const opened = openAdSession(withEnergy(50), energyOffer, T0, rules, idFactory);
    expect(codeOf(() => claimAdReward(opened.account, 'ad-chuzoy', energyOffer, T0, rules))).toBe(
      ErrorCodes.AD_SESSION_REQUIRED
    );
  });

  it('повторный клейм той же сессии невозможен', () => {
    const account = withEnergy(10);
    const opened = openAdSession(account, energyOffer, T0, rules, idFactory);
    const first = claimAdReward(opened.account, opened.session.id, energyOffer, T0, rules);
    expect(
      codeOf(() => claimAdReward(first.account, opened.session.id, energyOffer, addMs(T0, 5 * MINUTE), rules))
    ).toBe(ErrorCodes.AD_SESSION_REQUIRED);
  });

  it('просроченная сессия — AD_SESSION_EXPIRED', () => {
    const opened = openAdSession(withEnergy(50), energyOffer, T0, rules, idFactory);
    expect(codeOf(() => claimAdReward(opened.account, opened.session.id, energyOffer, addMs(T0, 3 * MINUTE), rules))).toBe(
      ErrorCodes.AD_SESSION_EXPIRED
    );
  });

  it('чаще минимального интервала — AD_TOO_SOON', () => {
    const first = flow(withEnergy(10), energyOffer, T0, T0, strict);
    expect(codeOf(() => flow(first.account, energyOffer, addMs(T0, MINUTE), addMs(T0, MINUTE), strict))).toBe(
      ErrorCodes.AD_TOO_SOON
    );
  });

  it('суточный лимит наград — AD_LIMIT_REACHED, и он сбрасывается на следующий день', () => {
    const first = flow(withEnergy(10), energyOffer, T0, T0, strict);
    const second = flow(first.account, energyOffer, addMs(T0, 301_000), addMs(T0, 301_000), strict);
    expect(second.account.ads.claimed).toBe(2);
    expect(codeOf(() => flow(second.account, energyOffer, addMs(T0, 601_000), addMs(T0, 601_000), strict))).toBe(
      ErrorCodes.AD_LIMIT_REACHED
    );

    const nextDay = addMs(T0, 24 * 60 * MINUTE);
    const third = flow(second.account, energyOffer, nextDay, nextDay, strict);
    expect(third.account.ads.claimed).toBe(1);
  });
});

describe('ads: память исполненных reward_id (анти-реплей постбэка)', () => {
  it('noteAdRewardId помнит id один раз: повторная запись не удваивает строку', () => {
    const once = noteAdRewardId(withEnergy(50), 'vk-1', T0, rules);
    const twice = noteAdRewardId(once, 'vk-1', addMs(T0, MINUTE), rules);
    expect(twice.ads.used).toEqual([{ id: 'vk-1', at: addMs(T0, MINUTE) }]);
  });

  it('пустой rewardId не запоминается: сервер не выдумывает ключ сверки', () => {
    const account = withEnergy(50);
    // Площадка без reward_id — это режим, в котором память физически невозможна.
    // Придумать id здесь значило бы сравнить повтор с собственным генератором.
    expect(noteAdRewardId(account, null, T0, rules)).toBe(account);
    expect(account.ads.used).toEqual([]);
  });

  it('записи старше окна выбрасываются: документ не разрастается до бесконечности', () => {
    const old = noteAdRewardId(withEnergy(50), 'vk-old', T0, narrow);
    const fresh = noteAdRewardId(old, 'vk-new', addMs(T0, 10 * MINUTE), narrow);
    expect(fresh.ads.used.map((used) => used.id)).toEqual(['vk-new']);
  });

  it('потолок AD_USED_IDS_CAP режет самые старые записи', () => {
    let account = withEnergy(50);
    for (let i = 0; i < AD_USED_IDS_CAP + 10; i += 1) {
      account = noteAdRewardId(account, `vk-${i}`, addMs(T0, i), rules);
    }
    expect(account.ads.used).toHaveLength(AD_USED_IDS_CAP);
    expect(account.ads.used[0]?.id).toBe('vk-10');
    expect(account.ads.used[AD_USED_IDS_CAP - 1]?.id).toBe(`vk-${AD_USED_IDS_CAP + 9}`);
  });

  it('claimAdReward сохраняет память: иначе она стиралась бы при каждой выдаче', () => {
    const opened = openAdSession(withEnergy(50), energyOffer, T0, rules, idFactory);
    const noted = noteAdRewardId(opened.account, 'vk-earlier', addMs(T0, -MINUTE), rules);
    const claimed = claimAdReward(noted, opened.session.id, energyOffer, T0, rules);
    // Возврат из claimAdReward собирает новый объект ads. Без переноса `used`
    // память жила бы ровно до первой следующей награды — то есть всегда пуста.
    expect(claimed.account.ads.used.map((used) => used.id)).toContain('vk-earlier');
  });
});

describe('ads/postback: isAdPostbackReplay', () => {
  const remembered = { ...withEnergy(50), ads: { ...withEnergy(50).ads, used: [{ id: 'vk-1', at: T0 }] } };

  it('узнаёт исполненный id в пределах окна', () => {
    expect(isAdPostbackReplay(remembered, 'vk-1', T0, 120_000)).toBe(true);
  });

  it('не узнаёт id за пределами окна: повтор через месяц — это уже другой показ', () => {
    expect(isAdPostbackReplay(remembered, 'vk-1', addMs(T0, 10 * MINUTE), 120_000)).toBe(false);
  });

  it('чужой id и отсутствующий id — не реплей', () => {
    expect(isAdPostbackReplay(remembered, 'vk-2', T0, 120_000)).toBe(false);
    expect(isAdPostbackReplay(remembered, null, T0, 120_000)).toBe(false);
  });
});
