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
 * ТРИ ВЕЩИ, КОТОРЫЕ ЛОМАЮТ ВХОД, ЕСЛИ О НИХ НЕ ПОЗАБОТИТЬСЯ ЯВНО:
 *
 *  1. ИМЯ ПОЛЯ ПОДПИСИ. Документация Mini Apps называет поле `sign`, но в ходу и
 *     алиас `sig` (старые bridge-обёртки, часть шаблонов ВК). Требовать только
 *     `sign` — значит отказать игроку, чьи параметры подписаны корректно. Поэтому
 *     `SIGN_KEYS` — список, а оба имени всегда исключены из строки проверки:
 *     подпись не может быть соучастницей собственной проверки.
 *
 *  2. КАКИЕ БАЙТЫ УЧАСТВУЮТ В ПРОВЕРКЕ. У двух схем они РАЗНЫЕ, и это главный
 *     источник «магически не совпадающих» подписей:
 *       — `mini_app` площадка считает по РАСКРЫТЫМ значениям (`session_hash`
 *         приезжает как `A%2BB`, а подписывается `A+B`), то есть как обычный
 *         `new URLSearchParams(initData)`;
 *       — `launch_params` — по СЫРОЙ urlencoded-строке (`%20` остаётся `%20`).
 *     Поэтому верификация идёт ДВОЙНЫМ ПРОХОДОМ (`verifyVkInitDataParams`):
 *     сначала сырые байты, затем раскрытые. На результат порядок не влияет:
 *     без спецсимволов в значениях оба прохода идентичны, а с спецсимволами
 *     совпасть может ровно один. Влияет он на диагностику: поле `source`
 *     говорит, каким мостом площадка подписывала, и по нему отличают «секрет
 *     не тот» от «пришла другая схема».
 *
 *  3. СУДЬБА `hash`. Документация Mini Apps его не подписывает, и мы его
 *     вырезаем (канон). Но часть переходов из шеринга приходит так, будто
 *     fragment — обычный параметр, и тогда строка проверки без него не
 *     сходится — молчаливый 401 ровно на приглашённой аудитории, то есть на
 *     самой ценной. Поэтому каждый из двух проходов идёт ещё и с ДВУМЯ
 *     решениями о `hash` (снаружи → внутри, см. VkHashPolicy). Это ничего не
 *     ослабляет: подпись по-прежнему HMAC-отпечаток тех самых байтов, а вот
 *     сломать вход без этого второго решения — легко.
 */

export type VkParams = Record<string, string>;

/** Имена поля подписи: `sign` — документированное, `sig` — встречавшийся алиас. */
export const SIGN_KEYS = ['sign', 'sig'] as const;

export const VkSignatureScheme = {
  /** Mini Apps: HMAC с сервисным ключом, hex-подпись. */
  MINI_APP: 'mini_app',
  /** Launch params (игры/iframe): HMAC с секретом, base64url-подпись. */
  LAUNCH_PARAMS: 'launch_params'
} as const;
export type VkSignatureScheme = (typeof VkSignatureScheme)[keyof typeof VkSignatureScheme];

/**
 * Параметры, которые никогда не участвуют в строке проверки подписи.
 * `sign`/`sig` — сама подпись; `hash` — deep-link приложения, площадкой не
 * подписывается (см. vk.adapter.ts: из него достаются только рефералы).
 */
const UNSIGNED_KEYS = new Set<string>([...SIGN_KEYS, 'hash']);
const SIGN_KEY_SET = new Set<string>(SIGN_KEYS);

/** Имя неподписанного параметра deep-link'а площадки. */
export const HASH_PARAM_KEY = 'hash';

/**
 * Решение о том, участвует ли `hash` в строке проверки.
 *
 * По умолчанию НЕТ: документация Mini Apps не относит fragment запуска к
 * подписываемым параметрам. Но если площадка когда-либо подписывает его
 * (часть переходов из шеринга приходит именно так), проверка с исключённым
 * `hash` даёт молчаливый 401 ровно на той аудитории, которая пришла по
 * приглашению, — то есть на самой ценной. Поэтому верификация идёт и так,
 * и так (см. verifyVkInitDataParams), а вот генератор подписывает по
 * канону, если вызывающий не попросил иначе.
 */
export interface VkHashPolicy {
  includeHash?: boolean;
}

/** Какие ключи вырезаны из строки проверки при данном решении о `hash`. */
function excludedKeys(includeHash: boolean): ReadonlySet<string> {
  return includeHash ? SIGN_KEY_SET : UNSIGNED_KEYS;
}


/** Извлекает подпись по любому из известных имён. null — подписи нет вовсе. */
export function signatureOf(params: VkParams): { key: string; value: string } | null {
  for (const key of SIGN_KEYS) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) return { key, value };
  }
  return null;
}

function decodePart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, '%20'));
  } catch {
    return part;
  }
}

export interface ParseOptions {
  /**
   * true (по умолчанию) — значения раскрываются (`%2B` → `+`, `+` → пробел),
   * как это делает `new URLSearchParams`. Так подписывает `mini_app`.
   * false — значения остаются СЫРЫМИ, байт в байт с присланной строкой: так
   * подписывает `launch_params`.
   */
  decode?: boolean;
}

/**
 * Разбирает initData / query строку запуска в плоский объект.
 * Принимает строку как с ведущим `?`, так и без.
 */
export function parseVkParams(raw: string, options: ParseOptions = {}): VkParams {
  const decode = options.decode !== false;
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
    params[decodedKey] = decode ? decodePart(value) : value;
  }
  return params;
}

/** Разбор БЕЗ раскрытия значений — по такой строке подписывает `launch_params`. */
export function parseVkRawParams(raw: string): VkParams {
  return parseVkParams(raw, { decode: false });
}

/**
 * Обратная операция к parseVkParams: плоский объект → query-строка initData.
 *
 * Чистый сериализатор: переносит ВСЁ, что ему дали, включая `sign`/`sig` и `hash`.
 * Решение «какие поля не должны доехать до строки запуска» принимает вызывающая
 * сторона (`signVkParams` вырезает чужие подписи до того, как положить свою).
 * Иначе генератор молча отдавал бы initData без подписи — то есть заведомо
 * отвергаемую боевым входом.
 */
export function encodeVkParams(params: VkParams): string {
  return Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key] ?? '')}`)
    .join('&');
}

function sortedPairs(params: VkParams, filter: (key: string) => boolean): Array<[string, string]> {
  return Object.keys(params)
    .filter(filter)
    .sort()
    .map((key) => [key, params[key] ?? ''] as [string, string]);
}

/**
 * Строка проверки для схемы Mini Apps.
 *
 * `options.includeHash` — см. VkHashPolicy: по умолчанию `hash` вырезан, как
 * требует документ площадки.
 */
export function buildMiniAppCheckString(params: VkParams, options: VkHashPolicy = {}): string {
  const excluded = excludedKeys(options.includeHash === true);
  return sortedPairs(params, (k) => !excluded.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/**
 * Строка проверки для схемы Launch Params (только `vk_*`).
 *
 * `hash` здесь решению не подлежит: он не начинается с `vk_` и в строку
 * проверки не попадает ни при каком `includeHash`.
 */
export function buildLaunchParamsCheckString(params: VkParams, options: VkHashPolicy = {}): string {
  const excluded = excludedKeys(options.includeHash === true);
  return sortedPairs(params, (k) => k.startsWith('vk_') && !excluded.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

/** service_key = HMAC_SHA256(SECRET_KEY, app_id) — «ключ сервиса» конкретного приложения. */
export function deriveVkServiceKey(appId: number | string, secretKey: string): Buffer {
  return createHmac('sha256', secretKey).update(String(appId), 'utf8').digest();
}

export function signVkMiniApp(
  params: VkParams,
  appId: number | string,
  secretKey: string,
  options: VkHashPolicy = {}
): string {
  const serviceKey = deriveVkServiceKey(appId, secretKey);
  return createHmac('sha256', serviceKey)
    .update(buildMiniAppCheckString(params, options), 'utf8')
    .digest('hex');
}

export function signVkLaunchParams(params: VkParams, secretKey: string, options: VkHashPolicy = {}): string {
  return createHmac('sha256', secretKey)
    .update(buildLaunchParamsCheckString(params, options), 'utf8')
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

export interface VkSignOptions {
  appId: number | string;
  secretKey: string;
  /** Схема подписи; по умолчанию современная Mini Apps. */
  scheme?: VkSignatureScheme;
  /** Имя поля, под которым подпись уедет в строку запуска (`sign` по умолчанию). */
  signKey?: (typeof SIGN_KEYS)[number];
  /**
   * Подписать `hash` вместе с остальными параметрами (см. VkHashPolicy).
   * Нужен стенду и тестам, чтобы прогнать по верификатору ту форму initData,
   * которую площадка ещё может прислать.
   */
  includeHash?: boolean;
}

export interface VkSignedInitData {
  /** Готовая строка initData: те же байты, что передала бы площадка. */
  initData: string;
  sign: string;
  scheme: VkSignatureScheme;
  signKey: string;
  checkString: string;
}

/**
 * Собирает подписанную initData из плоского набора параметров.
 *
 * Единственная реализация формулы «собери строку → подпиши → вставь поле» в
 * проекте: ею пользуется dev-генератор (`POST /v1/dev/vk/sign`) и тесты. Вторая
 * копия здесь была бы опасна: генератор и верификатор разошлись бы молча, и
 * стенд показывал бы «подпись не совпала» на параметрах, которые сам же выдал.
 */
export function signVkParams(params: VkParams, options: VkSignOptions): VkSignedInitData {
  const scheme = options.scheme ?? VkSignatureScheme.MINI_APP;
  const signKey = options.signKey ?? 'sign';
  const hashPolicy: VkHashPolicy = { includeHash: options.includeHash === true };
  const body: VkParams = {};
  for (const key of Object.keys(params)) {
    if (SIGN_KEYS.includes(key as (typeof SIGN_KEYS)[number])) continue;
    body[key] = params[key] ?? '';
  }
  const sign =
    scheme === VkSignatureScheme.LAUNCH_PARAMS
      ? signVkLaunchParams(body, options.secretKey, hashPolicy)
      : signVkMiniApp(body, options.appId, options.secretKey, hashPolicy);
  body[signKey] = sign;
  return {
    initData: encodeVkParams(body),
    sign,
    scheme,
    signKey,
    checkString:
      scheme === VkSignatureScheme.LAUNCH_PARAMS
        ? buildLaunchParamsCheckString(body, hashPolicy)
        : buildMiniAppCheckString(body, hashPolicy)
  };
}

export interface VkSignatureCheck {
  scheme: VkSignatureScheme;
  checkString: string;
  expectedSign: string;
  matched: boolean;
  /** Имя поля, в котором пришла подпись (`sign` | `sig`); null — поля нет. */
  signKey: string | null;
}

/**
 * Вычисляет подпись всеми известными схемами и возвращает детали каждой.
 * Нужен и верификации, и dev-инструментам (vk:doctor / dev signer).
 */
export function inspectVkSignatures(
  params: VkParams,
  options: { appId: number | string; secretKey: string },
  hashPolicy: VkHashPolicy = {}
): VkSignatureCheck[] {
  const found = signatureOf(params);
  const sign = found?.value ?? '';
  const miniAppSign = signVkMiniApp(params, options.appId, options.secretKey, hashPolicy);
  const launchSign = signVkLaunchParams(params, options.secretKey, hashPolicy);

  return [
    {
      scheme: VkSignatureScheme.MINI_APP,
      checkString: buildMiniAppCheckString(params, hashPolicy),
      expectedSign: miniAppSign,
      matched: sign.length > 0 && safeEquals(miniAppSign, sign),
      signKey: found?.key ?? null
    },
    {
      scheme: VkSignatureScheme.LAUNCH_PARAMS,
      checkString: buildLaunchParamsCheckString(params, hashPolicy),
      expectedSign: launchSign,
      matched: sign.length > 0 && safeEquals(launchSign, sign),
      signKey: found?.key ?? null
    }
  ];
}

/** Возвращает первую схему, чья подпись совпала. */
export function verifyVkSignature(
  params: VkParams,
  options: { appId: number | string; secretKey: string },
  hashPolicy: VkHashPolicy = {}
): VkSignatureCheck | null {
  return inspectVkSignatures(params, options, hashPolicy).find((c) => c.matched) ?? null;
}

export interface VkVerifiedParams {
  /** Параметры, на которых подпись совпала. */
  params: VkParams;
  check: VkSignatureCheck;
  /** Как именно совпало: `raw` — байты площадки, `decoded` — после раскрытия. */
  source: 'raw' | 'decoded';
  /** Участвовал ли `hash` в строке проверки (см. VkHashPolicy). */
  hashIncluded: boolean;
}

/**
 * Какие решения о `hash` обязан перебрать верификатор.
 *
 * Второй вариант заводится только когда `hash` в строке действительно есть:
 * без него оба решения дают одну и ту же строку проверки, и лишние проходы просто
 * удваивают стоимость отказа.
 */
function hashPolicies(params: VkParams): boolean[] {
  const value = params[HASH_PARAM_KEY];
  return typeof value === 'string' && value.length > 0 ? [false, true] : [false];
}

/**
 * Проход по одной строке initData: (сырые байты → раскрытые) × (`hash` снаружи
 * строки проверки → внутри).
 *
 * Нужен потому, что две схемы VK подписывают РАЗНЫЕ байты (см. шапку файла):
 * `launch_params` — urlencoded-строку, `mini_app` — раскрытые значения. Один
 * проход по любому из двух вариантов гарантированно ломает вход на другом,
 * а разница проявляется только у реальных игроков — в WebView, где повторить
 * невозможно.
 *
 * Каноническая комбинация (`raw`, `hash` вне проверки) пробуется первой, поэтому
 * площадка, следующая документации, всегда даёт `source: 'raw'`,
 * `hashIncluded: false` — и именно эта пара пишется в лог `auth_vk`. Расхождение
 * с ней видно по одной строке журнала, а не по молчаливому 401.
 *
 * Возвращает null, если не совпала ни одна комбинация: детали не отдаются
 * намеренно, чтобы не помогать подбору.
 */
export function verifyVkInitDataParams(
  rawInitData: string,
  options: { appId: number | string; secretKey: string }
): VkVerifiedParams | null {
  const candidates: Array<[source: 'raw' | 'decoded', params: VkParams]> = [
    ['raw', parseVkRawParams(rawInitData)],
    ['decoded', parseVkParams(rawInitData)]
  ];
  for (const [source, params] of candidates) {
    for (const includeHash of hashPolicies(params)) {
      const check = verifyVkSignature(params, options, { includeHash });
      if (check) return { params, check, source, hashIncluded: includeHash };
    }
  }
  return null;
}

/**
 * Форма пришедшей подписи — по ней, ещё до сравнения, видно, какой схемой
 * площадка подписала строку.
 *
 * Смысл именно в «до сравнения»: когда HMAC не совпал, оператору нужно отличить
 * «секрет не тот» от «пришла третья, незнакомая схема». Первая гипотеза
 * подтверждается формой подписи (она ведь не зависит от секрета), вторая —
 * отсутствием какой-либо из двух известных форм.
 */
export type VkSignShape = 'mini_app' | 'launch_params' | 'unknown';

/** Mini Apps: hex от SHA-256 — ровно 64 шестнадцатеричных символа. */
const MINI_APP_SIGN_SHAPE = /^[0-9a-f]{64}$/;
/** Launch params: base64url от SHA-256 без padding — ровно 43 символа. */
const LAUNCH_PARAMS_SIGN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export function classifyVkSignShape(sign: string | null | undefined): VkSignShape {
  if (typeof sign !== 'string' || sign.length === 0) return 'unknown';
  if (MINI_APP_SIGN_SHAPE.test(sign)) return 'mini_app';
  if (LAUNCH_PARAMS_SIGN_SHAPE.test(sign)) return 'launch_params';
  return 'unknown';
}

/** Одна из перебранных комбинаций и её результат. */
export interface VkPassReport {
  source: 'raw' | 'decoded';
  includeHash: boolean;
  scheme: VkSignatureScheme;
  matched: boolean;
}

/**
 * Одна строка отчёта о перебранной комбинации: `source/hash?/scheme = match|miss`.
 *
 * В логе отказа живёт массив таких строк, и он же — единственный ответ на вопрос
 * «а пробовали ли мы вообще то, что прислала площадка»: четыре строки показывают,
 * какая из комбинаций была ближе всех, а не только «ничего не совпало».
 */
export function formatVkPass(pass: VkPassReport): string {
  return `${pass.source}/${pass.includeHash ? 'hash' : 'nohash'}/${pass.scheme}=${pass.matched ? 'match' : 'miss'}`;
}

/**
 * Полный отчёт о том, как площадка подписала строку, — для лога отказа и для
 * `vk:doctor`.
 *
 * ЦЕННОСТЬ ДЛЯ ОПЕРАТОРА. Первый живой вход единственен: повторить его нельзя,
 * а чинить приходится по логам. Поэтому здесь нет ни одного значения параметра
 * (только имена и длина подписи) — но есть ответ на вопрос «что именно пришло»:
 * имя поля подписи, его форма, присутствие `hash` и какие из четырёх комбинаций
 * совпали. По этим четырём полям «не тот секрет» отличается от «не та схема»
 * за одну строку журнала.
 */
export interface VkInitDataDiagnosis {
  paramCount: number;
  /** Имена параметров, отсортированные, не более DIAGNOSIS_KEY_LIMIT штук. */
  paramKeys: string[];
  signKey: string | null;
  signLength: number;
  signShape: VkSignShape;
  hashPresent: boolean;
  passes: VkPassReport[];
  /** Первая совпавшая комбинация; null — вход не состоится. */
  matched: VkPassReport | null;
}

/** Столько имён параметров попадает в лог отказа: больше — не читается. */
export const DIAGNOSIS_KEY_LIMIT = 40;

export function diagnoseVkInitData(
  rawInitData: string,
  options: { appId: number | string; secretKey: string }
): VkInitDataDiagnosis {
  const candidates: Array<[source: 'raw' | 'decoded', params: VkParams]> = [
    ['raw', parseVkRawParams(rawInitData)],
    ['decoded', parseVkParams(rawInitData)]
  ];
  const primary = candidates[0]?.[1] ?? {};
  const found = signatureOf(primary);
  const passes: VkPassReport[] = [];

  for (const [source, params] of candidates) {
    for (const includeHash of hashPolicies(params)) {
      for (const check of inspectVkSignatures(params, options, { includeHash })) {
        passes.push({ source, includeHash, scheme: check.scheme, matched: check.matched });
      }
    }
  }

  return {
    paramCount: Object.keys(primary).length,
    paramKeys: Object.keys(primary).sort().slice(0, DIAGNOSIS_KEY_LIMIT),
    signKey: found?.key ?? null,
    signLength: found?.value.length ?? 0,
    signShape: classifyVkSignShape(found?.value ?? null),
    hashPresent: typeof primary[HASH_PARAM_KEY] === 'string' && primary[HASH_PARAM_KEY] !== '',
    passes,
    matched: passes.find((pass) => pass.matched) ?? null
  };
}

