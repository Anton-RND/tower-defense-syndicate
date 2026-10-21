import type { FastifyInstance, FastifyRequest } from 'fastify';

import { validationError } from '../../lib/errors.js';
import { confirmPayment, refundPayment } from '../../modules/payment/commit.js';
import {
  parseVkPaymentEvent,
  verifyVkEvent,
  vkEventFailure
} from '../../modules/payment/provider.vk.js';
import type { AppContext } from '../context.js';

/**
 * Приём подписанных событий площадки (Часть 1, транспортная половина).
 *
 * ЕДИНСТВЕННОЕ МЕСТО, ГДЕ ДЕНЬГИ ВХОДЯТ В ИГРУ. `openCheckout` создаёт заказ по
 * просьбе клиента, но «клиент запросил окно» — не «клиент заплатил»: сигнал
 * WebView можно подделать одним подменённым WebSocket'ом. Товар выдаёт только
 * этот маршрут — после проверки подписи и свежести в provider.vk.ts и
 * фиксации через `confirmPayment` (см. шапку payment/commit.ts).
 *
 * НАМЕРЕННЫЕ ГРАНИЦЫ:
 *  - Сверка идёт по СЫРОМУ телу запроса, а не по разобранному объекту: любая
 *    нормализация JSON меняет байты и мгновенно ломает HMAC. Поэтому ниже
 *    используется `request.rawBody`, который ставит специальный content-type
 *    парсер (см. app.ts) — тот самый, что отдаёт в `request.body` обычный JSON
 *    для всех остальных маршрутов.
 *  - Маршрут неавторизованный (площадка приходит без JWT) и закрыт только
 *    бюджетом `guard('event')` (RATE_LIMIT_EVENT_PER_MIN): пачка событий после
 *    перебоя площадки — норма, но бесконечный поток — уже не она.
 *  - Сбои НЕ проглатываются: кривая подпись, протухшее событие, чужой заказ —
 *    всё это AppError, и площадка получает не-200 и ретраит; оператор видит
 *    каждый случай в структурированном логе onResponse.
 *
 * ⚠ ДО ПЕРВОГО PAYMENTS_ENABLED=true: имя заголовка подписи и точный состав тела
 * сверить с актуальным кабинетом разработчика (npm run vk:doctor и
 * private/vk-coordinates.md). Сейчас принимаются `X-Vk-Signature` и
 * `X-Signature` — каноническая схема из provider.vk.ts, но живой вектор от
 * площадки эту пара гада не заменяет.
 */

const CALLBACKS_EVENTS = '/callbacks/vk/events';

/** Заголовок может прийти массивом — берём первый элемент, как у X-Forwarded-For. */
function headerValue(request: FastifyRequest, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export function registerVkEventsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const deps = { users: ctx.users, ledger: ctx.ledger, idFactory: ctx.idFactory };
  const postback = { preHandler: ctx.security.guard('event') };

  app.post(CALLBACKS_EVENTS, postback, async (request, reply) => {
    const now = ctx.now();
    const rawBody = request.rawBody;
    if (rawBody === undefined) {
      // Тело не разобрано как application/json — проверять подпись не на чем.
      throw validationError('Тело события площадки должно прийти в application/json');
    }

    const parsed = parseVkPaymentEvent(rawBody);
    if (!parsed) {
      ctx.logger.warn('vk_event_unreadable', { requestId: request.id });
      throw validationError('Тело события площадки не соответствует схеме');
    }

    // Свежесть и подпись — РАНЬШЕ любых действий: orders/commit.ts выдаёт товар
    // только под валидным подтверждением, а не «по форме тела».
    const signature =
      headerValue(request, 'x-vk-signature') ?? headerValue(request, 'x-signature');
    const check = verifyVkEvent(rawBody, signature, {
      secretKey: ctx.config.vk.secretKey,
      serviceId: ctx.config.vkEvents.serviceId,
      sentAt: parsed.event.sentAt,
      now,
      maxAgeSec: ctx.config.vkEvents.maxAgeSec
    });
    if (!check.ok) {
      // Детали отказа — в лог, не клиенту: подпись — секрет, а не диагностика.
      ctx.logger.warn('vk_event_rejected', {
        requestId: request.id,
        eventId: parsed.event.eventId,
        reason: check.reason
      });
      // vkEventFailure() всегда отдаёт AppError — не-ok без него невозможен.
      throw vkEventFailure(check) as never;
    }

    const event = parsed.event;
    const externalId = event.reference.externalId;

    if (event.eventType === 'onAppPayment') {
      const fulfilled = await confirmPayment(
        deps,
        externalId ?? '',
        {
          providerOrderId: event.reference.orderId ?? event.reference.externalId,
          item: event.reference.item,
          votes: event.reference.votes
        },
        now,
        ctx.config.economy
      );
      ctx.logger.info('vk_event_paid', {
        requestId: request.id,
        eventId: event.eventId,
        orderId: fulfilled.order.id,
        userId: fulfilled.userId,
        granted: fulfilled.granted,
        duplicate: fulfilled.duplicate
      });
    } else if (event.eventType === 'chargeback') {
      if (externalId === null) {
        // Вернуть нечего: заказ не за чем догонять. Отказ был бы вечным ретраем
        // (индекса по providerOrderId у нас нет), поэтому — громкий лог и 200.
        ctx.logger.error('vk_event_chargeback_unmappable', {
          requestId: request.id,
          eventId: event.eventId,
          providerOrderId: event.reference.orderId
        });
      } else {
        const refunded = await refundPayment(deps, externalId, now, ctx.config.economy);
        ctx.logger.info('vk_event_chargeback', {
          requestId: request.id,
          eventId: event.eventId,
          orderId: refunded.order.id,
          userId: refunded.userId,
          duplicate: refunded.duplicate
        });
      }
    } else {
      // Незнакомый тип — не ошибка, а будущая совместимость: старый сервер не
      // должен ронять новый поток площадки. Подтверждаем приём, оставляем след.
      ctx.logger.info('vk_event_type_unknown', {
        requestId: request.id,
        eventId: event.eventId,
        type: event.eventType
      });
    }

    // Площадка считает доставленным всё, что ответило чем угодно валидным;
    // договор здесь — связка «200 + ok», как у событий сообщества.
    return reply.type('text/plain; charset=utf-8').send('ok');
  });
}
