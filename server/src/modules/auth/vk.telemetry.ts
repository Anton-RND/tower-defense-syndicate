/**
 * Наблюдение за входом ВКонтакте.
 *
 * ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ПРОСТО ЛОГ. Первый живой вход единственен:
 * его нельзя ни повторить, ни отладить, ни снять сниффингом. Если площадка
 * подписывает параметры формой, которой нет в документации, единственный след,
 * который остаётся оператору, — это несколько полей о ТОМ, как пришла подпись.
 * Лог их содержит, но «посмотреть лог» требует доступа к хосту, а `/health` —
 * нет: оператор открывает один URL и видит, какой мостом подписала площадка
 * (`source`), в каком поле пришла подпись (`signKey`), участвовал ли `hash` и
 * сколько входов отклонено.
 *
 * ЧТО ЗДЕСЬ СОБИРАЕТСЯ, а что НЕТ. Только имена полей, их формы и счётчики.
 * Ни одного значения параметров, ни одного `viewer_id`, ни самой подписи:
 * эти данные уже есть в логе `auth_vk`, а здесь они создали бы копию
 * персональных данных в эндпоинте, который не требует аутентификации.
 *
 * СЧЁТЧИКИ НЕ ОГРАНИЧЕНЫ ПО ВРЕМЕНИ И НЕ СБРАСЫВАЮТСЯ: процесс живёт от деплоя
 * до деплоя, и этого достаточно для ответа на вопрос «что случилось сегодня».
 * Долговременная аналитика — дело агрегатора логов, а не этого модуля.
 */

/** Профиль успешно принятой подписи: чем площадка её поставила. */
export interface VkAuthProfile {
  scheme: string;
  signKey: string;
  source: 'raw' | 'decoded';
  hashIncluded: boolean;
  tsKey: string | null;
  /** Момент входа (ISO): по нему строка сопоставляется с логом `auth_vk`. */
  at: string;
}

/** Профиль отклонённой подписи: то, что можно сказать о ней без значений. */
export interface VkAuthRejection {
  code: string;
  reason: string | null;
  signKey: string | null;
  signShape: string;
  hashPresent: boolean;
  paramCount: number;
  at: string;
}

export interface VkAuthSnapshot {
  accepted: number;
  rejected: number;
  /** Отказы по коду ошибки: `INVALID_INIT_DATA` отличается от `EXPIRED_INIT_DATA`. */
  rejectsByCode: Record<string, number>;
  lastAccepted: VkAuthProfile | null;
  lastRejected: VkAuthRejection | null;
}

export interface VkAuthTelemetry {
  accepted(profile: Omit<VkAuthProfile, 'at'>): void;
  rejected(rejection: Omit<VkAuthRejection, 'at'>): void;
  snapshot(): VkAuthSnapshot;
}

export function createVkAuthTelemetry(now: () => Date = () => new Date()): VkAuthTelemetry {
  let accepted = 0;
  let rejected = 0;
  const byCode = new Map<string, number>();
  let lastAccepted: VkAuthProfile | null = null;
  let lastRejected: VkAuthRejection | null = null;

  return {
    accepted(profile): void {
      accepted += 1;
      lastAccepted = { ...profile, at: now().toISOString() };
    },
    rejected(rejection): void {
      rejected += 1;
      byCode.set(rejection.code, (byCode.get(rejection.code) ?? 0) + 1);
      lastRejected = { ...rejection, at: now().toISOString() };
    },
    snapshot(): VkAuthSnapshot {
      return {
        accepted,
        rejected,
        rejectsByCode: Object.fromEntries(byCode),
        lastAccepted,
        lastRejected
      };
    }
  };
}
