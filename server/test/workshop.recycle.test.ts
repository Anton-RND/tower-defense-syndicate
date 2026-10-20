import { describe, expect, it } from 'vitest';

import { RECYCLE_MAX_BATCH, getBlueprint } from '../src/config/workshop.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { settleBuilds, startBuild } from '../src/modules/workshop/craft.js';
import { dismantleItem, rollScrap, salvageYield } from '../src/modules/workshop/dismantle.js';
import { recycleJunk } from '../src/modules/workshop/recycle.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MINUTE, T0, addMs, errorCode, fixedRng, newAccount, testConfig, withJunk, withMetals, withResources, withTech } from './fixtures.js';

const config = testConfig();
let seq = 0;
const idFactory = () => `gen-${++seq}`;

const LASER = 'tower_laser_mk1';
const PLASMA = 'tower_plasma_mk3';

function funded() {
  const resources = withResources(newAccount(config), { ferrum: 10_000, silicium: 10_000, uranium: 5000, plasma: 5000 });
  const junk = withJunk(resources, { chips: 20, engines: 10, boards: 10 });
  const metals = withMetals(junk, {
    black_metal: 2000,
    colored_metal: 2000,
    precious_metal: 2000
  });
  // Сырьё тоже «оплаченное»: чертежи 2–3 тира берут вольфрам, и без него фикстура
  // перестала бы строить то, что обязана строить, — тест падал бы на старте крафта.
  return withTech(metals, { chronium: 200, wolfram: 500, stanium: 200 });
}

/** Аккаунт с одним готовым предметом в инвентаре (полный цикл: крафт → дожатие очереди). */
function withItem(code: string = LASER, buildMs = 10 * MINUTE) {
  const started = startBuild(funded(), code, T0, idFactory);
  const settled = settleBuilds(started.account, addMs(T0, buildMs), idFactory);
  const item = settled.items[0];
  if (!item) throw new Error('фикстура: предмет не появился в инвентаре');
  return { account: settled.account, item };
}

function blueprintOf(code: string) {
  const blueprint = getBlueprint(code);
  if (!blueprint) throw new Error(`нет чертежа ${code}`);
  return blueprint;
}

describe('деконструкция: salvage — возврат материалов', () => {
  it('возвращает 50% вложенного и удаляет предмет', () => {
    const { account, item } = withItem();
    const before = { ...account.resources };

    const result = dismantleItem(account, item.id, 'salvage', T0, idFactory);

    expect(result.mode).toBe('salvage');
    expect(result.salvage).toEqual({ ferrum: 100, silicium: 50, chips: 1 });
    expect(result.junk).toEqual({});
    expect(result.account.resources.ferrum).toBe(before.ferrum + 100);
    expect(result.account.resources.silicium).toBe(before.silicium + 50);
    expect(result.account.junk.chips).toBe(19);
    expect(result.account.inventory).toHaveLength(0);
    expect(result.drafts.map((draft) => draft.currency)).toEqual(['ferrum', 'silicium', 'junk_chips']);
    expect(result.drafts.every((draft) => draft.reason === 'dismantle')).toBe(true);
    expect(result.drafts.every((draft) => draft.refType === 'item' && draft.refId === item.id)).toBe(true);
    // Ключ на материал: одно действие — несколько валют.
    expect(new Set(result.drafts.map((draft) => draft.idempotencyKey)).size).toBe(result.drafts.length);
  });

  it('предмет выше 1 уровня возвращает больше (надбавка за прокачку)', () => {
    const plasma = blueprintOf(PLASMA);
    expect(salvageYield(plasma, 1).precious_metal).toBe(48);
    expect(salvageYield(plasma, 3).precious_metal).toBe(96);
  });

  it('salvage тира III возвращает металлы, сырьё и хлам-компоненты', () => {
    const { account, item } = withItem(PLASMA, 180 * MINUTE);
    const result = dismantleItem(account, item.id, 'salvage', T0, idFactory);

    expect(result.salvage).toEqual({
      ferrum: 720,
      uranium: 180,
      colored_metal: 120,
      precious_metal: 48,
      wolfram: 24,
      engines: 1
    });
    // Крафт потратил 200 цветного, 80 драгоценного и 40 вольфрама — считаем от остатка, а не от нормы.
    expect(result.account.metals.precious_metal).toBe(2000 - 80 + 48);
    expect(result.account.metals.colored_metal).toBe(2000 - 200 + 120);
    expect(result.account.materials.wolfram).toBe(500 - 40 + 24);
    expect(result.drafts.map((draft) => draft.currency)).toEqual([
      'ferrum',
      'uranium',
      'colored_metal',
      'precious_metal',
      'wolfram',
      'junk_engines'
    ]);
  });
});

describe('деконструкция: scrap — утилизация в хлам', () => {
  it('бросок таблицы детерминирован при инжектированном ГСЧ', () => {
    const { account, item } = withItem();
    // chips: шанс 0.9 пройден (0.0) -> количество по 0.5 => 2 шт;
    // boards: шанс 0.35 не пройден (0.99); гильзы: гарантия (шанс 1) -> минимум 2.
    const result = dismantleItem(account, item.id, 'scrap', T0, idFactory, fixedRng(0.0, 0.5, 0.99, 0.0));

    expect(result.junk).toEqual({ chips: 2, ammo_casings: 2 });
    expect(result.salvage).toEqual({});
    expect(result.account.resources.ferrum).toBe(9800);
    expect(result.drafts.map((draft) => draft.currency)).toEqual(['junk_chips', 'junk_ammo_casings']);
  });

  it('rollScrap на чистом нуле даёт минимумы гарантийных таблиц', () => {
    const drops = rollScrap(blueprintOf(LASER), fixedRng(0));
    expect(drops.chips).toBe(1);
    expect(drops.ammo_casings).toBe(2);
  });

  it('dismantle догоняет очередь: только что достроенное разбирается', () => {
    const { account, item } = withItem();
    const started = startBuild(account, LASER, T0, idFactory);
    const ready = addMs(T0, 10 * MINUTE);
    // Новый предмет ещё не в инвентаре — он там появится только от settleBuilds.
    expect(started.account.inventory).toHaveLength(1);

    const result = dismantleItem(started.account, item.id, 'salvage', ready, idFactory);
    expect(result.account.inventory).toHaveLength(1);
    expect(result.account.inventory[0]?.id).not.toBe(item.id);
    expect(result.account.builds).toHaveLength(0);
  });
});

describe('деконструкция: ошибки', () => {
  it('несуществующий предмет — ITEM_NOT_FOUND', () => {
    const { account } = withItem();
    expect(errorCode(() => dismantleItem(account, 'no-such-item', 'salvage', T0, idFactory))).toBe(
      ErrorCodes.ITEM_NOT_FOUND
    );
  });

  it('неизвестный режим — INVALID_DISMANTLE_MODE', () => {
    const { account, item } = withItem();
    expect(errorCode(() => dismantleItem(account, item.id, 'explode', T0, idFactory))).toBe(
      ErrorCodes.INVALID_DISMANTLE_MODE
    );
  });
});

const rules = config.economy;

describe('цех переработки: хлам → металлы', () => {
  it('чипы дают драгоценный и цветной металл плюс хрониум, хлам списывается', () => {
    const result = recycleJunk(withJunk(newAccount(config), { chips: 10 }), 'chips', 10, T0, rules);

    expect(result.yielded).toEqual({ precious_metal: 20, colored_metal: 10, chronium: 10 });
    expect(result.account.metals).toEqual({ black_metal: 0, colored_metal: 10, precious_metal: 20 });
    // Хрониум — единственный игровой кран «времени»: он выходит только из микросхем.
    expect(result.account.materials.chronium).toBe(10);
    expect(result.account.materials.asterium).toEqual({ purchased: 0, earned: 0 });
    expect(result.account.junk.chips).toBe(0);
    expect(result.junkLeft).toBe(0);
    expect(result.drafts.map((draft) => draft.currency)).toEqual([
      'junk_chips',
      'precious_metal',
      'colored_metal',
      'chronium'
    ]);
    expect(result.drafts.map((draft) => draft.delta)).toEqual([-10, 20, 10, 10]);
    expect(result.drafts.every((draft) => draft.reason === 'recycle')).toBe(true);
  });

  it('двигатели — чёрный металл и вольфрам, батареи — цветмет, станиум и энергия', () => {
    const engines = recycleJunk(withJunk(newAccount(config), { engines: 4 }), 'engines', 4, T0, rules);
    expect(engines.yielded).toEqual({ black_metal: 20, colored_metal: 8, wolfram: 4 });
    expect(engines.account.materials.wolfram).toBe(4);

    // Новичок стартует с полной энергией, поэтому заряжаем аккумулятор заранее:
    // иначе проверка «батарейки дают энергию» превратится в проверку «всё сгорело о верстак».
    const batteries = recycleJunk(
      withJunk(withResources(newAccount(config), { energy: 50 }), { batteries: 5 }),
      'batteries',
      5,
      T0,
      rules
    );
    expect(batteries.yielded).toEqual({ colored_metal: 20, stanium: 5 });
    expect(batteries.account.materials.stanium).toBe(5);
    expect(batteries.energy).toBe(10);
    expect(batteries.wastedEnergy).toBe(0);
    expect(batteries.account.resources.energy).toBe(60);
  });

  it('доски — единственный рецепт без сырья: широкий кран материала обнуляет магазин', () => {
    const boards = recycleJunk(withJunk(newAccount(config), { boards: 6 }), 'boards', 6, T0, rules);

    expect(boards.yielded).toEqual({ precious_metal: 6, colored_metal: 18 });
    expect(boards.account.materials.chronium).toBe(0);
    expect(boards.account.materials.wolfram).toBe(0);
    expect(boards.account.materials.stanium).toBe(0);
  });

  it('энергия уважает кап: излишек считается, а не исчезает молча', () => {
    const account = withJunk(withResources(newAccount(config), { energy: rules.energyCap - 3 }), { batteries: 5 });
    const result = recycleJunk(account, 'batteries', 5, T0, rules);

    expect(result.energy).toBe(3);
    expect(result.wastedEnergy).toBe(7);
    expect(result.account.resources.energy).toBe(rules.energyCap);
  });

  it('валидация партии и типа хлама', () => {
    const account = withJunk(newAccount(config), { boards: 5 });
    expect(errorCode(() => recycleJunk(account, 'boards', 0, T0, rules))).toBe(ErrorCodes.RECYCLE_BATCH_INVALID);
    expect(errorCode(() => recycleJunk(account, 'boards', 2.5, T0, rules))).toBe(ErrorCodes.RECYCLE_BATCH_INVALID);
    expect(errorCode(() => recycleJunk(account, 'boards', RECYCLE_MAX_BATCH + 1, T0, rules))).toBe(
      ErrorCodes.RECYCLE_BATCH_INVALID
    );
    expect(errorCode(() => recycleJunk(account, 'planks', 1, T0, rules))).toBe(ErrorCodes.VALIDATION_ERROR);
    expect(errorCode(() => recycleJunk(account, 'boards', 6, T0, rules))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
    expect(account.junk.boards).toBe(5);
  });

  it('ключ идемпотентности переживает ретрай клиента в журнале', async () => {
    const player = withJunk(newAccount(config), { chips: 10 });
    const result = recycleJunk(player, 'chips', 5, T0, rules, { idempotencyKey: 'req-77' });
    const store = new MemoryLedgerStore();
    await store.connect();

    // Ключ ОБЯЗАН нести id игрока: Idempotency-Key присылает клиент, и одинаковые «1»
    // у двух аккаунтов — норма, а не экзотика. Без привязки второй игрок остался бы
    // без аудиторского следа (уникальность ключа в журнале глобальная).
    expect(result.drafts[0]?.idempotencyKey).toBe(`recycle:${player.id}:req-77:chips`);
    expect(await store.appendMany(result.drafts.map((draft, i) => ({ ...draft, id: `a${i}` })))).toBe(
      result.drafts.length
    );
    expect(await store.appendMany(result.drafts.map((draft, i) => ({ ...draft, id: `b${i}` })))).toBe(0);
  });

  it('одинаковый клиентский ключ двух игроков не съедает записи второго', async () => {
    const first = withJunk(newAccount(config), { chips: 10 });
    const second = withJunk(newAccount(config), { chips: 10 });
    const a = recycleJunk(first, 'chips', 5, T0, rules, { idempotencyKey: 'req-1' });
    const b = recycleJunk(second, 'chips', 5, T0, rules, { idempotencyKey: 'req-1' });
    const store = new MemoryLedgerStore();
    await store.connect();

    expect(a.drafts[0]?.idempotencyKey).not.toBe(b.drafts[0]?.idempotencyKey);
    expect(await store.appendMany(a.drafts.map((draft, i) => ({ ...draft, id: `a${i}` })))).toBe(a.drafts.length);
    expect(await store.appendMany(b.drafts.map((draft, i) => ({ ...draft, id: `b${i}` })))).toBe(b.drafts.length);
    expect(await store.count(first.id)).toBe(a.drafts.length);
    expect(await store.count(second.id)).toBe(b.drafts.length);
  });
});

