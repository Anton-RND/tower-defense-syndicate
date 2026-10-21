import type { VkParams } from '../auth/vk.signature.js';

/**
 * Разбор постбэка rewarded-рекламы ВКонтакте (Часть 1.5, серверная половина).
 *
 * В кабинете оператора задаётся URL постбэка, и площадка дёргает его
 * подписанными параметрами по той же схеме, что у initData/событий сообщества:
 *     /callbacks/vk/ads?user_id=12345&reward_id=<session_id>&sign=<HMAC…>
 * где `reward_id` — строка, которую клиент передал в `VKWebAppShowNativeAds`
 * при открытии ролика. Контракт требует ровно одного: туда идёт id сессии
 * (`account.ads.pending.id`), и тогда постбэк находит сессию без всякого
 * индекса — владелец читается из `user_id`, сессия из `reward_id`, а
 * пересечение проверяется в домене.
 *
 * ⚠ КЛИЕНТСКОЙ ПОЛОВИНЫ ПОКА НЕТ. Во фронте лежат только `VkPaymentManager` и
 * `VkSocialManager`: вызова `VKWebAppShowNativeAds` с `reward_id` в репозитории
 * нет ни где. Маршрут готов и проверен тестами, но до появления этой обёртки
 * (по образцу `VkPaymentManager`, где резолв моста — тоже не факт выдачи)
 * площадка не подтвердит ни один показ: награда останется недостижимой, а
 * игрок — смотреть ролики впустую.
 *
 * ⚠ ДО ПЕРВОГО ADS_POSTBACK_READY=true: сверить имена параметров (`user_id`,
 * `reward_id`), формат (query-string) и схему подписи с актуальным кабинетом
 * (npm run vk:doctor). Реализация использует проверенную схему mini_app из
 * vk.signature.ts, но живой вектор постбэка рекламы у монорепо отсутствует.
 */

export interface VkAdPostback {
  /** VK id зрителя — это socialId игрока в нашей модели. */
  userId: string;
  /** Наш id сессии показа (мы отдали его площадке как `reward_id`). */
  sessionId: string;
}

export function parseVkAdPostback(params: VkParams): VkAdPostback | null {
  const userId = (params['user_id'] ?? '').trim();
  const sessionId = (params['reward_id'] ?? '').trim();
  if (userId.length === 0 || sessionId.length === 0) return null;
  return { userId, sessionId };
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
