import { describe, expect, it } from 'vitest';

import { MARKET_COMMISSION, MARKET_CORRIDORS, MARKET_MAX_ACTIVE_LOTS } from '../src/config/market.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { makeIdempotencyKey } from '../src/modules/ledger/ledger.types.js';
import { MemoryLotStore } from '../src/modules/market/lot.store.js';
import { MemoryCommodityStore } from '../src/modules/market/commodity.store.js';
import { lotTotal, type LotState } from '../src/modules/market/lot.types.js';
import {
  buyLot,
  cancelLot,
  listLot,
  reconcileMarket,
  type MarketDeps
} from '../src/modules/market/commit.js';
import { checkListing, claimLot, lotNet, buildLot } from '../src/modules/market/service.js';
import { describeLot, describeMarket, describeMarketRules } from '../src/modules/market/view.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { T0, addMs, errorCode, newAccount, testConfig, withJunk, withResources } from './fixtures.js';
/**
 * Чёрный рынок (Часть 2, P4).
 *
 * Домен двигает ТРИ состояния чужими руками: хлам продавца, монету покупателя и
 * монету продавца. Поэтому проверяется не «работает ли кнопка», а три инварианта:
 *
 *  1. ценность не создаётся и не исчезает молча — расхождение суммарного SEC двоих
 *     равно ровно комиссии, и ни единицей больше;
 *  2. отказ ничего не стоит: после любого 409/400 балансы игрока такие же, как были;
 *  3. прерванная операция закрывается разбором по доказательству в журнале, а не
 *     по надежде на статус документа.
 */

const config = testConfig();
const rules = config.economy;

let seq = 0;
const idFactory = () => `lot-${++seq}`;

function trader(seed = `mkt-${++seq}`): UserAccount {
  return newAccount(config, T0, seed);
}

/** Продавец: 100 чипов в запасе и 1000 SEC в кошельке. */
function seller(): UserAccount {
  return withResources(withJunk(trader(), { chips: 100, engines: 20 }), { sec: 1000 });
}

async function harness() {
  return {
    users: new MemoryUserStore(),
    lots: new MemoryLotStore(),
    commodities: new MemoryCommodityStore(),
    ledger: new MemoryLedgerStore(),
    idFactory
  };
}

/**
 * Сохраняет участников в стор.
 *
 * Домен читает документы ТОЛЬКО из стора (`findById`/`transact`), поэтому аккаунт,
 * созданный фикстурой и не сохранённый, для него не существует: тест упал бы с
 * «Игрок не найден» вместо проверяемого отказа. В клановых тестах ту же роль играет
 * `withClan`, сохраняющий лидера перед операцией.
 */
async function seed(deps: MarketDeps, ...accounts: UserAccount[]): Promise<void> {
  for (const account of accounts) await deps.users.save(account);
}

/**
 * Код отказа АСИНХРОННОГО протокола.
 *
 * Отдельная функция, а не `errorCode` из фикстур, потому что `errorCode` ловит
 * синхронные броски: переданный в него `buyLot(...)` вернул бы Promise, отказ стал бы
 * unhandled rejection, а тест — зелёным или падением не по делу. Здесь же отказ
 * дождаться обязательно.
 */
async function refusal(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}


/** Выставленный и подтверждённый эскроу лот: 10 чипов по 50 SEC = 500. */
async function listed(deps: MarketDeps, who: UserAccount, amount = 10, pricePerUnit = 50) {
  await deps.users.save(who);
  return listLot(deps, who.id, { junk: 'chips', amount, pricePerUnit }, T0);
}

const escrowProof = (deps: MarketDeps, lotId: string) =>
  deps.ledger.hasKey(makeIdempotencyKey('market', `${lotId}:escrow`));

/**
 * Оболочка лота вставленная, но не подтверждённая эскроу — ровно то состояние,
 * которое остаётся после падения между шагом 1 и шагом 2 протокола выставления.
 * Выводится из `buildLot`, а не пишется руками: иначе тест проверял бы свою же
 * фикстуру, а не домен.
 */
function shellOf(who: UserAccount, lotId: string, amount = 5, pricePerUnit = 50): LotState {
  const total = lotTotal(amount, pricePerUnit);
  const commission = Math.floor(total * MARKET_COMMISSION);
  return buildLot(
    { junk: 'chips', amount, pricePerUnit, total, commission, net: total - commission },
    who.id,
    lotId,
    T0
  );
}


describe('market.listing: хлам уходит в эскроу, лот выходит в витрину', () => {
  it('списание происходит в момент выставления, а не обещается на потом', async () => {
    const deps = await harness();
    const owner = seller();
    const { lot, account } = await listed(deps, owner);

    expect(lot.status).toBe('listed');
    expect(account.junk.chips).toBe(owner.junk.chips - 10);
    expect(await deps.lots.countActiveBySeller(owner.id)).toBe(1);
    expect(await escrowProof(deps, lot.id)).toBe(true);
  });

  it('цена вне коридора — отказ, и склад продавца не тронут', async () => {
    const deps = await harness();
    const owner = seller();
    const cheap = { junk: 'chips' as const, amount: 10, pricePerUnit: MARKET_CORRIDORS.chips.minPerUnit - 1 };
    const dear = { junk: 'chips' as const, amount: 10, pricePerUnit: MARKET_CORRIDORS.chips.maxPerUnit + 1 };

    await seed(deps, owner);
    expect(errorCode(() => checkListing(owner, cheap))).toBe(ErrorCodes.MARKET_PRICE_OUT_OF_RANGE);
    expect(errorCode(() => checkListing(owner, dear))).toBe(ErrorCodes.MARKET_PRICE_OUT_OF_RANGE);
    expect(await refusal(() => listLot(deps, owner.id, cheap, T0))).toBe(ErrorCodes.MARKET_PRICE_OUT_OF_RANGE);
    expect(await refusal(() => listLot(deps, owner.id, dear, T0))).toBe(ErrorCodes.MARKET_PRICE_OUT_OF_RANGE);

    const fresh = await deps.users.findById(owner.id);
    expect(fresh?.junk.chips).toBe(owner.junk.chips);
    expect(await deps.lots.countActiveBySeller(owner.id)).toBe(0);
  });

  it('не хватает хлама — отказ по конкретному виду, а не по «средствам» вообще', async () => {
    const deps = await harness();
    const poor = withResources(withJunk(trader(), { chips: 3 }), { sec: 100 });
    await deps.users.save(poor);
    try {
      await listLot(deps, poor.id, { junk: 'chips', amount: 10, pricePerUnit: 50 }, T0);
      throw new Error('ожидался отказ');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
      expect((error as { details?: { currency?: string } }).details?.currency).toBe('junk_chips');
    }
  });

  it('потолок активных лотов держится: следующий после лимита — MARKET_LOT_LIMIT', async () => {
    const deps = await harness();
    const owner = withResources(withJunk(trader(), { chips: 10_000 }), { sec: 0 });
    await seed(deps, owner);
    for (let i = 0; i < MARKET_MAX_ACTIVE_LOTS; i++) {
      await listLot(deps, owner.id, { junk: 'chips', amount: 1, pricePerUnit: 50 }, T0);
    }
    expect(await deps.lots.countActiveBySeller(owner.id)).toBe(MARKET_MAX_ACTIVE_LOTS);
    expect(
      await refusal(() => listLot(deps, owner.id, { junk: 'chips', amount: 1, pricePerUnit: 50 }, T0))
    ).toBe(ErrorCodes.MARKET_LOT_LIMIT);
  });
});

describe('market.buy: три состояния сходятся, комиссия сгорает', () => {
  it('покупатель платит полную цену, продавец получает чистыми за вычетом комиссии', async () => {
    const deps = await harness();
    const owner = seller();
    const buyer = withResources(trader(), { sec: 1000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, buyer);

    const bought = await buyLot(deps, buyer.id, lot.id, T0, rules);
    const commission = Math.floor(lot.total * MARKET_COMMISSION);
    expect(bought.settled).toBe(true);
    expect(bought.lot.status).toBe('sold');
    expect(bought.lot.payoutSettled).toBe(true);
    expect(bought.buyer.resources.sec).toBeCloseTo(buyer.resources.sec - lot.total, 6);
    expect(bought.seller?.resources.sec).toBeCloseTo(owner.resources.sec + lot.total - commission, 6);
    expect(lotNet(bought.lot)).toBe(lot.total - commission);
  });

  it('СУММАРНАЯ монета двоих проседает ровно на комиссию — это сток, а не только перевод', async () => {
    const deps = await harness();
    const owner = seller();
    const buyer = withResources(trader(), { sec: 1000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, buyer);
    const before = owner.resources.sec + buyer.resources.sec;

    const bought = await buyLot(deps, buyer.id, lot.id, T0, rules);
    const after = (bought.seller?.resources.sec ?? 0) + bought.buyer.resources.sec;

    expect(before - after).toBe(Math.floor(lot.total * MARKET_COMMISSION));
  });

  it('товар переезжает покупателю, а не «учитывается» в лоте', async () => {
    const deps = await harness();
    const owner = seller();
    const buyer = withResources(trader(), { sec: 1000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, buyer);

    const bought = await buyLot(deps, buyer.id, lot.id, T0, rules);
    const sellerAfter = await deps.users.findById(owner.id);
    expect(bought.buyer.junk.chips).toBe(buyer.junk.chips + 10);
    expect(sellerAfter?.junk.chips).toBe(owner.junk.chips - 10);
  });

  it('свой лот не выкупишь: способ перегнать заработанное в SEC закрыт', async () => {
    const deps = await harness();
    const owner = seller();
    const { lot } = await listed(deps, owner);
    expect(await refusal(() => buyLot(deps, owner.id, lot.id, T0, rules))).toBe(ErrorCodes.MARKET_SELF_PURCHASE);
  });

  it('не хватает монеты — отказ, лот остаётся в витрине, монета цела', async () => {
    const deps = await harness();
    const owner = seller();
    const broke = withResources(trader(), { sec: 10 });
    const { lot } = await listed(deps, owner);
    await seed(deps, broke);

    expect(await refusal(() => buyLot(deps, broke.id, lot.id, T0, rules))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);

    const after = await deps.lots.findById(lot.id);
    expect(after?.status).toBe('listed');
    const buyerAfter = await deps.users.findById(broke.id);
    expect(buyerAfter?.resources.sec).toBe(10);
  });

  it('переполненный склад покупателя — отказ и возврат захвата, а не тихая потеря товара', async () => {
    // Отличие от лута защитника (P0) принципиальное: там переполнение `skipped`,
    // потому что бой уже засчитан; здесь игрок платит, и «денег лишили, товар не
    // выдали» — недопустимо. Лот обязан вернуться в витрину и быть купленным другим.
    const deps = await harness();
    const owner = seller();
    const stuffed = withResources(withJunk(trader(), { chips: rules.limits.loot.junkCap }), { sec: 5000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, stuffed);

    expect(await refusal(() => buyLot(deps, stuffed.id, lot.id, T0, rules))).toBe(ErrorCodes.JUNK_CAP_REACHED);

    const after = await deps.lots.findById(lot.id);
    expect(after?.status).toBe('listed');
    expect(after?.buyerId).toBeNull();
    const buyerAfter = await deps.users.findById(stuffed.id);
    expect(buyerAfter?.resources.sec).toBeCloseTo(5000, 6);
  });

  it('гонка двух покупателей: товар у одного, второй получает отказ и сохраняет монету', async () => {
    const deps = await harness();
    const owner = seller();
    const first = withResources(trader(), { sec: 1000 });
    const second = withResources(trader(), { sec: 1000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, first, second);

    const won = await buyLot(deps, first.id, lot.id, T0, rules);
    expect(won.settled).toBe(true);
    expect(await refusal(() => buyLot(deps, second.id, lot.id, T0, rules))).toBe(ErrorCodes.MARKET_LOT_TAKEN);

    const loser = await deps.users.findById(second.id);
    expect(loser?.resources.sec).toBeCloseTo(1000, 6);
    expect(loser?.junk.chips).toBe(0);
  });
});

describe('market.reconcile: прерванная операция закрывается журналом, а не статусом', () => {
  /**
   * Запись движения «как будто уже записана»: так выглядит падение между шагами.
   *
   * Именно ЗАПИСЬ, а не черновик: `appendMany` принимает журнал фактов с `id`, и
   * подсовывать ему черновик — то же самое, что писать в базу рынок без
   * идентификаторов движения. Раньше тест так и делал, и это была та же дыра, что
   * и в `commitDrafts`: тип `LedgerEntry` не давал её не заметить.
   */
  function fakeDraft(userId: string, key: string, currency: string, delta: number, ts: Date) {
    return {
      id: `entry-${key}`,
      userId,
      currency: currency as never,
      delta,
      balanceAfter: 0,
      reason: 'market_trade' as const,
      refType: 'lot' as const,
      refId: key,
      idempotencyKey: key,
      ts
    };
  }

  it('лот без доказательства эскроу снимается: витрина не имеет права показывать воздух', async () => {
    const deps = await harness();
    const owner = seller();
    await deps.users.save(owner);
    await deps.lots.insert(shellOf(owner, 'ghost-lot'));

    const result = await reconcileMarket(deps, T0);
    const after = await deps.lots.findById('ghost-lot');
    expect(after?.status).toBe('cancelled');
    expect(result.activated).toBe(0);
    // Товар не списывался — возвращать нечего, склад обязан быть нетронут.
    const fresh = await deps.users.findById(owner.id);
    expect(fresh?.junk.chips).toBe(owner.junk.chips);
  });

  it('лот С доказательством эскроу выходит в витрину, а не отменяется', async () => {
    const deps = await harness();
    const owner = seller();
    await deps.users.save(owner);
    await deps.lots.insert(shellOf(owner, 'half-lot'));
    // Списание состоялось (запись в журнале есть), а активация потерялась.
    await deps.users.transact(owner.id, (current) => ({
      ...current,
      junk: { ...current.junk, chips: current.junk.chips - 5 }
    }));
    await deps.ledger.appendMany([
      fakeDraft(owner.id, makeIdempotencyKey('market', 'half-lot:escrow'), 'junk_chips', -5, T0)
    ]);

    const result = await reconcileMarket(deps, T0);
    const after = await deps.lots.findById('half-lot');
    expect(after?.status).toBe('listed');
    expect(result.activated).toBe(1);
  });

  it('проданное без выплаты доводится до продавца по записи о деньгах покупателя', async () => {
    const deps = await harness();
    const owner = seller();
    const buyer = withResources(trader(), { sec: 5000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, buyer);

    // Падение между «деньги покупателя списаны» и «продавец получил».
    const claimed = await deps.lots.transact(lot.id, (current) => claimLot(current, buyer.id, T0));
    await deps.users.transact(buyer.id, (current) => ({
      ...current,
      resources: { ...current.resources, sec: current.resources.sec - claimed.total }
    }));
    await deps.ledger.appendMany([
      fakeDraft(buyer.id, makeIdempotencyKey('market', `${claimed.id}:sec`), 'sec', -claimed.total, T0)
    ]);

    const result = await reconcileMarket(deps, T0);
    expect(result.paidOut).toBe(1);

    const settled = await deps.lots.findById(claimed.id);
    expect(settled?.payoutSettled).toBe(true);
    const paid = await deps.users.findById(owner.id);
    const commission = Math.floor(claimed.total * MARKET_COMMISSION);
    expect(paid?.resources.sec).toBeCloseTo(owner.resources.sec + claimed.total - commission, 6);
  });

  it('проданное БЕЗ доказательства денег возвращается в витрину, а не висит мёртвым грузом', async () => {
    const deps = await harness();
    const owner = seller();
    const buyer = withResources(trader(), { sec: 5000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, buyer);

    // Падение между захватом и списанием: товар заморожен, денег нет.
    await deps.lots.transact(lot.id, (current) => claimLot(current, buyer.id, T0));
    const result = await reconcileMarket(deps, T0);

    const after = await deps.lots.findById(lot.id);
    expect(after?.status).toBe('listed');
    expect(after?.buyerId).toBeNull();
    expect(result.paidOut).toBe(0);
    // И его можно купить по-настоящему.
    const bought = await buyLot(deps, buyer.id, lot.id, T0, rules);
    expect(bought.settled).toBe(true);
  });

  it('просроченный лот возвращает хлам продавцу даже поверх полного склада', async () => {
    // Возврат не обязан вписываться в потолок: сжечь товар игрока из-за того, что его
    // ящик забился, пока лот висел, — худший из исходов (см. service.returnJunk).
    const deps = await harness();
    const cap = rules.limits.loot.junkCap;
    const owner = withResources(withJunk(trader(), { chips: cap - 2 }), { sec: 0 });
    const { lot } = await listed(deps, owner, 2, 50);
    expect((await deps.users.findById(owner.id))?.junk.chips).toBe(cap - 4);

    // Склад успел забиться рейдами, пока лот висел: возврат обязан выйти ЗА потолок.
    await deps.users.transact(owner.id, (current) => ({
      ...current,
      junk: { ...current.junk, chips: current.junk.chips + 4 }
    }));
    expect((await deps.users.findById(owner.id))?.junk.chips).toBe(cap);

    const later = addMs(T0, 25 * 60 * 60_000);
    const result = await reconcileMarket(deps, later);
    expect(result.expired).toBe(1);

    const after = await deps.lots.findById(lot.id);
    expect(after?.status).toBe('expired');
    const fresh = await deps.users.findById(owner.id);
    // Потолок ПРОСРЕЧЕН на 2 единицы — и это верный ответ: товар вернулся весь.
    expect(fresh?.junk.chips).toBe(cap + 2);
  });
});

describe('market.cancel и витрина', () => {
  it('снятый лот возвращает хлам и исчезает из витрины', async () => {
    const deps = await harness();
    const owner = seller();
    const { lot } = await listed(deps, owner);

    const cancelled = await cancelLot(deps, owner.id, lot.id, T0);
    expect(cancelled.lot.status).toBe('cancelled');
    expect(cancelled.account.junk.chips).toBe(owner.junk.chips);
    expect(await deps.lots.listActive({ limit: 10 })).toEqual([]);
  });

  it('чужой лот не снимется', async () => {
    const deps = await harness();
    const owner = seller();
    const thief = trader();
    const { lot } = await listed(deps, owner);
    await deps.users.save(thief);
    expect(await refusal(() => cancelLot(deps, thief.id, lot.id, T0))).toBe(ErrorCodes.FORBIDDEN);
  });

  it('проданный лот нельзя снять: деньги уже в пути', async () => {
    const deps = await harness();
    const owner = seller();
    const buyer = withResources(trader(), { sec: 1000 });
    const { lot } = await listed(deps, owner);
    await seed(deps, buyer);
    await buyLot(deps, buyer.id, lot.id, T0, rules);
    expect(await refusal(() => cancelLot(deps, owner.id, lot.id, T0))).toBe(ErrorCodes.MARKET_LOT_TAKEN);
  });

  it('витрина показывает покупателю чужие лоты, а продавцу — его собственные', async () => {
    const deps = await harness();
    const owner = seller();
    const viewer = withResources(trader(), { sec: 1000 });
    const { lot } = await listed(deps, owner);

    const market = describeMarket(await deps.lots.listActive({ limit: 10 }), viewer, 10);
    expect(market.lots).toHaveLength(1);
    expect(market.mine).toHaveLength(0);
    expect(market.lots[0]?.total).toBe(lot.total);
    expect(market.lots[0]?.net).toBe(lot.total - Math.floor(lot.total * MARKET_COMMISSION));
    // Чужой внутренний id наружу не уходит (псевдоним вместо него).
    expect(market.lots[0]?.seller).not.toContain(owner.id);

    const own = describeMarket(await deps.lots.listActive({ limit: 10 }), (await deps.users.findById(owner.id))!, 10);
    expect(own.lots).toHaveLength(0);
    expect(own.mine).toHaveLength(1);
    // Эскроу списал 10 единиц, значит «что бы ещё выставить» витрина обязана считать
    // по СВЕЖЕМУ документу: снятый со склада товар не должен числиться свободным.
    // Именно поэтому маршрут передаёт сюда `accountOf(ctx, request)`, а не снимок
    // из ответа прошлого запроса.
    expect(own.myUnits.chips).toBe(owner.junk.chips - 10);
  });

  it('глубина рынка считает предложения по виду, а не «есть/нет»', async () => {
    const deps = await harness();
    const owner = seller();
    await listed(deps, owner, 10, 50);
    await listLot(deps, owner.id, { junk: 'chips', amount: 5, pricePerUnit: 120 }, T0);

    const viewer = withResources(trader(), { sec: 1000 });
    const market = describeMarket(await deps.lots.listActive({ limit: 10 }), viewer, 10);
    const chips = market.depth.find((d) => d.junk === 'chips');
    expect(chips?.lots).toBe(2);
    expect(chips?.units).toBe(15);
    expect(chips?.minPerUnit).toBe(50);
    expect(chips?.maxPerUnit).toBe(120);
  });

  it('правила рынка наружу: UI серит кнопки по ним, а не по догадкам', () => {
    const view = describeMarketRules();
    expect(view.commission).toBe(MARKET_COMMISSION);
    expect(view.maxActiveLots).toBeGreaterThan(0);
    expect(view.corridors.length).toBeGreaterThan(0);
    expect(describeLot).toBeTypeOf('function');
  });
});



