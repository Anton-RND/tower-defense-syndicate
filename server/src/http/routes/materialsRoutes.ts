import type { FastifyInstance } from 'fastify';

import {
  ASTERIUM_YIELD,
  CHRONIUM_MAX_BATCH,
  CHRONIUM_MS_PER_UNIT,
  CONVERSION_MAX_BATCH,
  STANIUM_FIELD_MAX_MS,
  STANIUM_MAX_BATCH,
  STANIUM_MS_PER_UNIT,
  STANIUM_SPEED_MULTIPLIER,
  TECH_LABEL,
  TECH_MATERIAL_IDS
} from '../../config/materials.js';
import { METAL_IDS } from '../../config/workshop.js';
import { chargeStanium, convertAsterium } from '../../modules/materials/commit.js';
import { describeStaniumField, quoteConversion } from '../../modules/materials/service.js';
import { accountOf, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { bodyOf, idempotencyKeyOf, intOf, stringOf, viewOf } from '../helpers.js';

/**
 * Четыре высокотехнологичных материала: молекулярный станок и станиумный модуль.
 *
 * Маршруты НЕ оборачивают действие в `accountAction`: протоколы станка и модуля
 * живут в materials/commit.ts, который сам владеет транзакцией и предпроверкой
 * идемпотентности по журналу (см. шапку того файла). Дублировать транзакцию сверху
 * означало бы либо двойной CAS, либо обход предпроверки — и то, и другое хуже.
 *
 * Курс и выход наружу не отдаются «наугад»: клиент обязан показать цену ДО запроса,
 * поэтому котировка снимается тем же `quoteConversion`, которым её пересчитывает
 * сервер при списании. Клиент не передаёт ни выход, ни курс.
 */
export function registerMaterialsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };
  const deps = { users: ctx.users, ledger: ctx.ledger, idFactory: ctx.idFactory };

  app.get('/v1/materials', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    return {
      ...viewOf(ctx.config, account, now),
      rules: {
        metals: METAL_IDS.map((metal) => ({ id: metal, yieldPerAsterium: ASTERIUM_YIELD[metal] })),
        conversionMaxBatch: CONVERSION_MAX_BATCH,
        chroniumMsPerUnit: CHRONIUM_MS_PER_UNIT,
        chroniumMaxBatch: CHRONIUM_MAX_BATCH,
        staniumMsPerUnit: STANIUM_MS_PER_UNIT,
        staniumMaxBatch: STANIUM_MAX_BATCH,
        staniumFieldMaxMs: STANIUM_FIELD_MAX_MS,
        staniumSpeedMultiplier: STANIUM_SPEED_MULTIPLIER,
        labels: TECH_MATERIAL_IDS.map((id) => ({ id, ...TECH_LABEL[id] }))
      }
    };
  });

  app.get('/v1/materials/conversion', auth, async (request) => {
    const params = request.query as Record<string, unknown>;
    const metal = stringOf(params, 'metal', 32);
    const amount = intOf(params, 'amount', { min: 1, max: CONVERSION_MAX_BATCH });
    const quote = quoteConversion(metal, amount);
    return { quote };
  });

  app.post('/v1/materials/convert', auth, async (request) => {
    const now = ctx.now();
    const body = bodyOf(request);
    const metal = stringOf(body, 'metal', 32);
    const amount = intOf(body, 'amount', { min: 1, max: CONVERSION_MAX_BATCH });
    const committed = await convertAsterium(deps, claimsOf(request).sub, { metal, amount }, now, {
      requestId: idempotencyKeyOf(request)
    });
    ctx.logger.info('asterium_converted', {
      userId: committed.account.id,
      metal: committed.metal,
      spent: committed.spent,
      yielded: committed.yielded,
      duplicate: committed.duplicate
    });
    return {
      ...viewOf(ctx.config, committed.account, now),
      result: {
        spent: committed.spent,
        metal: committed.metal,
        yielded: committed.yielded,
        asteriumLeft: committed.asteriumLeft,
        duplicate: committed.duplicate
      }
    };
  });

  app.post('/v1/materials/stanium/charge', auth, async (request) => {
    const now = ctx.now();
    const units = intOf(bodyOf(request), 'units', { min: 1, max: STANIUM_MAX_BATCH });
    const committed = await chargeStanium(deps, claimsOf(request).sub, units, now, {
      requestId: idempotencyKeyOf(request)
    });
    ctx.logger.info('stanium_charged', {
      userId: committed.account.id,
      spent: committed.spent,
      until: committed.field.until?.toISOString() ?? null,
      duplicate: committed.duplicate
    });
    return {
      ...viewOf(ctx.config, committed.account, now),
      result: { spent: committed.spent, field: committed.field, duplicate: committed.duplicate }
    };
  });

  app.get('/v1/materials/stanium/field', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    return { ...viewOf(ctx.config, account, now), result: { field: describeStaniumField(account, now) } };
  });
}
