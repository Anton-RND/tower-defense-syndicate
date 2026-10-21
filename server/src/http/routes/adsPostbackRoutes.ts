import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppError, ErrorCodes, validationError } from '../../lib/errors.js';
import { getAdOffer } from '../../config/ads.js';
import { parseVkAdPostback, isAdPostbackReplay, resolveAdPostbackSession, toVkParams } from '../../modules/ads/postback.js';
import { claimAdReward, noteAdRewardId } from '../../modules/ads/rewarded.js';
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
 * КОРРЕЛЯЦИЯ: ПОДПИСЬ ВАЖНЕЕ ИНДЕКСА. Мост площадки (vk-bridge 3.0.2) не умеет
 * принимать наш идентификатор показа: `ShowNativeAdsRequest` — это только
 * `ad_format` и `use_waterfall`. Поэтому `reward_id` из постбэка не обязан быть
 * нашим id сессии, и выбор сессии делает резолвер домена (см. postback.ts):
 * совпал — строгая выдача, не совпал или его нет — единственная живая сессия
 * владельца из подписи. Режим пишется в лог (`correlated`) всегда.
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

    const { userId, rewardId } = parsed;
    const account0 = await ctx.users.findBySocial('vk', userId);
    if (!account0) {
      ctx.logger.error('ad_postback_unknown_user', { requestId: request.id, userId, rewardId });
      return reply.type('text/plain; charset=utf-8').send('ok');
    }

    // РЕПЛЕЙ РАНЬШЕ РЕЗОЛВЕРА. Повторная доставка того же постбэка не обязана ни
    // кормить следующий слот игрока, ни сжигать его: слот остаётся живым для
    // настоящего подтверждения этого показа. Память id молчит, когда площадка его
    // не шлёт, — тогда выдача идёт дальше и защищается только лимитами.
    if (isAdPostbackReplay(account0, rewardId, now, ctx.config.economy.limits.ads.replayWindowMs)) {
      ctx.logger.warn('ad_postback_replay', {
        requestId: request.id,
        userId,
        rewardId,
        pendingId: account0.ads.pending?.id ?? null
      });
      return reply.type('text/plain; charset=utf-8').send('ok');
    }

    const session = resolveAdPostbackSession(account0, parsed);
    const offer = session ? getAdOffer(session.pending.sku) : undefined;
    if (!session || !offer) {
      // Валидная подпись + невыполнимый сценарий: чаще всего повторная доставка
      // уже выданной награды (слот пуст). Отвечаем «принято» и кладём причину в
      // лог — см. шапку.
      ctx.logger.warn('ad_postback_ignored', {
        requestId: request.id,
        userId,
        rewardId,
        pendingId: account0.ads.pending?.id ?? null,
        reason: session ? 'offer_missing' : 'no_pending_session'
      });
      return reply.type('text/plain; charset=utf-8').send('ok');
    }

    const sessionId = session.pending.id;
    try {
      const { account, meta } = await accountAction(ctx, account0.id, now, (synced) => {
        const claimed = claimAdReward(synced, sessionId, offer, now, ctx.config.economy);
        // Память об исполненном id пишется в ТОМ ЖЕ редукторе, что и выдача: запись
        // при неуспешной выдаче отбила бы игроку его следующий честный показ.
        return {
          account: noteAdRewardId(claimed.account, rewardId, now, ctx.config.economy),
          drafts: claimed.drafts,
          meta: claimed
        };
      });
      ctx.logger.info('ad_postback_claimed', {
        requestId: request.id,
        userId: account.id,
        sessionId,
        rewardId,
        correlated: session.correlated,
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
        rewardId,
        correlated: session.correlated,
        code: error instanceof AppError ? error.code : 'INTERNAL',
        message: error instanceof Error ? error.message : String(error)
      });
    }
    return reply.type('text/plain; charset=utf-8').send('ok');
  };

  app.get('/callbacks/vk/ads', postback, handler);
  app.post('/callbacks/vk/ads', postback, handler);
}
