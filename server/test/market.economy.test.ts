import { describe, expect, it } from 'vitest';

import {
  MARKET_CORRIDORS,
  MARKET_PRICE_DYNAMICS,
  corridorAt,
  hardBoundsOf,
  marketCommission,
  priceWithinBounds,
  scarcityFactorOf
} from '../src/config/market.js';
import { JUNK_IDS, type JunkId } from '../src/config/workshop.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { MemoryCommodityStore } from '../src/modules/market/commodity.store.js';
import {
  NEUTRAL_FACTOR,
  commodityBounds,
  isRepriceDue,
  neutralCommodity,
  priceWithinCommodity,
  repriceCommodity,
  scarcityIndex,
  type CommodityState
} from '../src/modules/market/commodity.types.js';
import { MemoryLotStore } from '../src/modules/market/lot.store.js';
import { activateLot, buildLot } from '../src/modules/market/service.js';
import { buyLot, listLot, type MarketDeps } from '../src/modules/market/commit.js';
import { repriceMarket, type EconomyDeps } from '../src/modules/market/economy.js';
import { lotTotal, type LotState } from '../src/modules/market/lot.types.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { T0, addMs, newAccount, testConfig, withJunk, withResources } from './fixtures.js';

/**
 * Динамика коридоров цен (Часть 2, P5).
 *
 * Проверяется не «формула посчитала», а четыре свойства, без которых живая цена
 * хуже мёртвой:
 *
 *  1. ПОКОЙ. При эталонном предложении коридор обязан совпадать со статическим
 *     якорем — иначе «живая экономика» ломает рынок, который и так работал.
 *  2. ПРЕДЕЛЫ. Куда бы ни уехал множитель, границы остаются внутри
 *     [якорь × пол, якорь × потолок]. Динамика не имеет права вывести цену за
 *     границу, защищающую от демпинга против цеха и от тиража монеты.
 *  3. СКОРОСТЬ. За один пересчёт край сдвигается не чем на `maxMoveRatio`, а между
 *     пересчётами обязана быть пауза. Иначе одно крупное объявление обрушивает
 *     коридор под собой, и витрина дёргается на каждом запросе.
 *  4. ОДНОСТОРОННОСТЬ. Движение коридора не имеет права задним числом делать
 *     недействительным уже выставленное объявление.
 */

const D = MARKET_PRICE_DYNAMICS;

let seq = 0;

/** Лот, лежащий на рынке: `buildLot` + активация, а не рука написанный объект. */
function marketLot(junk: JunkId, amount: number, pricePerUnit: number, sellerId: string, id: string): LotState {
  const total = lotTotal(amount, pricePerUnit);
  const commission = marketCommission(total);
  const shell = buildLot(
    { junk, amount, pricePerUnit, total, commission, net: total - commission },
    sellerId,
    id,
    T0
  );
  return activateLot(shell, T0);
}

describe('market.scarcity: кривая дефицита', () => {
  it('рынок в покое даёт множитель ровно 1 — динамика не трогает работавший рынок', () => {
    for (const junk of JUNK_IDS) {
      const reference = MARKET_CORRIDORS[junk].referenceUnits;
      expect(scarcityFactorOf(reference, reference)).toBe(1);
    }
  });

  it('пустой рынок упирается в потолок, а не делит на ноль', () => {
    const factor = scarcityFactorOf(0, MARKET_CORRIDORS.chips.referenceUnits);
    expect(Number.isFinite(factor)).toBe(true);
    expect(factor).toBe(D.factorCeil);
  });

  it('затоваренный рынок упирается в пол и не уходит в отрицательные цены', () => {
    const factor = scarcityFactorOf(10_000_000, MARKET_CORRIDORS.chips.referenceUnits);
    expect(factor).toBe(D.factorFloor);
    expect(factor).toBeGreaterThan(0);
  });

  it('монотонно: чем больше предложения, тем ниже множитель', () => {
    const reference = MARKET_CORRIDORS.engines.referenceUnits;
    const points = [0, 50, reference, reference * 4, reference * 40].map((units) =>
      scarcityFactorOf(units, reference)
    );
    for (let i = 1; i < points.length; i++) {
      expect(points[i] as number).toBeLessThanOrEqual(points[i - 1] as number);
    }
  });

  it('дефицит ощущается сильнее профицита: половина эталона дорожает больше, чем вдвое дешевле', () => {
    const reference = MARKET_CORRIDORS.boards.referenceUnits;
    const scarce = scarcityFactorOf(reference / 2, reference);
    const glutted = scarcityFactorOf(reference * 2, reference);
    expect(scarce - 1).toBeGreaterThan(1 - glutted);
  });

  it('некорректный эталон не отравляет множитель', () => {
    expect(scarcityFactorOf(100, 0)).toBe(1);
    expect(scarcityFactorOf(Number.NaN, 100)).toBe(1);
    expect(scarcityFactorOf(-5, 100)).toBe(D.factorCeil);
  });
});

describe('market.corridor: границы под множитель', () => {
  it('множитель 1 возвращает якорь дословно — это точка покоя, а не приближение', () => {
    for (const junk of JUNK_IDS) {
      expect(corridorAt(junk, 1)).toEqual({
        minPerUnit: MARKET_CORRIDORS[junk].minPerUnit,
        maxPerUnit: MARKET_CORRIDORS[junk].maxPerUnit
      });
    }
  });

  it('оба края едут на одном множителе: ширина коридора — про разброс оценок, а не про уровень цен', () => {
    const anchor = corridorAt('engines', 1) as { minPerUnit: number; maxPerUnit: number };
    const moved = corridorAt('engines', 1.7) as { minPerUnit: number; maxPerUnit: number };
    expect(moved.minPerUnit / anchor.minPerUnit).toBeCloseTo(1.7, 2);
    expect(moved.maxPerUnit / anchor.maxPerUnit).toBeCloseTo(1.7, 2);
  });

  it('целые монеты и порядок краёв — при любом множителе, включая вырожденные', () => {
    for (const junk of JUNK_IDS) {
      for (const factor of [0.01, 0.5, 1, 1.333333, 2.25, 99]) {
        const bounds = corridorAt(junk, factor) as { minPerUnit: number; maxPerUnit: number };
        expect(Number.isInteger(bounds.minPerUnit)).toBe(true);
        expect(Number.isInteger(bounds.maxPerUnit)).toBe(true);
        expect(bounds.minPerUnit).toBeGreaterThanOrEqual(1);
        expect(bounds.maxPerUnit).toBeGreaterThanOrEqual(bounds.minPerUnit);
      }
    }
  });

  it('некорректный множитель откатывается к покою, а не к нулю цены', () => {
    expect(corridorAt('chips', Number.NaN)).toEqual(corridorAt('chips', 1));
    expect(corridorAt('chips', -3)).toEqual(corridorAt('chips', 1));
  });

  it('якорь лежит внутри абсолютных пределов', () => {
    for (const junk of JUNK_IDS) {
      const anchor = MARKET_CORRIDORS[junk];
      const hard = hardBoundsOf(junk) as { minPerUnit: number; maxPerUnit: number };
      expect(hard.minPerUnit).toBeLessThanOrEqual(anchor.minPerUnit);
      expect(hard.maxPerUnit).toBeGreaterThanOrEqual(anchor.maxPerUnit);
      expect(priceWithinBounds(hard, anchor.minPerUnit)).toBe(true);
    }
  });

  it('неторгуемый вид не получает ни коридора, ни предела', () => {
    expect(corridorAt('plasma_gun', 1)).toBeUndefined();
    expect(hardBoundsOf('chronium')).toBeUndefined();
  });
});

describe('market.reprice: редуктор товара', () => {
  const chips = (): CommodityState => neutralCommodity('chips', T0);

  it('покой: снапшот = якорь, индекс дефицита = 0', () => {
    const state = chips();
    expect(state.factor).toBe(NEUTRAL_FACTOR);
    expect(commodityBounds(state)).toEqual({
      minPerUnit: MARKET_CORRIDORS.chips.minPerUnit,
      maxPerUnit: MARKET_CORRIDORS.chips.maxPerUnit
    });
    expect(scarcityIndex(state)).toBe(0);
  });

  it('свежий снапшот пересчитываем сразу: иначе первый же запрос витрины заморозил бы якорь навсегда', () => {
    expect(isRepriceDue(chips(), T0)).toBe(true);
  });

  it('пауза держит: пересчёт раньше срока не двигает ни границу, ни ревизию', () => {
    const moved = repriceCommodity(chips(), 0, T0);
    expect(isRepriceDue(moved, addMs(T0, D.cooldownMs - 1))).toBe(false);
    const held = repriceCommodity(moved, 900_000, addMs(T0, D.cooldownMs - 1));
    expect(held).toBe(moved);
    expect(held.revision).toBe(moved.revision);
  });

  it('за один пересчёт граница сдвигается не больше чем на maxMoveRatio', () => {
    const scarce = repriceCommodity(chips(), 0, addMs(T0, D.cooldownMs));
    expect(scarce.factor).toBeCloseTo(1 + D.maxMoveRatio, 6);
    expect(scarce.revision).toBe(1);

    const glut = repriceCommodity(chips(), 10_000_000, addMs(T0, D.cooldownMs));
    expect(glut.factor).toBeCloseTo(1 - D.maxMoveRatio, 6);
  });

  it('сходимость: повторными шагами множитель доезжает до цели и не перелетает', () => {
    let state = chips();
    for (let i = 1; i <= 40; i++) state = repriceCommodity(state, 0, addMs(T0, D.cooldownMs * i));
    const target = scarcityFactorOf(0, MARKET_CORRIDORS.chips.referenceUnits);
    expect(state.factor).toBe(target);

    // Дальше дефицит не растёт: потолок множителя — не приглашение его превысить.
    state = repriceCommodity(state, 0, addMs(T0, D.cooldownMs * 41));
    expect(state.factor).toBe(target);
  });

  it('инвариант пределов: куда бы ни ехал рынок, границы внутри [якорь × пол, якорь × потолок]', () => {
    for (const junk of JUNK_IDS) {
      const hard = hardBoundsOf(junk) as { minPerUnit: number; maxPerUnit: number };
      let state = neutralCommodity(junk, T0);
      for (const supply of [0, 1, 30, 5_000, 40_000, 0, 200_000]) {
        state = repriceCommodity(state, supply, addMs(T0, D.cooldownMs));
        expect(state.minPerUnit).toBeGreaterThanOrEqual(hard.minPerUnit);
        expect(state.maxPerUnit).toBeLessThanOrEqual(hard.maxPerUnit);
        expect(state.minPerUnit).toBeLessThanOrEqual(state.maxPerUnit);
      }
    }
  });

  it('индекс дефицита ограничен [-1; +1] и знаково совпадает с множителем', () => {
    let scarce = chips();
    for (let i = 1; i <= 40; i++) scarce = repriceCommodity(scarce, 0, addMs(T0, D.cooldownMs * i));
    expect(scarcityIndex(scarce)).toBe(1);

    let glut = chips();
    for (let i = 1; i <= 40; i++) glut = repriceCommodity(glut, 9_000_000, addMs(T0, D.cooldownMs * i));
    expect(scarcityIndex(glut)).toBe(-1);
  });

  it('цена проверяется по ТЕКУЩЕМУ коридору, а не по якорю — в обе стороны', () => {
    // Затоваривание: коридор уехал ВНИЗ, и верх якоря больше не проходит.
    let glut = chips();
    for (let i = 1; i <= 40; i++) glut = repriceCommodity(glut, 9_000_000, addMs(T0, D.cooldownMs * i));
    expect(priceWithinCommodity(glut, MARKET_CORRIDORS.chips.maxPerUnit)).toBe(false);
    expect(priceWithinCommodity(glut, glut.maxPerUnit)).toBe(true);
    expect(priceWithinCommodity(glut, glut.minPerUnit - 1)).toBe(false);

    // Голод: коридор уехал ВВЕРХ, и низ якоря больше не проходит. Обратное
    // направление принципиально: при росте коридора старая верхняя цена якоря
    // остаётся внутри — и это правильно, граница двигается целиком.
    let scarce = chips();
    for (let i = 1; i <= 40; i++) scarce = repriceCommodity(scarce, 0, addMs(T0, D.cooldownMs * i));
    expect(priceWithinCommodity(scarce, MARKET_CORRIDORS.chips.minPerUnit)).toBe(false);
    expect(priceWithinCommodity(scarce, scarce.minPerUnit)).toBe(true);
    expect(priceWithinCommodity(scarce, MARKET_CORRIDORS.chips.maxPerUnit)).toBe(true);
  });

  it('шкала дефицита симметрична в логарифмах: ±удвоение — это ±одинаковая величина', () => {
    const double = neutralCommodity('chips', T0);
    const half = neutralCommodity('chips', T0);
    expect(scarcityIndex({ ...double, factor: 2 })).toBeGreaterThan(0);
    expect(scarcityIndex({ ...half, factor: 0.5 })).toBe(-1);
    // 1.0 — покой, и он обязан быть нулём: иначе витрина врёт игроку о ровном рынке.
    expect(scarcityIndex({ ...double, factor: 1 })).toBe(0);
    expect(Math.abs(scarcityIndex({ ...double, factor: 2 }))).toBeLessThanOrEqual(1);
  });
});

describe('market.economy: пересчёт по живому рынку', () => {
  function harness(): EconomyDeps & { lots: MemoryLotStore; commodities: MemoryCommodityStore } {
    const lots = new MemoryLotStore();
    const commodities = new MemoryCommodityStore();
    return { lots, commodities };
  }

  /** Прогоняет рынок через `rounds` пересчётов с соблюдением паузы. */
  async function advance(deps: EconomyDeps, rounds: number, from = T0): Promise<Date> {
    let now = from;
    for (let i = 0; i < rounds; i++) {
      await repriceMarket(deps, now);
      now = addMs(now, D.cooldownMs);
    }
    return now;
  }

  it('холодный старт создаёт ровно шесть товаров и больше не трогает их в паузу', async () => {
    const deps = harness();
    const first = await repriceMarket(deps, T0);
    expect(await deps.commodities.list()).toHaveLength(JUNK_IDS.length);
    expect(first.paused).toBe(0);
    expect(Object.keys(first.supply)).toHaveLength(JUNK_IDS.length);

    const before = await deps.commodities.find('chips');
    const second = await repriceMarket(deps, T0);
    expect(second.paused).toBe(JUNK_IDS.length);
    expect(second.moved).toHaveLength(0);
    const after = await deps.commodities.find('chips');
    expect(after?.revision).toBe(before?.revision);
    expect(after?.factor).toBe(before?.factor);
  });

  it('пустой рынок дорожает до потолка по всем шести видам', async () => {
    const deps = harness();
    await advance(deps, 12);
    for (const state of await deps.commodities.list()) {
      expect(state.supply).toBe(0);
      expect(state.factor).toBe(D.factorCeil);
    }
  });

  it('эталонное предложение оставляет коридор якорным — рынок в покое не платит за динамику', async () => {
    const deps = harness();
    const reference = MARKET_CORRIDORS.chips.referenceUnits;
    await deps.lots.insert(marketLot('chips', reference, MARKET_CORRIDORS.chips.minPerUnit, 's1', 'ref-1'));
    await repriceMarket(deps, T0);
    const chips = await deps.commodities.find('chips');
    expect(chips?.factor).toBe(NEUTRAL_FACTOR);
    expect(commodityBounds(chips as CommodityState)).toEqual({
      minPerUnit: MARKET_CORRIDORS.chips.minPerUnit,
      maxPerUnit: MARKET_CORRIDORS.chips.maxPerUnit
    });
  });

  it('затоваренный рынок дешевеет до пола, но не ниже абсолютного предела', async () => {
    const deps = harness();
    for (let i = 0; i < 20; i++) {
      await deps.lots.insert(marketLot('chips', 1_000, MARKET_CORRIDORS.chips.minPerUnit, `s${i}`, `flood-${i}`));
    }
    await advance(deps, 12);
    const chips = (await deps.commodities.find('chips')) as CommodityState;
    const hard = hardBoundsOf('chips') as { minPerUnit: number; maxPerUnit: number };
    expect(chips.supply).toBe(20_000);
    expect(chips.factor).toBe(D.factorFloor);
    expect(chips.minPerUnit).toBe(hard.minPerUnit);
    expect(chips.maxPerUnit).toBeLessThan(MARKET_CORRIDORS.chips.maxPerUnit);
  });

  it('в эскроу считается только витрина: зависшие, снятые и проданные лоты не делают рынок богаче', async () => {
    const deps = harness();
    await deps.lots.insert(marketLot('chips', 100, 50, 's1', 'live-1'));
    const shell = buildLot(
      { junk: 'chips', amount: 900, pricePerUnit: 50, total: 45_000, commission: 2_250, net: 42_750 },
      's1',
      'ghost-1',
      T0
    );
    await deps.lots.insert(shell);
    await deps.lots.insert({ ...marketLot('chips', 900, 50, 's1', 'gone-1'), status: 'cancelled' });
    await deps.lots.insert({ ...marketLot('engines', 500, 100, 's1', 'eng-1'), status: 'sold' });

    const supply = await deps.lots.sumActiveUnits();
    expect(supply.chips).toBe(100);
    expect(supply.engines).toBe(0);
    expect(supply.boards).toBe(0);

    const report = await repriceMarket(deps, T0);
    expect(report.supply.chips).toBe(100);
  });

  it('вид без единого лота отличается от вида с нулём: отсутствие предложения — сигнал, а не дырка', async () => {
    const deps = harness();
    await deps.lots.insert(marketLot('chips', 10, 50, 's1', 'only-chips'));
    const supply = await deps.lots.sumActiveUnits();
    for (const junk of JUNK_IDS) expect(typeof supply[junk]).toBe('number');
    expect(supply.engines).toBe(0);
  });
});

describe('market.listing: объявление подчиняется живому коридору', () => {
  const config = testConfig();

  async function tradeDeps(): Promise<MarketDeps> {
    return {
      users: new MemoryUserStore(),
      lots: new MemoryLotStore(),
      commodities: new MemoryCommodityStore(),
      ledger: new MemoryLedgerStore(),
      idFactory: () => `lot-${++seq}`
    };
  }

  function vendor(): UserAccount {
    return withResources(withJunk(newAccount(config, T0, `v-${++seq}`), { chips: 5_000 }), { sec: 10_000 });
  }

  async function refusal(fn: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await fn();
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  }

  /** Доводит коридор чипов до пола (затоваривание) или потолка (голод) без листингов. */
  async function forceCorridor(deps: MarketDeps, units: number, rounds = 12): Promise<CommodityState> {
    let now = T0;
    for (let i = 0; i < rounds; i++) {
      await deps.lots.save(marketLot('chips', units, MARKET_CORRIDORS.chips.minPerUnit, 'flood', `flood-${i}`));
      await repriceMarket(deps, now);
      now = addMs(now, D.cooldownMs);
    }
    return (await deps.commodities.find('chips')) as CommodityState;
  }

  it('затоваренный рынок отклоняет цену, которую якорь ещё разрешал', async () => {
    const deps = await tradeDeps();
    const chips = await forceCorridor(deps, 1_000);
    const anchorTop = MARKET_CORRIDORS.chips.maxPerUnit;
    expect(anchorTop).toBeGreaterThan(chips.maxPerUnit);

    const owner = vendor();
    await deps.users.save(owner);
    expect(await refusal(() => listLot(deps, owner.id, { junk: 'chips', amount: 10, pricePerUnit: anchorTop }, T0))).toBe(
      ErrorCodes.MARKET_PRICE_OUT_OF_RANGE
    );

    // Та же цена, что внутри живого коридора, проходит: отказ — про рынок, а не про лобби.
    expect(await refusal(() => listLot(deps, owner.id, { junk: 'chips', amount: 10, pricePerUnit: chips.maxPerUnit }, T0))).toBe(
      undefined
    );
  });

  it('голодный рынок поднимает низ: якорный минимум больше не проходит', async () => {
    const deps = await tradeDeps();
    // Голод: рынок пуст, пересчёты катим без листингов.
    let now = T0;
    for (let i = 0; i < 12; i++) {
      await repriceMarket(deps, now);
      now = addMs(now, D.cooldownMs);
    }
    const chips = (await deps.commodities.find('chips')) as CommodityState;
    expect(chips.minPerUnit).toBeGreaterThan(MARKET_CORRIDORS.chips.minPerUnit);

    const owner = vendor();
    await deps.users.save(owner);
    expect(
      await refusal(() =>
        listLot(deps, owner.id, { junk: 'chips', amount: 10, pricePerUnit: MARKET_CORRIDORS.chips.minPerUnit }, T0)
      )
    ).toBe(ErrorCodes.MARKET_PRICE_OUT_OF_RANGE);
  });

  it('выставленный лот не аннулируется задним числом: коридор — контракт новых объявлений', async () => {
    const deps = await tradeDeps();
    const owner = vendor();
    const buyer = withResources(newAccount(config, T0, `b-${++seq}`), { sec: 100_000 });
    await deps.users.save(owner);
    await deps.users.save(buyer);

    // Спокойный рынок: цена 200 за чип — верх якоря, и он принят.
    const { lot } = await listLot(deps, owner.id, { junk: 'chips', amount: 10, pricePerUnit: 200 }, T0);
    expect(lot.pricePerUnit).toBe(200);

    // Рынок затоваривается, коридор уезжает вниз за цену лота.
    const chips = await forceCorridor(deps, 1_000);
    expect(chips.maxPerUnit).toBeLessThan(lot.pricePerUnit);

    // Лот всё ещё выкупаем по своей цене: иначе игрок потерял бы хлам в эскроу за
    // то, что рынок двигался без его участия.
    const bought = await buyLot(deps, buyer.id, lot.id, T0, config.economy);
    expect(bought.lot.pricePerUnit).toBe(200);
    expect(bought.settled).toBe(true);
    const goods = await deps.users.findById(buyer.id);
    expect(goods?.junk.chips).toBe(10);
  });

  it('пересчёт не трогает витрину: лоты стоят, пока их не выкупили или не сняли', async () => {
    const deps = await tradeDeps();
    const owner = vendor();
    await deps.users.save(owner);
    const { lot } = await listLot(deps, owner.id, { junk: 'chips', amount: 10, pricePerUnit: 100 }, T0);

    let now = T0;
    for (let i = 0; i < 6; i++) {
      await repriceMarket(deps, now);
      now = addMs(now, D.cooldownMs);
    }
    const after = await deps.lots.findById(lot.id);
    expect(after?.status).toBe('listed');
    expect(after?.revision).toBe(lot.revision);
  });
});



