import type { EconomyConfig } from '../../config/env.js';
import { type CraftTechId } from '../../config/materials.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { grantEntitlement, type NewEntitlement } from '../economy/entitlements.js';
import { dayKey } from '../economy/energy.js';
import { credit, resource, tech, asterium, type MovementContext } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';

/**
 * Rewarded-реклама: самый массовый канал монетизации (работает на 100% DAU, а не
 * на 1-3% плательщиков) и самый дешёвый по разработке.
 *
 * Главное правило: награда выдаётся ТОЛЬКО после серверного подтверждения показа.
 * Клиент может сказать лишь «я хочу посмотреть» (openAdSession) — факт просмотра
 * подтверждается постбэком рекламной сети, и только тогда вызывается claimAdReward.
 * Иначе rewarded-видео превращается в бесплатную фабрику энергии и убивает и экономику,
 * и рекламный доход.
 */

export type AdReward =
  | { kind: 'energy'; units: number }
  | { kind: 'asterium'; amount: number }
  /**
   * Сырьё за просмотр рекламы (хрониум / вольфрам / станиум).
   *
   * Рекламный кран намеренно мельче покупного: 1-2 единицы за показ. Реклама —
   * самый массовый канал, и щедрый кран превратил бы «посмотри ролик» в замену
   * магазину, обнулив ARPPU на материалах.
   */
  | { kind: 'material'; material: CraftTechId; amount: number }
  | { kind: 'entitlement'; entitlement: Omit<NewEntitlement, 'source' | 'orderId'> };

/** Позиция каталога рекламных наград (SKU фиксируем на сервере, цена не живёт в клиенте). */
export interface AdOffer {
  sku: string;
  label: string;
  reward: AdReward;
}

export interface AdSession {
  id: string;
  sku: string;
  createdAt: Date;
  expiresAt: Date;
}

function assertRewardable(account: UserAccount, config: EconomyConfig): void {
  if (!config.limits.ads.enabled) {
    throw new AppError(ErrorCodes.ADS_DISABLED, 503, 'Монетизация рекламой ещё не подключена');
  }
  if (account.materials.asterium.purchased < 0) {
    throw new AppError(ErrorCodes.PURCHASES_BLOCKED, 403, 'Есть неотработанный возврат платежа');
  }
}

/** Суточный счётчик сбрасывается на новый UTC-день. */
function dailyCounter(account: UserAccount, now: Date): { day: string; claimed: number } {
  const day = dayKey(now);
  return account.ads.day === day ? { day, claimed: account.ads.claimed } : { day, claimed: 0 };
}

/** Шаг 1: игрок нажал «Посмотреть рекламу». Выдаём одноразовый id сессии. */
export function openAdSession(
  account: UserAccount,
  offer: AdOffer,
  now: Date,
  config: EconomyConfig,
  idFactory: () => string
): { account: UserAccount; session: AdSession } {
  assertRewardable(account, config);
  const pending = account.ads.pending;
  if (pending && pending.expiresAt.getTime() > now.getTime()) {
    throw new AppError(ErrorCodes.AD_SESSION_REQUIRED, 409, 'Показ уже открыт — завершите его', {
      sessionId: pending.id,
      sku: pending.sku
    });
  }

  const session: AdSession = {
    id: idFactory(),
    sku: offer.sku,
    createdAt: now,
    expiresAt: new Date(now.getTime() + config.limits.ads.sessionTtlMs)
  };

  return {
    account: { ...account, ads: { ...account.ads, pending: { ...session } } },
    session
  };
}

/**
 * Шаг 2: награда. Вызывается только из обработчика постбэка рекламной сети
 * (или после проверки подписи callback'а) — никогда не по прямой просьбе клиента.
 */
export function claimAdReward(
  account: UserAccount,
  sessionId: string,
  offer: AdOffer,
  now: Date,
  config: EconomyConfig
): { account: UserAccount; drafts: LedgerDraft[]; granted: string } {
  assertRewardable(account, config);
  const limits = config.limits.ads;
  const pending = account.ads.pending;

  if (!pending || pending.id !== sessionId) {
    throw new AppError(ErrorCodes.AD_SESSION_REQUIRED, 409, 'Нет открытой сессии показа для этой награды');
  }
  if (pending.expiresAt.getTime() <= now.getTime()) {
    throw new AppError(ErrorCodes.AD_SESSION_EXPIRED, 410, 'Сессия показа истекла — посмотрите рекламу заново', {
      sessionId
    });
  }

  const counter = dailyCounter(account, now);
  if (limits.dailyRewards > 0 && counter.claimed >= limits.dailyRewards) {
    throw new AppError(ErrorCodes.AD_LIMIT_REACHED, 429, 'Суточный лимит наград за рекламу исчерпан', {
      limit: limits.dailyRewards,
      used: counter.claimed
    });
  }
  const lastClaimAt = account.ads.lastClaimAt?.getTime() ?? 0;
  if (counter.claimed > 0 && now.getTime() - lastClaimAt < limits.minIntervalMs) {
    throw new AppError(ErrorCodes.AD_TOO_SOON, 429, 'Слишком рано для следующей награды', {
      waitMs: limits.minIntervalMs - (now.getTime() - lastClaimAt)
    });
  }

  const ctxBase: Omit<MovementContext, 'reason'> = {
    ts: now,
    refType: 'ad_session',
    refId: sessionId,
    idempotencyKey: makeIdempotencyKey('ad', sessionId)
  };
  const drafts: LedgerDraft[] = [];
  let next = account;
  let granted = '';

  switch (offer.reward.kind) {
    case 'energy': {
      const room = Math.max(0, Math.min(offer.reward.units, config.energyCap - next.resources.energy));
      const movement = credit(next, resource('energy'), room, { ...ctxBase, reason: 'ad_reward' });
      next = movement.account;
      drafts.push(movement.draft);
      granted = `energy:${room}`;
      break;
    }
    case 'asterium': {
      const movement = credit(next, asterium('earned'), offer.reward.amount, { ...ctxBase, reason: 'ad_reward' });
      next = movement.account;
      drafts.push(movement.draft);
      granted = `asterium_earned:${offer.reward.amount}`;
      break;
    }
    case 'material': {
      // Сырьё за рекламу — всегда «заработанное» по смыслу: оно не покупалось, и
      // рефанд платежа его не касается (в отличие от астерия с его двумя кошельками).
      const movement = credit(next, tech(offer.reward.material), offer.reward.amount, { ...ctxBase, reason: 'ad_reward' });
      next = movement.account;
      drafts.push(movement.draft);
      granted = `${offer.reward.material}:${offer.reward.amount}`;
      break;
    }
    case 'entitlement': {
      next = grantEntitlement(
        next,
        { ...offer.reward.entitlement, source: 'ad_reward', orderId: makeIdempotencyKey('ad', sessionId) },
        now,
        {
          idFactory: () => makeIdempotencyKey('ad', sessionId),
          maxActive: config.limits.purchases.maxActiveEntitlements
        }
      );
      granted = `entitlement:${offer.reward.entitlement.sku}`;
      break;
    }
  }

  return {
    account: {
      ...next,
      ads: { day: counter.day, claimed: counter.claimed + 1, lastClaimAt: now, pending: null }
    },
    drafts,
    granted
  };
}

/** Отказ/таймаут показа: снимаем висящую сессию, чтобы игрок мог попробовать снова. */
export function abandonAdSession(account: UserAccount, sessionId: string): UserAccount {
  if (account.ads.pending?.id !== sessionId) return account;
  return { ...account, ads: { ...account.ads, pending: null } };
}