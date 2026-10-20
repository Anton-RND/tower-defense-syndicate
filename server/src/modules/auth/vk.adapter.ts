import { isVkConfigured, type VkConfig } from '../../config/env.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import {
  parseVkParams,
  verifyVkSignature,
  type VkParams,
  type VkSignatureScheme
} from './vk.signature.js';

/** Нормализованная персона, извлечённая из подписанных параметров платформы. */
export interface SocialIdentity {
  platform: 'vk' | 'tg';
  /** Стабильный числовой id пользователя в соцсети (VK viewer_id / TG id). */
  socialId: string;
  appId: string | null;
  /** Сообщество, из которого запущено приложение (клановые войны, п.4.2). */
  groupId: string | null;
  meta: {
    platformHint: string | null;
    language: string | null;
    ref: string | null;
    sessionHash: string | null;
    isAppUser: boolean;
  };
  raw: VkParams;
}

export interface VkVerificationResult {
  identity: SocialIdentity;
  scheme: VkSignatureScheme;
  /** Момент выдачи параметров VK (vk_ts / auth_date), если передан. */
  issuedAt: Date | null;
}

const ID_KEYS = ['viewer_id', 'vk_user_id', 'mid', 'user_id', 'uid'] as const;
const APP_ID_KEYS = ['vk_app_id', 'aid', 'app_id'] as const;
const GROUP_KEYS = ['vk_group_id', 'gid', 'group_id'] as const;
const TS_KEYS = ['vk_ts', 'auth_date', 'timestamp'] as const;
const PLATFORM_KEYS = ['vk_platform', 'platform'] as const;
const LANGUAGE_KEYS = ['vk_language', 'language'] as const;
const REF_KEYS = ['vk_ref', 'ref'] as const;

/** Разрешённый перекос часов клиента/сервера при проверке свежести параметров. */
const MAX_FUTURE_SKEW_SEC = 300;

function firstOf(params: VkParams, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function invalid(reason: string, details?: Record<string, unknown>): AppError {
  return new AppError(ErrorCodes.INVALID_INIT_DATA, 401, `Невалидные параметры инициализации VK: ${reason}`, {
    reason,
    ...details
  });
}

/**
 * Полный путь проверки initData (или launch params) из WebView ВКонтакте.
 *
 * Порядок проверок важен: сначала конфигурация → структура → совпадение App ID →
 * свежесть → криптографическая подпись → наличие пользователя.
 *
 * @throws AppError 500 VK_NOT_CONFIGURED | 401 INVALID_INIT_DATA | 401 EXPIRED_INIT_DATA
 */
export function verifyVkInitData(
  rawInitData: string,
  config: VkConfig,
  now: Date = new Date()
): VkVerificationResult {
  if (!isVkConfigured({ vk: config })) {
    throw new AppError(
      ErrorCodes.VK_NOT_CONFIGURED,
      500,
      'Не заданы VK_APP_ID / VK_SECRET_KEY — авторизация ВКонтакте невозможна'
    );
  }

  const params = parseVkParams(rawInitData ?? '');
  if (Object.keys(params).length === 0) throw invalid('пустая строка initData');

  const sign = params['sign'];
  if (!sign) throw invalid('отсутствует параметр sign');

  const appIdRaw = firstOf(params, APP_ID_KEYS);
  if (appIdRaw === null) throw invalid('не найден идентификатор приложения (vk_app_id / aid)');
  if (appIdRaw !== String(config.appId)) {
    throw invalid('идентификатор приложения не совпадает с VK_APP_ID', { received: appIdRaw });
  }

  // Свежесть: защищаем от повторного использования перехваченных initData (replay).
  let issuedAt: Date | null = null;
  const tsRaw = firstOf(params, TS_KEYS);
  if (tsRaw !== null) {
    const tsSec = Number(tsRaw);
    if (!Number.isFinite(tsSec) || tsSec <= 0) throw invalid('некорректный timestamp подписи');
    issuedAt = new Date(Math.trunc(tsSec * 1000));
    const ageSec = (now.getTime() - issuedAt.getTime()) / 1000;
    if (ageSec > config.initDataSourceTtlSec) {
      throw new AppError(
        ErrorCodes.EXPIRED_INIT_DATA,
        401,
        'Параметры инициализации устарели — перезапустите приложение',
        { reason: 'expired', ageSec: Math.trunc(ageSec), ttlSec: config.initDataSourceTtlSec }
      );
    }
    if (ageSec < -MAX_FUTURE_SKEW_SEC) {
      throw invalid('timestamp из будущего', { ageSec: Math.trunc(ageSec) });
    }
  }

  const check = verifyVkSignature(params, { appId: config.appId, secretKey: config.secretKey });
  if (!check) {
    // Специфально без деталей подписи: не помогаем подбору.
    throw invalid('подпись не совпала ни одной известной схемой VK');
  }

  const socialId = firstOf(params, ID_KEYS);
  if (socialId === null || !/^\d+$/.test(socialId) || socialId === '0') {
    throw invalid('не удалось определить идентификатор пользователя');
  }

  const isAppUserRaw = firstOf(params, ['is_app_user', 'vk_is_app_user']);

  return {
    scheme: check.scheme,
    issuedAt,
    identity: {
      platform: 'vk',
      socialId,
      appId: appIdRaw,
      groupId: firstOf(params, GROUP_KEYS),
      meta: {
        platformHint: firstOf(params, PLATFORM_KEYS),
        language: firstOf(params, LANGUAGE_KEYS),
        ref: firstOf(params, REF_KEYS),
        sessionHash: firstOf(params, ['session_hash', 'sid']),
        isAppUser: isAppUserRaw === '1' || isAppUserRaw === 'true'
      },
      raw: params
    }
  };
}
