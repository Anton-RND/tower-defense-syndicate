import type { FastifyInstance } from 'fastify';

import { MARKET_FEED_LIMIT } from '../../config/market.js';
import { isJunkId } from '../../config/workshop.js';
import { buyLot, cancelLot, listLot } from '../../modules/market/commit.js';
import { runMarketMaintenance } from '../../modules/market/maintenance.js';
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
 * ЧТЕНИЕ ВИТРИНЫ обслуживает рынок (`runMarketMaintenance`: разбор зависших лотов +
 * пересчёт коридоров) — иначе «оплата обрабатывается» превратилось бы в вечное
 * состояние, а «живая экономика» осталась бы таблицей из конфига. С появлением
 * фонового цикла (backlog 4) это перестало быть ЕДИНСТВЕННЫМ моментом, когда рынок
 * доделывается, но читать витрину по-прежнему нужно разобранным: игрок, нажавший
 * «обновить», обязан видеть мир после разбора, а не до него. Порядок и логи общие с
 * циклом намеренно — одна функция на обоих путях.
 */
export function registerMarketRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };
  // Зависимости протоколов собираются один раз в контексте процесса: тот же объект
  // идёт и в фоновый цикл, иначе reconcile из цикла и reconcile из маршрута имели бы
  // разные права на объявление продажи (marketDeps.onSold) — то есть пуш зависел бы от
  // того, кто первым доделал лот.
  const deps = ctx.marketDeps;
  const config = ctx.config.economy;

  app.get('/v1/market', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    await runMarketMaintenance(deps, now, ctx.logger);
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
