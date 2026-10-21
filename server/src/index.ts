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
  // Циклы — ПОСЛЕ открытия порта: сторы уже подняты, а медленный старт воркера не
  // имеет права задерживать готовность процесса (пробка оркестратора смотрит на /health).
  ctx.startWorkers();

  ctx.logger.info('server_started', {
    env: ctx.config.env,
    host: ctx.config.host,
    port: ctx.config.port,
    store: ctx.config.store.driver,
    vk: ctx.config.vk.appId > 0,
    payments: ctx.config.economy.limits.purchases.enabled,
    ads: ctx.config.economy.limits.ads.enabled,
    dev: ctx.config.devSignerEnabled,
    market_worker: ctx.config.market.worker.enabled,
    push: ctx.notices.readiness(),
    debug_page: `http://localhost:${ctx.config.port}/debug`
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) {
      // Второй сигнал означает, что оператор устал ждать: спорим сразу. Дожидаться
      // watchdog'а здесь — значит не ответить на Ctrl+C вообще никогда.
      ctx.logger.fatal('server_shutdown_forced', { signal, reason: 'second_signal' });
      process.exit(1);
      return;
    }
    stopping = true;
    ctx.logger.info('server_stopping', { signal, timeoutMs: ctx.config.shutdownTimeoutMs });

    // Watchdog, а не бесконечное ожидание. `app.close` дожидается дозавершения
    // живых запросов, а один зависший клиент удерживает этот процесс навсегда:
    // оркестратор считает контейнер умирающим, не может его снять, и деплой встаёт.
    const watchdog = setTimeout(() => {
      ctx.logger.fatal('server_shutdown_timeout', { timeoutMs: ctx.config.shutdownTimeoutMs });
      process.exit(1);
    }, ctx.config.shutdownTimeoutMs);
    // unref: таймер не имеет права сам держать процесс живым после успешного закрытия.
    watchdog.unref();

    try {
      await app.close();
      await ctx.close();
      clearTimeout(watchdog);
      process.exit(0);
    } catch (error) {
      clearTimeout(watchdog);
      ctx.logger.fatal('server_shutdown_failed', { error });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Необработанные состояния. Node и так валит процесс на unhandledRejection
  // (с v15), но делает это без единой строки в структурированном логе — в
  // контейнере остаётся только код выхода 1. Здесь причина успевает быть
  // записанной, а сторы и фоновые циклы — закрытыми.
  const onFatal = (kind: string, error: unknown): void => {
    ctx.logger.fatal(kind, { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    void shutdown(kind);
  };
  process.on('unhandledRejection', (reason) => onFatal('unhandled_rejection', reason));
  process.on('uncaughtException', (error) => onFatal('uncaught_exception', error));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), level: 'fatal', msg: 'server_start_failed', error: error instanceof Error ? error.message : String(error) })}\n`
  );
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  process.exit(1);
});
