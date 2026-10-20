import process from 'node:process';

import { buildApp } from './http/app.js';
import { createContext } from './http/context.js';

/**
 * Точка входа сервера (Шаг 6).
 *
 * Порядок запуска принципиален: сначала поднимаются сторы (mongo может быть недоступен
 * несколько секунд, и падать после открытия порта — значит ловить трафик на мёртвый
 * процесс), только потом слушать. Остановка — обратная: сначала перестаем принимать
 * запросы, потом рвём соединение с БД.
 */
async function main(): Promise<void> {
  const ctx = createContext();
  await ctx.connect();

  const app = await buildApp(ctx);
  await app.listen({ host: ctx.config.host, port: ctx.config.port });

  ctx.logger.info('server_started', {
    env: ctx.config.env,
    host: ctx.config.host,
    port: ctx.config.port,
    store: ctx.config.store.driver,
    vk: ctx.config.vk.appId > 0,
    payments: ctx.config.economy.limits.purchases.enabled,
    ads: ctx.config.economy.limits.ads.enabled,
    dev: ctx.config.devSignerEnabled,
    debug_page: `http://localhost:${ctx.config.port}/debug`
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    ctx.logger.info('server_stopping', { signal });
    try {
      await app.close();
      await ctx.close();
      process.exit(0);
    } catch (error) {
      ctx.logger.fatal('server_shutdown_failed', { error });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'server_start_failed', error: error instanceof Error ? error.message : String(error) })}\n`
  );
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
