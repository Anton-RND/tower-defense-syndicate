import cors from '@fastify/cors';
import compress from '@fastify/compress';
import { constants as zlibConstants } from 'node:zlib';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { AppError, ErrorCodes } from '../lib/errors.js';
import { authModeOf, isVkConfigured } from '../config/env.js';
import { publicConfig } from '../modules/economy/view.js';
import { describeCatalog } from '../config/shop.js';
import { describeAdOffers } from '../config/ads.js';
import type { AppContext } from './context.js';
import { resolveRequestId } from './security.js';
import { loadDebugPage } from './debugPage.js';
import { loadPlayPage } from './playPage.js';
import { registerAdsRoutes } from './routes/adsRoutes.js';
import { registerAdsPostbackRoutes } from './routes/adsPostbackRoutes.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerClanRoutes } from './routes/clanRoutes.js';
import { registerDevRoutes } from './routes/devRoutes.js';
import { registerEconomyRoutes } from './routes/economyRoutes.js';
import { registerMaterialsRoutes } from './routes/materialsRoutes.js';
import { registerMarketRoutes } from './routes/marketRoutes.js';
import { registerVkEventsRoutes } from './routes/vkEventsRoutes.js';

/**
 * Content-type парсер для `application/json` (C3). Замена дефолтного парсера
 * Fastify ровно по одной причине: подпись событий площадки считается по СЫРЫМ
 * байтам тела (payment/provider.vk.ts), а дефолтный парсер оставляет разобранный
 * объект и молча теряет исходную строку. Здесь те же байты сохраняются в
 * `request.rawBody` для `/callbacks/vk/events`, а в `request.body` по-прежнему
 * кладётся обычный JSON — остальным маршрутам ничего не заметно.
 */
declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
  }
}

import { registerPvpRoutes } from './routes/pvpRoutes.js';
import { registerShopRoutes } from './routes/shopRoutes.js';
import { registerWorkshopRoutes } from './routes/workshopRoutes.js';

/**
 * HTTP-слой (Шаг 6): транспорт, а не логика.
 *
 * Здесь нет ни одной игровой формулы — только разбор запроса, вызов хаба домена и
 * сборка ответа. Проверка того, что слой тонкий, простая: в этом файле и в routes/
 * не импортируются ни mongoose, ни редукторы баланса напрямую, только публичные
 * функции modules/*.
 *
 * Формат ошибки единократный: `{ error: { code, message, details? } }` (lib/errors.ts).
 * Клиент не должен разбирать и Fastify-овские 400 про схему, и доменные AppError, и
 * «Cannot read property» разными словами.
 */
export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 1 << 20,
    // Идентификатор запроса заводится до всего остального: и лог, и головы, и
    // отказ должны говорить одним id. Чужой `X-Request-Id` принимается, если он
    // безопасен по алфавиту и длине, иначе — свой UUID (см. security.ts).
    genReqId: (request) => resolveRequestId(request.headers['x-request-id'])
  });

  // Головы безопасности — на ВСЕ ответы, включая 404 и 429: отказ от входа
  // ничем не отличается от отказа витрины по уровню доверия к transport-слою.
  app.addHook('onRequest', async (request, reply) => {
    ctx.security.headers(request, reply);
  });

  // Сырое тело для подписи площадки (см. declare module выше). `parseAs: 'string'`
  // даёт байты как есть; плохой JSON → 400 тем же путём, что и у дефолтного
  // парсера (errorHandler различает транспортные ошибки по `statusCode`).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    request.rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch (error) {
      const parseError = new Error('Тело запроса не является валидным JSON') as Error & { statusCode: number };
      parseError.statusCode = 400;
      done(parseError);
    }
  });

  const wildcard = ctx.config.allowedOrigins.includes('*');
  await app.register(cors, {
    origin: wildcard ? true : ctx.config.allowedOrigins,
    credentials: !wildcard,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Ledger-Count']
  });

  // Сжатие ответа. Витрина — 17.4 КБ JSON на каждый опрос, и это худший из возможных
  // для канала содержимое: повторяющиеся ключи и числа, жмущиеся в разы (замер:
  // `npm run bench`, раздел 4). Дельта-запись стора (modules/user/doc.diff.ts) убрала
  // лишний трафик СЕРВЕР↔БД; здесь убирается лишний трафик СЕРВЕР↔клиент, и это
  // единственная экономия, которая не требует менять игровую семантику.
  //
  // Почему только gzip, без brotli. `br` дал бы ещё ~15% на тексте, но объявляет ли
  // его WebView на старых Android — непроверяемо отсюда, а непроверенное кодирование
  // платит пустым ответом у части аудитории ради процентов. Гипотеза дешёвая: когда
  // появится замер аудитории, добавить кодировку — одна строка.
  //
  // Почему не разжимаем запрос. `bodyLimit` 1 МБ (см. Fastify выше) в связке с
  // приймом сжатого тела — это zip-бомба: 1 МБ на входе может стоить гигабайта на
  // выходе и остановки процесса. Мы никогда не говорили клиенту, что умеем принимать
  // сжатое тело, поэтому и не умеем молча — отказ на стороне парсера, а не утечка.
  await app.register(compress, {
    // Нижняя граница: тело меньше жать невыгодно — заголовок и окно zlib дороже
    // выгоды на паре сотен байт (/health, 404, короткие отказы). В v9 это `threshold`
    // (в v8 называлось `minSize`), и по умолчанию оно ровно 1024 — названо явно,
    // потому что это граница, а не случайность дефолта.
    threshold: 1024,
    encodings: ['gzip'],
    // Самое важное здесь. По умолчанию плагин разжимает и тело ЗАПРОСА (br/gzip/
    // deflate), а это значит, что `bodyLimit` в 1 МБ перестаёт быть границей: мегабайт
    // сжатого потока разворачивается в гигабайты ещё до парсера. Мы никогда не
    // объявляли клиенту, что принимаем сжатое тело, — значит, и разжимать нечего,
    // а отказ (415) приходит до любой работы с байтами.
    requestEncodings: ['identity'],
    // Уровень 6 (он же default zlib): 9 платит CPU там, где узкое место — CPU, и
    // выигрывает доли процента на уже сжатом JSON.
    zlibOptions: { level: zlibConstants.Z_DEFAULT_COMPRESSION }
  });

  app.addHook('onResponse', (request, reply, done) => {
    ctx.logger.info('http_request', {
      requestId: request.id,
      method: request.method,
      url: request.url,
      route: request.routeOptions?.url ?? null,
      status: reply.statusCode,
      durationMs: Math.round(reply.elapsedTime * 1000) / 1000,
      userId: request.claims?.sub ?? null
    });
    done();
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof AppError) {
      // Retry-After из деталей ошибки: лимитер знает, когда освободится бакет, а
      // клиент без заголовка обязан угадывать экспоненциальной задержкой и
      // либо долбит раньше, либо висит дольше, чем нужно.
      const retryAfter = error.details?.['retryAfterSec'];
      if (error.code === ErrorCodes.RATE_LIMITED && typeof retryAfter === 'number' && retryAfter > 0) {
        reply.header('Retry-After', String(Math.ceil(retryAfter)));
      }
      reply.status(error.status).send(error.toJSON());
      return;
    }
    // Валидация Fastify (сломанный JSON, неверный тип тела) — 4xx, а не 500:
    // игрок получил сообщение о своей ошибке, а не «внутренняя ошибка сервера».
    const transport = error as { statusCode?: unknown; message?: unknown; validation?: unknown };
    const status = typeof transport.statusCode === 'number' ? transport.statusCode : 500;
    const message = typeof transport.message === 'string' ? transport.message : 'Неизвестная ошибка';
    if (status >= 400 && status < 500) {
      reply.status(status).send({
        error: {
          code: ErrorCodes.VALIDATION_ERROR,
          message,
          details: transport.validation ? { validation: transport.validation } : undefined
        }
      });
      return;
    }
    ctx.logger.error('http_unhandled', { url: request.url, error: message });
    reply.status(500).send({ error: { code: ErrorCodes.INTERNAL, message: 'Внутренняя ошибка сервера' } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: ErrorCodes.NOT_FOUND, message: `Маршрут не найден: ${request.method} ${request.url}` }
    });
  });

  app.get('/health', async () => ({
    ok: true,
    env: ctx.config.env,
    store: ctx.config.store.driver,
    // `isVkConfigured`, а не `appId > 0`: флаг отвечал за половину координат и
    // отправлял витрину на 500 VK_NOT_CONFIGURED (см. config/env.ts:authModeOf).
    vk: isVkConfigured(ctx.config),
    auth: authModeOf(ctx.config),
    payments: ctx.config.economy.limits.purchases.enabled,
    ads: ctx.config.economy.limits.ads.enabled,
    dev: ctx.config.devSignerEnabled,
    // Профиль входа ВКонтакте (счётчики + чем площадка подписала последнюю
    // initData). Здесь ради одного случая: первый живой вход единственен, и по
    // этому полю видно, совпала ли ожидаемая схема (`raw`, `hashIncluded: false`)
    // с фактической — без доступа к хосту и без разбора логов.
    vk_auth: ctx.vkAuth.snapshot(),
    // Раздельно «включено» и «настроено»: `VK_PUSH_ENABLED=true` при отсутствии ключей
    // — это конфигурационная ошибка, и `/health` обязан показывать её до первой продажи,
    // а не после тысячи `notice_rejected` в логе.
    push: ctx.notices.readiness(),
    market_worker: ctx.config.market.worker.enabled,
    // Оптимистичная блокировка невидима снаружи, а именно она решает, куда идти следующим:
    // доля CAS-конфликтов — это цена повторной симуляции боя в рейде, а доля холостых
    // ходов — цена пишущего GET. Без этих чисел обе оптимизации заказываются вслепую
    // (см. lib/store.metrics.ts).
    stores: {
      users: ctx.users.metrics(),
      clans: ctx.clans.metrics(),
      lots: ctx.lots.metrics(),
      commodities: ctx.commodities.metrics()
    },
    ts: ctx.now()
  }));

  // Публичные правила: клиент рисует таймеры и витрины по ним, а не по своим копиям
  // констант (иначе валидатор и интерфейс разойдутся при первом же баланс-патче).
  app.get('/v1/config', async () => ({
    ...publicConfig(ctx.config),
    catalog: describeCatalog(),
    adOffers: describeAdOffers()
  }));

  // Стендовые страницы отдаём без кэша. Причина не гипотетическая: `play.html` и
  // `debug.html` кэшируются на процесс (playPage.ts:33), поэтому правка HTML видна
  // только после перезапуска. Если сверху повиснет ещё и кэш браузера, починенный
  // стенд продолжит показывать старую страницу, и это выглядит как «фикс не помог» —
  // ровно ложный багрепорт, который невозможно воспроизвести по коду.
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');

  app.get('/', async (_request, reply) => noStore(reply).type('text/html; charset=utf-8').send(loadDebugPage()));
  app.get('/debug', async (_request, reply) => noStore(reply).type('text/html; charset=utf-8').send(loadDebugPage()));
  // Полигон с отрисовкой поля: редактор планировки и проигрыватель боя. Тот же
  // принцип — HTML рядом файлом, никакой сборки и ни одной клиентской копии констант
  // баланса (геометрия берётся из /v1/config, боевые цифры — из ответа рейда).
  app.get('/play', async (_request, reply) => noStore(reply).type('text/html; charset=utf-8').send(loadPlayPage()));

  registerAuthRoutes(app, ctx);
  registerEconomyRoutes(app, ctx);
  registerWorkshopRoutes(app, ctx);
  registerMaterialsRoutes(app, ctx);
  registerShopRoutes(app, ctx);
  registerAdsRoutes(app, ctx);
  // Постбэк рекламной сети — вне сессии игрока, поэтому отдельным маршрутом
  // (см. шапку adsPostbackRoutes.ts).
  registerAdsPostbackRoutes(app, ctx);
  registerPvpRoutes(app, ctx);
  registerClanRoutes(app, ctx);
  registerMarketRoutes(app, ctx);
  registerDevRoutes(app, ctx);
  // Подписанные события площадки — вне сессии игрока, поэтому отдельным
  // маршрутом, а не внутри shopRoutes (см. шапку vkEventsRoutes.ts).
  registerVkEventsRoutes(app, ctx);

  return app;
}
