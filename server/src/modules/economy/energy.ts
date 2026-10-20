import type { EconomyConfig } from '../../config/env.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import type { UserAccount } from '../user/user.types.js';
import { effectiveEnergyRegenPerHour } from './entitlements.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import { credit, resource } from './wallet.js';
import { HOUR_MS } from './mining.js';

/**
 * Социальная энергия (п.2.3) — «виральный движок».
 *
 * Реген и траты считаются лениво (lazy): энергия «догоняется» до `now` при каждом
 * запросе/входе игрока. Так мы не держим воркеров на каждого пользователя и получаем
 * идемпотентность повторных расчётов.
 */
export interface EnergyTickResult {
  /** Новое (дробное) значение энергии, не выше капа. */
  energy: number;
  energyUpdatedAt: Date;
  /** Когда энергия станет полной (null — уже полная или реген отключён). */
  fullAt: Date | null;
  /** Через сколько мс появится следующая целая единица. */
  msToNextUnit: number | null;
}

/** Ключ суток UTC — для суточных лимитов (ассисты, дейлики). */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function computeEnergyTick(account: UserAccount, now: Date, config: EconomyConfig): EnergyTickResult {
  const elapsedMs = Math.max(0, now.getTime() - account.energyUpdatedAt.getTime());
  // Бусты регена («Энерго-катализатор» из магазина/рекламы) применяются поверх базовой ставки.
  const perHour = effectiveEnergyRegenPerHour(account, now, config.energyRegenPerHour);
  const cap = config.energyCap;

  const raw = account.resources.energy + (perHour * elapsedMs) / HOUR_MS;
  const energy = round6(Math.min(cap, raw));
  // Полная энергия «замораживает» точку отсчёта, иначе переполнение будет копиться.
  const updated = energy >= cap ? now : account.energyUpdatedAt;

  let fullAt: Date | null = null;
  if (energy < cap && perHour > 0) {
    fullAt = new Date(now.getTime() + ((cap - energy) / perHour) * HOUR_MS);
  }

  let msToNextUnit: number | null = null;
  if (energy < cap && perHour > 0) {
    const fractionNeeded = Math.ceil(energy) - energy;
    const units = fractionNeeded <= 1e-9 ? 1 : fractionNeeded;
    msToNextUnit = Math.max(0, Math.round((units / perHour) * HOUR_MS));
  }

  return { energy, energyUpdatedAt: updated, fullAt, msToNextUnit };
}

/** Догоняет реген энергии до `now`. Идемпотентна. */
export function applyEnergyTick(account: UserAccount, now: Date, config: EconomyConfig): UserAccount {
  const tick = computeEnergyTick(account, now, config);
  return {
    ...account,
    resources: { ...account.resources, energy: tick.energy },
    energyUpdatedAt: tick.energyUpdatedAt
  };
}

export interface SpendResult {
  account: UserAccount;
  /** Целые единицы до траты (после тика регена). */
  before: number;
  after: number;
  cost: number;
}

/**
 * Трата энергии на действие (PvP-атака, ускорение крафта — п.2.3, п.3.1).
 * Сначала реген, потом списание; не хватает — AppError(409), и стор (благодаря
 * транзакционной семантике) не пишет ничего.
 */
export function spendEnergy(
  account: UserAccount,
  cost: number,
  now: Date,
  config: EconomyConfig
): SpendResult {
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'Стоимость действия должна быть целым числом > 0', {
      cost
    });
  }

  const ticked = applyEnergyTick(account, now, config);
  const before = Math.floor(ticked.resources.energy);
  if (before < cost) {
    const tick = computeEnergyTick(ticked, now, config);
    throw new AppError(ErrorCodes.INSUFFICIENT_ENERGY, 409, `Недостаточно энергии: нужно ${cost}, есть ${before}`, {
      cost,
      available: before,
      cap: config.energyCap,
      /** Ориентир для UI / апселла доната: когда накопится нужное. */
      readyInMs: tick.msToNextUnit ? (cost - before) * tick.msToNextUnit : null,
      assistAvailable: ticked.assist.count < config.limits.assist.dailyLimit
    });
  }

  return {
    account: { ...ticked, resources: { ...ticked.resources, energy: ticked.resources.energy - cost } },
    before,
    after: before - cost,
    cost
  };
}


/** Сколько единиц даёт одна «Помощь друга» (25% капа по умолчанию). */
export function assistGainUnits(config: EconomyConfig): number {
  return Math.floor((config.energyCap * config.limits.assist.percent) / 100);
}

export interface AssistResult {
  account: UserAccount;
  /** Движение энергии в журнал (reason = 'assist'). */
  drafts: LedgerDraft[];
  /** Фактически выданное (может быть меньше номинала, если упираемся в кап). */
  granted: number;
  /** Номинал «Помощи друга» до ограничения капом. */
  nominal: number;
  energy: number;
  /** Осталось ассистов сегодня; -1 — лимит отключён. */
  remainingToday: number;
}

/**
 * Механика «Помощь друга» (п.2.3): друг перешёл по ссылке → получил свой бонус →
 * владельцу мгновенно восстанавливается 25% капа.
 *
 * Анти-чит: один друг помогает игроку ровно один раз (массив helpers) и всего
 * `limits.assist.dailyLimit` ассистов в сутки. Ключ идемпотентности привязан к
 * (игрок, сутки, номер ассиста) — повторный клик по той же ссылке не удвоит энергию.
 */
export function grantAssistEnergy(
  account: UserAccount,
  helperId: string,
  now: Date,
  config: EconomyConfig
): AssistResult {
  const ticked = applyEnergyTick(account, now, config);
  const limits = config.limits.assist;
  const today = dayKey(now);
  const assist =
    ticked.assist.day === today
      ? { day: today, count: ticked.assist.count, helpers: [...ticked.assist.helpers] }
      : { day: today, count: 0, helpers: [...ticked.assist.helpers] };

  if (limits.dailyLimit > 0 && assist.count >= limits.dailyLimit) {
    throw new AppError(
      ErrorCodes.ASSIST_LIMIT_REACHED,
      429,
      'Суточный лимит восстановлений энергии исчерпан — дождитесь регена или попробуйте завтра',
      { limit: limits.dailyLimit, used: assist.count }
    );
  }

  if (helperId && assist.helpers.includes(helperId)) {
    throw new AppError(ErrorCodes.ALREADY_HELPED, 409, 'Этот друг уже помогал вам', { helperId });
  }

  const nominal = assistGainUnits(config);
  const room = Math.max(0, Math.min(nominal, config.energyCap - ticked.resources.energy));
  const movement = credit(ticked, resource('energy'), room, {
    ts: now,
    reason: 'assist',
    refId: helperId || null,
    idempotencyKey: makeIdempotencyKey('event', `assist:${account.id}:${today}:${assist.count}`)
  });

  assist.helpers.push(helperId);
  if (limits.helpersHistory > 0 && assist.helpers.length > limits.helpersHistory) {
    assist.helpers.splice(0, assist.helpers.length - limits.helpersHistory);
  }
  assist.count += 1;

  return {
    account: {
      ...movement.account,
      // После ручного восстановления точка отсчёта регена — сейчас.
      energyUpdatedAt: now,
      assist
    },
    drafts: [movement.draft],
    granted: round6(room),
    nominal,
    energy: movement.account.resources.energy,
    remainingToday: limits.dailyLimit > 0 ? Math.max(0, limits.dailyLimit - assist.count) : -1
  };
}
