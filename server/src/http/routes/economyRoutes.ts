import type { FastifyInstance } from 'fastify';

import { LEDGER_REASONS, type LedgerReason } from '../../modules/ledger/ledger.types.js';
import { grantAssistEnergy } from '../../modules/economy/energy.js';
import { collectWarehouse } from '../../modules/economy/mining.js';
import { validationError } from '../../lib/errors.js';
import { authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf, optionalStringOf, queryInt, viewOf } from '../helpers.js';

/**
 * Склад, энергия и журнал (п.2.1–2.3).
 *
 * GET /v1/me — не «только чтение». Тик экономики по договору применяется «при каждом
 * запросе» (п.1 ТЗ), поэтому снятие витрины догоняет состояние аккаунта и пишет его.
 * Отсюда два следствия, которые нужно держать в голове: опрос идемпотентен по времени
 * (повтор в тот же такт ничего не меняет), и — благодаря дельта-записи стора
 * (modules/user/doc.diff.ts) — такой холостой повтор НЕ трогает документ и НЕ растит
 * `revision`. Ровно поэтому тяжёлый GET не разрушает CAS-окно параллельного рейда.
 *
 * Для прода это заменяется на явный `POST /v1/tick` + кэш витрины, но не на откат тика:
 * игрок, закрывший приложение на ночь, обязан увидеть добычу.
 *
 * ЧТЕНИЕ БЕЗ ЗАПИСИ ЗДЕСЬ НЕВОЗМОЖНО — и не от лени. Догон рождает движения журнала:
 * `applyIndustryTick` начисляет SEC через `credit`, то есть вместе с черновиком
 * (modules/economy/industry.ts), и черновик обязан быть записан вместе с состоянием —
 * «движение без факта запрещено» (шапка modules/ledger/ledger.store.ts). Значит
 * неписущий GET обязан либо выбросить черновик и показать игроку деньги без
 * аудиторского следа, либо отказаться от тика и лишить игрока ночной добычи (п.1 ТЗ).
 * Оба варианта хуже записи. Путь «сделайте GET неписущим» закрыт до тех пор, пока
 * начисление монеты живёт в догоне; цена текущего пути измерена и небольшая: 0.2 КБ
 * дельты и ~4.6% CPU запроса (`npm run bench`, разделы 3 и 7).
 */
export function registerEconomyRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };

  app.get('/v1/economy', auth, async (request) => {
    const now = ctx.now();
    const { account } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => ({
      account: synced,
      meta: null
    }));
    return viewOf(ctx.config, account, now);
  });

  app.post('/v1/economy/collect', auth, async (request) => {
    const now = ctx.now();
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const result = collectWarehouse(synced, now);
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    ctx.logger.info('warehouse_collected', { userId: account.id, collected: meta.collected });
    return {
      ...viewOf(ctx.config, account, now),
      result: { collected: meta.collected, drafts: meta.drafts.length }
    };
  });

  app.post('/v1/energy/assist', auth, async (request) => {
    const now = ctx.now();
    const helperId = optionalStringOf(bodyOf(request), 'helperId', 64);
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const result = grantAssistEnergy(synced, helperId ?? `anon:${now.getTime()}`, now, ctx.config.economy);
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        granted: meta.granted,
        nominal: meta.nominal,
        energy: meta.energy,
        remainingToday: meta.remainingToday
      }
    };
  });

  app.get('/v1/ledger', auth, async (request, reply) => {
    const limit = queryInt(request, 'limit', { min: 1, max: 500, fallback: 50 });
    const rawReason = (request.query as Record<string, unknown>)['reason'];
    let reasons: LedgerReason[] | undefined;
    if (typeof rawReason === 'string' && rawReason.trim().length > 0) {
      const reason = rawReason.trim() as LedgerReason;
      if (!LEDGER_REASONS.includes(reason)) {
        throw validationError(`Неизвестная причина движения: ${rawReason}`, { allowed: LEDGER_REASONS });
      }
      reasons = [reason];
    }
    const entries = await ctx.ledger.list(claimsOf(request).sub, { limit, reasons });
    reply.header('x-ledger-count', String(entries.length));
    return {
      count: entries.length,
      entries: entries.map((entry) => ({
        id: entry.id,
        ts: entry.ts,
        currency: entry.currency,
        delta: entry.delta,
        balanceAfter: entry.balanceAfter,
        reason: entry.reason,
        refType: entry.refType,
        refId: entry.refId,
        idempotencyKey: entry.idempotencyKey,
        meta: entry.meta ?? null
      }))
    };
  });
}
