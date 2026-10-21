import { describe, expect, it } from 'vitest';

import { CLAN_CREATE_COST, CLAN_MAX_DEPOSIT_UNITS, CLAN_MAX_MEMBERS } from '../src/config/clans.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryClanStore } from '../src/modules/clan/clan.store.js';
import mongoose from 'mongoose';
import {
  clanSchema,
  toClan,
  toSetPayload,
  type ClanDoc,
  type ClanModel
} from '../src/modules/clan/mongo.model.js';
import {
  buildClanShell,
  chargeClanCreation,
  chargeDeposit,
  checkClanIdentity,
  disbandClan,
  joinClan,
  leaveClan,
  planDeposit,
  pruneContributions,
  settleClanCreation,
  settleContribution,
  transferLeadership,
  voidContribution
} from '../src/modules/clan/service.js';
import {
  checkClanName,
  contributionsToday,
  normalizeClanName,
  treasuryUnits,
  type ClanState
} from '../src/modules/clan/clan.types.js';
import {
  createClan,
  depositToTreasury,
  disbandCurrentClan,
  joinClanById,
  leaveCurrentClan,
  reconcileClan,
  resolveMembership,
  type ClanDeps
} from '../src/modules/clan/commit.js';
import { describeClan, describeClanMembership, describeMyContributions, treasuryFill } from '../src/modules/clan/view.js';
import { makeIdempotencyKey } from '../src/modules/ledger/ledger.types.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';

import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { newAccount, testConfig, T0, addMs, DAY, errorCode, MINUTE, withAsterium, withMetals } from './fixtures.js';

/**
 * Кланы (Часть 2).
 *
 * Проверяются три вещи, ради которых этот домен и написан: имя занято — деньги не
 * списываются; взнос либо оседает в казне, либо откатывается, но не исчезает; и
 * прерванная двухдокументная операция закрывается разбором (reconcile) по доказательству
 * в журнале, а не по надежде.
 */

const config = testConfig();
const rules = config.economy;

let seq = 0;
const idFactory = () => `clan-id-${++seq}`;

function player(seed = `clan-player-${++seq}`): UserAccount {
  return newAccount(config, T0, seed);
}

function payer(purchased = CLAN_CREATE_COST, earned = 0): UserAccount {
  return withAsterium(player(), purchased, earned);
}

async function harness() {
  const users = new MemoryUserStore();
  const clans = new MemoryClanStore();
  const ledger = new MemoryLedgerStore();
  return { users, clans, ledger, idFactory } as ClanDeps & {
    users: MemoryUserStore;
    clans: MemoryClanStore;
    ledger: MemoryLedgerStore;
  };
}

/** Активный клан с одним участником-основителем: исходная точка большинства тестов. */
async function withClan(deps: ClanDeps, leader: UserAccount, name = 'Стальные волки') {
  await deps.users.save(leader);
  return createClan(deps, leader.id, { name }, T0, rules);
}

describe('clan.name: имя нормализуется до проверки занятости', () => {
  it('пробелы, регистр и трим приводят имя к одной канонической форме', () => {
    expect(normalizeClanName('  Стальные   ВОЛКИ ')).toBe('стальные волки');
    const identity = checkClanIdentity({ name: ' Стальные   ВОЛКИ ' });
    expect(identity.name).toBe('стальные волки');
    expect(identity.tag).toMatch(/^[0-9A-ZА-ЯЁ]{2,6}$/);
  });

  it('короткое, пустое, длинное и «символьное» имя отклоняются до всякой оплаты', () => {
    expect(checkClanName('аб')).toEqual({ ok: false, reason: 'short' });
    expect(checkClanName('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(checkClanName('а'.repeat(25))).toEqual({ ok: false, reason: 'long' });
    expect(checkClanName('!!!')).toEqual({ ok: false, reason: 'chars' });
    expect(errorCode(() => checkClanIdentity({ name: 'аб' }))).toBe(ErrorCodes.CLAN_NAME_INVALID);
  });

  it('тег задаётся явно, если проходит правила, иначе выводится из имени', () => {
    expect(checkClanIdentity({ name: 'Стальные волки', tag: 'stal' }).tag).toBe('STAL');
    expect(errorCode(() => checkClanIdentity({ name: 'Стальные волки', tag: 'A' }))).toBe(
      ErrorCodes.CLAN_NAME_INVALID
    );
  });
});

describe('clan.chargeClanCreation: оплата основания', () => {
  it('списывает астериев, ставит clanId и пишет движение с ключом клана', () => {
    const result = chargeClanCreation(payer(300, 0), 'clan-1', T0, rules);
    expect(result.account.clanId).toBe('clan-1');
    expect(result.account.materials.asterium).toEqual({ purchased: 50, earned: 0 });
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.reason).toBe('clan_create');
    // spendAsterium ключует по кошельку: заработанный первым, купленный вторым.
    expect(result.drafts[0]?.idempotencyKey).toBe(`${makeIdempotencyKey('clan', 'clan-1')}:purchased`);
  });

  it('игрок уже в клане — отказ до списания', () => {
    const inClan: UserAccount = { ...payer(1000, 0), clanId: 'other-clan' };
    expect(errorCode(() => chargeClanCreation(inClan, 'clan-1', T0, rules))).toBe(ErrorCodes.ALREADY_IN_CLAN);
  });

  it('недостаточно критания — INSUFFICIENT_FUNDS, а не «половина клана»', () => {
    expect(errorCode(() => chargeClanCreation(payer(10, 0), 'clan-1', T0, rules))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
  });

  it('долг по донату: оплатить можно только заработанным астерием', () => {
    const inDebt: UserAccount = { ...payer(-100, 100), clanId: null };
    expect(errorCode(() => chargeClanCreation(inDebt, 'clan-1', T0, rules))).toBe(ErrorCodes.PURCHASES_BLOCKED);
    const paidEarned: UserAccount = { ...payer(-100, 500), clanId: null };
    expect(chargeClanCreation(paidEarned, 'clan-1', T0, rules).account.materials.asterium).toEqual({
      purchased: -100,
      earned: 250
    });
  });

  it('оболочка клана рождается неоплаченной и с лидером в участниках', () => {
    const clan = buildClanShell(checkClanIdentity({ name: 'Стальные волки' }), 'clan-1', 'leader-1', T0).clan;
    expect(clan.status).toBe('pending_payment');
    expect(clan.members).toEqual(['leader-1']);
    expect(treasuryUnits(clan)).toBe(0);
    expect(settleClanCreation(clan, T0).status).toBe('active');
  });
});

describe('clan.createClan: протокол на два документа', () => {
  it('оплаченный клан активен, лидер привязан, журнал содержит одно списание', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    const result = await withClan(deps, leader);

    expect(result.active).toBe(true);
    expect(result.clan.status).toBe('active');
    expect(result.clan.name).toBe('стальные волки');
    expect(result.clan.members).toEqual([leader.id]);
    expect(result.account.clanId).toBe(result.clan.id);
    expect(result.account.materials.asterium.purchased).toBe(1000 - CLAN_CREATE_COST);

    const entries = await deps.ledger.list(leader.id, { reasons: ['clan_create'] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.idempotencyKey).toBe(`${makeIdempotencyKey('clan', result.clan.id)}:purchased`);
  });

  it('занятое имя (в любом регистре и с лишними пробелами) — отказ, и деньги остаются', async () => {
    const deps = await harness();
    await withClan(deps, payer(1000, 0), 'Стальные волки');

    const second = payer(1000, 0);
    await deps.users.save(second);
    // createClan — асинхронный протокол: отказ приходит rejected promise'ом.
    await expect(createClan(deps, second.id, { name: ' СТАЛЬНЫЕ   ВОЛКИ ' }, T0, rules)).rejects.toMatchObject({
      code: ErrorCodes.CLAN_NAME_TAKEN
    });
    expect(deps.clans.size).toBe(1);
    expect((await deps.users.findById(second.id))?.materials.asterium.purchased).toBe(1000);
  });

  it('сломанный игрок не занимает имя: кланов не прибавляется', async () => {
    const deps = await harness();
    const broke = payer(10, 0);
    await deps.users.save(broke);
    await expect(createClan(deps, broke.id, { name: 'Фантомы' }, T0, rules)).rejects.toMatchObject({
      code: ErrorCodes.INSUFFICIENT_FUNDS
    });
    expect(deps.clans.size).toBe(0);
    expect(await deps.clans.findByName('фантомы')).toBeNull();
  });

  it('повторное основание участником клана — ALREADY_IN_CLAN', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    await withClan(deps, leader);
    await expect(createClan(deps, leader.id, { name: 'Вторая попытка' }, T0, rules)).rejects.toMatchObject({
      code: ErrorCodes.ALREADY_IN_CLAN
    });
  });
});

describe('clan.depositToTreasury: взнос в казну', () => {
  async function clanWithMember(deps: ClanDeps, env: Record<string, string> = {}) {
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);
    const account = await deps.users.transact(leader.id, (current) =>
      withMetals(current, { black_metal: 1000, colored_metal: 500, precious_metal: 100 })
    );
    return { clan: created.clan, account, rules: testConfig(env).economy };
  }

  it('металл переезжает в казну, списание попадает в журнал ровно один раз', async () => {
    const deps = await harness();
    const { clan, account, rules: r } = await clanWithMember(deps);
    const result = await depositToTreasury(deps, account.id, { metal: 'black_metal', amount: 200 }, addMs(T0, MINUTE), r);

    expect(result.settled).toBe(true);
    expect(result.clan.treasury.black_metal).toBe(200);
    expect(result.account.metals.black_metal).toBe(800);
    expect(result.contribution.status).toBe('settled');
    expect(clan.treasury.black_metal).toBe(0);

    const entries = await deps.ledger.list(account.id, { reasons: ['clan_deposit'] });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.currency).toBe('black_metal');
    expect(entries[0]?.delta).toBe(-200);
    expect(entries[0]?.balanceAfter).toBe(800);
    expect(entries[0]?.idempotencyKey).toBe(makeIdempotencyKey('deposit', result.contribution.id));
  });

  it('нулевой, дробный и сверхразовый взнос отклоняются без резерва в клане', async () => {
    const deps = await harness();
    const { clan, account, rules: r } = await clanWithMember(deps);
    for (const amount of [0, -5, 0.5, CLAN_MAX_DEPOSIT_UNITS + 1]) {
      expect(errorCode(() => planDeposit(clan, account, { metal: 'black_metal', amount }, T0, r, idFactory))).toBe(
        ErrorCodes.CLAN_DEPOSIT_INVALID
      );
      await expect(depositToTreasury(deps, account.id, { metal: 'black_metal', amount }, T0, r)).rejects.toMatchObject({
        code: ErrorCodes.CLAN_DEPOSIT_INVALID
      });
    }
    expect((await deps.clans.findById(clan.id))?.contributions).toHaveLength(0);
  });

  it('больше, чем на складе — отказ, склад не уходит в минус', async () => {
    const deps = await harness();
    const { account, rules: r } = await clanWithMember(deps);
    await expect(
      depositToTreasury(deps, account.id, { metal: 'precious_metal', amount: 101 }, T0, r)
    ).rejects.toMatchObject({ code: ErrorCodes.CLAN_DEPOSIT_INVALID });
    expect((await deps.users.findById(account.id))?.metals.precious_metal).toBe(100);
  });

  it('игрок без клана не может сдавать в чужую казну', async () => {
    const deps = await harness();
    const stranger = payer(1000, 0);
    await deps.users.save(withMetals(stranger, { black_metal: 500, colored_metal: 0, precious_metal: 0 }));
    await expect(
      depositToTreasury(deps, stranger.id, { metal: 'black_metal', amount: 10 }, T0, rules)
    ).rejects.toMatchObject({ code: ErrorCodes.NOT_IN_CLAN });
  });

  it('суточные потолки взносов и единиц работают как антифрод-сток', async () => {
    const deps = await harness();
    const { account, rules: limited } = await clanWithMember(deps, { CLAN_DAILY_DEPOSITS: '1' });
    await depositToTreasury(deps, account.id, { metal: 'black_metal', amount: 10 }, T0, limited);
    await expect(
      depositToTreasury(deps, account.id, { metal: 'black_metal', amount: 10 }, T0, limited)
    ).rejects.toMatchObject({ code: ErrorCodes.CLAN_DEPOSIT_INVALID });
    // Следующий день (UTC) — лимит сброшен.
    await expect(
      depositToTreasury(deps, account.id, { metal: 'black_metal', amount: 10 }, addMs(T0, DAY), limited)
    ).resolves.toMatchObject({ settled: true });

    const byUnits = await harness();
    const prepared = await clanWithMember(byUnits, { CLAN_DAILY_UNITS: '100' });
    await expect(
      depositToTreasury(byUnits, prepared.account.id, { metal: 'black_metal', amount: 101 }, T0, prepared.rules)
    ).rejects.toMatchObject({ code: ErrorCodes.CLAN_DEPOSIT_INVALID });
  });

  it('провал списания откатывает резерв: казна не растёт из ниоткуда', async () => {
    const deps = await harness();
    const { clan, account, rules: r } = await clanWithMember(deps);
    const plan = planDeposit(clan, account, { metal: 'black_metal', amount: 300 }, T0, r, idFactory);
    await deps.clans.save(plan.clan);

    // Списание не состоялось (игрок успел потратить металл): резерв аннулируется.
    const drained = withMetals(account, { black_metal: 10, colored_metal: 0, precious_metal: 0 });
    expect(errorCode(() => chargeDeposit(drained, plan.contribution, clan.id, T0))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
    const rolled = voidContribution(plan.clan, plan.contribution.id, 'charge_failed', T0);
    expect(rolled.contributions[0]?.status).toBe('void');
    expect(treasuryUnits(rolled)).toBe(0);
  });
});

describe('clan.reconcileClan: закрытие прерванных операций по журналу', () => {
  const ttl = rules.limits.clan.pendingTtlMs;

  async function clanWithPending(deps: ClanDeps, amount: number) {
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);
    const account = await deps.users.transact(leader.id, (current) =>
      withMetals(current, { black_metal: 500, colored_metal: 0, precious_metal: 0 })
    );
    const plan = planDeposit(created.clan, account, { metal: 'black_metal', amount }, T0, rules, idFactory);
    await deps.clans.save(plan.clan);
    return { clan: created.clan, account, plan };
  }

  it('взнос без доказательства списания аннулируется, казна и склад не трогается', async () => {
    const deps = await harness();
    const { clan, account, plan } = await clanWithPending(deps, 200);

    // Окно ещё живо — трогать нельзя: списание может прийти с задержкой.
    expect(await reconcileClan(deps, clan.id, addMs(T0, MINUTE), rules)).toEqual({
      activated: false,
      settled: 0,
      voided: 0
    });

    const after = await reconcileClan(deps, clan.id, addMs(T0, ttl + MINUTE), rules);
    expect(after.voided).toBe(1);
    const restored = await deps.clans.findById(clan.id);
    expect(treasuryUnits(restored as ClanState)).toBe(0);
    expect(restored?.contributions[0]?.status).toBe('void');
    expect(restored?.contributions[0]?.note).toBe('expired');
    // Металл у игрока остался: зависшая запись дешевле потерянной ценности.
    expect((await deps.users.findById(account.id))?.metals.black_metal).toBe(500);
    expect(plan.contribution.status).toBe('pending');
  });

  it('взнос с доказательством списания досаживается в казну', async () => {
    const deps = await harness();
    const { clan, account, plan } = await clanWithPending(deps, 200);

    const charged = chargeDeposit(account, plan.contribution, clan.id, T0);
    await deps.users.save(charged.account);
    for (const draft of charged.drafts) await deps.ledger.append({ ...draft, id: idFactory() });

    const after = await reconcileClan(deps, clan.id, addMs(T0, ttl + MINUTE), rules);
    expect(after.settled).toBe(1);
    const restored = await deps.clans.findById(clan.id);
    expect(restored?.treasury.black_metal).toBe(200);
    expect(restored?.contributions[0]?.status).toBe('settled');
    expect(settleContribution(restored as ClanState, plan.contribution.id, T0)).toBe(restored);
  });

  it('неоплаченное основание по истечении окна аннулируется, оплаченное — активируется', async () => {
    const deps = await harness();
    const ghost = buildClanShell(checkClanIdentity({ name: 'Призрак' }), 'clan-ghost', 'leader-1', T0).clan;
    await deps.clans.insert(ghost);
    expect((await reconcileClan(deps, 'clan-ghost', addMs(T0, ttl + MINUTE), rules)).activated).toBe(false);
    expect((await deps.clans.findById('clan-ghost'))?.status).toBe('void');
    expect((await deps.clans.findById('clan-ghost'))?.note).toBe('unpaid_timeout');

    const paid = buildClanShell(checkClanIdentity({ name: 'Оплачен' }), 'clan-paid', 'leader-2', T0).clan;
    await deps.clans.insert(paid);
    await deps.ledger.append({
      id: idFactory(),
      userId: 'leader-2',
      currency: 'asterium_earned',
      delta: -CLAN_CREATE_COST,
      balanceAfter: 0,
      reason: 'clan_create',
      refType: 'clan',
      refId: 'clan-paid',
      idempotencyKey: `${makeIdempotencyKey('clan', 'clan-paid')}:earned`,
      ts: T0
    });
    expect((await reconcileClan(deps, 'clan-paid', addMs(T0, ttl + MINUTE), rules)).activated).toBe(true);
    expect((await deps.clans.findById('clan-paid'))?.status).toBe('active');
  });
});


describe('clan.membership: вступление и выход', () => {
  it('второй игрок вступает согласованно, повторный вход идемпотентен', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);
    const other = payer(1000, 0);
    await deps.users.save(other);

    const joined = await joinClanById(deps, other.id, created.clan.id, T0);
    expect(joined.clan.members).toEqual([leader.id, other.id]);
    expect(joined.account.clanId).toBe(created.clan.id);

    const again = await joinClanById(deps, other.id, created.clan.id, addMs(T0, MINUTE));
    expect(again.clan.members).toHaveLength(2);
    expect(again.account.clanId).toBe(created.clan.id);
  });

  it('полный клан отказывает вступлению, а не превышает потолок документа', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);
    const full: ClanState = {
      ...created.clan,
      members: Array.from({ length: CLAN_MAX_MEMBERS }, (_, i) => (i === 0 ? leader.id : `u-${i}`))
    };
    await deps.clans.save(full);

    const other = payer(1000, 0);
    await deps.users.save(other);
    await expect(joinClanById(deps, other.id, full.id, T0)).rejects.toMatchObject({ code: ErrorCodes.CLAN_FULL });
  });

  it('при двух участниках основитель не выйдет; передав управление — сможет', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);
    const other = payer(1000, 0);
    await deps.users.save(other);
    await joinClanById(deps, other.id, created.clan.id, T0);

    // Пока в клане двое, уход основителя распустил бы клан с чужими взносами в казне.
    await expect(leaveCurrentClan(deps, leader.id, T0)).rejects.toMatchObject({ code: ErrorCodes.CLAN_LEADER_ONLY });

    const transferred = await deps.clans.transact(created.clan.id, (current) =>
      transferLeadership(current, leader.id, other.id, T0)
    );
    expect(transferred.leaderId).toBe(other.id);

    const left = await leaveCurrentClan(deps, leader.id, T0);
    expect(left.clan?.members).toEqual([other.id]);
    expect(left.account.clanId).toBeNull();
    // Бывший основитель больше не участник: повторный выход — NOT_IN_CLAN, а не тихий успех.
    await expect(leaveCurrentClan(deps, leader.id, T0)).rejects.toMatchObject({ code: ErrorCodes.NOT_IN_CLAN });
  });

  it('выход единственного участника расформировывает клан', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);
    const left = await leaveCurrentClan(deps, leader.id, T0);
    expect(left.clan).toBeNull();
    expect(left.account.clanId).toBeNull();
    expect((await deps.clans.findById(created.clan.id))?.status).toBe('void');
  });
});

describe('clan.membership: роспуск и источник истины членства', () => {
  it('роспуск возможен только основителем и только с пустой казной', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);
    await deps.users.transact(leader.id, (current) =>
      withMetals(current, { black_metal: 100, colored_metal: 0, precious_metal: 0 })
    );
    await depositToTreasury(deps, leader.id, { metal: 'black_metal', amount: 100 }, T0, rules);

    await expect(disbandCurrentClan(deps, leader.id, T0)).rejects.toMatchObject({ code: ErrorCodes.CONFLICT });

    // Казну израсходовали (здесь — руками, редуктором): роспуск разрешён.
    await deps.clans.transact(created.clan.id, (current) => ({
      ...current,
      treasury: { black_metal: 0, colored_metal: 0, precious_metal: 0 }
    }));
    const disbanded = await disbandCurrentClan(deps, leader.id, T0);
    expect(disbanded.status).toBe('void');
    expect(disbanded.members).toEqual([]);
    expect((await deps.users.findById(leader.id))?.clanId).toBeNull();
  });

  it('чужой игрок не может расформировать клан', async () => {
    const deps = await harness();
    const created = await withClan(deps, payer(1000, 0));
    const stranger = payer(1000, 0);
    await deps.users.save({ ...stranger, clanId: created.clan.id });
    await expect(disbandCurrentClan(deps, stranger.id, T0)).rejects.toMatchObject({
      code: ErrorCodes.CLAN_LEADER_ONLY
    });
  });

  it('resolveMembership: клан — истина, clanId — кэш', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    const created = await withClan(deps, leader);

    const ok = await resolveMembership((await deps.users.findById(leader.id)) as UserAccount, deps.clans);
    expect(ok.clanId).toBe(created.clan.id);

    await deps.clans.transact(created.clan.id, (current) => ({ ...current, status: 'void' }));
    expect(await resolveMembership((await deps.users.findById(leader.id)) as UserAccount, deps.clans)).toEqual({
      clanId: null,
      clan: null
    });

    const outsider = payer(1000, 0);
    await deps.users.save({ ...outsider, clanId: created.clan.id });
    expect(await resolveMembership((await deps.users.findById(outsider.id)) as UserAccount, deps.clans)).toEqual({
      clanId: null,
      clan: null
    });
    expect(await resolveMembership({ ...outsider, clanId: null }, deps.clans)).toEqual({ clanId: null, clan: null });
  });

  it('чистые функции не мутируют входные документы', () => {
    const clan = settleClanCreation(buildClanShell(checkClanIdentity({ name: 'Немутация' }), 'clan-x', 'u-1', T0).clan, T0);
    const account: UserAccount = { ...payer(0, 0), clanId: null };
    const joined = joinClan(account, clan, T0);
    expect(clan.members).toEqual(['u-1']);
    expect(joined.clan.members).toEqual(['u-1', account.id]);
    expect(leaveClan(joined.account, joined.clan, T0).clan.members).toEqual(['u-1']);
    expect(disbandClan(clan, 'u-1', 'test', T0).status).toBe('void');
  });
});

describe('clan.view и журнал взносов', () => {
  it('витрина отдаёт счётчики, а не список участников', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    await withClan(deps, leader);
    await deps.users.transact(leader.id, (current) =>
      withMetals(current, { black_metal: 50, colored_metal: 0, precious_metal: 0 })
    );
    const deposited = await depositToTreasury(deps, leader.id, { metal: 'black_metal', amount: 50 }, T0, rules);

    const view = describeClan(deposited.clan);
    expect(view.members).toBe(1);
    expect(view.limit).toBe(CLAN_MAX_MEMBERS);
    expect(view.pending).toBe(0);
    expect(view.treasuryUnits).toBe(50);
    expect(view.status).toBe('active');
    // Имя наружу уходит каноническим: фронт не перевыпускает нормализацию.
    expect(view.name).toBe('стальные волки');
    expect(Object.keys(view)).not.toContain('membersList');

    const mine = describeMyContributions(deposited.clan, leader.id, T0.toISOString().slice(0, 10), rules);
    expect(mine).toEqual({ count: 1, units: 50, dailyDeposits: 20, dailyUnits: 100_000 });
    expect(treasuryFill(deposited.clan, 100)).toBe(0.5);
    expect(treasuryFill(deposited.clan, 0)).toBe(0);
  });

  it('кнопка «Основать клан» сернеет по причине, а не по ошибке 409', () => {
    const rich = payer(1000, 0);
    expect(describeClanMembership(rich, null, rules)).toMatchObject({
      canCreate: true,
      reason: 'ok',
      cost: CLAN_CREATE_COST
    });
    expect(describeClanMembership({ ...rich, clanId: 'c-1' }, null, rules).reason).toBe('member');
    expect(describeClanMembership(payer(10, 0), null, rules).reason).toBe('funds');
    expect(describeClanMembership({ ...payer(-100, 50), clanId: null }, null, rules).reason).toBe('debt');
    const shell = buildClanShell(checkClanIdentity({ name: 'Вид' }), 'c-2', rich.id, T0).clan;
    expect(describeClanMembership({ ...rich, clanId: 'c-2' }, shell, rules).clan?.id).toBe('c-2');
  });

  it('журнал взносов укорачивается по закрытым, pending не выбрасывается никогда', () => {
    const base = settleClanCreation(
      buildClanShell(checkClanIdentity({ name: 'Журнал' }), 'clan-h', 'u-1', T0).clan,
      T0
    );
    const userId = 'u-2';
    const account: UserAccount = { ...payer(0, 0), clanId: 'clan-h' };

    const contribution = (id: string, status: 'pending' | 'settled', index: number) => ({
      id,
      userId,
      metal: 'black_metal' as const,
      amount: 10,
      createdAt: addMs(T0, index * MINUTE),
      settledAt: status === 'settled' ? addMs(T0, index * MINUTE) : null,
      status,
      note: null
    });

    let clan: ClanState = { ...base, contributions: [contribution('s-1', 'settled', 1), contribution('s-2', 'settled', 2)] };
    clan = { ...clan, contributions: [...clan.contributions, contribution('p-1', 'pending', 3)] };
    expect(contributionsToday(clan, userId, T0.toISOString().slice(0, 10))).toEqual({ count: 3, units: 30 });

    const pruned = pruneContributions(clan, 2);
    expect(pruned.contributions.map((c) => c.id)).toEqual(['s-2', 'p-1']);
    // Аннулированный вклад не считается в суточном потолке: он ничего не стоил игроку.
    const voided = voidContribution(pruned, 's-2', 'expired', T0);
    expect(contributionsToday(voided, userId, T0.toISOString().slice(0, 10)).count).toBe(2);
    expect(account.clanId).toBe('clan-h');
  });
});

const MODEL_NAME = 'TdClanSchemaSmoke';
const Model: ClanModel =
  (mongoose.models[MODEL_NAME] as ClanModel | undefined) ?? mongoose.model<ClanDoc>(MODEL_NAME, clanSchema);

describe('clan.mongo: маппинг документа клана', () => {
  it('клон с вкладами ездит в документ и обратно без потерь', async () => {
    const deps = await harness();
    const leader = payer(1000, 0);
    await withClan(deps, leader);
    await deps.users.transact(leader.id, (current) =>
      withMetals(current, { black_metal: 300, colored_metal: 0, precious_metal: 0 })
    );
    const deposited = await depositToTreasury(deps, leader.id, { metal: 'black_metal', amount: 300 }, T0, rules);
    const clan = deposited.clan;

    const doc = new Model({ _id: clan.id, ...toSetPayload(clan) });
    await doc.validate();
    const restored = toClan(doc.toObject() as unknown as ClanDoc);
    expect(restored).toEqual(clan);
    expect(restored.contributions[0]?.createdAt).toBeInstanceOf(Date);
    expect(restored.contributions[0]?.settledAt).toBeInstanceOf(Date);
    expect(restored.treasury.black_metal).toBe(300);
  });

  it('недопустимое состояние документа отклоняется схемой, а не молча пишется', async () => {
    const clan = buildClanShell(checkClanIdentity({ name: 'Проверка' }), 'clan-bad', 'u-1', T0).clan;
    const doc = new Model({
      _id: clan.id,
      ...toSetPayload(clan),
      name: 'аб',
      contributions: [
        {
          cid: 'x',
          userId: 'u-1',
          metal: 'plutonium',
          amount: 1,
          createdAt: T0,
          settledAt: null,
          status: 'pending',
          note: null
        }
      ]
    });
    await expect(doc.validate()).rejects.toThrow();
  });

  it('индексы занятости имени и поиска по участнику объявлены схемой', () => {
    type IndexedEntry = [{ [field: string]: unknown }, { unique?: boolean }];
    const indexes = clanSchema.indexes() as unknown as IndexedEntry[];
    const uniqueName = indexes.find(([, options]) => options?.unique === true);
    expect(Object.keys(uniqueName?.[0] ?? {})).toContain('name');
    expect(indexes.some(([fields]) => Object.keys(fields ?? {}).includes('members'))).toBe(true);
  });
});

