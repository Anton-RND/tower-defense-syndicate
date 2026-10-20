import {
  CLAN_CREATE_COST,
  CLAN_MAX_DEPOSIT_UNITS,
  CLAN_MAX_MEMBERS,
  CLAN_TREASURY_CAP
} from '../../config/clans.js';
import type { EconomyConfig } from '../../config/env.js';
import { METAL_IDS, type MetalId } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { dayKey } from '../economy/energy.js';
import { credit, debit, metal, asteriumTotal, spendAsterium } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';
import {
  checkClanName,
  checkClanTag,
  contributionsToday,
  emptyTreasury,
  isMember,
  type ClanContribution,
  type ClanState
} from './clan.types.js';

/**
 * Домен кланов (Часть 2): ЧИСТЫЕ ФУНКЦИИ, как и весь остальной домен проекта.
 *
 * Ни одна из них ничего не читает и не пишет в стор: они принимают `UserAccount`
 * и/или `ClanState` и возвращают новые состояния вместе с черновиками журнала.
 * Порядок записи двух документов — в clan/commit.ts, и только там.
 *
 * ПОЧЕМУ ОСНОВАНИЕ КЛАНА РАЗРЕЗАНО НА ДВЕ ФУНКЦИИ. Клан создаётся в одном документе,
 * а астериев списывается в другом, и общей транзакции у нас нет (CAS атомарен в
 * пределах одного документа). Поэтому: сначала `buildClanShell` + `insert` (занятое
 * имя отсекает уникальный индекс — дешёвый отказ ДО списания денег), затем
 * `chargeClanCreation` (списание с идемпотентным ключом `clan:<clanId>`), затем
 * `settleClanCreation`. Провал на любом шаге не уничтожает ценность игрока: клан
 * остаётся в `pending_payment` и разбирается reconcile-ом, а деньги либо списаны,
 * либо нет — третьего журнал не допускает.
 */

// ─── Основание клана ──────────────────────────────────────────────────────────

export interface ClanIdentity {
  name: string;
  tag: string;
}

/**
 * Проверка имени/тега без обращения к сторy. Занятость имени проверяется отдельно:
 * это единственный факт о клане, который может измениться между проверкой и вставкой.
 */
export function checkClanIdentity(input: { name: string; tag?: string | null }): ClanIdentity {
  const checked = checkClanName(input.name);
  if (!checked.ok) {
    throw new AppError(ErrorCodes.CLAN_NAME_INVALID, 400, 'Имя клана не проходит правила', { reason: checked.reason });
  }
  const tag = checkClanTag(input.tag);
  if (tag && !tag.ok) {
    throw new AppError(ErrorCodes.CLAN_NAME_INVALID, 400, 'Тег клана не проходит правила (2-6 символов, А-Я/0-9)');
  }
  return { name: checked.name, tag: tag && tag.ok ? tag.tag : deriveTag(checked.name) };
}

/** Тег по умолчанию: первые допустимые символы нормализованного имени (без гугла кириллицы). */
function deriveTag(name: string): string {
  const letters = name.replace(/[^0-9A-ZА-ЯЁ]/gu, '').toLocaleUpperCase('ru').slice(0, 6);
  return letters.length >= 2 ? letters : 'КЛАН';
}

export interface ClanShell {
  clan: ClanState;
}

/** Оболочка клана в статусе `pending_payment`: оплата ещё не подтверждена. */
export function buildClanShell(identity: ClanIdentity, clanId: string, leaderId: string, now: Date): ClanShell {
  return {
    clan: {
      id: clanId,
      name: identity.name,
      tag: identity.tag,
      leaderId,
      members: [leaderId],
      status: 'pending_payment',
      treasury: emptyTreasury(),
      contributions: [],
      createdAt: now,
      updatedAt: now,
      note: null,
      revision: 0
    }
  };
}

export interface ChargeResult {
  account: UserAccount;
  drafts: LedgerDraft[];
}

/**
 * Списание критания за основание. Долг по донату (`purchased < 0`) блокирует оплату
 * так же, как в магазине строителей: платить можно только заработанным астерием,
 * иначе возврат платежа оставил бы игроку и клан, и возможность углублять долг.
 */
export function chargeClanCreation(
  account: UserAccount,
  clanId: string,
  now: Date,
  config: EconomyConfig
): ChargeResult {
  if (account.clanId) {
    throw new AppError(ErrorCodes.ALREADY_IN_CLAN, 409, 'Вы уже состоите в клане', { clanId: account.clanId });
  }
  const cost = CLAN_CREATE_COST;
  if (account.materials.asterium.purchased < 0 && account.materials.asterium.earned < cost) {
    throw new AppError(
      ErrorCodes.PURCHASES_BLOCKED,
      403,
      'Есть неотработанный возврат платежа: клан можно основать только за заработанный астериев',
      { cost, earned: account.materials.asterium.earned }
    );
  }
  if (asteriumTotal(account) < cost) {
    throw new AppError(ErrorCodes.INSUFFICIENT_FUNDS, 409, 'Недостаточно Астерия для основания клана', {
      required: cost,
      available: asteriumTotal(account)
    });
  }

  const spent = spendAsterium(account, cost, {
    ts: now,
    reason: 'clan_create',
    refType: 'clan',
    refId: clanId,
    idempotencyKey: makeIdempotencyKey('clan', clanId),
    meta: { cost, clan_id: clanId }
  });

  return { account: { ...spent.account, clanId }, drafts: spent.drafts };
}

/**
 * Ключи идемпотентности оплаты основания.
 *
 * `spendAsterium` ключует движение ПО КОШЕЛЬКУ (`:earned` / `:purchased`), иначе
 * второе движение одной траты было бы молча отброшено уникальным индексом журнала.
 * Значит, и доказательство оплаты для reconcile — любой из этой пары, а не «голый»
 * ключ действия: проверка одного лишь `clan:<id>` навсегда оставила бы оплаченный
 * клан в `pending_payment`.
 */
export function clanChargeKeys(clanId: string): string[] {
  const base = makeIdempotencyKey('clan', clanId);
  return [`${base}:earned`, `${base}:purchased`];
}

/** Оплата прошла → клан становится живым. */
export function settleClanCreation(clan: ClanState, now: Date): ClanState {
  if (clan.status === 'active') return clan;
  if (clan.status === 'void') {
    throw new AppError(ErrorCodes.CLAN_UNPAID, 409, 'Клан аннулирован, повторная активация невозможна', {
      clanId: clan.id
    });
  }
  return { ...clan, status: 'active', updatedAt: now };
}

/** Клан без оплаты: разбор зависшего слота имени (reconcile). */
export function voidClan(clan: ClanState, reason: string, now: Date): ClanState {
  if (clan.status === 'void') return clan;
  return { ...clan, status: 'void', updatedAt: now, note: reason };
}

// ─── Взнос в казну ────────────────────────────────────────────────────────────

export interface DepositInput {
  metal: MetalId;
  amount: number;
}

export interface DepositPlan {
  /** Клан с добавленным pending-взносом (казна НЕ тронута). */
  clan: ClanState;
  contribution: ClanContribution;
}

function assertActiveClan(clan: ClanState): void {
  if (clan.status === 'void') {
    throw new AppError(ErrorCodes.CLAN_NOT_FOUND, 404, 'Клан расформирован', { clanId: clan.id });
  }
  if (clan.status !== 'active') {
    throw new AppError(ErrorCodes.CLAN_UNPAID, 409, 'Клан ещё не оплачен', { clanId: clan.id, status: clan.status });
  }
}

function assertMember(clan: ClanState, account: UserAccount): void {
  if (!isMember(clan, account.id) || account.clanId !== clan.id) {
    throw new AppError(ErrorCodes.NOT_IN_CLAN, 409, 'Вы не состоите в этом клане', {
      clanId: clan.id,
      userId: account.id
    });
  }
}

/**
 * План взноса: проверяет оба документа и кладёт в клан pending-запись.
 *
 * ПОРЯДОК ИМЕННО ТАКОЙ, А НЕ «СНАЧАЛА СПИСАТЬ У ИГРОКА». Клановый взнос — вторая
 * в проекте операция на два документа (первая — рейд, см. pvp/raid.ts). Здесь мы
 * сознательно идём от обратного к рейду: сначала резервируем место в казне (pending),
 * потом списываем металл, потом подтверждаем. Если процесс упадёт между первым и
 * вторым шагом, у клана висит незакрытая запись, а у игрока целы ресурсы — reconcile
 * аннулирует запись по истечении окна. Списывай мы первыми, падение между шагами
 * ОТОБРАЛО БЫ у игрока металл без следа в казне, и чинить это пришлось бы через
 * поддержку. Потерянная ценность игрока всегда хуже зависшей записи в клане.
 */
export function planDeposit(
  clan: ClanState,
  account: UserAccount,
  input: DepositInput,
  now: Date,
  config: EconomyConfig,
  idFactory: () => string
): DepositPlan {
  assertActiveClan(clan);
  assertMember(clan, account);

  const amount = Math.trunc(input.amount);
  if (!Number.isFinite(input.amount) || amount <= 0) {
    throw new AppError(ErrorCodes.CLAN_DEPOSIT_INVALID, 400, 'Количество должно быть целым и больше нуля', {
      amount: input.amount
    });
  }
  if (amount > CLAN_MAX_DEPOSIT_UNITS) {
    throw new AppError(ErrorCodes.CLAN_DEPOSIT_INVALID, 400, 'Взнос превышает разовый потолок', {
      amount,
      limit: CLAN_MAX_DEPOSIT_UNITS
    });
  }
  const available = account.metals[input.metal] ?? 0;
  if (available < amount) {
    throw new AppError(ErrorCodes.CLAN_DEPOSIT_INVALID, 409, 'Недостаточно ресурсов для взноса', {
      metal: input.metal,
      required: amount,
      available
    });
  }

  const treasuryAfter = (clan.treasury[input.metal] ?? 0) + amount;
  if (treasuryAfter > CLAN_TREASURY_CAP) {
    throw new AppError(ErrorCodes.CLAN_FULL, 409, 'Казна клана заполнена', {
      metal: input.metal,
      treasury: clan.treasury[input.metal],
      cap: CLAN_TREASURY_CAP
    });
  }

  const limits = config.limits.clan;
  const today = contributionsToday(clan, account.id, dayKey(now));
  if (limits.dailyDeposits > 0 && today.count >= limits.dailyDeposits) {
    throw new AppError(ErrorCodes.CLAN_DEPOSIT_INVALID, 429, 'Суточный лимит взносов исчерпан', {
      limit: limits.dailyDeposits,
      used: today.count
    });
  }
  if (limits.dailyUnits > 0 && today.units + amount > limits.dailyUnits) {
    throw new AppError(ErrorCodes.CLAN_DEPOSIT_INVALID, 429, 'Суточный потолок единиц взноса исчерпан', {
      limit: limits.dailyUnits,
      used: today.units,
      requested: amount
    });
  }

  const contribution: ClanContribution = {
    id: idFactory(),
    userId: account.id,
    metal: input.metal,
    amount,
    createdAt: now,
    settledAt: null,
    status: 'pending',
    note: null
  };

  return {
    clan: { ...clan, contributions: [...clan.contributions, contribution], updatedAt: now },
    contribution
  };
}

/** Списание металла у игрока под уже зарезервированный взнос. */
export function chargeDeposit(
  account: UserAccount,
  contribution: ClanContribution,
  clanId: string,
  now: Date
): ChargeResult {
  const movement = debit(account, metal(contribution.metal), contribution.amount, {
    ts: now,
    reason: 'clan_deposit',
    refType: 'contribution',
    refId: contribution.id,
    idempotencyKey: makeIdempotencyKey('deposit', contribution.id),
    meta: { clan_id: clanId, metal: contribution.metal }
  });
  return { account: movement.account, drafts: [movement.draft] };
}

/** Компенсация: вернули металл игроку, если резервирование в клане не состоялось. */
export function rollbackDeposit(
  account: UserAccount,
  contribution: ClanContribution,
  clanId: string,
  now: Date
): ChargeResult {
  const movement = credit(account, metal(contribution.metal), contribution.amount, {
    ts: now,
    reason: 'clan_deposit',
    refType: 'contribution',
    refId: contribution.id,
    idempotencyKey: makeIdempotencyKey('deposit', `${contribution.id}:rollback`),
    meta: { clan_id: clanId, rollback: true }
  });
  return { account: movement.account, drafts: [movement.draft] };
}

/** Взнос подтверждён: металл переехал в казну. Идемпотентно по статусу. */
export function settleContribution(clan: ClanState, contributionId: string, now: Date): ClanState {
  const target = clan.contributions.find((c) => c.id === contributionId);
  if (!target) return clan;
  if (target.status === 'settled') return clan;
  if (target.status === 'void') {
    throw new AppError(ErrorCodes.CLAN_PENDING_EXPIRED, 409, 'Взнос уже аннулирован', { contributionId });
  }
  const treasury = { ...clan.treasury };
  treasury[target.metal] = (treasury[target.metal] ?? 0) + target.amount;
  return {
    ...clan,
    treasury,
    contributions: clan.contributions.map((c) =>
      c.id === contributionId ? { ...c, status: 'settled' as const, settledAt: now, note: null } : c
    ),
    updatedAt: now
  };
}

/** Взнос аннулирован (окно вышло / списание не состоялось): казна не трогается. */
export function voidContribution(clan: ClanState, contributionId: string, reason: string, now: Date): ClanState {
  const target = clan.contributions.find((c) => c.id === contributionId);
  if (!target || target.status !== 'pending') return clan;
  return {
    ...clan,
    contributions: clan.contributions.map((c) =>
      c.id === contributionId ? { ...c, status: 'void' as const, note: reason } : c
    ),
    updatedAt: now
  };
}

/**
 * Укорачиваем журнал взносов: закрытые записи старше прочих выбрасываем, pending не
 * трогаем НИКОГДА — именно они и есть неразобранное состояние двухдокументной операции.
 */
export function pruneContributions(clan: ClanState, history: number): ClanState {
  if (history <= 0) return clan;
  const pending = clan.contributions.filter((c) => c.status === 'pending');
  const closed = clan.contributions.filter((c) => c.status !== 'pending');
  const budget = Math.max(0, history - pending.length);
  if (closed.length <= budget) return clan;
  return { ...clan, contributions: [...closed.slice(closed.length - budget), ...pending] };
}

// ─── Состав участников ────────────────────────────────────────────────────────

/**
 * Вход в клан. Модели «заявка/приглашение» здесь намеренно нет: она требует отдельной
 * сущности заявок и уведомлений, а первая ценность Части 2 — казна и основание.
 * Открытый вход при потолке участников — осознанный компромисс до клановых войн.
 */
export function joinClan(account: UserAccount, clan: ClanState, now: Date): { clan: ClanState; account: UserAccount } {
  // Повторный вход в СВОЙ клан — no-op, а не ошибка: клиент ретраит запрос по плохой
  // сети, и отказ здесь выглядел бы как «тебя исключили».
  if (account.clanId === clan.id && isMember(clan, account.id)) return { clan, account };
  if (account.clanId) {
    throw new AppError(ErrorCodes.ALREADY_IN_CLAN, 409, 'Вы уже состоите в клане', { clanId: account.clanId });
  }
  assertActiveClan(clan);
  // Кэш игрока пуст, но клан его помнит: лечим кэш, не трогая состав.
  if (isMember(clan, account.id)) {
    return { clan, account: { ...account, clanId: clan.id } };
  }
  if (clan.members.length >= CLAN_MAX_MEMBERS) {
    throw new AppError(ErrorCodes.CLAN_FULL, 409, 'Клан заполнен', {
      members: clan.members.length,
      limit: CLAN_MAX_MEMBERS
    });
  }
  return {
    clan: { ...clan, members: [...clan.members, account.id], updatedAt: now },
    account: { ...account, clanId: clan.id }
  };
}

/**
 * Выход из клана.
 *
 * ЛИДЕР НЕ МОЖЕТ ПРОСТО ВЫЙТИ: `leaderId` обязан указывать на живого участника, иначе
 * клан остаётся сиротой с непередаваемым управлением. Единственному участнику
 * выход равен расформированию.
 */
export function leaveClan(account: UserAccount, clan: ClanState, now: Date): { clan: ClanState; account: UserAccount } {
  assertMember(clan, account);
  const alone = clan.members.length <= 1;
  if (clan.leaderId === account.id && !alone) {
    throw new AppError(ErrorCodes.CLAN_LEADER_ONLY, 409, 'Основитель не может выйти: передайте управление или расформируйте клан', {
      clanId: clan.id
    });
  }
  if (alone) {
    return {
      clan: { ...clan, status: 'void', members: [], updatedAt: now, note: 'disbanded_by_sole_member' },
      account: { ...account, clanId: null }
    };
  }
  return {
    clan: { ...clan, members: clan.members.filter((id) => id !== account.id), updatedAt: now },
    account: { ...account, clanId: null }
  };
}

/** Передача управления: только лидеру, только действующему участнику. */
export function transferLeadership(clan: ClanState, fromUserId: string, toUserId: string, now: Date): ClanState {
  if (clan.leaderId !== fromUserId) {
    throw new AppError(ErrorCodes.CLAN_LEADER_ONLY, 403, 'Передавать управление может только основитель', {
      clanId: clan.id
    });
  }
  if (!isMember(clan, toUserId)) {
    throw new AppError(ErrorCodes.CLAN_NOT_FOUND, 404, 'Новый основитель не состоит в клане', { userId: toUserId });
  }
  return { ...clan, leaderId: toUserId, updatedAt: now };
}

/**
 * Расформирование: только лидер и только с пустой казной.
 *
 * Казна — общая ценность: распустить клан с 50 000 чёрного металла означало бы просто
 * её сжечь (вернуть участникам уже невозможно — не помним, кто сколько внёс в общий
 * котёл, да и не нужно: взносы безвозмездны). Поэтому сначала тратим, потом роспуск.
 *
 * `clanId` бывших участников массово не вычищается: это N записей N документов ради
 * одного поля-кэша. Чтение клана по `clanId` со статусом `void` трактуется как «клана
 * нет» (см. resolveMembership в clan/commit.ts).
 */
export function disbandClan(clan: ClanState, byUserId: string, reason: string, now: Date): ClanState {
  if (clan.leaderId !== byUserId) {
    throw new AppError(ErrorCodes.CLAN_LEADER_ONLY, 403, 'Расформировать клан может только основитель', {
      clanId: clan.id
    });
  }
  const total = METAL_IDS.reduce((sum, id) => sum + (clan.treasury[id] ?? 0), 0);
  if (total > 0) {
    throw new AppError(ErrorCodes.CONFLICT, 409, 'Казна не пуста: сначала израсходуйте средства', {
      clanId: clan.id,
      treasuryUnits: total
    });
  }
  return { ...clan, status: 'void', members: [], updatedAt: now, note: reason };
}
