import { describe, expect, it } from 'vitest';

import { MARKET_COMMISSION } from '../src/config/market.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { makeIdempotencyKey, type LedgerEntry } from '../src/modules/ledger/ledger.types.js';
import { MemoryCommodityStore } from '../src/modules/market/commodity.store.js';
import { MemoryLotStore } from '../src/modules/market/lot.store.js';
import {
  buyLot,
  cancelLot,
  listLot,
  reconcileMarket,
  type MarketDeps
} from '../src/modules/market/commit.js';
import { claimLot, lotNet } from '../src/modules/market/service.js';
import type { LotSoldEvent } from '../src/modules/notification/notice.types.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { T0, newAccount, testConfig, withJunk, withResources } from './fixtures.js';

/**
 * Факт продажи (Часть 2, backlog 3): кто имеет право объявить «вас купили».
 *
 * Протокол рынка НЕ решает, лететь ли пушу: он обязан выдать ФАКТ ровно один раз и
 * только тому, кто записал выплату. Гейтинг (площадка, настройки, очередь) — дело
 * `notification/outbox.ts`. Отсюда три проверяемых свойства: ОДИН РАЗ (ни дубля при
 * гонке, ни события на снятом лоте), ПРАВО (событие получает лишь победитель записи
 * выплаты) и ИЗОЛЯЦИЯ (падение подписчика не превращает разведённые деньги в 500).
 */

const config = testConfig();
const rules = config.economy;

let seq = 0;
const idFactory = () => `lot-${++seq}`;

function trader(socialId: string): UserAccount {
  return newAccount(config, T0, socialId);
}

function sellerAccount(): UserAccount {
  return withResources(withJunk(trader('777001'), { chips: 100 }), { sec: 1000 });
}

function buyerAccount(): UserAccount {
  return withResources(trader('888002'), { sec: 10_000 });
}

interface Harness {
  deps: MarketDeps;
  sold: LotSoldEvent[];
  errors: Array<{ message: string; context: Record<string, unknown> }>;
}

function harness(over: Partial<MarketDeps> = {}): Harness {
  const sold: LotSoldEvent[] = [];
  const errors: Array<{ message: string; context: Record<string, unknown> }> = [];
  const deps: MarketDeps = {
    users: new MemoryUserStore(),
    lots: new MemoryLotStore(),
    commodities: new MemoryCommodityStore(),
    ledger: new MemoryLedgerStore(),
    idFactory,
    onError: (error, context) => errors.push({ message: error.message, context }),
    onSold: (event) => {
      sold.push(event);
    },
    ...over
  };
  return { deps, sold, errors };
}

/** Выставленный лот: по умолчанию 10 чипов по 50 SEC = 500. */
async function listed(deps: MarketDeps, who: UserAccount, amount = 10, pricePerUnit = 50) {
  await deps.users.save(who);
  return listLot(deps, who.id, { junk: 'chips', amount, pricePerUnit }, T0);
}

/** Запись движения для моделирования падения между шагами протокола. */
function entry(userId: string, key: string, delta: number, reason: LedgerEntry['reason']): LedgerEntry {
  return {
    id: `ledger-${++seq}`,
    userId,
    currency: 'sec',
    delta,
    balanceAfter: 0,
    reason,
    refType: 'lot',
    refId: key,
    idempotencyKey: key,
    ts: T0
  };
}

/** Код отказа асинхронного протокола. */
async function refusal(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('market.onSold: право объявить продажу', () => {
  it('покупка даёт ровно одно событие с зачисленной суммой, а не ценой лота', async () => {
    const { deps, sold } = harness();
    const owner = sellerAccount();
    const buyer = buyerAccount();
    const { lot } = await listed(deps, owner);
    await deps.users.save(buyer);

    const bought = await buyLot(deps, buyer.id, lot.id, T0, rules);
    expect(bought.settled).toBe(true);
    expect(sold).toHaveLength(1);

    const event = sold[0];
    expect(event?.lotId).toBe(lot.id);
    expect(event?.grossSec).toBe(lot.total);
    expect(event?.netSec).toBe(lotNet(lot));
    expect(event?.netSec).toBe(lot.total - Math.floor(lot.total * MARKET_COMMISSION));
    expect(event?.sellerId).toBe(owner.id);
    expect(event?.sellerPlatform).toBe('vk');
    expect(event?.sellerSocialId).toBe('777001');
    expect(event?.buyerId).toBe(buyer.id);
    expect(event?.junk).toBe('chips');
    expect(event?.amount).toBe(10);
  });

  it('протокол отдаёт факт как есть: площадка продавца — дело руки подписчика', async () => {
    // Протокол не знает, что tg-игроку пуш ВК не доставить: он не имеет права решать
    // про доставку, иначе `outbox` потерял бы свою политику, а тест рынка начал бы
    // зависеть от настроек площадки.
    const { deps, sold } = harness();
    const owner = { ...sellerAccount(), platform: 'tg' as const };
    const buyer = buyerAccount();
    const { lot } = await listed(deps, owner);
    await deps.users.save(buyer);

    await buyLot(deps, buyer.id, lot.id, T0, rules);
    expect(sold).toHaveLength(1);
    expect(sold[0]?.sellerPlatform).toBe('tg');
  });

  it('второй покупатель не получает лот и не рождает второго события', async () => {
    const { deps, sold } = harness();
    const owner = sellerAccount();
    const first = buyerAccount();
    const second = withResources(trader('888003'), { sec: 10_000 });
    const { lot } = await listed(deps, owner);
    await deps.users.save(first);
    await deps.users.save(second);

    await buyLot(deps, first.id, lot.id, T0, rules);
    expect(await refusal(() => buyLot(deps, second.id, lot.id, T0, rules))).toBe(ErrorCodes.MARKET_LOT_TAKEN);
    expect(sold).toHaveLength(1);
  });

  it('отказ по деньгам не рождает события: лот остаётся в витрине', async () => {
    const { deps, sold } = harness();
    const owner = sellerAccount();
    const poor = withResources(trader('999004'), { sec: 10 });
    const { lot } = await listed(deps, owner);
    await deps.users.save(poor);

    expect(await refusal(() => buyLot(deps, poor.id, lot.id, T0, rules))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
    expect(sold).toHaveLength(0);
    expect((await deps.lots.findById(lot.id))?.status).toBe('listed');
  });

  it('снятый и просроченный лот никого не будят: продажи не было', async () => {
    const { deps, sold } = harness();
    const owner = sellerAccount();
    const { lot } = await listed(deps, owner);

    await cancelLot(deps, owner.id, lot.id, T0);
    expect(sold).toHaveLength(0);

    const second = await listed(deps, owner, 5, 50);
    await reconcileMarket(deps, new Date(T0.getTime() + 25 * 60 * 60_000));
    expect(sold).toHaveLength(0);
    expect((await deps.lots.findById(second.lot.id))?.status).toBe('expired');
  });

  it('reconcile доводит деньги и объявляет продажу — продавца в игре нет, пуш нужнее всего', async () => {
    const { deps, sold } = harness();
    const owner = sellerAccount();
    const buyer = buyerAccount();
    const { lot } = await listed(deps, owner);
    await deps.users.save(buyer);

    // Падение между «деньги покупателя списаны» и «продавец получил».
    const claimed = await deps.lots.transact(lot.id, (current) => claimLot(current, buyer.id, T0));
    await deps.users.transact(buyer.id, (current) => ({
      ...current,
      resources: { ...current.resources, sec: current.resources.sec - claimed.total }
    }));
    await deps.ledger.appendMany([
      entry(buyer.id, makeIdempotencyKey('market', `${claimed.id}:sec`), -claimed.total, 'market_trade')
    ]);

    const result = await reconcileMarket(deps, T0);
    expect(result.paidOut).toBe(1);
    expect(sold).toHaveLength(1);
    expect(sold[0]?.lotId).toBe(claimed.id);
    expect(sold[0]?.netSec).toBe(lotNet(claimed));
  });

  it('выплата, уже записанная победителем, не объявляется второй раз и не удваивает счёт', async () => {
    const { deps, sold } = harness();
    const owner = sellerAccount();
    const buyer = buyerAccount();
    const { lot } = await listed(deps, owner);
    await deps.users.save(buyer);

    // buyLot довёл деньги (запись `:payout` на месте) и упал до `markPaid`.
    const claimed = await deps.lots.transact(lot.id, (current) => claimLot(current, buyer.id, T0));
    const net = lotNet(claimed);
    await deps.users.transact(owner.id, (current) => ({
      ...current,
      resources: { ...current.resources, sec: current.resources.sec + net }
    }));
    await deps.ledger.appendMany([
      entry(buyer.id, makeIdempotencyKey('market', `${claimed.id}:sec`), -claimed.total, 'market_trade'),
      entry(owner.id, makeIdempotencyKey('market', `${claimed.id}:payout`), net, 'market_payout')
    ]);

    const before = await deps.users.findById(owner.id);
    const result = await reconcileMarket(deps, T0);

    // Второй `paySeller` зачислил бы сумму поверх уже полученной: журнал отсекает
    // ДВИЖЕНИЕ по уникальному ключу, а изменение счёта игрока — нет.
    expect(result.paidOut).toBe(0);
    expect(sold).toHaveLength(0);
    const after = await deps.users.findById(owner.id);
    expect(after?.resources.sec).toBe(before?.resources.sec);
    expect((await deps.lots.findById(claimed.id))?.payoutSettled).toBe(true);
  });

  it('падение подписчика не превращает завершённую сделку в ошибку для покупателя', async () => {
    const { deps, errors } = harness({
      onSold: () => {
        throw new Error('очередь переполнена');
      }
    });
    const owner = sellerAccount();
    const buyer = buyerAccount();
    const { lot } = await listed(deps, owner);
    await deps.users.save(buyer);

    const bought = await buyLot(deps, buyer.id, lot.id, T0, rules);
    expect(bought.settled).toBe(true);
    const paid = await deps.users.findById(owner.id);
    expect(paid?.resources.sec).toBeCloseTo(owner.resources.sec + lotNet(lot), 6);
    expect(errors.some((e) => e.context['stage'] === 'on_sold')).toBe(true);
  });
});
