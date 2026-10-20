import type { FastifyInstance } from 'fastify';

import { MINING_RESOURCES } from '../../config/env.js';
import { CRAFT_TECH_IDS, type CraftTechId } from '../../config/materials.js';
import { JUNK_IDS, METAL_IDS, type JunkId, type MetalId } from '../../config/workshop.js';
import { validationError } from '../../lib/errors.js';
import {
  asterium,
  credit,
  junk as junkTarget,
  metal as metalTarget,
  resource as resourceTarget,
  tech as techTarget,
  type BalanceTarget
} from '../../modules/economy/wallet.js';
import { chargeStanium } from '../../modules/materials/commit.js';
import { confirmPayment, refundPayment } from '../../modules/payment/commit.js';
import { createAccount } from '../../modules/user/user.types.js';
import { accountOf, assertDevRoutes, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf, intOf, optionalStringOf, stringOf, viewOf } from '../helpers.js';

/**
 * Отладочные маршруты стенда. ВСЕ закрыты `assertDevRoutes`: в production
 * `config.devSignerEnabled` всегда false (env.ts:225), поэтому сюда физически
 * невозможно попасть с деньгами игрока.
 *
 * Зачем здесь три разные вещи:
 *  - `/payments/confirm|refund` — эмуляция подписанного события площадки. Настоящий
 *    вебхук требует VK_SECRET_KEY и приходит вне сессии игрока; стенд подменяет его,
 *    иначе весь маршрут «купил пак → материал пришёл → возврат → долг» непроверяем.
 *  - `/grant` — печать баланса. Без неё невозможно посмотреть станиумное поле и долг
 *    по рефанду, не наиграв несколько часов майнинга.
 *  - `/seed-opponents` — соперники. В пустой базе findOpponent всегда возвращает
 *    NO_OPPONENT, и PvP-часть стенда была бы мертва.
 */
export function registerDevRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };
  const deps = { users: ctx.users, ledger: ctx.ledger, idFactory: ctx.idFactory };

  app.post('/v1/dev/grant', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const grants = collectGrants(bodyOf(request));
    if (grants.length === 0) {
      throw validationError('Не указано ни одного поля для выдачи', { allowed: ALLOWED_GRANT_FIELDS });
    }
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      let next = synced;
      const drafts = [];
      for (const grant of grants) {
        const movement = credit(next, grant.target, grant.amount, {
          ts: now,
          reason: 'admin',
          refType: null,
          refId: 'dev_grant',
          idempotencyKey: null,
          meta: { source: 'dev_grant' }
        });
        next = movement.account;
        drafts.push(movement.draft);
      }
      return { account: next, drafts, meta: { count: drafts.length } };
    });
    ctx.logger.info('dev_grant', { userId: account.id, movements: meta.count });
    return { ...viewOf(ctx.config, account, now), result: { movements: meta.count } };
  });

  /**
   * Состояние очереди уведомлений (Часть 2, backlog 3).
   *
   * Единственная наблюдаемая точка пути «продажа → пуш». Сам факт рождается внутри
   * денежного протокола, а доставка уходит в фон, поэтому ни того, ни другого нельзя
   * увидеть ни в одном ответе игрока: продажа проходит молча, и молча потерянный пуш
   * выглядит точно так же, как доставленный. Без этого маршрута проводку можно
   * проверить только подняв подставной VK API, то есть силами оператора, а не смоука.
   */
  app.get('/v1/dev/notices', auth, async () => {
    assertDevRoutes(ctx);
    return {
      result: {
        readiness: ctx.notices.readiness(),
        stats: ctx.notices.stats(),
        queued: ctx.notices.size()
      }
    };
  });

  app.post('/v1/dev/seed-opponents', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const body = bodyOf(request);
    const count = intOf(body, 'count', { min: 1, max: 50 });
    const stanium = intOf(body, 'stanium', { min: 0, max: 96 });
    const batch = optionalStringOf(body, 'batch', 32) ?? String(now.getTime());

    const seeded: Array<{ userId: string; socialId: string; rating: number; staniumField: string | null }> = [];
    for (let index = 0; index < count; index += 1) {
      const socialId = `bot-${batch}-${index + 1}`;
      const { account } = await ctx.users.getOrCreate(
        { platform: 'vk', socialId, appId: null, groupId: null },
        now,
        (identity, at) => createAccount(identity, at, ctx.config.economy, ctx.idFactory)
      );
      let field: Date | null = null;
      if (stanium > 0) {
        // Поле ставим через боевой хаб, а не правкой документа: иначе стенд проверял
        // бы не тот код, по которому играет реальный рейд.
        await accountAction(ctx, account.id, now, (synced) => ({
          account: credit(synced, techTarget('stanium'), stanium, {
            ts: now,
            reason: 'admin',
            refType: null,
            refId: 'dev_seed',
            idempotencyKey: null
          }).account,
          meta: null
        }));
        const charged = await chargeStanium(deps, account.id, stanium, now, {});
        field = charged.field.until ?? null;
      }
      const fresh = await ctx.users.findById(account.id);
      seeded.push({
        userId: account.id,
        socialId,
        rating: fresh?.pvp.rating ?? account.pvp.rating,
        staniumField: field ? field.toISOString() : null
      });
    }
    ctx.logger.info('dev_seed_opponents', { count: seeded.length, stanium });
    return { result: { seeded } };
  });

  app.post('/v1/dev/payments/confirm', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const body = bodyOf(request);
    const orderId = stringOf(body, 'orderId', 128);
    const fulfilled = await confirmPayment(
      deps,
      orderId,
      {
        providerOrderId: optionalStringOf(body, 'providerOrderId', 64),
        item: optionalStringOf(body, 'item', 64),
        votes: body['votes'] === undefined || body['votes'] === null ? null : intOf(body, 'votes', { min: 0 })
      },
      now,
      ctx.config.economy
    );
    ctx.logger.info('dev_payment_confirmed', { orderId, userId: fulfilled.userId, granted: fulfilled.granted });
    return {
      ...viewOf(ctx.config, fulfilled.account, now),
      result: { order: fulfilled.order, granted: fulfilled.granted, duplicate: fulfilled.duplicate }
    };
  });

  app.post('/v1/dev/payments/refund', auth, async (request) => {
    assertDevRoutes(ctx);
    const now = ctx.now();
    const orderId = stringOf(bodyOf(request), 'orderId', 128);
    const refunded = await refundPayment(deps, orderId, now, ctx.config.economy);
    ctx.logger.info('dev_payment_refunded', { orderId, userId: refunded.userId });
    return {
      ...viewOf(ctx.config, refunded.account, now),
      result: { order: refunded.order, granted: refunded.granted, duplicate: refunded.duplicate }
    };
  });

  app.get('/v1/dev/account', auth, async (request) => {
    assertDevRoutes(ctx);
    const account = await accountOf(ctx, request);
    // Сырой документ, включая отрицательные кошельки: витрина часть состояния
    // нормализует, а долговые сценарии надо смотреть по оригиналу.
    return { account };
  });
}

// ─── Выдача баланса ───────────────────────────────────────────────────────────────

interface Grant {
  target: BalanceTarget;
  amount: number;
}

const ALLOWED_GRANT_FIELDS: string[] = [
  ...MINING_RESOURCES,
  'energy',
  // SEC — не руда: он не майнится складом и не собирается рукой, а накапает тиком.
  // Без печати на стенде нельзя проверить ни витрину кошелька, ни трату монеты.
  'sec',
  'asteriumPurchased',
  'asteriumEarned',
  ...CRAFT_TECH_IDS,
  ...METAL_IDS,
  ...JUNK_IDS
];

function collectGrants(body: Record<string, unknown>): Grant[] {
  const grants: Grant[] = [];
  const take = (field: string, target: BalanceTarget): void => {
    const raw = body[field];
    if (raw === undefined || raw === null || raw === '') return;
    grants.push({ target, amount: intOf(body, field, { min: 0, max: 10_000_000 }) });
  };

  for (const id of MINING_RESOURCES) take(id, resourceTarget(id));
  take('energy', resourceTarget('energy'));
  take('sec', resourceTarget('sec'));
  take('asteriumPurchased', asterium('purchased'));
  take('asteriumEarned', asterium('earned'));
  for (const id of CRAFT_TECH_IDS as readonly CraftTechId[]) take(id, techTarget(id));
  for (const id of METAL_IDS as readonly MetalId[]) take(id, metalTarget(id));
  for (const id of JUNK_IDS as readonly JunkId[]) take(id, junkTarget(id));
  return grants;
}
