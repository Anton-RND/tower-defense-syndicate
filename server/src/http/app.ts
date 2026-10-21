import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

import { AppError, ErrorCodes } from '../lib/errors.js';
import { publicConfig } from '../modules/economy/view.js';
import { describeCatalog } from '../config/shop.js';
import { describeAdOffers } from '../config/ads.js';
import type { AppContext } from './context.js';
import { loadDebugPage } from './debugPage.js';
import { loadPlayPage } from './playPage.js';
import { registerAdsRoutes } from './routes/adsRoutes.js';
import { registerAuthRoutes } from './routes/authRoutes.js';
import { registerClanRoutes } from './routes/clanRoutes.js';
import { registerDevRoutes } from './routes/devRoutes.js';
import { registerEconomyRoutes } from './routes/economyRoutes.js';
import { registerMaterialsRoutes } from './routes/materialsRoutes.js';
import { registerMarketRoutes } from './routes/marketRoutes.js';
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
  const app = Fastify({ logger: false, bodyLimit: 1 << 20 });

  const wildcard = ctx.config.allowedOrigins.includes('*');
  await app.register(cors, {
    origin: wildcard ? true : ctx.config.allowedOrigins,
    credentials: !wildcard,
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Ledger-Count']
  });

  app.addHook('onResponse', (request, reply, done) => {
    ctx.logger.info('http_request', {
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
    vk: ctx.config.vk.appId > 0,
    payments: ctx.config.economy.limits.purchases.enabled,
    ads: ctx.config.economy.limits.ads.enabled,
    dev: ctx.config.devSignerEnabled,
    // Раздельно «включено» и «настроено»: `VK_PUSH_ENABLED=true` при отсутствии ключей
    // — это конфигурационная ошибка, и `/health` обязан показывать её до первой продажи,
    // а не после тысячи `notice_rejected` в логе.
    push: ctx.notices.readiness(),
    market_worker: ctx.config.market.worker.enabled,
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
  registerPvpRoutes(app, ctx);
  registerClanRoutes(app, ctx);
  registerMarketRoutes(app, ctx);
  registerDevRoutes(app, ctx);

  return app;
}
