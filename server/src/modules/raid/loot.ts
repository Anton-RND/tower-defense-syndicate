import type { EconomyConfig } from '../../config/env.js';
import {
  JUNK_IDS,
  LOOT_BASE,
  LOOT_OUTCOME_MULTIPLIER,
  LOOT_PER_DESTROYED,
  MAX_DESTROYED_PER_REPORT,
  isBattleOutcome,
  junkTotal,
  type BattleOutcome,
  type MaterialCost
} from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { dayKey } from '../economy/energy.js';
import { gainMaterials } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import { emptyLoot, type UserAccount } from '../user/user.types.js';

/**
 * Боевой лут (п.4 ТЗ): хлам, который игрок собирает после PvP-боя.
 *
 * ВАЖНО про источник истины. Эта функция НЕ вызывается по прямой просьбе клиента
 * («я выиграл, дай лут»). Её вызывает серверный резолвер боя (Шаг 4), который сам
 * посчитал исход и масштаб разрушений. Всё, что приходит от клиента, здесь
 * проходит через жёсткую валидацию и потолки:
 *  - raidId обязателен и служит ключом идемпотентности (повторный отчёт ≠ второй лут);
 *  - destroyed — целое в пределах MAX_DESTROYED_PER_REPORT;
 *  - суточный лимит событий (limits.loot.dailyEvents) и потолок склада хлама
 *    (limits.loot.junkCap) — страховка от бота, гоняющего бой по 200 раз в минуту.
 *
 * Формула: (бросок базового диапазона + destroyed × выход на единицу) × множитель исхода.
 * Проигравший собирает обломки (×0.2), а не трофеи — иначе проигрыш становился
 * выгоднее победы по сырью для цеха.
 */

export interface BattleReport {
  /** Идентификатор боя, выданный сервером. Обязателен. */
  raidId: string;
  outcome: BattleOutcome | string;
  /** Сколько единиц техники противника уничтожено (считает сервер). */
  destroyed: number;
}

export interface LootResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Выданный хлам (пустой объект — если бой был слишком мелким). */
  loot: MaterialCost;
  outcome: BattleOutcome;
  multiplier: number;
  /** Сколько единиц хлама принёс этот бой. */
  units: number;
  /** Засчитанных боёв с лутом за сегодня (после инкремента). */
  eventsToday: number;
  junkTotal: number;
}

function validateReport(report: BattleReport): BattleOutcome {
  const raidId = typeof report.raidId === 'string' ? report.raidId.trim() : '';
  if (raidId.length === 0 || raidId.length > 128) {
    throw new AppError(ErrorCodes.INVALID_BATTLE_REPORT, 400, 'Некорректный идентификатор боя', {
      length: raidId.length
    });
  }
  if (!isBattleOutcome(report.outcome)) {
    throw new AppError(ErrorCodes.INVALID_BATTLE_REPORT, 400, `Неизвестный исход боя: ${String(report.outcome)}`, {
      allowed: ['win', 'draw', 'loss']
    });
  }
  if (!Number.isInteger(report.destroyed) || report.destroyed < 0) {
    throw new AppError(ErrorCodes.INVALID_BATTLE_REPORT, 400, 'Количество уничтоженного должно быть целым и >= 0', {
      destroyed: report.destroyed
    });
  }
  if (report.destroyed > MAX_DESTROYED_PER_REPORT) {
    throw new AppError(ErrorCodes.INVALID_BATTLE_REPORT, 400, 'Масштаб разрушений превышает разумный для одного боя', {
      destroyed: report.destroyed,
      limit: MAX_DESTROYED_PER_REPORT
    });
  }
  return report.outcome;
}

export function rollBattleLoot(report: BattleReport, outcome: BattleOutcome, rng: () => number): MaterialCost {
  const multiplier = LOOT_OUTCOME_MULTIPLIER[outcome];
  const loot: MaterialCost = {};
  for (const id of JUNK_IDS) {
    const range = LOOT_BASE[id];
    const perDestroyed = LOOT_PER_DESTROYED[id] ?? 0;
    if (!range) continue;
    const roll = range.min + rng() * Math.max(0, range.max - range.min);
    const amount = Math.floor((roll + report.destroyed * perDestroyed) * multiplier);
    if (amount > 0) loot[id] = amount;
  }
  return loot;
}

/** Начисляет лут за бой. Чистая функция: вызывается из резолвера рейда внутри transact. */
export function generateBattleLoot(
  account: UserAccount,
  report: BattleReport,
  now: Date,
  config: EconomyConfig,
  rng: () => number = Math.random
): LootResult {
  const outcome = validateReport(report);
  const raidId = report.raidId.trim();

  const limits = config.limits.loot;
  const today = dayKey(now);
  const isNewDay = account.loot.day !== today;
  const eventsToday = isNewDay ? 0 : account.loot.events;
  const unitsToday = isNewDay ? 0 : account.loot.totalUnits;

  if (limits.dailyEvents > 0 && eventsToday >= limits.dailyEvents) {
    throw new AppError(ErrorCodes.LOOT_LIMIT_REACHED, 429, 'Суточный лимит боёв с лутом исчерпан', {
      limit: limits.dailyEvents,
      used: eventsToday
    });
  }

  if (!isNewDay && account.loot.lastRaidId === raidId) {
    throw new AppError(ErrorCodes.DUPLICATE_ORDER, 409, 'Этот бой уже обработан', { raidId });
  }

  const loot = rollBattleLoot(report, outcome, rng);
  const units = Object.values(loot).reduce((total, value) => total + (value ?? 0), 0);

  const currentJunk = junkTotal(account.junk);
  if (limits.junkCap > 0 && currentJunk + units > limits.junkCap) {
    throw new AppError(ErrorCodes.JUNK_CAP_REACHED, 409, 'Склад хлама переполнен — сдайте обломки в цех переработки', {
      cap: limits.junkCap,
      current: currentJunk,
      incoming: units
    });
  }

  const multiplier = LOOT_OUTCOME_MULTIPLIER[outcome];
  const gained = gainMaterials(account, loot, {
    ts: now,
    reason: 'battle_loot',
    refType: 'raid',
    refId: raidId,
    // Ключ на тип хлама: один бой даёт несколько валют, и каждая — отдельная запись журнала.
    idempotencyKeyFor: (id) => makeIdempotencyKey('raid', `${raidId}:${id}`),
    meta: { outcome, destroyed: report.destroyed, multiplier }
  });

  return {
    account: {
      ...gained.account,
      loot: { day: today, events: eventsToday + 1, totalUnits: unitsToday + units, lastRaidId: raidId }
    },
    drafts: gained.drafts,
    loot: gained.moved,
    outcome,
    multiplier,
    units,
    eventsToday: eventsToday + 1,
    junkTotal: junkTotal(gained.account.junk)
  };
}

/** Обнуление суточного счётчика (лениво, при первом бою нового дня). */
export function resetLootDay(account: UserAccount, now: Date): UserAccount {
  const today = dayKey(now);
  if (account.loot.day === today) return account;
  return { ...account, loot: emptyLoot(today) };
}

