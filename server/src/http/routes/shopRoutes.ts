import type { FastifyInstance } from 'fastify';

import { describeCatalog } from '../../config/shop.js';
import { describeBuilderShop, buyBuilder } from '../../modules/shop/builders.js';
import { describeOrders } from '../../modules/payment/orders.js';
import { noteClientReceipt, openCheckout } from '../../modules/payment/commit.js';
import { accountOf, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf, optionalStringOf, stringOf, viewOf } from '../helpers.js';

/**
 * Магазин (Часть 1).
 *
 * Здесь только шаги 1 и «запомнить квитанцию». Выдачи товара по просьбе клиента нет
 * и быть не может: товар подтверждает подписанное событие площадки (payment/commit.ts
 * → confirmPayment). В стенде эту роль играет /v1/dev/payments/* — см. devRoutes.ts,
 * маршрут закрыт DEV_SIGNER_ENABLED и в production не существует.
 *
 * Покупка слота робота — исключение из «подтверждай площадка»: это не донат-пак, а
 * разовая списание астерия внутри игры, поэтому оплата проходит обычный кошелёк и
 * идемпотентна детерминированным orderId (`builder:<userId>:<slot>`).
 */
export function registerShopRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };
  const deps = { users: ctx.users, ledger: ctx.ledger, idFactory: ctx.idFactory };

  app.get('/v1/shop/catalog', auth, async () => ({ catalog: describeCatalog() }));

  app.get('/v1/shop/builders', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    return { ...viewOf(ctx.config, account, now), result: { builders: describeBuilderShop(account, now) } };
  });

  app.post('/v1/shop/builders', auth, async (request) => {
    const now = ctx.now();
    const orderId = optionalStringOf(bodyOf(request), 'orderId', 128);
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const result = buyBuilder(synced, now, ctx.config.economy, { orderId, idFactory: ctx.idFactory });
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    ctx.logger.info('builder_purchased', { userId: account.id, orderId: meta.orderId, price: meta.price });
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        orderId: meta.orderId,
        price: meta.price,
        ownedAfter: meta.ownedAfter,
        buildersMax: meta.buildersMax,
        nextPrice: meta.nextPrice,
        asteriumLeft: meta.asteriumLeft
      }
    };
  });

  app.post('/v1/shop/orders', auth, async (request) => {
    const now = ctx.now();
    const sku = stringOf(bodyOf(request), 'sku', 64);
    const checkout = await openCheckout(deps, claimsOf(request).sub, sku, now, ctx.config.economy);
    ctx.logger.info('order_opened', {
      userId: checkout.account.id,
      sku,
      orderId: checkout.order.id,
      resumed: checkout.resumed
    });
    return {
      ...viewOf(ctx.config, checkout.account, now),
      result: {
        // Что клиент обязан передать VKWebAppShowOrderBox. Выбирает сервер, не клиент.
        box: checkout.box,
        priceRub: checkout.priceRub,
        order: checkout.order,
        resumed: checkout.resumed
      }
    };
  });

  app.get('/v1/shop/orders', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    return { ...viewOf(ctx.config, account, now), result: { orders: describeOrders(account) } };
  });

  app.post<{ Params: { orderId: string } }>('/v1/shop/orders/:orderId/receipt', auth, async (request) => {
    const now = ctx.now();
    const providerOrderId = optionalStringOf(bodyOf(request), 'providerOrderId', 64);
    const account = await noteClientReceipt(deps, claimsOf(request).sub, request.params.orderId, providerOrderId, now);
    return { ...viewOf(ctx.config, account, now), result: { orderId: request.params.orderId } };
  });
}
