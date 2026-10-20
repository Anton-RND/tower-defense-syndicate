import { describe, expect, it } from 'vitest';

import { getAdOffer } from '../src/config/ads.js';
import { STARTER_KIT } from '../src/config/starter.js';
import { getBlueprint, junkTotal, materialEntries } from '../src/config/workshop.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { claimAdReward, openAdSession } from '../src/modules/ads/rewarded.js';
import { applyStarterKit } from '../src/modules/user/starter.js';
import { createAccount } from '../src/modules/user/user.types.js';
import { startBuild } from '../src/modules/workshop/craft.js';
import { T0, newAccount, testConfig, withJunk } from './fixtures.js';

/**
 * Стартовый комплект и рекламный кран хлама (P0).
 *
 * Файл существует не для покрытия `applyStarterKit` как функции — он покрывает
 * УТВЕРЖДЕНИЕ, которое раньше было ложным и которое сломало онбординг: «новичок
 * соберёт первый предмет сам, из ресурсов майнинга» (комментарий `createAccount`).
 * Собирать было нечего: все тир-1 чертежи требуют хлам, хлам даёт только бой,
 * бой требует дрон, дрон требует хлам.
 *
 * Поэтому здесь два теста обязательны одновременно:
 *  1. игрок С комплектом строит и первого дрона, и первую турель;
 *  2. игрок БЕЗ комплекта не строит ничего — то есть именно комплект размыкает
 *     круг, а не совпадение.
 * Второй не даёт первому тихо превратиться в «ну и ладно, зачем-то он есть».
 */

const config = testConfig();
const rules = config.economy;

let seq = 0;
const idFactory = (): string => `starter-${++seq}`;

/** Аккаунт ровно такой, каким его создаёт вход в игру: без грантов и подачек. */
function virgin() {
  seq += 1;
  return createAccount({ platform: 'vk', socialId: `new-${seq}`, appId: null, groupId: null }, T0, rules, idFactory);
}

const DRONE_CODE = 'drone_cargo_mk1';
const TOWER_CODE = 'tower_laser_mk1';
const DRONE = getBlueprint(DRONE_CODE);
const TOWER = getBlueprint(TOWER_CODE);

if (!DRONE || !TOWER) throw new Error('фикстура: чертежи первого тира переименованы');

/** Реклама по умолчанию выключена (ADS_ENABLED=false), поэтому для неё свой конфиг. */
const adsConfig = testConfig({ ADS_ENABLED: 'true', ADS_DAILY_REWARDS: '20' });
const adsRules = adsConfig.economy;

describe('starter: комплект размыкает круг производства', () => {
  it('новичок без комплекта не может построить ничего — ровно та былая яма', () => {
    const fresh = virgin();
    expect(() => startBuild(fresh, DRONE_CODE, T0, idFactory)).toThrow();
    expect(() => startBuild(fresh, TOWER_CODE, T0, idFactory)).toThrow();
    expect(junkTotal(fresh.junk)).toBe(0);
    expect(fresh.resources.ferrum).toBe(0);
  });

  it('комплекта хватает на первый дрон И на первую турель одновременно', () => {
    // Инвариант проверяется по таблице чертежей, а не по выдуманным числам: правка
    // стоимости тир-1 обязана либо пройти этот тест, либо заставить поменять KIT.
    for (const blueprint of [DRONE, TOWER]) {
      for (const [id, amount] of materialEntries(blueprint.cost)) {
        expect(STARTER_KIT[id] ?? 0, `${id}: комплекта не хватает на ${blueprint.code}`).toBeGreaterThanOrEqual(amount);
      }
    }
  });

  it('с комплектом оба предмета строятся подряд без единого гранта', () => {
    const kit = applyStarterKit(virgin(), T0).account;
    const drone = startBuild(kit, DRONE_CODE, T0, idFactory);
    const tower = startBuild(drone.account, TOWER_CODE, T0, idFactory);

    expect(tower.account.builds).toHaveLength(2);
    expect(tower.account.junk.batteries).toBe((STARTER_KIT.batteries ?? 0) - (DRONE.cost.batteries ?? 0));
    expect(tower.account.junk.chips).toBe((STARTER_KIT.chips ?? 0) - (TOWER.cost.chips ?? 0));
    // Остаток железа должен покрывать первую стену: 40 железа + 2 чёрмета.
    expect(tower.account.resources.ferrum).toBeGreaterThanOrEqual(40);
    expect(tower.account.metals.black_metal).toBeGreaterThanOrEqual(2);
  });

  it('комплект не содержит донатных валют: альт-ферма не оправдана', () => {
    // MaterialCost не позволяет указать asterium/sec (их нет в MaterialId), но тест
    // держит это на уровне данных, а не типов: завтра кто-то расширит union.
    expect(Object.keys(STARTER_KIT)).not.toContain('asterium');
    expect(Object.keys(STARTER_KIT)).not.toContain('sec');
  });

  it('каждое зерно комплекта уходит в журнал с причиной `starter` и своим ключом', () => {
    const fresh = virgin();
    const { drafts, granted } = applyStarterKit(fresh, T0);

    expect(drafts).toHaveLength(materialEntries(STARTER_KIT).length);
    expect(drafts.every((draft) => draft.reason === 'starter')).toBe(true);
    expect(drafts.every((draft) => draft.userId === fresh.id)).toBe(true);
    expect(drafts.every((draft) => draft.delta > 0)).toBe(true);
    // Ключ идемпотентности обязан содержать и игрока, и материал (инварианты
    // ledger.types.ts): без валюты в ключе вторая запись пачки отбросился бы как дубль.
    const keys = drafts.map((draft) => draft.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => key?.startsWith(`starter:${fresh.id}:`))).toBe(true);
    expect(Object.keys(granted).length).toBe(drafts.length);
  });

  it('журнал комплекта различает валюты склада и кошелька', () => {
    const { drafts } = applyStarterKit(virgin(), T0);
    const currencies = drafts.map((draft) => draft.currency);
    expect(currencies).toContain('ferrum');
    expect(currencies).toContain('junk_chips');
    expect(currencies).toContain('black_metal');
  });
});

describe('ads: хлам за рекламу — аварийный кран тир-1', () => {
  const positions = ['ad_chips_2', 'ad_batteries_2', 'ad_boards_2'] as const;

  it('каталог предлагает ровно три позиции хлама, и все они настоящего хлама', () => {
    for (const sku of positions) {
      const offer = getAdOffer(sku);
      expect(offer, `нет оффера ${sku}`).toBeDefined();
      expect(offer?.reward.kind).toBe('junk');
      if (offer?.reward.kind === 'junk') {
        // 1-2 единицы за показ: кран выводит из ямы, но не заменяет PvP.
        expect(offer.reward.amount).toBeGreaterThan(0);
        expect(offer.reward.amount).toBeLessThanOrEqual(2);
      }
    }
  });

  it('глубокие тиры остаются боевыми: движки и трансмиссии за рекламу не выдаются', () => {
    for (const sku of ['ad_engines_1', 'ad_transmissions_1', 'ad_ammo_casings_1']) {
      expect(getAdOffer(sku), `${sku} обесценил бы PvP`).toBeUndefined();
    }
  });

  it('награда падает в склад хлама и пишется в журнал своей валютой', () => {
    const account = newAccount(adsConfig);
    const offer = getAdOffer('ad_chips_2');
    if (!offer) throw new Error('нет оффера ad_chips_2');
    const opened = openAdSession(account, offer, T0, adsRules, idFactory);
    const claimed = claimAdReward(opened.account, opened.session.id, offer, T0, adsRules);

    expect(claimed.account.junk.chips).toBe(2);
    expect(claimed.drafts).toHaveLength(1);
    expect(claimed.drafts[0]?.currency).toBe('junk_chips');
    expect(claimed.drafts[0]?.reason).toBe('ad_reward');
    expect(claimed.granted).toBe('chips:2');
  });

  it('переполненный склад хлама отсекается тем же кодом, что и боевой лут', () => {
    const strict = testConfig({ JUNK_CAP: '3', ADS_ENABLED: 'true' }).economy;
    const offer = getAdOffer('ad_chips_2');
    if (!offer) throw new Error('нет оффера ad_chips_2');
    const crowded = withJunk(newAccount(config), { chips: 3 });
    const opened = openAdSession(crowded, offer, T0, strict, idFactory);
    expect(() => claimAdReward(opened.account, opened.session.id, offer, T0, strict)).toThrow();
    try {
      claimAdReward(opened.account, opened.session.id, offer, T0, strict);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCodes.JUNK_CAP_REACHED);
    }
  });
});

