import type { UserAccount } from '../user/user.types.js';
import type { VkParams } from '../auth/vk.signature.js';

/**
 * Разбор постбэка rewarded-рекламы ВКонтакте (Часть 1.5, серверная половина).
 *
 * В кабинете оператора задаётся URL постбэка, и площадка дёргает его
 * подписанными параметрами по той же схеме, что у initData/событий сообщества:
 *     /callbacks/vk/ads?user_id=12345&reward_id=<…>&sign=<HMAC…>
 *
 * КАК НА САМОМ ДЕЛЕ ВЫГЛЯДИТ `reward_id` (проверено по типам площадки).
 * `@vkontakte/vk-bridge@3.0.2`, packages/core/src/types/data.ts:
 *
 *     export type EAdsFormats = 'reward' | 'interstitial';
 *     export type ShowNativeAdsRequest = { ad_format: EAdsFormats; use_waterfall?: boolean };
 *     // ответ моста:
 *     VKWebAppShowNativeAds:  { result: true };
 *     VKWebAppCheckNativeAds: { result: boolean };
 *
 * В ВЫЗОВЕ МОСТА НЕТ ПОЛЯ ДЛЯ СВОЕГО ИДЕНТИФИКАТОРА приложения: клиент не может
 * передать площадке id нашей сессии, поэтому `reward_id` в постбэке — это
 * идентификатор ПЛОЩАДКИ (если она его шлёт вообще), и совпасть с
 * `account.ads.pending.id` он не способен. Отсюда второй режим корреляции ниже.
 *
 * Значит опора выдачи без кабинета одна: ПОДПИСЬ + владелец. `user_id` из
 * подписанных параметров называет игрока, а у игрока ровно один слот показа
 * (`ads.pending`), поэтому «какую сессию подтверждать» не спрашивает никто.
 * `reward_id` работает, когда он есть и совпадает (строгий режим), и иначе
 * только попадает в лог.
 *
 * ⚠ ДО ПЕРВОГО ADS_POSTBACK_READY=true: сверить имена параметров, формат
 * (query-string) и схему подписи с актуальным кабинетом (npm run vk:doctor).
 * Живого вектора постбэка рекламы у монорепо нет — реализация опирается на
 * проверенную схему mini_app из vk.signature.ts и на типы bridge выше, но не на
 * перехваченный запрос площадки.
 */

export interface VkAdPostback {
  /** VK id зрителя — это socialId игрока в нашей модели. Обязателен всегда. */
  userId: string;
  /** Идентификатор награды площадки; у части постбэков его нет. */
  rewardId: string | null;
}

/** Чем постбэк привязался к сессии: своим id или только владельцем. */
export type AdPostbackCorrelation = 'reward_id' | 'owner';

export function parseVkAdPostback(params: VkParams): VkAdPostback | null {
  const userId = (params['user_id'] ?? '').trim();
  if (userId.length === 0) return null;
  const rewardId = (params['reward_id'] ?? '').trim();
  return { userId, rewardId: rewardId.length > 0 ? rewardId : null };
}

/**
 * Выбор сессии, которую постбэк подтверждает.
 *
 *  - `reward_id` совпал со слотом → строгая связка (этот режим держат тесты и
 *    любая площадка, которая умеет отдавать наш id обратно);
 *  - иначе → владелец: подписанный `user_id` уже назвал игрока, а слот показа у
 *    него один, поэтому подтверждаем его единственный открытый показ.
 *
 * Здесь НЕ проверяются срок жизни сессии, лимиты и частота наград — это домен
 * `claimAdReward`, и дублировать его решения было бы вторым источником истины.
 * Возвращаем `null` только когда подтверждать нечего (слот пуст).
 *
 * ⚠ ОСТАТОЧНЫЙ РИСК РЕПЛЕЯ. Повторная доставка того же постбэка, прилетевшая
 * уже после выдачи, попадёт в СЛЕДУЮЩИЙ открытый показ игрока и выдаст его.
 * Полностью это лечится только памятью об уже использованных `reward_id`
 * площадки (поле в документе игрока), а без живого вектора неизвестно, шлёт ли
 * она их вообще. Сейчас риск ограничен сверху: суточный лимит
 * `ADS_DAILY_REWARDS`, межнаградовый интервал `ADS_MIN_INTERVAL_SEC` и TTL
 * сессии `ADS_SESSION_TTL_SEC` — дальше «нескольких лишних наград в сутки» не
 * пойдёт, и это осознанная цена за то, чтобы кран открывался по подписи.
 */
export function resolveAdPostbackSession(
  account: UserAccount,
  postback: VkAdPostback
): { pending: NonNullable<UserAccount['ads']['pending']>; correlated: AdPostbackCorrelation } | null {
  const pending = account.ads.pending;
  if (!pending) return null;
  if (postback.rewardId && pending.id === postback.rewardId) {
    return { pending, correlated: 'reward_id' };
  }
  return { pending, correlated: 'owner' };
}

/** Приводит разобранный query/тело к плоским строкам: повторный ключ → первый. */
export function toVkParams(raw: unknown): VkParams {
  const params: VkParams = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return params;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined || first === null) continue;
    params[key] = String(first);
  }
  return params;
}

