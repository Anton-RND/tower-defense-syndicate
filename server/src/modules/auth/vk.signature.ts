import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Проверка подлинности параметров, которые ВКонтакте передаёт в WebView приложения.
 *
 * ВКонтакте использует ДВЕ разные схемы подписи — обе поддержаны явно:
 *
 * 1) `mini_app` — современные Mini Apps (VKWebApp / `initData` из VK Bridge,
 *    параметры `vk_app_id`, `viewer_id`, `is_app_user`, `session_hash`, `sign`, ...).
 *       service_key  = HMAC_SHA256(key = SECRET_KEY, data = String(APP_ID))          → raw bytes
 *       check_string = join(sorted(`key=rawValue`), '&') для всех параметров кроме `sign`
 *       sign         = HMAC_SHA256(key = service_key, data = check_string)            → hex
 *
 * 2) `launch_params` — классические параметры запуска игр/iframe-приложений
 *    (все параметры с префиксом `vk_`, время — `vk_ts`).
 *       check_string = urlencode(sorted(`vk_*` params))
 *       sign         = base64url(HMAC_SHA256(key = SECRET_KEY, data = check_string)) без padding `=`
 *
 * Схема 2 проверена реальным вектором из официальных тестов сторонней реализации
 * (swimmwatch/vk-mini-app-auth, app_id=53377165) — см. test/vk.signature.test.ts.
 * Схема 1 применяется первой; если initData придёт по старой схеме, сработает фолбэк.
 * Что использует ваше приложение: `npm run vk:doctor -- "<initData>"`.
 *
 * ВАЖНО: значения берутся СЫРЫМИ (без раскрытия `+` в пробел), иначе base64-составляющие
 * (`session_hash`, `access_token`) ломают строку проверки.
 */

export type VkParams = Record<string, string>;

export const VkSignatureScheme = {
  /** Mini Apps: HMAC с сервисным ключом, hex-подпись. */
  MINI_APP: 'mini_app',
  /** Launch params (игры/iframe): HMAC с секретом, base64url-подпись. */
  LAUNCH_PARAMS: 'launch_params'
} as const;
export type VkSignatureScheme = (typeof VkSignatureScheme)[keyof typeof VkSignatureScheme];

/** Параметры, которые никогда не участвуют в строке проверки подписи. */
const UNSIGNED_KEYS = new Set(['sign', 'hash']);

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, '%20'));
  } catch {
    return part;
  }
}

/**
 * Разбирает initData / query строку запуска в плоский объект.
 * Принимает строку как с ведущим `?`, так и без.
 */
export function parseVkParams(raw: string): VkParams {
  const query = raw.trim().replace(/^[?#&]+/, '');
  const params: VkParams = {};
  if (query.length === 0) return params;

  for (const pair of query.split('&')) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    const value = eq === -1 ? '' : pair.slice(eq + 1);
    const decodedKey = decodePart(key);
    if (decodedKey.length === 0) continue;
    params[decodedKey] = decodePart(value);
  }
  return params;
}

function sortedPairs(params: VkParams, filter: (key: string) => boolean): Array<[string, string]> {
  return Object.keys(params)
    .filter(filter)
    .sort()
    .map((key) => [key, params[key] ?? ''] as [string, string]);
}

/** Строка проверки для схемы Mini Apps. */
export function buildMiniAppCheckString(params: VkParams): string {
  return sortedPairs(params, (k) => !UNSIGNED_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** Строка проверки для схемы Launch Params (только `vk_*`). */
export function buildLaunchParamsCheckString(params: VkParams): string {
  return sortedPairs(params, (k) => k.startsWith('vk_') && !UNSIGNED_KEYS.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** service_key = HMAC_SHA256(SECRET_KEY, app_id) — «ключ сервиса» конкретного приложения. */
export function deriveVkServiceKey(appId: number | string, secretKey: string): Buffer {
  return createHmac('sha256', secretKey).update(String(appId), 'utf8').digest();
}

export function signVkMiniApp(params: VkParams, appId: number | string, secretKey: string): string {
  const serviceKey = deriveVkServiceKey(appId, secretKey);
  return createHmac('sha256', serviceKey).update(buildMiniAppCheckString(params), 'utf8').digest('hex');
}

export function signVkLaunchParams(params: VkParams, secretKey: string): string {
  return createHmac('sha256', secretKey)
    .update(buildLaunchParamsCheckString(params), 'utf8')
    .digest('base64url')
    .replace(/=+$/, '');
}

/** Константное по времени сравнение подписей (разные длины → false). */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface VkSignatureCheck {
  scheme: VkSignatureScheme;
  checkString: string;
  expectedSign: string;
  matched: boolean;
}

/**
 * Вычисляет подпись всеми известными схемами и возвращает детали каждой.
 * Нужен и верификации, и dev-инструментам (vk:doctor / dev signer).
 */
export function inspectVkSignatures(
  params: VkParams,
  options: { appId: number | string; secretKey: string }
): VkSignatureCheck[] {
  const sign = params['sign'] ?? '';
  const miniAppSign = signVkMiniApp(params, options.appId, options.secretKey);
  const launchSign = signVkLaunchParams(params, options.secretKey);

  return [
    {
      scheme: VkSignatureScheme.MINI_APP,
      checkString: buildMiniAppCheckString(params),
      expectedSign: miniAppSign,
      matched: sign.length > 0 && safeEquals(miniAppSign, sign)
    },
    {
      scheme: VkSignatureScheme.LAUNCH_PARAMS,
      checkString: buildLaunchParamsCheckString(params),
      expectedSign: launchSign,
      matched: sign.length > 0 && safeEquals(launchSign, sign)
    }
  ];
}

/** Возвращает первую схему, чья подпись совпала с `sign`. */
export function verifyVkSignature(
  params: VkParams,
  options: { appId: number | string; secretKey: string }
): VkSignatureCheck | null {
  return inspectVkSignatures(params, options).find((c) => c.matched) ?? null;
}

