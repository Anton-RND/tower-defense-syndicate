import type { EconomyConfig } from '../../config/env.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { dayKey } from '../economy/energy.js';
import { credit, asterium, resource } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';

/**
 * «Пригласи друга» (п.2.3, Часть 2 ТЗ про VK).
 *
 * Клиент (frontend/src/vk/VkSocialManager.ts) рисит нативное окно шеринга ВК и
 * раздаёт ссылку с `ref=inv_<userId>`. При следующем запуске WebView приносит этот
 * ref в initData, а сервер — вот здесь — превращает его в награду пригласившему.
 *
 * ТРИ ВЕЩИ, ИЗ-ЗА КОТОРЫХ ЭТО СЕРВЕРНЫЙ МОДУЛЬ, А НЕ КЛИЕНТСКИЙ:
 *
 *  1. Награда выдаётся по факту РЕГИСТРАЦИИ нового аккаунта, а не по факту клика.
 *     Клиент может «забыть» сообщить о клике, сообщить дважды или сообщить за чужой
 *     аккаунт — всё это лечится только тем, что факт привязки живёт в документе
 *     приглашённого (`referral.invitedBy`), а факт награды — в документе пригласившего
 *     (`referral.invited`).
 *
 *  2. Один приглашённый = одна награда, навсегда, и учитывается это с ДВУХ сторон:
 *     новый аккаунт принимает `invitedBy` ровно один раз (повторная запись
 *     игнорируется), а награда считается выданной по факту в списке `invited`
 *     пригласившего. Поэтому «пришёл по своей ссылке» и «пригласил сам себя вторым
 *     аккаунтом» не работают, а массовая фейковая регистрация — это уже задача
 *     антифрода по device/social id, а не задача этой функции.
 *
 *  3. ref — внутренний id аккаунта (UUID), а не VK id: ссылка не раздаёт персональные
 *     данные третьим лицам и не поддаётся подбору «пригласи 1000 чужих id».
 */

/** Префикс ref-параметра. Отличает нашу реферальную метку от vk_ref и маркетинговых тегов. */
export const REFERRAL_PREFIX = 'inv_';

/**
 * Награда пригласившему: энергия (ед.) и заработанный астериев.
 *
 * Астерий — именно `earned`, а не `purchased`: он не участвует в сверке с агентом
 * выплат и не может быть «отмыт», а игрок, приведший друга, получает мягкую валюту.
 * Правка этих чисел — балансное решение, поэтому они в коде, а не в .env.
 */
export const REFERRAL_REWARD_ENERGY = 25;
export const REFERRAL_REWARD_ASTERIUM = 50;

/** ref для ссылки приглашения: `https://vk.com/app12345#inv_<userId>`. */
export function referralRef(userId: string): string {
  return `${REFERRAL_PREFIX}${userId}`;
}

/** ref → внутренний id пригласившего. null — метка не наша (маркетинг, vk_ref, мусор). */
export function parseReferral(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  // WebView иногда приносит хвост параметров («inv_x&foo=bar») — отрезаем по первому &.
  const raw = value.trim().split('&')[0] ?? '';
  if (!raw.startsWith(REFERRAL_PREFIX)) return null;
  const id = raw.slice(REFERRAL_PREFIX.length);
  // UUID (36) и технические id тестов: держим диапазон, а не строгий формат, иначе
  // любая сгенерированная id-схема обязана будет править этот модуль.
  if (id.length < 6 || id.length > 64) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return id;
}

export interface ReferralCredit {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** true — награда выдана. false — отказ (причина в `reason`). */
  credited: boolean;
  reason: 'ok' | 'self' | 'already' | 'limit';
  /** Сколько энергии реально начислено (0 — шкаф полный, начисление урезано капом). */
  energy: number;
  asterium: number;
  /** Осталось приглашений сегодня; -1 — лимит отключён. */
  remainingToday: number;
}

/**
 * Выдача награды пригласившему. Вызывается один раз на регистрацию приглашённого
 * (HTTP-слой: `store.transact(inviterId, ...)`), повторя — идемпотентны: тот же
 * inviteeId второй раз вернёт `{ credited: false, reason: 'already' }` и ни одного
 * движения по журналу.
 *
 * Энергия урезается капом, как в ассисте, но приглашение при этом ВСЁ РАВНО
 * засчитывается: иначе игрок с полным шкафом мог бы бесконечно переигрывать попытку
 * и получать награду в момент, когда шкаф опустеет.
 */
export function creditInviter(
  inviter: UserAccount,
  inviteeId: string,
  now: Date,
  config: EconomyConfig
): ReferralCredit {
  const limits = config.limits.referral;
  const today = dayKey(now);
  const state =
    inviter.referral.day === today
      ? { ...inviter.referral, invited: [...inviter.referral.invited] }
      : { ...inviter.referral, day: today, count: 0, invited: [...inviter.referral.invited] };

  const refuse = (reason: ReferralCredit['reason']): ReferralCredit => ({
    account: inviter,
    drafts: [],
    credited: false,
    reason,
    energy: 0,
    asterium: 0,
    remainingToday: limits.dailyMax > 0 ? Math.max(0, limits.dailyMax - state.count) : -1
  });

  if (!inviteeId || inviteeId === inviter.id) return refuse('self');
  if (state.invited.includes(inviteeId)) return refuse('already');
  if (limits.dailyMax > 0 && state.count >= limits.dailyMax) return refuse('limit');

  const energyRoom = Math.max(0, Math.min(REFERRAL_REWARD_ENERGY, config.energyCap - inviter.resources.energy));
  const keyFor = (currency: string): string =>
    makeIdempotencyKey('event', `referral:${inviter.id}:${inviteeId}:${currency}`);

  let next = inviter;
  const drafts: LedgerDraft[] = [];

  if (energyRoom > 0) {
    const movement = credit(next, resource('energy'), energyRoom, {
      ts: now,
      reason: 'event',
      refType: null,
      refId: inviteeId,
      idempotencyKey: keyFor('energy'),
      meta: { referral: true, invitee: inviteeId }
    });
    next = movement.account;
    drafts.push(movement.draft);
  }
  if (REFERRAL_REWARD_ASTERIUM > 0) {
    const movement = credit(next, asterium('earned'), REFERRAL_REWARD_ASTERIUM, {
      ts: now,
      reason: 'event',
      refType: null,
      refId: inviteeId,
      idempotencyKey: keyFor('asterium'),
      meta: { referral: true, invitee: inviteeId }
    });
    next = movement.account;
    drafts.push(movement.draft);
  }

  state.invited.push(inviteeId);
  if (limits.history > 0 && state.invited.length > limits.history) {
    state.invited.splice(0, state.invited.length - limits.history);
  }
  state.count += 1;
  state.creditedAt = now;

  return {
    account: { ...next, referral: state },
    drafts,
    credited: true,
    reason: 'ok',
    energy: energyRoom,
    asterium: REFERRAL_REWARD_ASTERIUM,
    remainingToday: limits.dailyMax > 0 ? Math.max(0, limits.dailyMax - state.count) : -1
  };
}

/**
 * Точка сборки для HTTP-слоя: привязка при регистрации + награда пригласившему.
 *
 * Возвращает черновики для ЖУРНАЛА пригласившего и НОВЫЙ документ приглашённого.
 * Порядок обязателен: сначала приглашённый принимает связку (это его единственный
 * шанс), затем пригласивший получает награду. Наоборот — провал записи приглашённого
 * оставил бы выданную награду без основания.
 */
export interface ReferralBinding {
  invitee: UserAccount;
  inviter: ReferralCredit | null;
}

/**
 * Точка сборки для HTTP-слоя: привязка при регистрации + награда пригласившему.
 *
 * Вызывается ОДИН раз — в обработчике входа, когда аккаунт только что создан
 * (`getOrCreate` вернул `created: true`), а `ref` взят из подписанных initData.
 * Порядок обязателен: сначала приглашённый принимает связку (это его единственный
 * шанс — на следующем входе `invitedBy` уже будет заполнен и bindReferral промолчит),
 * затем пригласивший получает награду. Наоборот — провал записи приглашённого оставил
 * бы выданную награду без основания.
 */
export function applyReferralOnSignup(
  invitee: UserAccount,
  ref: string | null | undefined,
  inviter: UserAccount | null,
  now: Date,
  config: EconomyConfig
): ReferralBinding {
  const bound = bindReferral(invitee, ref, now);
  const inviterId = bound.referral.invitedBy;
  if (!inviter || !inviterId || inviter.id !== inviterId) return { invitee: bound, inviter: null };
  return { invitee: bound, inviter: creditInviter(inviter, bound.id, now, config) };
}

/** Причина отказа награды → HTTP-ошибка (409 на «уже/сам», 429 на лимит). */
export function referralFailure(credit: ReferralCredit): AppError | null {
  if (credit.credited) return null;
  if (credit.reason === 'limit') {
    return new AppError(ErrorCodes.RATE_LIMITED, 429, 'Суточный лимит приглашений исчерпан', {
      reason: credit.reason
    });
  }
  return null;
}

/**
 * Привязка приглашённого к пригласившему при регистрации нового аккаунта.
 *
 * Идемпотентна и отказоустойчива: повторный запуск с тем же ref ничего не меняет,
 * а `ref === own id` (человек попал на свою же ссылку) игнорируется — иначе
 * самонакрутка энергии стала бы легальной механикой.
 */
export function bindReferral(invitee: UserAccount, ref: string | null | undefined, now: Date): UserAccount {
  if (invitee.referral.invitedBy) return invitee;
  const inviterId = parseReferral(ref);
  if (!inviterId || inviterId === invitee.id) return invitee;
  return {
    ...invitee,
    referral: { ...invitee.referral, invitedBy: inviterId, creditedAt: null, day: dayKey(now) }
  };
}
