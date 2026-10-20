import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  CLAN_CREATE_COST,
  CLAN_MAX_DEPOSIT_UNITS,
  CLAN_MAX_MEMBERS,
  CLAN_NAME_MAX_LENGTH,
  CLAN_NAME_MIN_LENGTH,
  CLAN_TAG_MAX_LENGTH,
  CLAN_TAG_MIN_LENGTH,
  CLAN_TREASURY_CAP
} from '../../config/clans.js';
import { METAL_IDS, isMetalId } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { dayKey } from '../../modules/economy/energy.js';
import {
  createClan,
  depositToTreasury,
  disbandCurrentClan,
  joinClanByName,
  leaveCurrentClan,
  reconcileClan,
  resolveMembership,
  transferLeadershipTo
} from '../../modules/clan/commit.js';
import { describeClan, describeClanMembership, describeMyContributions } from '../../modules/clan/view.js';
import { accountOf, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { bodyOf, intOf, stringOf, viewOf } from '../helpers.js';

/**
 * Клан (Часть 2).
 *
 * Маршруты, как и в materialsRoutes, НЕ оборачивают действие в `accountAction`:
 * протоколы клана живут в clan/commit.ts и владеют своими транзакциями над ДВУМЯ
 * документами, а сверху этой атомарности нет — `users.transact` и `clans.transact`
 * два разных CAS. Собирать их в одну транзакцию сверху означало бы либо вложить
 * транзакцию в транзакцию, либо молча потерять шаг отката при провале второго документа.
 *
 * ЕДИНСТВЕННЫЙ источник истины — клан, а не `account.clanId`. Поэтому GET сначала
 * делает `resolveMembership` (и возвращает «клана нет», если документ клана
 * расформирован или игрока в нём уже нет), и только потом отдаёт витрину. Иначе
 * фронт показывал бы казну клана, из которого игрока исключили часом ранее.
 *
 * Разбор зависших записей (`reconcileClan`) вызывается на чтении, а не фоном: при
 * отсутствии воркера именно чтение — единственный честный момент, когда
 * «обрабатывается» превращается в «подтверждено» или «отменено». Дешевизна
 * ограничена: один клан на запрос, и только если в нём есть pending-записи.
 */
export function registerClanRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };
  const deps = {
    users: ctx.users,
    clans: ctx.clans,
    ledger: ctx.ledger,
    idFactory: ctx.idFactory,
    onError: (error: Error, context: Record<string, unknown>) =>
      ctx.logger.error('clan_commit_cleanup_failed', { error: error.message, ...context })
  };
  const config = ctx.config.economy;

  /** Свежий документ игрока + его клан (или null) + разбор зависших взносов. */
  async function membershipOf(request: FastifyRequest, now: Date) {
    const account = await accountOf(ctx, request);
    const resolved = await resolveMembership(account, ctx.clans);
    if (!resolved.clan) return { account, clan: null };
    await reconcileClan(deps, resolved.clan.id, now, config);
    const refreshed = await ctx.clans.findById(resolved.clan.id);
    return { account, clan: refreshed ?? resolved.clan };
  }

  app.get('/v1/clan', auth, async (request) => {
    const now = ctx.now();
    const { account, clan } = await membershipOf(request, now);
    return {
      ...viewOf(ctx.config, account, now),
      membership: describeClanMembership(account, clan, config),
      mine: clan ? describeMyContributions(clan, account.id, dayKey(now), config) : null,
      rules: clanRules(config)
    };
  });

  app.get('/v1/clan/catalog', auth, async () => ({ rules: clanRules(ctx.config.economy) }));

  app.post('/v1/clan', auth, async (request) => {
    const now = ctx.now();
    const body = bodyOf(request);
    const name = stringOf(body, 'name', CLAN_NAME_MAX_LENGTH * 2);
    const tag = typeof body.tag === 'string' ? body.tag : null;
    const created = await createClan(deps, claimsOf(request).sub, { name, tag }, now, config);
    ctx.logger.info('clan_created', {
      userId: created.account.id,
      clanId: created.clan.id,
      // active=false — деньги списаны или зависли, но клан ещё не работает: это
      // состояние для поддержки важнее самого факта запроса.
      active: created.active
    });
    return {
      ...viewOf(ctx.config, created.account, now),
      result: { clan: describeClan(created.clan), active: created.active }
    };
  });

  app.post('/v1/clan/join', auth, async (request) => {
    const now = ctx.now();
    const name = stringOf(bodyOf(request), 'name', CLAN_NAME_MAX_LENGTH * 2);
    const joined = await joinClanByName(deps, claimsOf(request).sub, name, now);
    ctx.logger.info('clan_joined', { userId: joined.account.id, clanId: joined.clan.id });
    return {
      ...viewOf(ctx.config, joined.account, now),
      result: { clan: describeClan(joined.clan) }
    };
  });

  app.post('/v1/clan/deposit', auth, async (request) => {
    const now = ctx.now();
    const body = bodyOf(request);
    const metal = stringOf(body, 'metal', 32);
    // Казна принимает ровно три металла, и `DepositInput` это типом требует:
    // пропустить сюда произвольную строку означало бы отдать домену параметр, который
    // он обязан отвергнуть, вместо отказа на входе HTTP-слоя.
    if (!isMetalId(metal)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'Неизвестный металл казны', {
        metal,
        allowed: METAL_IDS
      });
    }
    const amount = intOf(body, 'amount', { min: 1, max: CLAN_MAX_DEPOSIT_UNITS });
    const deposited = await depositToTreasury(deps, claimsOf(request).sub, { metal, amount }, now, config);
    ctx.logger.info('clan_deposit', {
      userId: deposited.account.id,
      clanId: deposited.clan.id,
      metal,
      amount,
      settled: deposited.settled
    });
    return {
      ...viewOf(ctx.config, deposited.account, now),
      result: {
        clan: describeClan(deposited.clan),
        contribution: deposited.contribution,
        // false — металл у игрока уже списан, а казна ещё не выросла: UI обязан
        // показать «обрабатывается», а не «взнос потерян».
        settled: deposited.settled
      }
    };
  });

  app.post('/v1/clan/leave', auth, async (request) => {
    const now = ctx.now();
    const left = await leaveCurrentClan(deps, claimsOf(request).sub, now);
    ctx.logger.info('clan_left', { userId: left.account.id, clanId: left.clan?.id ?? null });
    return {
      ...viewOf(ctx.config, left.account, now),
      result: { clan: left.clan ? describeClan(left.clan) : null }
    };
  });

  app.post('/v1/clan/disband', auth, async (request) => {
    const now = ctx.now();
    const clan = await disbandCurrentClan(deps, claimsOf(request).sub, now);
    ctx.logger.info('clan_disbanded', { clanId: clan.id });
    return { result: { clan: describeClan(clan) } };
  });

  app.post('/v1/clan/transfer', auth, async (request) => {
    const now = ctx.now();
    const toUserId = stringOf(bodyOf(request), 'userId', 64);
    const clan = await transferLeadershipTo(deps, claimsOf(request).sub, toUserId, now);
    ctx.logger.info('clan_leader_transferred', { clanId: clan.id, toUserId });
    return { result: { clan: describeClan(clan) } };
  });
}

/**
 * Правила клана наружу одним объектом.
 *
 * Отдаются, а не проверяются молча: кнопка «Основать» обязана сереться по причине,
 * которую фронт может показать («имя от 3 до 24 символов»), иначе отказ 400 приходит
 * раньше, чем игрок понимает, что сделал не так.
 */
function clanRules(config: AppContext['config']['economy']) {
  return {
    createCost: CLAN_CREATE_COST,
    maxMembers: CLAN_MAX_MEMBERS,
    treasuryCap: CLAN_TREASURY_CAP,
    maxDepositUnits: CLAN_MAX_DEPOSIT_UNITS,
    metals: METAL_IDS,
    name: { min: CLAN_NAME_MIN_LENGTH, max: CLAN_NAME_MAX_LENGTH },
    tag: { min: CLAN_TAG_MIN_LENGTH, max: CLAN_TAG_MAX_LENGTH },
    dailyDeposits: config.limits.clan.dailyDeposits,
    dailyUnits: config.limits.clan.dailyUnits,
    pendingTtlMs: config.limits.clan.pendingTtlMs,
    history: config.limits.clan.history
  };
}
