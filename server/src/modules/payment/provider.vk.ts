import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { AppError, ErrorCodes } from '../../lib/errors.js';
import { safeEquals } from '../auth/vk.signature.js';

/**
 * Приём подтверждений оплаты от ВКонтакте (Часть 1, серверная половина).
 *
 * ГДЕ ДОВЕРИЕ ПОЯВЛЯЕТСЯ НА САМОМ ДЕЛЕ. `VKWebAppShowOrderBox` резолвится в WebView
 * тогда, когда пользователь закрыл окно платежа. Это сигнал интерфейса, а не факт
 * оплаты: его можно подделать одним подменённым WebSocket'ом, и площадка по такому
 * сигналу деньги не списывает. Единственный канал, которому мы верим, — server-to-server
 * событие площадки, пришедшее на наш HTTP-эндпойнт и подписанное ключом приложения.
 *
 * СХЕМА ПОДПИСИ (Signed Events — та же, что у событий сообщества):
 *     service_key = HMAC_SHA256(key = SECRET_KEY, data = "VK_" + <service_id>)
 *     signature   = HMAC_SHA256(key = service_key, data = <raw request body>) → hex
 * где `<service_id>` — id сущности-источника: для игровых приложений `app_id`, для
 * событий сообщества `group_id`. Оба варианта поддерживаются явным параметром
 * `serviceId`: угадывать, какой настроен в кабинете, нельзя.
 *
 * ПОДПИСЬ ПРОВЕРЯЕТСЯ ПО СЫРОМУ ТЕЛУ ЗАПРОСА, а не по разобранному объекту: любая
 * нормализация JSON (порядок ключей, пробелы, экранирование) меняет байты, и честной
 * сверки не будет. HTTP-слой обязан отдать ровно те байты, что получил.
 *
 * ⚠ ДО ПЕРВОГО PAYMENTS_ENABLED=true: сверить точный формат тела и имя заголовка
 * подписи с актуальным кабинетом разработчика и прогнать живой вектор (по образцу
 * `npm run vk:doctor`). Реализация каноническая, но офлайн-проверки против реальной
 * площадки у этого монорепо нет — ровно как с rewarded-постбэком.
 */

export interface VkPaymentEvent {
  eventId: string;
  eventType: string;
  apiId: number;
  viewerId: number | null;
  groupId: number | null;
  sentAt: number;
  /** order_id площадки и (опционально) наш external_order_id, если площадка его приняла. */
  reference: {
    orderId: string | null;
    externalId: string | null;
    item: string | null;
    votes: number | null;
    priceRub: number | null;
  };
}

const eventSchema = z.object({
  event_id: z.union([z.string(), z.number()]).transform(String),
  type: z.string().min(1),
  api_id: z.union([z.string(), z.number()]).transform(Number),
  viewer_id: z.union([z.string(), z.number()]).optional(),
  group_id: z.union([z.string(), z.number()]).optional(),
  sent_at: z.union([z.string(), z.number()]).transform(Number),
  reference: z
    .object({
      order_id: z.union([z.string(), z.number()]).optional(),
      external_order_id: z.union([z.string(), z.number()]).optional(),
      item: z.string().optional(),
      amount: z.union([z.string(), z.number()]).optional(),
      price: z.union([z.string(), z.number()]).optional()
    })
    .passthrough()
});

/** Разбирает тело подписанного события в доменную форму. null — тело не наше. */
export function parseVkPaymentEvent(rawBody: string): { event: VkPaymentEvent; payload: unknown } | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const parsed = eventSchema.safeParse(json);
  if (!parsed.success) return null;
  const raw = parsed.data;
  const ref = raw.reference;

  return {
    payload: json,
    event: {
      eventId: raw.event_id,
      eventType: raw.type,
      apiId: Number(raw.api_id),
      viewerId: raw.viewer_id !== undefined ? Number(raw.viewer_id) : null,
      groupId: raw.group_id !== undefined ? Number(raw.group_id) : null,
      sentAt: Number(raw.sent_at),
      reference: {
        orderId: ref.order_id !== undefined ? String(ref.order_id) : null,
        externalId: ref.external_order_id !== undefined ? String(ref.external_order_id) : null,
        item: ref.item ?? null,
        votes: ref.amount !== undefined ? Number(ref.amount) : null,
        priceRub: ref.price !== undefined ? Number(ref.price) : null
      }
    }
  };
}


/** service_key = HMAC_SHA256(SECRET_KEY, "VK_" + serviceId) — ключ конкретного приложения. */
export function deriveVkEventKey(secretKey: string, serviceId: string | number): Buffer {
  return createHmac('sha256', secretKey).update(`VK_${String(serviceId)}`, 'utf8').digest();
}

export function signVkEvent(rawBody: string, secretKey: string, serviceId: string | number): string {
  return createHmac('sha256', deriveVkEventKey(secretKey, serviceId)).update(rawBody, 'utf8').digest('hex');
}

export interface VkEventCheck {
  ok: boolean;
  /** Почему отказ — уходит в лог, а не клиенту: детали подписи не должны течь наружу. */
  reason: 'ok' | 'no_signature' | 'secret_missing' | 'body_expired' | 'sign_mismatch';
}

/**
 * Проверка события: подпись + свежесть.
 *
 * `maxAgeSec` обязателен: валидную подпись имеет и событие недельной давности, а
 * повторная доставка старого подтверждения не должна получать шанса выдать товар
 * заново (главная защита — статус заказа, но replay-окно закрываем и здесь).
 */
export function verifyVkEvent(
  rawBody: string,
  signature: string | undefined,
  options: { secretKey: string; serviceId: string | number; sentAt: number; now: Date; maxAgeSec?: number }
): VkEventCheck {
  if (!options.secretKey) return { ok: false, reason: 'secret_missing' };
  if (!signature) return { ok: false, reason: 'no_signature' };

  const maxAge = options.maxAgeSec ?? 3600;
  if (Number.isFinite(options.sentAt) && options.sentAt > 0) {
    const ageMs = options.now.getTime() - options.sentAt * 1000;
    if (Math.abs(ageMs) > maxAge * 1000) return { ok: false, reason: 'body_expired' };
  }
  if (!safeEquals(signVkEvent(rawBody, options.secretKey, options.serviceId), signature)) {
    return { ok: false, reason: 'sign_mismatch' };
  }
  return { ok: true, reason: 'ok' };
}

/** Отказ по итогам проверки — ошибка того же класса, что и подделанная initData. */
export function vkEventFailure(check: VkEventCheck): AppError | null {
  if (check.ok) return null;
  if (check.reason === 'body_expired') {
    return new AppError(ErrorCodes.EXPIRED_INIT_DATA, 401, 'Слишком старое событие площадки', {
      reason: check.reason
    });
  }
  return new AppError(ErrorCodes.INVALID_PAYMENT_SIGNATURE, 401, 'Подпись подтверждения оплаты не пройдена', {
    reason: check.reason
  });
}

/** Тестам и doctor-скрипту: константное по времени сравнение без утечки ожидаемой подписи. */
export function signatureEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}