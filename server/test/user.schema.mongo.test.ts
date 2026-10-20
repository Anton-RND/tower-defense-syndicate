import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';

import { DEFAULT_HQ } from '../src/config/base.js';
import { PVP_RATING_START } from '../src/config/pvp.js';
import { generateBattleLoot } from '../src/modules/raid/loot.js';
import { saveLayout } from '../src/modules/pvp/defense.js';
import { buyBuilder } from '../src/modules/shop/builders.js';
import { settleBuilds, startBuild } from '../src/modules/workshop/craft.js';
import { dismantleItem } from '../src/modules/workshop/dismantle.js';
import { recycleJunk } from '../src/modules/workshop/recycle.js';
import {
  toAccount,
  toSetPayload,
  userSchema,
  type UserDoc,
  type UserModel
} from '../src/modules/user/mongo.model.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { MINUTE, T0, addMs, fixedRng, newAccount, testConfig, withAsterium, withJunk, withMetals, withPvp, withReferral, withResources, withStaniumField, withTech } from './fixtures.js';
import { confirmPurchase, openOrder } from '../src/modules/payment/orders.js';

const config = testConfig();
const payingConfig = testConfig({ PAYMENTS_ENABLED: 'true' });
const rules = config.economy;
let seq = 0;
const idFactory = () => `gen-${++seq}`;

const MODEL_NAME = 'TdUserSchemaSmoke';
const Model: UserModel =
  (mongoose.models[MODEL_NAME] as UserModel | undefined) ?? mongoose.model<UserDoc>(MODEL_NAME, userSchema);

/**
 * Аккаунт, прошедший все новые потоки подряд: магазин → стройка → разбор →
 * переработка → боевой лут → снова стройка. Именно такую смесь полей и обязан
 * бесследно переводить маппинг в Mongo.
 */
function playedAccount(): UserAccount {
  // Металлы нужны не чертежам (лазер берёт железо/кремний/чипы), а стене обороны:
  // её цена включает чёрный металл, и планировка в фикстуре обязана пройти валидацию.
  let account = withMetals(
    withJunk(withResources(withAsterium(newAccount(config), 5000, 1000), { ferrum: 5000, silicium: 5000 }), {
      chips: 50,
      batteries: 20
    }),
    { black_metal: 50, colored_metal: 10, precious_metal: 10 }
  );

  account = buyBuilder(account, T0, rules, { idFactory }).account;
  account = startBuild(account, 'tower_laser_mk1', T0, idFactory).account;
  account = startBuild(account, 'tower_laser_mk1', T0, idFactory).account;

  const settled = settleBuilds(account, addMs(T0, 10 * MINUTE), idFactory);
  account = settled.account;
  const item = settled.items[0];
  const spare = settled.items[1];
  if (!item || !spare) throw new Error('фикстура: предметы не появились в инвентаре');

  account = dismantleItem(account, item.id, 'scrap', addMs(T0, 10 * MINUTE), idFactory, fixedRng(0.5)).account;
  account = recycleJunk(account, 'batteries', 5, addMs(T0, 11 * MINUTE), rules).account;
  account = generateBattleLoot(
    account,
    { raidId: 'raid-smoke', outcome: 'win', destroyed: 12 },
    addMs(T0, 12 * MINUTE),
    rules,
    fixedRng(0.5)
  ).account;
  // Планировка обороны (Шаг 3): вложенная сетка со стеной и ссылкой на живой предмет.
  account = saveLayout(
    account,
    { walls: [{ x: 1, y: 1 }, { x: 1, y: 2 }], units: [{ itemId: spare.id, x: 2, y: 2 }] },
    addMs(T0, 12 * MINUTE)
  ).account;
  // Третья стройка намеренно не завершена: в документе должны уживаться и готовый
  // предмет, и активная работа, и выставленная на карту башня.
  return startBuild(account, 'tower_laser_mk1', addMs(T0, 12 * MINUTE), idFactory).account;
}

async function roundtrip(account: UserAccount): Promise<UserAccount> {
  const doc = new Model({ _id: account.id, ...toSetPayload(account) });
  // validate() вместо деприкейшн validateSync(): сценарий проверки маппинга не должен
  // жить за счёт API, который в Mongoose 10 удалят.
  await doc.validate();
  return toAccount(doc.toObject() as unknown as UserDoc);
}

describe('mongo.model: маппинг инвентаря, хлама, металлов, очереди и лута', () => {
  it('roundtrip аккаунт → документ → аккаунт ничего не теряет', async () => {
    const account = playedAccount();
    expect(await roundtrip(account)).toEqual(account);
  });

  it('предметы и работы сохраняют собственные id (иначе dismantle их не найдёт)', async () => {
    const account = playedAccount();
    expect(account.inventory.length).toBeGreaterThan(0);
    expect(account.builds.length).toBeGreaterThan(0);

    const restored = await roundtrip(account);
    expect(restored.inventory.map((item) => item.id)).toEqual(account.inventory.map((item) => item.id));
    expect(restored.builds.map((job) => job.id)).toEqual(account.builds.map((job) => job.id));
    expect(restored.builds[0]?.endsAt).toBeInstanceOf(Date);
  });

  it('хлам и металлы сохраняются счётчиками, а не массивами', async () => {
    const account = playedAccount();
    const restored = await roundtrip(account);

    expect(Object.keys(restored.junk)).toHaveLength(6);
    expect(Object.keys(restored.metals)).toHaveLength(3);
    expect(restored.junk.ammo_casings).toBeGreaterThan(0);
    expect(restored.metals.colored_metal).toBeGreaterThan(0);
    expect(restored.loot).toMatchObject({ lastRaidId: 'raid-smoke', events: 1 });
  });

  it('pvp-профиль и рефералы (Шаг 4) ездят в документ и обратно', async () => {
    const base = playedAccount();
    const account = withReferral(
      withPvp(base, {
        rating: 1450,
        bestRating: 1500,
        battles: 20,
        wins: 12,
        draws: 2,
        losses: 6,
        streak: 3,
        attacksToday: 4,
        lastRaidId: 'raid:1:2:3',
        lastBattleAt: T0
      }),
      { invitedBy: 'inviter-1', creditedAt: T0, count: 1, invited: ['inviter-1'] }
    );

    const restored = await roundtrip(account);
    expect(restored.pvp).toEqual(account.pvp);
    expect(restored.referral).toEqual(account.referral);
    // Дата боя обязана остаться Date-объектом после маппинга: по ней фронт рисует «последний рейд».
    expect(restored.pvp.lastBattleAt).toBeInstanceOf(Date);
    expect(restored.referral.creditedAt).toBeInstanceOf(Date);
  });

  it('планировка обороны ездит в документ и обратно, не теряя ссылок на предметы', async () => {
    const account = playedAccount();
    expect(account.base.units.length).toBeGreaterThan(0);
    expect(account.base.walls).toHaveLength(2);

    const restored = await roundtrip(account);
    expect(restored.base).toEqual(account.base);
    expect(restored.base.units[0]?.itemId).toBe(account.base.units[0]?.itemId);
    expect(restored.base.hq).toEqual(account.base.hq);
    // Маппинг обязан дать новые объекты: иначе редуктор дописал бы прямо в прочитанный документ.
    expect(restored.base.walls).not.toBe(account.base.walls);
  });

  it('заказы (Часть 1) и clanId (Часть 2) ездят в документ и обратно', async () => {
    const placed = openOrder(withAsterium(playedAccount(), 1000, 0), 'asterium_pack_500', T0, payingConfig.economy, 'smoke-1');
    const fulfilled = confirmPurchase(
      placed.account,
      placed.order.id,
      { item: 'asterium_pack_500', providerOrderId: 'vk-9' },
      addMs(T0, MINUTE),
      payingConfig.economy,
      idFactory
    ).account;
    const account = { ...fulfilled, clanId: 'clan-smoke-1' };

    const restored = await roundtrip(account);
    expect(restored.clanId).toBe('clan-smoke-1');
    expect(restored.orders).toEqual(account.orders);
    // Даты заказа обязаны остаться Date: по expiresAt редуктор решает, сжигать ли заказ.
    expect(restored.orders[0]?.createdAt).toBeInstanceOf(Date);
    expect(restored.orders[0]?.expiresAt).toBeInstanceOf(Date);
    expect(restored.orders[0]?.providerOrderId).toBe('vk-9');
    expect(restored.materials.asterium.purchased).toBe(1500);
  });

  it('документы до Шага 1.6 (без новых полей) читаются как пустые, а не падают', () => {
    const legacy = {
      _id: 'legacy-1',
      platform: 'vk',
      socialId: '1',
      createdAt: T0,
      lastLoginAt: T0,
      resources: { energy: 10, ferrum: 0, silicium: 0, uranium: 0, plasma: 0 },
      mined: { ferrum: 0, silicium: 0, uranium: 0, plasma: 0 },
      storageCapacity: 1000,
      miningRates: { ferrum: 50, silicium: 30, uranium: 8, plasma: 2 },
      lastLootTime: T0,
      energyUpdatedAt: T0,
      assist: { day: '2026-10-18', count: 0, helpers: [] },
      buildRobots: 2,
      premium: { purchased: 0, earned: 0 },
      entitlements: [],
      ads: { day: '2026-10-18', claimed: 0, lastClaimAt: null, pending: null },
      revision: 3
    } as unknown as UserDoc;

    const account: UserAccount = toAccount(legacy);
    expect(account.inventory).toEqual([]);
    expect(account.builds).toEqual([]);
    expect(account.junk).toEqual({
      chips: 0,
      boards: 0,
      engines: 0,
      transmissions: 0,
      batteries: 0,
      ammo_casings: 0
    });
    expect(account.metals).toEqual({ black_metal: 0, colored_metal: 0, precious_metal: 0 });
    expect(account.loot).toEqual({ day: '1970-01-01', events: 0, totalUnits: 0, lastRaidId: null });
    // Документы до Шага 3: пустая, но валидная база со штабом по умолчанию.
    expect(account.base).toEqual({ hq: DEFAULT_HQ, walls: [], units: [], version: 0, updatedAt: new Date(T0) });
    // Документы до Шага 4: стартовый рейтинг и пустые рефералы, а не null — иначе
    // матчмейкинг и витрина получили бы ветку «рейтинга нет» на живых игроков.
    expect(account.pvp.rating).toBe(PVP_RATING_START);
    expect(account.pvp.bestRating).toBe(PVP_RATING_START);
    expect(account.pvp.battles).toBe(0);
    expect(account.pvp.lastBattleAt).toBeNull();
    expect(account.referral).toEqual({ invitedBy: null, creditedAt: null, day: '2026-10-18', count: 0, invited: [] });
    // Документы до Части 1/2: нет заказов и клана — пустой список и null, а не падение.
    expect(account.orders).toEqual([]);
    expect(account.clanId).toBeNull();
  });

  it('четыре материала и срок станиумного модуля ездят в документ и обратно', async () => {
    const until = addMs(T0, 90 * MINUTE);
    const account = withTech(withStaniumField(playedAccount(), until), { chronium: 15, wolfram: 50, stanium: 20 });
    const restored = await roundtrip(account);

    expect(restored.materials).toEqual({
      asterium: account.materials.asterium,
      chronium: 15,
      wolfram: 50,
      stanium: 20,
      staniumFieldUntil: until
    });
    // Срок хранится датой, а не числом: редуктор модуля вызывает .getTime() без
    // приведения типов, и строка вместо Date превратила бы зарядку в NaN.
    expect(restored.materials.staniumFieldUntil).toBeInstanceOf(Date);
  });

  it('legacy-поле premium переезжает в materials.asterium при чтении и исчезает при записи', () => {
    const legacy = {
      _id: 'legacy-2',
      platform: 'vk',
      socialId: '2',
      createdAt: T0,
      lastLoginAt: T0,
      resources: { energy: 10, ferrum: 0, silicium: 0, uranium: 0, plasma: 0 },
      mined: { ferrum: 0, silicium: 0, uranium: 0, plasma: 0 },
      storageCapacity: 1000,
      miningRates: { ferrum: 50, silicium: 30, uranium: 8, plasma: 2 },
      lastLootTime: T0,
      energyUpdatedAt: T0,
      assist: { day: '2026-10-18', count: 0, helpers: [] },
      buildRobots: 2,
      premium: { purchased: 1234, earned: 56 },
      entitlements: [],
      ads: { day: '2026-10-18', claimed: 0, lastClaimAt: null, pending: null },
      revision: 7
    } as unknown as UserDoc;

    const account: UserAccount = toAccount(legacy);
    // Деньги игрока не исчезают с приходом четырёх материалов: астерий читается из
    // legacy-поля, а сырьё стартует нулём — его в старом документе не существовало.
    expect(account.materials).toEqual({
      asterium: { purchased: 1234, earned: 56 },
      chronium: 0,
      wolfram: 0,
      stanium: 0,
      staniumFieldUntil: null
    });

    // Обратный ход: $set пишет только materials, поэтому `premium` вымирает сам, по мере
    // сохранения документов, — без скрипта по коллекции и без риска задвоить деньги.
    const payload = toSetPayload(account) as Record<string, unknown>;
    expect(payload.materials).toMatchObject({ asterium: { purchased: 1234, earned: 56 } });
    expect('premium' in payload).toBe(false);
  });
});

