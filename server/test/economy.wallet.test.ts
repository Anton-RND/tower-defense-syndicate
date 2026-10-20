import { describe, expect, it } from 'vitest';

import { collectWarehouse } from '../src/modules/economy/mining.js';
import {
  credit,
  asterium,
  debit,
  hasTechDebt,
  isPurchaseBlocked,
  asteriumTotal,
  refundAsterium,
  refundTech,
  resource,
  spendAsterium,
  spendTech,
  tech
} from '../src/modules/economy/wallet.js';
import { CRAFT_TECH_IDS, isCraftTechId, isTechMaterialId } from '../src/config/materials.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { makeIdempotencyKey, type LedgerDraft, type LedgerEntry } from '../src/modules/ledger/ledger.types.js';
import { AppError, ErrorCodes } from '../src/lib/errors.js';
import { T0, addMs, newAccount, testConfig, withAsterium, withTech } from './fixtures.js';

const config = testConfig();

const ctx = (overrides: Partial<{ reason: LedgerDraft['reason']; idempotencyKey: string | null }> = {}) => ({
  ts: T0,
  reason: 'purchase' as const,
  ...overrides
});

function asEntry(draft: LedgerDraft, id: string): LedgerEntry {
  return { ...draft, id };
}

describe('wallet: движение ценностей', () => {
  it('credit/debit пишут корректный balanceAfter', () => {
    const account = newAccount(config);
    const topped = credit(account, resource('ferrum'), 500, ctx({ reason: 'event' }));
    expect(topped.account.resources.ferrum).toBe(500);
    expect(topped.draft.delta).toBe(500);
    expect(topped.draft.balanceAfter).toBe(500);

    const spent = debit(topped.account, resource('ferrum'), 200, ctx({ reason: 'craft' }));
    expect(spent.account.resources.ferrum).toBe(300);
    expect(spent.draft.delta).toBe(-200);
    expect(spent.draft.balanceAfter).toBe(300);
    // Оригинал не мутируется — доменные функции чистые.
    expect(account.resources.ferrum).toBe(0);
  });

  it('недостаток средств — INSUFFICIENT_FUNDS без частичного списания', () => {
    const account = newAccount(config);
    try {
      debit(account, resource('uranium'), 5, ctx({ reason: 'craft' }));
      throw new Error('ожидался INSUFFICIENT_FUNDS');
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
      expect((error as AppError).details?.available).toBe(0);
    }
  });

  it('отрицательная сумма в движении — ошибка валидации', () => {
    const account = newAccount(config);
    expect(() => credit(account, resource('plasma'), -1, ctx())).toThrow();
  });

  it('трата астерия: сначала заработанный кошелёк, потом купленный', () => {
    const account = withAsterium(newAccount(config), 100, 30);
    const cheap = spendAsterium(account, 20, ctx({ reason: 'upgrade' }));
    expect(cheap.account.materials.asterium).toEqual({ purchased: 100, earned: 10 });
    expect(cheap.drafts.map((draft) => draft.currency)).toEqual(['asterium_earned']);

    const expensive = spendAsterium(account, 40, ctx({ reason: 'upgrade' }));
    expect(expensive.account.materials.asterium).toEqual({ purchased: 90, earned: 0 });
    expect(expensive.drafts.map((draft) => draft.currency)).toEqual(['asterium_earned', 'asterium_purchased']);
    expect(expensive.drafts.map((draft) => draft.delta)).toEqual([-30, -10]);
  });

  it('не хватает обоих кошельков — INSUFFICIENT_FUNDS', () => {
    const account = withAsterium(newAccount(config), 10, 5);
    try {
      spendAsterium(account, 50, ctx());
      throw new Error('ожидался INSUFFICIENT_FUNDS');
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
    }
  });

  it('возврат платежа уходит в минус по купленному и блокирует покупки', () => {
    const account = withAsterium(newAccount(config), 100, 500);
    const refunded = refundAsterium(account, 150, ctx({ reason: 'refund' }));
    expect(refunded.account.materials.asterium).toEqual({ purchased: -50, earned: 500 });
    expect(refunded.draft.reason).toBe('refund');
    expect(isPurchaseBlocked(refunded.account)).toBe(true);
    // Заработанные не тронуты: долг по возврату не снимаем с игровых наград.
    expect(asteriumTotal(refunded.account)).toBe(450);
  });
});

describe('wallet: трата астерия между кошельками', () => {
  it('два движения одного списания получают разные ключи идемпотентности', async () => {
    const account = withAsterium(newAccount(config), 100, 5);
    const spent = spendAsterium(account, 60, ctx({ idempotencyKey: makeIdempotencyKey('rush', 'job-1') }));

    expect(spent.account.materials.asterium).toEqual({ purchased: 45, earned: 0 });
    expect(spent.drafts.map((draft) => draft.idempotencyKey)).toEqual(['rush:job-1:earned', 'rush:job-1:purchased']);

    // Регресс: с общим ключом уникальный индекс журнала отбросил бы второе движение,
    // и 55 купленного критания ушли бы без единой записи — «откуда дырка в балансе».
    const store = new MemoryLedgerStore();
    await store.connect();
    expect(await store.appendMany(spent.drafts.map((draft, index) => asEntry(draft, `l${index}`)))).toBe(2);
    expect(await store.sum(account.id, 'asterium_purchased')).toBe(-55);
    expect(await store.sum(account.id, 'asterium_earned')).toBe(-5);
  });

  it('в пределах одного кошелька — одно движение и один ключ с суффиксом', () => {
    const account = withAsterium(newAccount(config), 0, 500);
    const spent = spendAsterium(account, 60, ctx({ idempotencyKey: makeIdempotencyKey('rush', 'job-2') }));
    expect(spent.drafts.map((draft) => draft.idempotencyKey)).toEqual(['rush:job-2:earned']);
  });

  it('ключ null остаётся null: разовые действия не должны делить один индекс', () => {
    const account = withAsterium(newAccount(config), 100, 5);
    const spent = spendAsterium(account, 60, ctx({ idempotencyKey: null }));
    expect(spent.drafts.every((draft) => draft.idempotencyKey === null)).toBe(true);
  });
});

describe('wallet: сырьё (хрониум, вольфрам, станиум)', () => {
  it('spendTech — одно движение и один ключ: кошельков у сырья нет', () => {
    const account = withTech(newAccount(config), { chronium: 100 });
    const spent = spendTech(account, 'chronium', 60, ctx({
      reason: 'upgrade',
      idempotencyKey: makeIdempotencyKey('rush', 'job-1')
    }));

    expect(spent.account.materials.chronium).toBe(40);
    expect(spent.draft.currency).toBe('chronium');
    expect(spent.draft.delta).toBe(-60);
    expect(spent.draft.balanceAfter).toBe(40);
    // Суффикс кошелька нужен только астерию: у сырья один баланс, и ключ — ровно один.
    expect(spent.draft.idempotencyKey).toBe('rush:job-1');
    expect(spent.account.materials.wolfram).toBe(0);
    expect(spent.account.materials.asterium).toEqual({ purchased: 0, earned: 0 });
  });

  it('долг по сырью — не кредит: минус не тратится и попадается в hasTechDebt', () => {
    const debtor = withTech(newAccount(config), { wolfram: -50 });
    try {
      spendTech(debtor, 'wolfram', 1, ctx({ reason: 'craft' }));
      throw new Error('ожидался INSUFFICIENT_FUNDS');
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
      expect((error as AppError).details?.available).toBe(-50);
      expect((error as AppError).details?.currency).toBe('wolfram');
    }
    expect(hasTechDebt(debtor)).toBe(true);
    expect(hasTechDebt(newAccount(config))).toBe(false);
    // Долг по одному материалу не блокирует остальные: вольфрам в минусе не отнимает
    // у игрока право собирать хрониумом ускорения (и наоборот).
    expect(isPurchaseBlocked(debtor)).toBe(false);
  });

  it('refundTech уходит в минус и гасится начислением того же материала', () => {
    const account = withTech(newAccount(config), { stanium: 20 });
    const refunded = refundTech(account, 'stanium', 50, ctx({
      idempotencyKey: makeIdempotencyKey('order', 'vk-9:refund')
    }));

    expect(refunded.account.materials.stanium).toBe(-30);
    expect(refunded.draft.reason).toBe('refund');
    expect(refunded.draft.delta).toBe(-50);
    expect(refunded.draft.balanceAfter).toBe(-30);
    expect(hasTechDebt(refunded.account)).toBe(true);

    const partial = credit(refunded.account, tech('stanium'), 10, ctx({ reason: 'recycle' }));
    expect(partial.account.materials.stanium).toBe(-20);
    expect(hasTechDebt(partial.account)).toBe(true);
    const cleared = credit(partial.account, tech('stanium'), 20, ctx({ reason: 'recycle' }));
    expect(hasTechDebt(cleared.account)).toBe(false);
  });

  it('астерий — деньги, а не сырьё: в CRAFT_TECH_IDS его нет', () => {
    expect(CRAFT_TECH_IDS).toEqual(['chronium', 'wolfram', 'stanium']);
    expect(isCraftTechId('asterium')).toBe(false);
    expect(isCraftTechId('wolfram')).toBe(true);
    expect(isTechMaterialId('asterium')).toBe(true);
  });
});

describe('mining: сбор со склада в журнал', () => {
  it('collectWarehouse отдаёт по движению на каждый ресурс', () => {
    const account = {
      ...newAccount(config),
      storages: { ferrum: 120.75, silicium: 60.2, uranium: 0.9, plasma: 0, deuterium: 500, nitrogen: 300 }
    };
    const result = collectWarehouse(account, T0);
    expect(result.collected).toEqual({ ferrum: 120, silicium: 60, uranium: 0, plasma: 0, deuterium: 0, nitrogen: 0 });
    expect(result.account.resources.ferrum).toBe(120);
    expect(result.account.storages.ferrum).toBeCloseTo(0.75, 6);
    // Газы в кошелёк не переезжают: это рабочая жидкость промышленности, а не товар.
    // Ручной сбор дейтерия обнулил бы собой топливо тяжёлой техники, и игрок сделал бы
    // это одним неосторожным тапом — поэтому ветка закрыта на уровне тика, а не UI.
    expect(result.account.storages.deuterium).toBe(500);
    expect(result.account.storages.nitrogen).toBe(300);
    expect(result.drafts).toHaveLength(2);
    expect(result.drafts.every((draft) => draft.reason === 'collect')).toBe(true);
    expect(result.drafts.map((draft) => draft.balanceAfter)).toEqual([120, 60]);
    // Ключи разные по валюте: иначе вторая запись той же сборки считается дублем.
    expect(new Set(result.drafts.map((draft) => draft.idempotencyKey)).size).toBe(2);
  });
});

describe('ledger: память и идемпотентность', () => {
  it('повтор с тем же idempotencyKey не создаёт вторую запись', async () => {
    const store = new MemoryLedgerStore();
    await store.connect();
    const account = newAccount(config);
    const draft = credit(account, asterium('purchased'), 100, {
      ts: T0,
      reason: 'purchase',
      idempotencyKey: makeIdempotencyKey('order', 'vk-1')
    }).draft;

    expect(await store.append(asEntry(draft, 'l1'))).toBe(true);
    expect(await store.append(asEntry({ ...draft, balanceAfter: 200 }, 'l2'))).toBe(false);
    expect(await store.count(account.id)).toBe(1);
    expect(await store.sum(account.id, 'asterium_purchased')).toBe(100);
  });

  it('list отдаёт свежие в начале и фильтрует по причине', async () => {
    const store = new MemoryLedgerStore();
    const account = newAccount(config);
    const first = credit(account, resource('ferrum'), 10, { ts: addMs(T0, -1000), reason: 'collect' }).draft;
    const second = credit(account, resource('ferrum'), 5, { ts: T0, reason: 'event' }).draft;
    await store.appendMany([asEntry(first, 'l1'), asEntry(second, 'l2')]);

    const all = await store.list(account.id);
    expect(all.map((entry) => entry.id)).toEqual(['l2', 'l1']);
    expect(await store.list(account.id, { reasons: ['collect'] })).toHaveLength(1);
    expect(await store.sum(account.id, 'ferrum', { reasons: ['event'] })).toBe(5);
  });
});
