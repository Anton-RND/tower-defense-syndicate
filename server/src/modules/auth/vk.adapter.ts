/**
 * Адаптер авторизации ВКонтакте: строка запуска WebView → нормализованная персона.
 *
 * ЗДЕСЬ НЕТ НИ ОДНОЙ ФОРМУЛЫ ПОДПИСИ — только порядок проверок и разбор полей.
 * Формула живёт в vk.signature.ts и используется оттуда же, из dev-генератора
 * (`POST /v1/dev/vk/sign`) и из `npm run vk:doctor`: вторая копия проверки
 * рано или поздно разошлась бы с первой, и разница проявилась бы только у
 * реальных игроков.
 *
 * ЧЕТЫРЕ РЕШЕНИЯ, КОТОРЫЕ НЕ ОЧЕВИДНЫ ИЗ КОДА:
 *
 *  1. Подпись ищется по двум именам (`sign`, `sig`) и двумя проходами по байтам
 *     (сырые → раскрытые). Любое ужесточение здесь = отказанная входа половина
 *     живой аудитории, поэтому и список имён, и порядок проходов документированы
 *     на месте (vk.signature.ts).
 *  2. Порядок проверок — от дешёвых к дорогим и от конфигурационных к
 *     криптографическим: сначала «мы вообще умеем входить», потом «структура»,
 *     потом «наше ли приложение», потом «свежесть», и только затем HMAC. Так
 *     отказ всегда объясняется причиной, а не общим «подпись не совпала».
 *  3. Реферал (`referral`) извлекается здесь, но НЕ применяется: `hash`
 *     площадкой не подписывается, и решение «верить или нет» принимает HTTP-слой
 *     (authRoutes.bindReferralOnSignup), где известны `created` и антифрод.
 *  4. Из подписанных полей берётся только личность (socialId/appId/groupId) и
 *     `meta`; всё остальное наружу не уходит — `raw` предназначен логированию,
 *     а не клиенту.
 */
import { isVkConfigured, type VkConfig } from '../../config/env.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { parseReferral } from '../social/referral.js';
import {
  parseVkParams,
  signatureOf,
  verifyVkInitDataParams,
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
    /** Метка перехода из ПОДПИСАННЫХ параметров (`vk_ref` / `ref`). */
    ref: string | null;
    sessionHash: string | null;
    isAppUser: boolean;
  };
  raw: VkParams;
}

/**
 * Заявка о реферале. Отдельный тип, а не строка в meta: у неё разная степень
 * доверия в зависимости от источника, и HTTP-слой обязан это различать.
 */
export interface ReferralClaim {
  /** Сырое значение метки («inv_0f1e…», «vk_share_panel», …). */
  raw: string;
  /**
   * `signed` — параметр вошёл в строку проверки; `hash` — НЕ подписан площадкой;
   * `stored` — метки нет вовсе: связка уже записана в документ новичка и
   * догоняется на повторном входе (см. authRoutes.settleStoredReferral).
   * Адаптер третий источник не производит: он о нём даже не знает.
   */
  source: 'signed' | 'hash' | 'stored';
  /** Идентификатор пригласившего; null — метка не наша (маркетинг, мусор). */
  inviterId: string | null;
}

export interface VkVerificationResult {
  identity: SocialIdentity;
  scheme: VkSignatureScheme;
  /** Имя поля, в котором пришла подпись: `sign` (документ) или `sig` (алиас). */
  signKey: string;
  /** Совпала ли подпись по сырым байтам или только после раскрытия значений. */
  source: 'raw' | 'decoded';
  /**
   * Участвовал ли `hash` в строке проверки. `true` означает, что площадка
   * подписала fragment запуска — форма, не описанная в документации Mini Apps,
   * и её обязан показать лог `auth_vk`, а не молчаливый 401.
   */
  hashIncluded: boolean;
  /** Имя пришедшего поля времени (`vk_ts` | `ts` | `auth_date` | `timestamp`); null — поля нет. */
  tsKey: string | null;
  /** Момент выдачи параметров VK (vk_ts / auth_date), если передан. */
  issuedAt: Date | null;
  /** Реферальная метка, если площадка её передала (см. extractReferralClaim). */
  referral: ReferralClaim | null;
}

const ID_KEYS = ['viewer_id', 'vk_user_id', 'mid', 'user_id', 'uid'] as const;
const APP_ID_KEYS = ['vk_app_id', 'aid', 'app_id'] as const;
const GROUP_KEYS = ['vk_group_id', 'gid', 'group_id'] as const;
/**
 * Имена поля времени. `ts` здесь обязательнO: современные Mini Apps подписывают
 * момент выдачи именно им, а `vk_ts` — старая схема. Без `ts` в этом списке
 * replay-проверка молча не срабатывала ни на одной живой initData: игрок мог
 * унести строку запуска и пользоваться ею сутки, а сервер отвечал 200.
 */
const TS_KEYS = ['vk_ts', 'ts', 'auth_date', 'timestamp'] as const;
const PLATFORM_KEYS = ['vk_platform', 'platform'] as const;
const LANGUAGE_KEYS = ['vk_language', 'language'] as const;
const REF_KEYS = ['vk_ref', 'ref'] as const;
/** Имена внутри deep-link (`hash`), чьё значение считается реферальной меткой. */
const REF_QUERY_KEYS = ['ref', 'invite', 'invitation'] as const;
/** Не подписываемый параметр, в котором WebView приносит fragment запуска. */
const HASH_KEYS = ['hash'] as const;
/** Форма токена, которую вообще стоит нести в parseReferral: без слэшей и `&`. */
const REF_TOKEN_SHAPE = /^[A-Za-z0-9_.-]{1,128}$/;

/** Разрешённый перекос часов клиента/сервера при проверке свежести параметров. */
const MAX_FUTURE_SKEW_SEC = 300;

function firstOf(params: VkParams, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Имя первого присутствующего ключа — диагностика для лога отказа.
 *
 * Значение уже отдаёт `firstOf`; здесь нужен именно САМ ключ, потому что вопрос
 * оператора на первом живом входе звучит не «какое время», а «как оно
 * называется»: `ts` или `vk_ts`. Разница между ними — это разница между
 * современной Mini Apps и старой схемой запуска, а значит и между двумя
 * формулами подписи.
 */
function firstKeyOf(params: VkParams, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return key;
  }
  return null;
}

/**
 * Кандидаты реферальной метки из неподписанного `hash`, в порядке убывания правдоподобия.
 *
 * `hash` — fragment-часть адреса приложения. Площадка его НЕ подписывает, поэтому
 * сюда попадают четыре разные формы:
 *
 *   1. `hash=inv_0f1e2d3c…`                  — наш реферал голым токеном;
 *   2. `hash=ref%3Dinv_0f1e2d3c…`            — вложенный query (`ref=…`);
 *   3. `hash=?ref=inv_0f1e2d3c…`             — то же с ведущим `?` (raw-разбор
 *                                              раскрывает `%3D` в `=`, ведущий
 *                                              `?` остаётся);
 *   4. `hash=oid%26inv_0f1e2d3c…`            — хвост чужого query после `&`.
 *
 * Чистая функция без рекурсивного декодирования: двойное раскрытие открыло бы
 * путь, при котором `%253D` превращается в `=` на втором проходе, то есть
 * доверенное значение стало бы результатом работы парсера, а не площадки.
 */
export function extractHashCandidates(hash: string | null | undefined): string[] {
  if (typeof hash !== 'string') return [];
  const value = hash.trim().replace(/^[?#&]+/, '');
  if (value.length === 0) return [];

  const out: string[] = [];
  const add = (candidate: string | null | undefined): void => {
    const token = (candidate ?? '').trim();
    if (token.length > 0 && !out.includes(token)) out.push(token);
  };

  if (value.includes('=')) {
    for (const pair of value.split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const key = pair.slice(0, eq).trim().toLowerCase();
      if ((REF_QUERY_KEYS as readonly string[]).includes(key)) add(pair.slice(eq + 1));
    }
    // Хвост после первого `&` — правдоподобный кандидат только когда он не похож
    // на пару key=value: иначе `a=b&c=d` породило бы кандидата «d» из чужого query.
    const tail = value.slice(value.indexOf('&') + 1);
    if (tail.length > 0 && !tail.includes('=')) add(tail);
  }
  // Целиком: ловит форму `oid%26inv_xxx`, где хвост отрезан до первого `&`.
  add(value.split('&')[0]);
  return out;
}

/**
 * Реферальная метка из параметров запуска.
 *
 * ИСТОЧНИК УКАЗЫВАЕТСЯ ЯВНО, потому что доверие к ним разное: подписанные `vk_ref`
 * / `ref` подделаны быть не могут, а `hash` — произвольная строка, которую
 * атакующий напишет сам. HTTP-слой принимает заявку из `hash` только на создании
 * аккаунта и только через антифрод referral.ts; смешать эти источники молча —
 * значит однажды наградить того, кто прислал чужой ref в неподписанном поле.
 */
export function extractReferralClaim(params: VkParams): ReferralClaim | null {
  const signed = firstOf(params, REF_KEYS);
  if (signed !== null) {
    return { raw: signed, source: 'signed', inviterId: parseReferral(signed) };
  }
  for (const candidate of extractHashCandidates(firstOf(params, HASH_KEYS))) {
    if (!REF_TOKEN_SHAPE.test(candidate)) continue;
    return { raw: candidate, source: 'hash', inviterId: parseReferral(candidate) };
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
 * Подпись ищется ДВОЙНЫМ ПРОХОДОМ (сырые байты → раскрытые значения), по ДВУМ
 * ИМЕНАМ поля (`sign`, `sig`) и с ДВУМЯ решениями о `hash` — см. шапку
 * vk.signature.ts. Единственный случай, когда вход запрещён при валидной
 * подписи площадки, — это потребовать ровно `sign`: игрок с `sig` получил бы
 * 401 без всякой возможности восстановить приложение.
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

  const declared = parseVkParams(rawInitData ?? '');
  if (Object.keys(declared).length === 0) throw invalid('пустая строка initData');
  if (!signatureOf(declared)) throw invalid('отсутствует параметр подписи (sign / sig)');

  const appIdRaw = firstOf(declared, APP_ID_KEYS);
  if (appIdRaw === null) throw invalid('не найден идентификатор приложения (vk_app_id / aid)');
  if (appIdRaw !== String(config.appId)) {
    throw invalid('идентификатор приложения не совпадает с VK_APP_ID', { received: appIdRaw });
  }

  // Свежесть: защищаем от повторного использования перехваченных initData (replay).
  // Считается по раскрытому разбору: `vk_ts`/`auth_date`/`timestamp` — десятичные
  // числа, им раскрытие не вредит, а сырые байты нужны только для HMAC.
  let issuedAt: Date | null = null;
  const tsKey = firstKeyOf(declared, TS_KEYS);
  const tsRaw = tsKey === null ? null : (declared[tsKey] ?? null);
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

  const verified = verifyVkInitDataParams(rawInitData ?? '', {
    appId: config.appId,
    secretKey: config.secretKey
  });
  if (!verified) {
    // Специфально без деталей подписи: не помогаем подбору.
    throw invalid('подпись не совпала ни одной известной схемой VK');
  }
  const params = verified.params;

  const socialId = firstOf(params, ID_KEYS);
  if (socialId === null || !/^\d+$/.test(socialId) || socialId === '0') {
    throw invalid('не удалось определить идентификатор пользователя');
  }

  const isAppUserRaw = firstOf(params, ['is_app_user', 'vk_is_app_user']);

  return {
    scheme: verified.check.scheme,
    signKey: verified.check.signKey ?? 'sign',
    source: verified.source,
    hashIncluded: verified.hashIncluded,
    tsKey,
    issuedAt,
    referral: extractReferralClaim(params),
    identity: {
      platform: 'vk',
      socialId,
      appId: firstOf(params, APP_ID_KEYS),
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
