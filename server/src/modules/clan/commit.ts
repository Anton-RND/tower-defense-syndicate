import type { EconomyConfig } from '../../config/env.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { asteriumTotal } from '../economy/wallet.js';
import { CLAN_CREATE_COST } from '../../config/clans.js';
import { makeIdempotencyKey, type LedgerEntry } from '../ledger/ledger.types.js';
import type { LedgerStore } from '../ledger/ledger.store.js';
import type { UserAccount } from '../user/user.types.js';
import type { UserStore } from '../user/user.store.js';
import { isMember, type ClanContribution, type ClanState } from './clan.types.js';
import { DuplicateClanNameError, type ClanStore } from './clan.store.js';
import {
  buildClanShell,
  chargeClanCreation,
  chargeDeposit,
  checkClanIdentity,
  clanChargeKeys,
  disbandClan,
  joinClan,
  leaveClan,
  planDeposit,
  pruneContributions,
  settleClanCreation,
  settleContribution,
  voidClan,
  voidContribution,
  type DepositInput
} from './service.js';

/**
 * Протоколы записи клановых операций на ДВА документа (Часть 2).
 *
 * Клан и игрок — разные документы, а стор атомарен только в пределах одного (CAS по
 * `revision`). Значит, любая клановая операция — это несколько транзакций, и между
 * ними процесс может упасть. Ровно та же задача, что и у рейда в Шаге 4, решается
 * здесь теми же принципами, но с другим порядком шагов — и разница обоснована:
 *
 *  1. Ни один шаг не должен создавать ценность из ниоткуда (казна растёт только на
 *     settled-взнос, у которого ЕСТЬ запись списания в журнале).
 *  2. Ни один шаг не должен терять ценность игрока молча (списание делается после
 *     резерва в клане, а провал списания откатывает резерв в `void`).
 *  3. Любой недоделанный шаг сам закрывается при следующем разборе (`reconcileClan`),
 *     арбитр — `LedgerStore.hasKey`: журнал знает, состоялись деньги или нет.
 *
 * Поэтому статусы `pending_payment` у клана и `pending` у взноса — не костыль, а
 * единственный честный способ ответить на вопрос «оплачено ли это».
 */

export interface ClanDeps {
  users: UserStore;
  clans: ClanStore;
  ledger: LedgerStore;
  idFactory: () => string;
  /**
   * Звонок провала компенсационного шага. HTTP-слой обязан залогировать его с
   * clanId/depositId: это сигнал для фоновой компенсации, а не тихая потеря.
   */
  onError?: (error: Error, context: Record<string, unknown>) => void;
}

export interface CreateClanResult {
  clan: ClanState;
  account: UserAccount;
  /** true — оплата проведена и клан активен; false — клан ждёт разбора (reconcile). */
  active: boolean;
}

/** Основание клана за астериев. См. шапку файла: порядок шагов — часть контракта. */
export async function createClan(
  deps: ClanDeps,
  userId: string,
  input: { name: string; tag?: string | null },
  now: Date,
  config: EconomyConfig
): Promise<CreateClanResult> {
  const fresh = await deps.users.findById(userId);
  if (!fresh) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId });
  // Дешёвые проверки до вставки: занять имя сломанным игроком — значит отобрать его
  // у того, кто реально готов платить, на время разбора зависшего клана.
  if (fresh.clanId) {
    throw new AppError(ErrorCodes.ALREADY_IN_CLAN, 409, 'Вы уже состоите в клане', { clanId: fresh.clanId });
  }
  if (asteriumTotal(fresh) < CLAN_CREATE_COST) {
    throw new AppError(ErrorCodes.INSUFFICIENT_FUNDS, 409, 'Недостаточно Астерия для основания клана', {
      required: CLAN_CREATE_COST,
      available: asteriumTotal(fresh)
    });
  }

  const identity = checkClanIdentity(input);
  const clanId = deps.idFactory();
  const shell = buildClanShell(identity, clanId, userId, now);

  try {
    await deps.clans.insert(shell.clan);
  } catch (error) {
    if (error instanceof DuplicateClanNameError) {
      throw new AppError(ErrorCodes.CLAN_NAME_TAKEN, 409, 'Клан с таким именем уже зарегистрирован', {
        name: identity.name
      });
    }
    throw error;
  }

  // Шаг 2: списание критания. Идемпотентность — по ключу `clan:<clanId>`: повторный
  // проход (ретрай клиента, догон reconcile) не спишет вторую разовую плату за тот же клан.
  let account: UserAccount;
  try {
    const captured: { account: UserAccount; drafts: LedgerEntry[] }[] = [];
    account = await deps.users.transact(userId, (current) => {
      const charged = chargeClanCreation(current, clanId, now, config);
      captured.push({
        account: charged.account,
        drafts: charged.drafts.map((draft) => ({ ...draft, id: deps.idFactory() }))
      });
      return charged.account;
    });
    const entries = captured[captured.length - 1]?.drafts ?? [];
    if (entries.length > 0) await deps.ledger.appendMany(entries);
  } catch (error) {
    // Оплата не состоялась → освобождаем имя. Провал освобождения не глотаем молча:
    // зависший pending_payment-клан разберёт reconcile по истечении окна.
    try {
      await deps.clans.transact(clanId, (current) => voidClan(current, 'charge_failed', now));
    } catch (cleanup) {
      deps.onError?.(cleanup instanceof Error ? cleanup : new Error(String(cleanup)), { clanId, stage: 'void' });
    }
    throw error;
  }

  // Шаг 3: активация. Если не прошло — деньги уже списаны, и reconcile обязан
  // активировать клан по доказательству в журнале, а не держать его вечным должником.
  try {
    const clan = await deps.clans.transact(clanId, (current) =>
      pruneContributions(settleClanCreation(current, now), config.limits.clan.history)
    );
    return { clan, account, active: true };
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), { clanId, stage: 'activate' });
    const clan = await deps.clans.findById(clanId);
    return { clan: clan ?? shell.clan, account, active: false };
  }
}

export interface DepositResult {
  clan: ClanState;
  account: UserAccount;
  contribution: ClanContribution;
  /** true — взнос подтверждён и лёг в казну; false — ждёт разбора (reconcile). */
  settled: boolean;
}

/**
 * Взнос в казну: резерв в клане → списание у игрока → подтверждение в клане.
 *
 * Провал списания откатывает резерв (`void`), поэтому у игрока никогда не бывает
 * «минус металл, плюс ничего». Провал подтверждения оставляет pending-запись,
 * которую закрывает reconcileClan по доказательству списания в журнале.
 */
export async function depositToTreasury(
  deps: ClanDeps,
  userId: string,
  input: DepositInput,
  now: Date,
  config: EconomyConfig
): Promise<DepositResult> {
  const account = await deps.users.findById(userId);
  if (!account) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId });
  if (!account.clanId) throw new AppError(ErrorCodes.NOT_IN_CLAN, 409, 'Вы не состоите в клане');
  const clanNow = await deps.clans.findById(account.clanId);
  if (!clanNow) throw new AppError(ErrorCodes.CLAN_NOT_FOUND, 404, 'Клан не найден', { clanId: account.clanId });

  // Шаг 1: резерв. Редуктор пересчитывает план на СВЕЖЕМ документе клана: CAS-повтор
  // обязан прийти к той же записи, иначе потолок взносов обходится гонкой.
  const planned: { clan: ClanState; contribution: ClanContribution }[] = [];
  const reserved = await deps.clans.transact(clanNow.id, (current) => {
    const plan = planDeposit(current, account, input, now, config, deps.idFactory);
    planned.push({ clan: plan.clan, contribution: plan.contribution });
    return plan.clan;
  });
  const contribution = planned[planned.length - 1]?.contribution;
  if (!contribution) throw new AppError(ErrorCodes.INTERNAL, 500, 'Взнос не зарезервирован');

  // Шаг 2: списание у игрока под зарезервированный id.
  let charged: UserAccount;
  try {
    const captured: { account: UserAccount; drafts: LedgerEntry[] }[] = [];
    charged = await deps.users.transact(userId, (current) => {
      const movement = chargeDeposit(current, contribution, reserved.id, now);
      captured.push({
        account: movement.account,
        drafts: movement.drafts.map((draft) => ({ ...draft, id: deps.idFactory() }))
      });
      return movement.account;
    });
    const entries = captured[captured.length - 1]?.drafts ?? [];
    if (entries.length > 0) await deps.ledger.appendMany(entries);
  } catch (error) {
    try {
      await deps.clans.transact(reserved.id, (current) => voidContribution(current, contribution.id, 'charge_failed', now));
    } catch (cleanup) {
      deps.onError?.(cleanup instanceof Error ? cleanup : new Error(String(cleanup)), {
        clanId: reserved.id,
        depositId: contribution.id,
        stage: 'void_contribution'
      });
    }
    throw error;
  }

  // Шаг 3: подтверждение — металл переезжает в казну.
  try {
    const clan = await deps.clans.transact(reserved.id, (current) =>
      pruneContributions(settleContribution(current, contribution.id, now), config.limits.clan.history)
    );
    return { clan, account: charged, contribution: { ...contribution, status: 'settled', settledAt: now }, settled: true };
  } catch (error) {
    deps.onError?.(error instanceof Error ? error : new Error(String(error)), {
      clanId: reserved.id,
      depositId: contribution.id,
      stage: 'settle_contribution'
    });
    return { clan: reserved, account: charged, contribution, settled: false };
  }
}

/** Разбор зависших записей клана: единственный способ «починить» прерванную операцию. */
export async function reconcileClan(
  deps: ClanDeps,
  clanId: string,
  now: Date,
  config: EconomyConfig
): Promise<{ activated: boolean; settled: number; voided: number }> {
  const clan = await deps.clans.findById(clanId);
  if (!clan) return { activated: false, settled: 0, voided: 0 };

  const ttl = config.limits.clan.pendingTtlMs;
  const stale = (at: Date): boolean => now.getTime() - at.getTime() > ttl;

  // Редуктор не может быть async (`hasKey` — I/O), поэтому решения считаются заранее,
  // а транзакция применяет их одним чистым редуктором. Счётчики выводятся из решений,
  // а не из числа вызовов редуктора: CAS-повтор обязан дать тот же ответ.
  const settle = new Set<string>();
  const expire = new Set<string>();
  let shouldActivate = false;
  let shouldVoid = false;

  if (clan.status === 'pending_payment' && stale(clan.createdAt)) {
    const proofs = clanChargeKeys(clan.id);
    let paid = false;
    for (const key of proofs) {
      if (await deps.ledger.hasKey(key)) {
        paid = true;
        break;
      }
    }
    shouldActivate = paid;
    // Основание без оплаты: освобождаем имя, иначе сломанный игрок держит название клана
    // навсегда. Деньги не теряются — их и не списывали (доказательства в журнале нет).
    shouldVoid = !shouldActivate;
  }
  for (const contribution of clan.contributions) {
    if (contribution.status !== 'pending' || !stale(contribution.createdAt)) continue;
    const charged = await deps.ledger.hasKey(makeIdempotencyKey('deposit', contribution.id));
    if (charged) settle.add(contribution.id);
    else expire.add(contribution.id);
  }
  if (!shouldActivate && !shouldVoid && settle.size === 0 && expire.size === 0) {
    return { activated: false, settled: 0, voided: 0 };
  }

  const applied = await deps.clans.transact(clanId, (current) => {
    if (shouldVoid) return voidClan(current, 'unpaid_timeout', now);
    let state = current;
    if (shouldActivate) state = settleClanCreation(state, now);
    for (const id of settle) state = settleContribution(state, id, now);
    for (const id of expire) state = voidContribution(state, id, 'expired', now);
    return pruneContributions(state, config.limits.clan.history);
  });

  return {
    activated: shouldActivate && applied.status === 'active',
    settled: [...settle].filter((id) =>
      applied.contributions.some((c) => c.id === id && c.status === 'settled')
    ).length,
    voided: [...expire].filter((id) =>
      applied.contributions.some((c) => c.id === id && c.status === 'void')
    ).length
  };
}

// ─── Состав участников ────────────────────────────────────────────────────────

/**
 * Членство игрока по состоянию его документа + клана.
 *
 * КЛАН — ИСТОЧНИК ИСТИНЫ. `account.clanId` это кэш: он устаревает, когда клан
 * расформирован, а `clanId` бывших участников массово не переписывался, и когда
 * игрока исключили, а его документ не обновился. Возвращать в этом случае «клан есть»
 * нельзя: фронт показал бы казну клана, в котором игрока уже нет.
 */
export async function resolveMembership(
  account: UserAccount,
  clans: ClanStore
): Promise<{ clanId: string | null; clan: ClanState | null }> {
  if (!account.clanId) return { clanId: null, clan: null };
  const clan = await clans.findById(account.clanId);
  if (!clan || clan.status === 'void' || !isMember(clan, account.id)) return { clanId: null, clan: null };
  return { clanId: clan.id, clan };
}

/** Вступление в открытый клан: один редуктор клана + один редуктор игрока. */
export async function joinClanById(
  deps: ClanDeps,
  userId: string,
  clanId: string,
  now: Date
): Promise<{ clan: ClanState; account: UserAccount }> {
  const account = await deps.users.findById(userId);
  if (!account) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId });

  // Проверка на свежем документе клана: потолок участников иначе обходится гонкой.
  const clan = await deps.clans.transact(clanId, (current) => joinClan(account, current, now).clan);

  const updated = await deps.users.transact(userId, (current) => {
    const result = joinClan(current, clan, now);
    return result.account;
  });
  return { clan, account: updated };
}

/** Выход из клана. Клан обновляется первым: иначе игрок останется без `clanId` при отказе клана. */
export async function leaveCurrentClan(
  deps: ClanDeps,
  userId: string,
  now: Date
): Promise<{ clan: ClanState | null; account: UserAccount }> {
  const account = await deps.users.findById(userId);
  if (!account) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId });
  if (!account.clanId) throw new AppError(ErrorCodes.NOT_IN_CLAN, 409, 'Вы не состоите в клане');

  const clanId = account.clanId;
  const clan = await deps.clans.transact(clanId, (current) => leaveClan(account, current, now).clan);
  const updated = await deps.users.transact(userId, (current) => ({ ...current, clanId: null }));
  return { clan: clan.status === 'void' ? null : clan, account: updated };
}

/** Расформирование клана основителем (казна обязана быть пуста). */
export async function disbandCurrentClan(
  deps: ClanDeps,
  userId: string,
  now: Date,
  reason = 'disbanded'
): Promise<ClanState> {
  const account = await deps.users.findById(userId);
  if (!account) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId });
  if (!account.clanId) throw new AppError(ErrorCodes.NOT_IN_CLAN, 409, 'Вы не состоите в клане');

  const clanId = account.clanId;
  const clan = await deps.clans.transact(clanId, (current) => disbandClan(current, userId, reason, now));
  await deps.users.transact(userId, (current) => ({ ...current, clanId: null }));
  return clan;
}
