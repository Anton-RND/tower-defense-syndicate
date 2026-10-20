import type { FastifyInstance } from 'fastify';

import { MARKET_FEED_LIMIT } from '../../config/market.js';
import { isJunkId } from '../../config/workshop.js';
import { buyLot, cancelLot, listLot, reconcileMarket } from '../../modules/market/commit.js';
import { repriceMarket } from '../../modules/market/economy.js';
import { describeLot, describeMarket, describeMarketRules } from '../../modules/market/view.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { accountOf, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { bodyOf, intOf, stringOf, viewOf } from '../helpers.js';

/**
 * Чёрный рынок (Часть 2): P2P-торговля боевым хламом за SEC.
 *
 * Как и клановые маршруты, эти НЕ оборачивают действие в `accountAction`: протоколы
 * в market/commit.ts владеют транзакциями над ТРЕМЯ документами (лот, покупатель,
 * продавец), и сверху такой атомарности не собрать.
 *
 * ЧТЕНИЕ ВИТРИНЫ разбирает зависшие лоты (`reconcileMarket`) и пересчитывает
 * коридоры (`repriceMarket`) — иначе «оплата обрабатывается» превратилось бы в
 * вечное состояние, а «живая экономика» осталась бы таблицей из конфига. Оба —
 * по одной причине: без фонового воркера чтение витрины единственный момент,
 * когда рынок имеет право доделать за кем-то и подвинуть цены (см. шапку
 * economy.ts о том, почему торгующие этого права не имеют).
 */
export function registerMarketRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };
  const deps = {
    users: ctx.users,
    lots: ctx.lots,
    commodities: ctx.commodities,
    ledger: ctx.ledger,
    idFactory: ctx.idFactory,
    onError: (error: Error, context: Record<string, unknown>) =>
      ctx.logger.error('market_commit_cleanup_failed', { error: error.message, ...context })
  };
  const config = ctx.config.economy;

  app.get('/v1/market', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    await reconcileMarket(deps, now);
    const report = await repriceMarket(deps, now);
    if (report.moved.length > 0) {
      // Единственный след пересчёта в логах: по нему видно, что коридоры двигаются
      // и какие виды. Молча поменявшиеся цены — это инцидент поддержки, а не фича.
      ctx.logger.info('market_repriced', {
        moved: report.moved.map((m) => `${m.junk}:${m.factorFrom}→${m.factorTo}`),
        paused: report.paused
      });
    }
    const [lots, commodities] = await Promise.all([
      ctx.lots.listActive({ limit: MARKET_FEED_LIMIT }),
      ctx.commodities.list()
    ]);
    return {
      ...viewOf(ctx.config, account, now),
      market: describeMarket(lots, account, MARKET_FEED_LIMIT, commodities),
      rules: describeMarketRules(commodities)
    };
  });

  app.get('/v1/market/rules', auth, async () => ({ rules: describeMarketRules(await ctx.commodities.list()) }));


  app.post('/v1/market/lots', auth, async (request) => {
    const now = ctx.now();
    const body = bodyOf(request);
    const junk = stringOf(body, 'junk', 32);
    if (!isJunkId(junk)) {
      throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'Неизвестный вид хлама', { junk });
    }
    const amount = intOf(body, 'amount', { min: 1, max: 100_000 });
    const pricePerUnit = intOf(body, 'pricePerUnit', { min: 1, max: 1_000_000 });
    const listed = await listLot(deps, claimsOf(request).sub, { junk, amount, pricePerUnit }, now);
    ctx.logger.info('market_lot_listed', {
      userId: listed.account.id,
      lotId: listed.lot.id,
      junk,
      amount,
      pricePerUnit
    });
    return {
      ...viewOf(ctx.config, listed.account, now),
      result: { lot: describeLot(listed.lot, listed.account.id) }
    };
  });

  app.post<{ Params: { lotId: string } }>('/v1/market/lots/:lotId/buy', auth, async (request) => {
    const now = ctx.now();
    const lotId = request.params.lotId;
    const bought = await buyLot(deps, claimsOf(request).sub, lotId, now, config);
    ctx.logger.info('market_lot_bought', {
      userId: bought.buyer.id,
      lotId,
      // settled=false — деньги у покупателя списались, продавцу ещё не доведены:
      // по этому полю поддержка ищет «зависшие» сделки, а не гадает по журналу.
      settled: bought.settled
    });
    return {
      ...viewOf(ctx.config, bought.buyer, now),
      result: {
        lot: describeLot(bought.lot, bought.buyer.id),
        settled: bought.settled
      }
    };
  });

  app.post<{ Params: { lotId: string } }>('/v1/market/lots/:lotId/cancel', auth, async (request) => {
    const now = ctx.now();
    const lotId = request.params.lotId;
    const cancelled = await cancelLot(deps, claimsOf(request).sub, lotId, now);
    ctx.logger.info('market_lot_cancelled', { userId: cancelled.account.id, lotId });
    return {
      ...viewOf(ctx.config, cancelled.account, now),
      result: { lot: describeLot(cancelled.lot, cancelled.account.id) }
    };
  });
}
