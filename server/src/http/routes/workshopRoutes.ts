import type { FastifyInstance } from 'fastify';

import {
  BLUEPRINTS,
  BUILD_CANCEL_GRACE_RATIO,
  BUILD_CANCEL_REFUND_RATE,
  isJunkId,
  JUNK_IDS,
  MATERIAL_LABEL,
  MAX_BUILD_QUEUE,
  RECYCLE_MAX_BATCH,
  RECYCLE_RECIPES
} from '../../config/workshop.js';
import { STORAGE_LABEL } from '../../config/storage.js';
import {
  HEAT_PER_NITROGEN,
  MAX_STRUCTURE_TOTAL,
  STRUCTURES
} from '../../config/structures.js';
import { UNIT_POWER_PROFILE } from '../../modules/economy/power.js';
import { rngFromKey } from '../../lib/rng.js';
import {
  applyChroniumSpeedup,
  cancelBuild,
  speedupAllBuilds,
  speedupCraft,
  startBuild,
  type PartialSpeedupResult,
  type SpeedupResult
} from '../../modules/workshop/craft.js';
import { dismantleItem, isDismantleMode } from '../../modules/workshop/dismantle.js';
import { recycleEntryKey, recycleJunk } from '../../modules/workshop/recycle.js';
import { validationError } from '../../lib/errors.js';
import { accountOf, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf, idempotencyKeyOf, intOf, optionalIntOf, stringOf, viewOf } from '../helpers.js';

/**
 * Мастерская: чертежи, очередь стройки, ускорение хронием, разбор и цех переработки
 * (п.3.1, Шаг 1.6).
 *
 * Все маршруты идут через `accountAction`: очередь сначала догоняется — дозревшая
 * постройка обязана уехать в инвентарь ДО проверки «есть ли свободный робот» и «есть
 * ли место». В домене этот шаг делает сам `settleBuilds`, но снаружи он всё равно
 * нужен: иначе витрина ответила бы «роботов нет», хотя робот освободился минуту назад.
 */
export function registerWorkshopRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };

  app.get('/v1/workshop/blueprints', auth, async () => ({
    queueLimit: MAX_BUILD_QUEUE,
    recycleBatchLimit: RECYCLE_MAX_BATCH,
    blueprints: BLUEPRINTS,
    /**
     * Сооружения — отдельным списком, а не вклеены в `blueprints`: у них другой контракт
     * (счётчик, а не предмет), и клиент, решивший по `kind`, что всё в этом каталоге
     * можно поставить на сетку, получил бы реактор в клетке лабиринта.
     */
    structures: STRUCTURES,
    structureQueueLimit: MAX_STRUCTURE_TOTAL,
    /**
     * Правила отмены стройки. Отдаются здесь, а не выводятся фронтом из его же
     * догадок: подсказка «до N% таймера возврат полный, дальше — M%» обязана
     * совпадать с кассой, иначе игрок проверяет её на первом же отменённом реакторе.
     */
    cancel: { graceRatio: BUILD_CANCEL_GRACE_RATIO, refundRate: BUILD_CANCEL_REFUND_RATE },
    junk: JUNK_IDS.map((id) => ({ id, recipe: RECYCLE_RECIPES[id] })),
    /**
     * Подписи материалов и накопителей.
     *
     * Витрина называет цену своими словами, только чтобы однажды назвать
     * `colored_metal` «бронзой» и продать её вдвое дешевле, чем взяла касса. Словарь
     * на сервере один (`MATERIAL_LABEL`, `STORAGE_LABEL`), и подсказка обязана
     * говорить его же голосом.
     */
    labels: { materials: MATERIAL_LABEL, storage: STORAGE_LABEL },
    /**
     * Как техника стоит в энергосети базы: `grid` (проводная), `battery` (заряд от
     * резерва), `autonomous` (свой реактор, ест дейтерий).
     *
     * Отдаётся профилем, а не пересказывается фронту: «тяжёлый рельсган не жрёт
     * электричество штаба» — это свойство класса, и придумывать его в разметке
     * нельзя.
     */
    units: UNIT_POWER_PROFILE,
    /**
     * От кольца «мощность ↔ охлаждение» витрине нужна ровно одна его константа:
     * без `heatPerNitrogen` подсказка про азот была бы гаданием.
     *
     * `baseSupply` и `passiveCooling` здесь лежали и убраны: страница не читала их
     * ни разу, хотя комментарий выше утверждал обратное. Оба числа доходят до
     * игрока составными — `economy.power.supplyOnline` и `economy.power.coolingCap`
     * считаются от тех же констант (`modules/economy/power.ts`), поэтому отдельная
     * сырая константа в каталоге была не «данные для подсказки», а второй источник
     * правды. Мёртвое поле в ответе стареет молча: правит его тот, кто читает
     * маршрут, а замечает — только тот, кто читает витрину. За это отвечает
     * `http.frontend-contract.test.ts`, раздел про поля ответа.
     */
    power: {
      heatPerNitrogen: HEAT_PER_NITROGEN
    }
  }));

  app.post('/v1/workshop/build', auth, async (request) => {
    const now = ctx.now();
    const code = stringOf(bodyOf(request), 'code', 64);
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const result = startBuild(synced, code, now, ctx.idFactory);
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    ctx.logger.info('build_started', {
      userId: account.id,
      code,
      jobId: meta.job.id,
      // Монета в логе обязательна: это единственная на сегодня трата SEC, и по ней
      // поддержка отвечает на вопрос «куда делись деньги» без чтения журнала.
      secSpent: meta.secCost
    });
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        job: meta.job,
        blueprint: meta.blueprint,
        // Непусто ровно одно из двух: фронт по этому полю решает, рисовать «башню» или
        // «здание» — и не должен угадывать это по коду.
        structure: meta.structure,
        // Сколько SEC списано этой стройкой (0 — денег не взяли). Фронт обязан показать
        // факт списания ответом сервера, а не догадываться по диффу кошелька между
        // двумя запросами: догадка по диффу теряет каждую транзакцию, случись между
        // запросами ещё один тик.
        secSpent: meta.secCost,
        busy: meta.busyAfter,
        free: meta.freeAfter
      }
    };
  });

  app.post<{ Params: { jobId: string } }>('/v1/workshop/build/:jobId/speedup', auth, async (request) => {
    const now = ctx.now();
    const { jobId } = request.params;
    const userId = claimsOf(request).sub;
    const amount = optionalIntOf(bodyOf(request), 'chronium', { min: 1 });

    const shape = (meta: SpeedupResult, partial?: PartialSpeedupResult) => ({
      ...viewOf(ctx.config, meta.account, now),
      result: {
        cost: meta.cost,
        savedMs: meta.savedMs,
        job: meta.job,
        items: meta.items.map((item) => ({ id: item.id, code: item.code, level: item.level })),
        busy: meta.busyAfter,
        free: meta.freeAfter,
        requested: partial?.requested ?? null,
        done: partial?.done ?? null,
        leftover: partial?.leftover ?? null
      }
    });

    // Без суммы — «добей досрочно» (списывается ровно цена остатка, с округлением
    // вверх); с суммой — частичное ускорение на столько времени, сколько оно даёт.
    if (amount === undefined) {
      const { meta } = await accountAction(ctx, userId, now, (synced) => {
        const result = applyChroniumSpeedup(synced, jobId, now, ctx.idFactory);
        return { account: result.account, drafts: result.drafts, meta: result };
      });
      return shape(meta);
    }
    const { meta } = await accountAction(ctx, userId, now, (synced) => {
      const result = speedupCraft(synced, jobId, amount, now, ctx.idFactory);
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    return shape(meta, meta);
  });

  app.post<{ Params: { jobId: string } }>('/v1/workshop/build/:jobId/cancel', auth, async (request) => {
    const now = ctx.now();
    const { jobId } = request.params;
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const result = cancelBuild(synced, jobId, now, ctx.idFactory);
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    ctx.logger.info('build_cancelled', {
      userId: account.id,
      jobId,
      code: meta.job.code,
      // Доля возврата в логе обязательна по той же причине, что и `secSpent` у старта:
      // «мне вернули меньше, чем я платил» разбирается по логу, а не по допросу игрока.
      rate: meta.rate,
      grace: meta.grace,
      refund: meta.refund,
      busy: meta.busyAfter
    });
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        job: meta.job,
        refund: meta.refund,
        rate: meta.rate,
        grace: meta.grace,
        busy: meta.busyAfter,
        free: meta.freeAfter
      }
    };
  });

  app.post('/v1/workshop/build/speedup-all', auth, async (request) => {
    const now = ctx.now();
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const result = speedupAllBuilds(synced, now, ctx.idFactory);
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    ctx.logger.info('build_queue_speedup_all', { userId: account.id, cost: meta.cost, count: meta.jobs.length });
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        cost: meta.cost,
        savedMs: meta.savedMs,
        count: meta.jobs.length,
        items: meta.items.map((item) => ({ id: item.id, code: item.code, level: item.level })),
        busy: meta.busyAfter,
        free: meta.freeAfter
      }
    };
  });

  app.post<{ Params: { itemId: string } }>('/v1/workshop/item/:itemId/dismantle', auth, async (request) => {
    const now = ctx.now();
    const { itemId } = request.params;
    const mode = stringOf(bodyOf(request), 'mode', 16);
    if (!isDismantleMode(mode)) {
      throw validationError(`Неизвестный режим разбора: ${mode}`, { allowed: ['salvage', 'scrap'] });
    }
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      // ГСЧ выведен из предмета и режима, а не из часов: «мне упало меньше, чем могло
      // быть» поддержка обязана перепроверить тем же броском, а не гадать.
      const result = dismantleItem(
        synced,
        itemId,
        mode,
        now,
        ctx.idFactory,
        rngFromKey(`${synced.id}:${itemId}:${mode}`)
      );
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        item: { id: meta.item.id, code: meta.item.code, level: meta.item.level },
        mode: meta.mode,
        salvage: meta.salvage,
        junk: meta.junk
      }
    };
  });

  app.post('/v1/workshop/recycle', auth, async (request) => {
    const now = ctx.now();
    const body = bodyOf(request);
    const junk = stringOf(body, 'junk', 32);
    const amount = intOf(body, 'amount', { min: 1, max: RECYCLE_MAX_BATCH });
    const key = idempotencyKeyOf(request);
    const userId = claimsOf(request).sub;

    // Ретрай того же запроса не должен сдавать хлам второй раз. У станка и модуля эта
    // предпроверка живёт в materials/commit.ts; отдельного «протокола» переработки нет,
    // поэтому она прямо в маршруте: арбитр «уже отдано или нет» — журнал, а не угадайка
    // по остатку хлама (сегодня на складе 60, завтра 0 — и ретрай внезапно сработает).
    if (key && isJunkId(junk) && (await ctx.ledger.hasKey(recycleEntryKey(userId, key, junk)))) {
      const current = await accountOf(ctx, request);
      ctx.logger.info('junk_recycle_duplicate', { userId: current.id, junk, amount });
      return {
        ...viewOf(ctx.config, current, now),
        result: {
          junk,
          amount: 0,
          yielded: {},
          energy: 0,
          wastedEnergy: 0,
          junkLeft: current.junk[junk],
          movements: 0,
          duplicate: true
        }
      };
    }

    const { account, meta } = await accountAction(ctx, userId, now, (synced) => {
      const result = recycleJunk(synced, junk, amount, now, ctx.config.economy, { idempotencyKey: key });
      return { account: result.account, drafts: result.drafts, meta: result };
    });
    ctx.logger.info('junk_recycled', { userId: account.id, junk, amount, yielded: meta.yielded });
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        junk: meta.junk,
        amount: meta.amount,
        yielded: meta.yielded,
        energy: meta.energy,
        wastedEnergy: meta.wastedEnergy,
        junkLeft: meta.junkLeft,
        movements: meta.drafts.length,
        duplicate: false
      }
    };
  });
}
