import { randomUUID } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import { rateLimited } from '../lib/errors.js';
import { Limiter, perMinutePolicy } from '../lib/limiter.js';
import type { AppConfig } from '../config/env.js';

/**
 * Слой безопасности транспорта.
 *
 * Здесь нет ни одной игровой формулы (см. шапку http/app.ts): только адрес клиента,
 * защитные головы и бюджет запросов. Причина держать это одним файлом, а не
 * размазать по маршрутам: три вещи ниже обязаны применяться одинаково ко ВСЕМ
 * маршрутам, и каждая попытка «добавить голову вот этому обработчику» — это дыра,
 * которая заживёт ровно в том месте, которое забыли.
 */

/** Бюджеты считаются раздельно: у площадки и у игрока разные профили обращения. */
export type RateScope = 'auth' | 'event';

export interface SecurityLayer {
  /** `onRequest`: головы безопасности и echo идентификатора запроса. */
  headers(request: FastifyRequest, reply: FastifyReply): void;
  /** `preHandler` маршрута: бросает 429 при исчерпанном бюджете адреса. */
  guard(scope: RateScope): (request: FastifyRequest) => Promise<void>;
  /** Сколько адресов на учёте: диагностика раздувания бакетов. */
  stats(): Record<RateScope, number>;
}

/**
 * Идентификатор запроса из заголовка, если он пригоден.
 *
 * Принимаем чужой id, а не игнорируем, ради сквозного трейса: фронт ВК и наш лог
 * должны говорить одним id, иначе «игрок пожаловался в 14:02» не превращается
 * в конкретную строку журнала. Но только если он безопасен: длина и алфавит,
 * потому что id попадает в лог как есть, а лог — в агрегатор, где перевод строки
 * в поле означает подделку записи.
 */
export function normalizeRequestId(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9._:-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * Алфавит и длина адреса, приемлемые из чужого `X-Forwarded-For`.
 *
 * Проверка нужна не ради «валидности IP» (мы адрес не маршрутизируем, а болеем
 * по нему), а ради двух других вещей: ключ бакета обязан остаться короткой
 * строкой (иначе 64 КБ тела заголовка превращаются в 64 КБ на каждый адрес в
 * карте лимитера), и в нём не должно быть разделителей, способных сломать
 * разбор логов агрегатором.
 */
const CLIENT_IP_SHAPE = /^[0-9a-fA-F.:_[\]-]{1,64}$/;

/**
 * Адрес клиента.
 *
 * `X-Forwarded-For` читается ТОЛЬКО когда оператор явно сказал, что сверху стоит
 * наш reverse proxy, который этот заголовок перезаписывает. Без такого прокси
 * заголовок пишет кто угодно, и доверять ему — значит выдать атакующему выбор
 * собственного бакета: лимитер начинает защищать от нас, а не от него.
 *
 * Берётся левый элемент: он ближайший к клиенту. Правому доверять нельзя —
 * его дописывает последний прокси в цепи, то есть часто мы сами.
 */
export function clientIpOf(request: FastifyRequest, trustForwardedFor: boolean): string {
  if (!trustForwardedFor) return request.ip;
  const raw = request.headers['x-forwarded-for'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return request.ip;
  const first = value.split(',')[0]?.trim();
  return first && CLIENT_IP_SHAPE.test(first) ? first : request.ip;
}

/**
 * Content-Security-Policy витрины.
 *
 * `'unsafe-inline'` в script-src и style-src — не забывчивость, а следствие
 * принципа `play.html`: один файл, vanilla JS, никакой сборки и ни одной
 * рантайм-зависимости. Весь скрипт инлайн, а nonce для одного файла, отдаваемого
 * без кэша, защиты не добавляет. Поэтому настоящая ценность этого слоя — не
 * inline-сдерживание, а `object-src 'none'`, `base-uri 'none'`,
 * `form-action 'self'` и главное `frame-ancestors`.
 *
 * `frame-ancestors` обязано содержать источники WebView. Шаблонный
 * `X-Frame-Options: DENY`, которым пестрят примеры настройки, здесь ВЫКЛЮЧИЛ БЫ
 * ИГРУ: ВК грузит приложение в iframe, и отказ во встраивании равен отказу во
 * входе. Сам `X-Frame-Options` не отправляется вовсе — он не понимает списков
 * источников, и один провайдер с нестандартным поддоменом убил бы вход молча.
 */
export function buildCsp(frameAncestors: readonly string[]): string {
  const ancestors = frameAncestors.length > 0 ? frameAncestors.join(' ') : "'none'";
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    // Мост ВК говорит с родительским окном через postMessage, но площадку в
    // allow-list всё же оставляем: иначе витрина потеряет доступ к API моста.
    "connect-src 'self' https://*.vk.com https://*.vk.ru",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    `frame-ancestors ${ancestors}`
  ].join('; ');
}

/**
 * Идентификатор запроса для Fastify (`genReqId`).
 *
 * Чужой заголовок принимается, если он безопасен, иначе — свой UUID. Падать на
 * кривом `X-Request-Id` нечем: это не вход игрока, а диагностика, и отказывать
 * запросу из-за мусорного трейсингового заголовка значит дарить атакующему
 * дешёвый способ срывать игру.
 */
export function resolveRequestId(raw: string | string[] | undefined): string {
  return normalizeRequestId(raw) ?? randomUUID();
}

/**
 * Сборка слоя под конкретный конфиг.
 *
 * Принимает `AppConfig`, а не `AppContext`, намеренно: контекст собирается этим
 * же слоем, и передача whole-контекста создала бы кольцо на уровне типов. Всему
 * слою нужны только лимиты, источники WebView и признак production — всё это
 * лежит в конфиге.
 *
 * Бакеты создаются лениво и держатся замыканием: заводить два Map на каждый
 * процесс, когда лимиты выключены (`RATE_LIMIT_*=0` в окружении), — значит платить
 * памятью за feature flag.
 */
export function createSecurityLayer(config: AppConfig): SecurityLayer {
  const limits = config.security.rateLimit;
  const options = { maxKeys: limits.maxKeys, idleTtlMs: limits.idleTtlMs };
  const buckets = new Map<RateScope, Limiter>();

  const budgetOf = (scope: RateScope): number => (scope === 'auth' ? limits.authPerMin : limits.eventPerMin);

  const bucketOf = (scope: RateScope): Limiter | null => {
    if (budgetOf(scope) <= 0) return null;
    const existing = buckets.get(scope);
    if (existing) return existing;
    const created = new Limiter(perMinutePolicy(budgetOf(scope)), options);
    buckets.set(scope, created);
    return created;
  };

  const csp = buildCsp(config.security.frameAncestors);
  // HSTS только в production: на стенде по http://localhost он бесполезен, а
  // случайно зашедший на 31 день в браузер разработчика — ломает сам стенд.
  const hsts = config.env === 'production' ? 'max-age=31536000; includeSubDomains' : null;

  return {
    headers(request, reply): void {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Referrer-Policy', 'no-referrer');
      reply.header('Content-Security-Policy', csp);
      reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=()');
      if (hsts) reply.header('Strict-Transport-Security', hsts);
      reply.header('X-Request-Id', request.id);
    },

    guard(scope: RateScope) {
      // Асинхронность — не прихоть, а требование Fastify: пре-хук с арностью < 3
      // Fastify 5 считает НЕ колбэком и ждёт от него промис. Синхронная функция,
      // вернувшая undefined, оставляет запрос висеть навсегда: контракт `done`
      // не вызван, обработчик не достигнут. authHook (см. auth.ts) сделан async
      // по той же причине — расхождение здесь сломало бы вход молча.
      return async (request: FastifyRequest): Promise<void> => {
        const bucket = bucketOf(scope);
        if (!bucket) return;
        const ip = clientIpOf(request, config.security.trustForwardedFor);
        const verdict = bucket.take(`${scope}:${ip}`);
        if (verdict.allowed) return;
        // Отдельного лога отказов нет намеренно: существующий onResponse-хук пишет
        // каждый запрос со статусом, поэтому 429 в логе уже видно. Отдельный поток
        // строк на каждый отказ был бы вторым способом залить диск — ровно той
        // проблемой, от которой лимитер и защищают.
        throw rateLimited('Слишком много запросов — попробуйте чуть позже', {
          scope,
          retryAfterSec: verdict.retryAfterSec
        });
      };
    },

    stats(): Record<RateScope, number> {
      return { auth: buckets.get('auth')?.size ?? 0, event: buckets.get('event')?.size ?? 0 };
    }
  };
}

