import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppError, ErrorCodes, validationError } from '../../lib/errors.js';
import { getAdOffer } from '../../config/ads.js';
import { parseVkAdPostback, toVkParams } from '../../modules/ads/postback.js';
import { claimAdReward } from '../../modules/ads/rewarded.js';
import { verifyVkSignature } from '../../modules/auth/vk.signature.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf } from '../helpers.js';

/**
 * Постбэк rewarded-рекламы (Часть 1.5, транспортная половина).
 *
 * ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ПРОСМОТР РОЛИКА ПРЕВРАЩАЕТСЯ В НАГРАДУ. Клиент может
 * открыть сессию (/v1/ads/session) и бросить её (/v1/ads/abandon), но выдать
 * энергию, сырьё или щит правомочен только этот маршрут — после проверки
 * подписи площадки. `/v1/ads/claim` остался эмуляцией под DEV_SIGNER_ENABLED:
 * в production поля /claim нет по той же причине, по которой у платежей нет
 * «выдачи по кнопке» (см. шапку adsRoutes.ts).
 *
 * КОНТРАКТ С ПЛОЩАДКОЙ, ОТЛИЧНЫЙ ОТ ПЛАТЕЖЕЙ. У платежей идемпотентность
 * держится статусом заказа, и повторный вебхук честно отвечает 200-дубликатом.
 * У рекламы сессии одноразовые: после выдачи `pending` обнуляется, и второго
 * «настоящего подтверждения» не бывает — только повторная доставка того же
 * постбэка. Поэтому любой валидно-подписанный постбэк, который не удалось
 * исполнить (сессия уже выдана / сгорела / не та), здесь отвечает 200 «принято»
 * и пишет причину в структурированный лог: площадка прекращает ретраить, а
 * оператор видит каждый пропуск. Кривая подпись — единственный случай не-200.
 */
export function registerAdsPostbackRoutes(app: FastifyInstance, ctx: AppContext): void {
  const postback = { preHandler: ctx.security.guard('event') };

  const handler = async (request: FastifyRequest, reply: FastifyReply) => {
    const now = ctx.now();
    const params = toVkParams(request.method === 'POST' ? bodyOf(request) : request.query);

    // Подпись — раньше любых действий: ни сессия, ни юзер не слушают «форма тела».
    const verified = verifyVkSignature(params, {
      appId: ctx.config.vk.appId,
      secretKey: ctx.config.vk.secretKey
    });
    if (!verified) {
      ctx.logger.warn('ad_postback_rejected', {
        requestId: request.id,
        hasSign: Boolean(params['sign'])
      });
      // Детали отказа — только в лог, клиенту — обезличенный 401.
      throw new AppError(ErrorCodes.INVALID_AD_POSTBACK_SIGNATURE, 401, 'Подпись постбэка рекламы не пройдена');
    }

    const parsed = parseVkAdPostback(params);
    if (!parsed) {
      ctx.logger.warn('ad_postback_unreadable', { requestId: request.id });
      throw validationError('Параметры постбэка рекламы не соответствуют схеме');
    }

    const { userId, sessionId } = parsed;
    const account0 = await ctx.users.findBySocial('vk', userId);
    if (!account0) {
      ctx.logger.error('ad_postback_unknown_user', { requestId: request.id, userId, sessionId });
      return reply.type('text/plain; charset=utf-8').send('ok');
    }

    const pending = account0.ads.pending;
    const offer = pending ? getAdOffer(pending.sku) : undefined;
    if (!pending || pending.id !== sessionId || !offer) {
      // Валидная подпись + невыполнимый сценарий: чаще всего повторная доставка
      // уже выданной сессии. Отвечаем «принято» и кладём причину в лог — см. шапку.
      ctx.logger.warn('ad_postback_ignored', {
        requestId: request.id,
        userId,
        sessionId,
        pendingId: pending?.id ?? null,
        reason: offer ? 'session_mismatch' : 'offer_missing'
      });
      return reply.type('text/plain; charset=utf-8').send('ok');
    }

    try {
      const { account, meta } = await accountAction(ctx, account0.id, now, (synced) => {
        const claimed = claimAdReward(synced, sessionId, offer, now, ctx.config.economy);
        return { account: claimed.account, drafts: claimed.drafts, meta: claimed };
      });
      ctx.logger.info('ad_postback_claimed', {
        requestId: request.id,
        userId: account.id,
        sessionId,
        sku: offer.sku,
        granted: meta.granted
      });
    } catch (error) {
      // Сгоревшая сессия, слишком ранняя награда, долг по возврату — всё, на что
      // ретрай не влияет. Признаём 200 и оставляем код в логе (см. шапку).
      ctx.logger.error('ad_postback_dropped', {
        requestId: request.id,
        userId: account0.id,
        sessionId,
        code: error instanceof AppError ? error.code : 'INTERNAL',
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return reply.type('text/plain; charset=utf-8').send('ok');
  };

  app.get('/callbacks/vk/ads', postback, handler);
  app.post('/callbacks/vk/ads', postback, handler);
}
