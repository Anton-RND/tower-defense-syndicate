import type { FastifyInstance } from 'fastify';

import { describeAdOffers, getAdOffer } from '../../config/ads.js';
import { abandonAdSession, claimAdReward, openAdSession } from '../../modules/ads/rewarded.js';
import { AppError, ErrorCodes, forbidden } from '../../lib/errors.js';
import { accountOf, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf, stringOf, viewOf } from '../helpers.js';

/**
 * Rewarded-реклама (Часть 1.5).
 *
 * Правило проекта: награда выдаётся ТОЛЬКО после серверного подтверждения показа.
 * Клиент имеет право сказать лишь «я хочу посмотреть» (/session) — факт просмотра
 * подтверждает постбэк рекламной сети, и только он вызывает /claim.
 *
 * Поэтому /claim закрыт отдельным гейтом DEV_SIGNER_ENABLED и здесь работает как
 * ЭМУЛЯЦИЯ постбэка. Боевой обработчик подписанного callback'а сети — маршрут
 * /callbacks/vk/ads (routes/adsPostbackRoutes.ts): вне сессии игрока, по образцу
 * платёжного /callbacks/vk/events. В production награду рождает только подпись
 * площадки, иначе rewarded-видео становится бесплатной фабрикой энергии и убивает
 * и экономику, и рекламный доход.
 */
export function registerAdsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };

  app.get('/v1/ads/offers', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    return {
      ...viewOf(ctx.config, account, now),
      offers: describeAdOffers().map((offer) => ({ sku: offer.sku, label: offer.label, reward: offer.reward }))
    };
  });

  app.post('/v1/ads/session', auth, async (request) => {
    const now = ctx.now();
    const sku = stringOf(bodyOf(request), 'sku', 64);
    const offer = requireOffer(sku);
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const opened = openAdSession(synced, offer, now, ctx.config.economy, ctx.idFactory);
      return { account: opened.account, meta: opened.session };
    });
    ctx.logger.info('ad_session_opened', { userId: account.id, sku, sessionId: meta.id });
    return {
      ...viewOf(ctx.config, account, now),
      result: { session: meta, expiresAt: meta.expiresAt }
    };
  });

  app.post('/v1/ads/abandon', auth, async (request) => {
    const now = ctx.now();
    const sessionId = stringOf(bodyOf(request), 'sessionId', 64);
    const { account } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => ({
      account: abandonAdSession(synced, sessionId),
      meta: null
    }));
    return { ...viewOf(ctx.config, account, now), result: { abandoned: sessionId } };
  });

  app.post('/v1/ads/claim', auth, async (request) => {
    if (!ctx.config.devSignerEnabled) {
      throw forbidden('Подтверждение показа возможно только из постбэка рекламной сети');
    }
    const now = ctx.now();
    const sessionId = stringOf(bodyOf(request), 'sessionId', 64);
    const account0 = await accountOf(ctx, request);
    const pending = account0.ads.pending;
    if (!pending || pending.id !== sessionId) {
      throw new AppError(ErrorCodes.AD_SESSION_REQUIRED, 409, 'Нет открытой сессии показа', { sessionId });
    }
    const offer = requireOffer(pending.sku);
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const claimed = claimAdReward(synced, sessionId, offer, now, ctx.config.economy);
      return { account: claimed.account, drafts: claimed.drafts, meta: claimed };
    });
    ctx.logger.info('ad_reward_claimed', {
      userId: account.id,
      sessionId,
      sku: offer.sku,
      granted: meta.granted
    });
    return { ...viewOf(ctx.config, account, now), result: { granted: meta.granted, sku: offer.sku } };
  });
}

function requireOffer(sku: string) {
  const offer = getAdOffer(sku);
  if (!offer) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, `Неизвестная рекламная награда: ${sku}`, { sku });
  }
  return offer;
}
