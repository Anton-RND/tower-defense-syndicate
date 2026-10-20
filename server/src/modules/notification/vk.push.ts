/**
 * Транспорт VK Push (Часть 2, backlog 3): единственная точка процесса, которая
 * умеет говорить с `secure.sendNotification`.
 *
 * ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Только HTTP: собрать запрос, отправить, разобрать ответ и
 * сказать, повторять ли его. Никаких решений «кому слать», «сколько раз» и «что за
 * текст» — они в `notice.types.ts` (домен) и `outbox.ts` (политика доставки). Смесь
 * того и другого в одном файле дала бы неприятное: тексты уведомлений пришлось бы
 * проверять через поднятую сеть, а сеть в тестах не поднимается.
 *
 * ПОЧЕМУ НЕ `Promise<boolean>`, КАК В ТЗ. ТЗ возвращало true/false: «отправлено или
 * нет». Для пуша это теряет ровно ту информацию, по которой принимается решение:
 * 429 от ВК надо повторить через паузу, 6.13.2 (нет права на метод) повторять нельзя
 * никогда — это конфиг, а не сеть, а 113 (несовместимый токен) требует вообще рук
 * администратора. Поэтому исход ровно трёхклассный: `sent` | `permanent` | `retryable`.
 *
 * СЕКРЕТ УХОДИТ В ТЕЛО ЗАПРОСА, А НЕ В URL. `client_secret` в строке запроса оседает
 * в логовых файлах прокси, CDN и самого VK в открытом виде; в
 * `application/x-www-form-urlencoded` теле он остаётся внутри TLS-канала. Метод
 * одинаково принимает и то, и другое, так что терять на этом нечего.
 */

/** Формат ответа ВК: `{response: ...}` при успехе, `{error: {...}}` при отказе. */
interface VkResponse {
  response?: unknown;
  error?: { error_code?: unknown; error_msg?: unknown };
}

export interface VkPushSettings {
  /** `client_id` приложения. 0 — не настроен (проверяется до первого запроса). */
  appId: number;
  /** `client_secret` приложения — тот же ключ, что подписывает initData и постбэки. */
  secretKey: string;
  /** Полная ссылка на метод: задаётся конфигом, чтобы стенд ловил локальную заглушку. */
  endpoint: string;
  /** Версия API. `secure.sendNotification` живёт с 5.x и в новых версиях не менялась. */
  apiVersion: string;
  /** Потолок ожидания ответа: пуш не имеет права держать процесс дольше этого. */
  timeoutMs: number;
}

/** Минимальная форма fetch: тест подставляет свой объект без сети. */
export interface FetchLike {
  (
    url: string,
    init: {
      method: string;
      headers: Record<string, string>;
      body: string;
      signal?: AbortSignal;
    }
  ): Promise<{ status: number; json(): Promise<unknown> }>;
}

export type VkPushResult =
  | { kind: 'sent'; raw: number }
  /** Повторять бессмысленно: отказ в правах, неверный id, сломанный ключ. Нужны руки. */
  | { kind: 'permanent'; code: number | null; message: string }
  /** Временное: перегрузка, 5xx, таймаут, сеть. Повторять с лимитом попыток. */
  | { kind: 'retryable'; code: number | null; message: string };

export interface VkPushDeps {
  fetch: FetchLike;
}

/**
 * Коды ВК, повтор которых не лечит ничего: они означают не состояние площадки,
 * а наше несоответствие её настройкам. Список кодов методов `secure.*`:
 * 3 unknown method, 4 invalid signature, 6 permission error (в том числе 6.13.2 —
 * метод запрещён приложению, и 6.112 — шаблон сообщения отклонён), 7 user access
 * denied, 9 invalid request, 11 invalid app auth, 12 app blocked, 15 access denied,
 * 16 validation error, 17 user deleted/banned, 113 token invalid, 131 invalid user id.
 * Всего, чего нет в этом списке, считаем временным: ложный `permanent` тихо теряет
 * уведомление игрока, ложный `retryable` стоит нас максимум двух повторных запросов.
 */
const PERMANENT_CODES = new Set<number>([3, 4, 6, 7, 9, 11, 12, 15, 16, 17, 113, 131]);

export function isVkPushConfigured(settings: Pick<VkPushSettings, 'appId' | 'secretKey'>): boolean {
  return settings.appId > 0 && settings.secretKey.length > 0;
}

/**
 * Отправить одно уведомление одному пользователю.
 *
 * ОДИН АДРЕС НА ОДИН ВЫЗОВ, а не список `user_ids`: очередь отвечает за каждую
 * сделку отдельно, и смешав несколько лотов в один запрос, мы получили бы одну
 * ошибку на несколько судеб — при отказе по одному игроку остальные потеряли бы
 * своё «вас купили». ВК принимает массив, и это оптимизация на будущее (пачка из
 * `outbox`), а не задача этого слоя.
 */
export async function sendVkPush(
  settings: VkPushSettings,
  userId: string,
  message: string,
  deps: VkPushDeps
): Promise<VkPushResult> {
  if (!isVkPushConfigured(settings)) {
    return { kind: 'permanent', code: null, message: 'VK_APP_ID/VK_SECRET_KEY не заданы' };
  }
  if (!/^\d{1,20}$/.test(userId)) {
    return { kind: 'permanent', code: 131, message: `Невалидный user_id: ${userId}` };
  }
  if (message.length === 0) {
    return { kind: 'permanent', code: null, message: 'Пустое сообщение' };
  }

  const body = new URLSearchParams({
    client_id: String(settings.appId),
    client_secret: settings.secretKey,
    user_ids: userId,
    message,
    v: settings.apiVersion
  }).toString();

  // AbortController вместо опции `timeout` у fetch: её нет в спецификации, и она
  // есть не у каждой реализации. Таймаут обязателен: без него зависший ответ ВК
  // держит проход очереди ровно столько, сколько держится TCP-соединение.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, settings.timeoutMs));
  try {
    const response = await deps.fetch(settings.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal
    });
    return classify(response.status, await parseBody(response));
  } catch (error) {
    // Сюда попадают и `AbortError` по таймауту, и сетевые отказы. И то и другое —
    // состояние сети, а не приложения: повтор допустим.
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      kind: 'retryable',
      code: null,
      message: aborted ? `Таймаут ${settings.timeoutMs}мс` : errorMessage(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function parseBody(response: { status: number; json(): Promise<unknown> }): Promise<VkResponse> {
  try {
    return (await response.json()) as VkResponse;
  } catch {
    // Пустое тело при 502 от прокси — обычное дело, и оно не имеет права
    // превратиться в необработанное исключение внутри игрового потока.
    return {};
  }
}

function classify(status: number, parsed: VkResponse): VkPushResult {
  const vkError = parsed.error;
  if (vkError) {
    const code = typeof vkError.error_code === 'number' ? vkError.error_code : null;
    const message = typeof vkError.error_msg === 'string' ? vkError.error_msg : 'Ошибка VK API';
    return {
      kind: code !== null && PERMANENT_CODES.has(code) ? 'permanent' : 'retryable',
      code,
      message
    };
  }

  if (status === 200 && parsed.response !== undefined) {
    // Ответ — `1` (или массив по числу адресатов): любое число значит, что уведомление
    // принято площадкой. Дальше гарантий нет: ВК доставляет его на устройство тогда,
    // когда может, и мы это принимаем как данность чужой платформы.
    const raw = Array.isArray(parsed.response) ? Number(parsed.response[0]) : Number(parsed.response);
    return { kind: 'sent', raw: Number.isFinite(raw) ? raw : 1 };
  }

  if (status === 429 || status >= 500) {
    return { kind: 'retryable', code: null, message: `HTTP ${status}` };
  }
  if (status >= 400) {
    return { kind: 'permanent', code: null, message: `HTTP ${status}` };
  }
  return { kind: 'retryable', code: null, message: `Неожиданный ответ VK API (HTTP ${status})` };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
