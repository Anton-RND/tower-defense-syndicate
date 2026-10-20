import type { FastifyInstance } from 'fastify';

import type { Cell } from '../../config/base.js';
import { validationError } from '../../lib/errors.js';
import { commitRaid, makeRaidId } from '../../modules/pvp/raid.js';
import { defenderLabel, findOpponent } from '../../modules/pvp/matchmaking.js';
import { clearLayout, deployableItems, describeBase, quoteWallCost, saveLayout, type LayoutSaveResult } from '../../modules/pvp/defense.js';
import { accountOf, authHook, claimsOf } from '../auth.js';
import type { AppContext } from '../context.js';
import { accountAction, bodyOf, intOf, optionalIntOf, stringOf, stringArrayOf, viewOf } from '../helpers.js';

/**
 * PvP и оборонительная сетка (Шаг 4).
 *
 * Соперник перед боем синхронизируется так же, как атакующий: добыча берётся из его
 * `mined`, а склад за время отсутствия не рос. Не синхронизировать его — значит
 * систематически недодавать атакующему трофеев, и игрок это заметит мгновенно.
 *
 * Состав армии наружу не доверяется: сервер берёт боевые цифры из инвентаря атакующего
 * по id предметов, а не из присланных характеристик (см. RaidInput.armyItemIds).
 */
export function registerPvpRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = { preHandler: authHook(ctx) };

  app.get('/v1/pvp/opponent', auth, async (request) => {
    const now = ctx.now();
    const attacker = await accountOf(ctx, request);
    const pick = await findOpponent(ctx.users, attacker, { now });
    return {
      ...viewOf(ctx.config, attacker, now),
      opponent: {
        defenderId: pick.defender.id,
        label: defenderLabel(pick.defender),
        rating: pick.candidate.rating,
        walls: pick.candidate.walls,
        units: pick.candidate.units,
        baseVersion: pick.candidate.baseVersion,
        report: pick.report,
        attempt: pick.attempt,
        band: pick.band
      }
    };
  });

  app.post('/v1/pvp/raid', auth, async (request) => {
    const now = ctx.now();
    const body = bodyOf(request);
    const defenderId = stringOf(body, 'defenderId', 128);
    const armyItemIds = stringArrayOf(body, 'armyItemIds', 200);
    const attackerId = claimsOf(request).sub;

    if (defenderId === attackerId) {
      throw validationError('Атаковать собственную базу нельзя', { defenderId });
    }
    // Догоняем оба документа: атакующего — регеном энергии и суточными счётчиками,
    // защитника — накопленным майнингом, из которого берётся лут.
    await accountAction(ctx, attackerId, now, (synced) => ({ account: synced, meta: null }));
    await accountAction(ctx, defenderId, now, (synced) => ({ account: synced, meta: null }));

    const defender = await ctx.users.findById(defenderId);
    if (!defender) throw validationError('Соперник не найден', { defenderId });

    const raidId = makeRaidId(attackerId, defenderId, ctx.idFactory());
    const committed = await commitRaid(
      { attackerId, defender, armyItemIds, raidId, now, config: ctx.config.economy },
      {
        store: ctx.users,
        ledger: ctx.ledger,
        idFactory: ctx.idFactory,
        onDefenderError: (error) =>
          // Бой засчитан, а списание у защитника не прошло: это сигнал для фоновой
          // компенсации, а не тихая потеря. Логируется обязательно (см. raid.ts).
          ctx.logger.error('raid_defender_write_failed', { raidId, defenderId, error }),
      }
    );
    const result = committed.result;
    ctx.logger.info('raid_committed', {
      raidId,
      attackerId,
      defenderId,
      outcome: result.battle.outcome,
      loot: result.loot,
      defenderCommitted: committed.defenderCommitted
    });
    return {
      ...viewOf(ctx.config, committed.attacker, now),
      result: {
        raidId: result.raidId,
        battle: result.battle,
        army: result.army,
        rating: result.rating,
        loot: result.loot,
        stolen: result.stolen,
        energy: result.energy,
        attacksRemaining: result.attacksRemaining,
        defenderCommitted: committed.defenderCommitted
      }
    };
  });

  app.get('/v1/base', auth, async (request) => {
    const now = ctx.now();
    const account = await accountOf(ctx, request);
    const report = describeBase(account);
    return {
      ...viewOf(ctx.config, account, now),
      result: {
        report,
        wallCost: quoteWallCost(1),
        deployable: deployableItems(account).map((item) => ({
          id: item.id,
          code: item.code,
          kind: item.kind,
          level: item.level
        }))
      }
    };
  });

  app.put('/v1/base/layout', auth, async (request) => {
    const now = ctx.now();
    const body = bodyOf(request);
    const input = {
      version: optionalIntOf(body, 'version', { min: 0 }),
      hq: cellOrNull(body['hq']),
      walls: body['walls'] === undefined ? undefined : cellsOf(body['walls'], 'walls'),
      units: body['units'] === undefined ? undefined : unitsOf(body['units'])
    };
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const saved = saveLayout(synced, input, now);
      return { account: saved.account, drafts: saved.drafts, meta: saved };
    });
    ctx.logger.info('layout_saved', {
      userId: account.id,
      effective: meta.effective,
      walls: meta.wallsAdded,
      charged: meta.charged
    });
    return { ...viewOf(ctx.config, account, now), result: summarizeLayout(meta) };
  });

  app.delete('/v1/base/layout', auth, async (request) => {
    const now = ctx.now();
    const { account, meta } = await accountAction(ctx, claimsOf(request).sub, now, (synced) => {
      const cleared = clearLayout(synced, now);
      return { account: cleared.account, drafts: cleared.drafts, meta: cleared };
    });
    return { ...viewOf(ctx.config, account, now), result: summarizeLayout(meta) };
  });
}

// ─── Разбор планировки ───────────────────────────────────────────────────────────

/** Координата из HTTP. Клетки приходят числами: «5,3» строкой клиент присылает часто. */
function cellOf(raw: unknown, field: string): Cell {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw validationError(`Поле «${field}» должно быть клеткой {x, y}`, { field });
  }
  const cell = raw as Record<string, unknown>;
  return { x: intOf(cell, 'x', { min: 0, max: 999 }), y: intOf(cell, 'y', { min: 0, max: 999 }) };
}

function cellOrNull(raw: unknown): Cell | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  return cellOf(raw, 'hq');
}

function cellsOf(raw: unknown, field: string): Cell[] {
  if (!Array.isArray(raw)) {
    throw validationError(`Поле «${field}» должно быть массивом клеток`, { field });
  }
  if (raw.length > 2000) {
    throw validationError(`Поле «${field}» длиннее 2000 клеток`, { field });
  }
  return raw.map((item, index) => cellOf(item, `${field}[${index}]`));
}

function unitsOf(raw: unknown): Array<{ itemId: string; x: number; y: number }> {
  if (!Array.isArray(raw)) {
    throw validationError('Поле «units» должно быть массивом', { field: 'units' });
  }
  if (raw.length > 500) {
    throw validationError('Поле «units» длиннее 500 элементов', { field: 'units' });
  }
  return raw.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw validationError(`Поле «units[${index}]» должно быть {itemId, x, y}`, { index });
    }
    const unit = item as Record<string, unknown>;
    const cell = cellOf(unit, `units[${index}]`);
    return { itemId: stringOf(unit, 'itemId', 128), x: cell.x, y: cell.y };
  });
}

/** Отчёт о сохранении: ровно те поля, по которым UI понимает, что изменилось. */
function summarizeLayout(saved: LayoutSaveResult): Record<string, unknown> {
  return {
    effective: saved.effective,
    version: saved.base.version,
    wallsAdded: saved.wallsAdded,
    wallsRemoved: saved.wallsRemoved,
    unitsDeployed: saved.unitsDeployed,
    unitsRecalled: saved.unitsRecalled,
    charged: saved.charged,
    refunded: saved.refunded,
    report: saved.report
  };
}
