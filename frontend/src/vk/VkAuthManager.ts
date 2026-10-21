/**
 * Вход в игру по подписанным параметрам площадки (P11) — клиентская половина.
 *
 * ЧТО КЛИЕНТСКОЕ, А ЧТО СЕРВЕРНОЕ — и почему важно не путать.
 *
 *  Клиент умеет одно: достать `initData` и отнести её серверу. Решать, кто этот
 *  игрок, клиент не вправе: строку запуска подделывает один fetch, поэтому
 *  единственным носителем личности является HMAC площадки
 *  (server/src/modules/auth/vk.signature.ts). Здесь нет ни одной формулы
 *  подписи, ни одного начисления и ни одного «запомню id и покажу чужой аккаунт».
 *
 *  `initData` СОХРАНИТЬ НЕЛЬЗЯ И НЕ НУЖНО. Она содержит `viewer_id` и
 *  `session_hash` — персональные данные, а срок её жизни ограничен
 *  `VK_INIT_DATA_SOURCE_TTL_SECONDS` (сервер отвергает устаревшую строку кодом
 *  `EXPIRED_INIT_DATA`). Наружу отсюда уходит только наш JWT.
 *
 * ПОЧЕМУ ЭТОТ МОДУЛЬ ВООБЩЕ НУЖЕН, ЕСЛИ ЕСТЬ play.html.
 *  Витрина полигона автономна: один файл, vanilla JS, никакой сборки (см.
 *  server/src/http/play.html). `frontend/src` — боевой клиент, собираемый вместе
 *  с `@vkontakte/vk-bridge`, и до появления этого файла его адаптеры (реклама,
 *  платежи, шеринг) ходили в сервер с токеном, который никто не выдавал:
 *  `/v1/auth/vk/init-data` оставался единственной петлёй входа, не подключённой
 *  к фронтенду.
 *
 * РЕЖИМ ВХОДА ВЫБИРАЕТ СЕРВЕР, А НЕ КЛИЕНТ.
 *  `GET /v1/config` → `auth.mode` (`vk` | `dev` | `disabled`), посчитанный тем же
 *  `authModeOf`, по которому `/health` и боевой маршрут судят о координатах
 *  площадки. Догадываться по булевым флагам здесь запрещено: это тот же класс
 *  ошибки, из-за которого витрина когда-то звала `/v1/auth/vk/init-data` на
 *  конфиге без секрета и получала 500.
 *
 * ТРАНСПОРТ ИНЖЕКТИТСЯ, а не импортируется — тот же принцип, что у
 * VkAdsManager, VkPaymentManager и VkSocialManager: `@vkontakte/vk-bridge` в
 * package.json этого монорепо нет. Пути — ЛИТЕРАЛЬНЫЕ константы, потому что
 * контрактный тест (server/test/http.frontend-contract.test.ts) сверяет с
 * маршрутами сервера именно строковые литералы.
 *
 *     import vkBridge from '@vkontakte/vk-bridge';
 *     const auth = new VkAuthManager(vkBridge, { api });
 *     const result = await auth.signIn();
 *     if (result.ok) api.setToken(auth.authorizationHeader);
 */

/** Минимальная форма vkBridge: один метод send с произвольным payload. */
export interface VkBridgeLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /**
   * Новый API моста (`window.VK.invokeAsync`). `webview.getAppMetaData` есть
   * только здесь — старое `send` не умеет запрашивать параметры запуска.
   */
  invokeAsync?<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Узкий интерфейс к серверу игры (в приложении — обёртка над fetch с JWT в заголовке). */
export interface GameApiLike {
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  get<T = unknown>(path: string): Promise<T>;
}

/** Литеральные пути сервера, которые знает этот клиент (см. шапку про контрактный тест). */
export const AUTH_PATHS = {
  config: '/v1/config',
  vkInitData: '/v1/auth/vk/init-data',
  devLogin: '/v1/auth/dev-login',
  me: '/v1/me'
} as const;

export type AuthMode = 'vk' | 'dev' | 'disabled';

export type AuthStatus =
  /** Сессия получена, токен в руке. */
  | 'signed_in'
  /** Сервер сказал EXPIRED_INIT_DATA, и повтор тоже не помог: строка запуска устарела. */
  | 'expired'
  /** initData взять неоткуда: мост не ответил, а в URL нет параметров площадки. */
  | 'unsupported'
  /** INVALID_INIT_DATA: подпись не совпала. Повторять бессмысленно — скажет то же. */
  | 'refused'
  /** Режим `disabled` либо VK_NOT_CONFIGURED: конфигурация сервера, а не вина игрока. */
  | 'misconfigured'
  /** Всё остальное: сеть, 5xx, неожиданная форма ответа. */
  | 'error';

export interface ReferralDiagnosis {
  ref: string;
  /** `signed` / `hash` / `stored` — см. ReferralOutcome на сервере. */
  source: string;
  bound: boolean;
  credited: boolean;
  reason: string;
}

export interface SignInResult {
  ok: boolean;
  status: AuthStatus;
  mode: AuthMode;
  /** true — аккаунт создан этим входом (первый запуск игры). */
  created: boolean;
  userId: string | null;
  /** Код ошибки сервера (`INVALID_INIT_DATA`, `EXPIRED_INIT_DATA`, …) — для диагноза в логах. */
  code: string | null;
  /** Диагностика реферала, если метка приходила с параметрами запуска. */
  referral?: ReferralDiagnosis;
  message?: string;
}

/** Хранилище токена. По умолчанию — localStorage браузера/WebView, иначе память процесса. */
export interface AuthStorage {
  load(): string | null;
  save(token: string): void;
  clear(): void;
}

export const TOKEN_STORAGE_KEY = 'tds.auth.token';


export interface VkAuthOptions {
  api: GameApiLike;
  storage?: AuthStorage;
  /** Социальный id для режима `dev` (стенд). Боевой режим его игнорирует. */
  devSocialId?: string;
  /** Сколько раз перезапросить initData при `EXPIRED_INIT_DATA`. По умолчанию 1. */
  retries?: number;
  /** Сюда ложатся отказы моста и сервера: тихая деградация не должна терять диагностику. */
  logger?: (message: string, payload?: Record<string, unknown>) => void;
}

/**
 * Хранилище по умолчанию.
 *
 * `localStorage` отсутствует в части окружений (приватный режим, тесты на node),
 * поэтому падение обратно в память: сессия переживает перезагрузку страницы, но
 * не переживает закрытие игры — худшая из двух возможных деградаций, но и та
 * не срывает вход.
 */
export function browserStorage(key: string = TOKEN_STORAGE_KEY): AuthStorage {
  const raw = typeof globalThis !== 'undefined' ? (globalThis as Record<string, unknown>)['localStorage'] : null;
  const area =
    raw && typeof raw === 'object' ? (raw as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) : null;
  let memory: string | null = null;
  return {
    load(): string | null {
      if (!area) return memory;
      try {
        return area.getItem(key);
      } catch {
        return memory;
      }
    },
    save(token: string): void {
      memory = token;
      if (!area) return;
      try {
        area.setItem(key, token);
      } catch {
        /* переполненное хранилище не обязано срывать вход: токен уже в памяти */
      }
    },
    clear(): void {
      memory = null;
      if (!area) return;
      try {
        area.removeItem(key);
      } catch {
        /* см. save */
      }
    }
  };
}

/** Признак подписанных параметров площадки в URL iframe'а. */
function looksLikeVkParams(value: string): boolean {
  if (!value) return false;
  const padded = `&${value}`;
  return value.includes('vk_app_id=') || padded.includes('&sign=') || padded.includes('&sig=');
}

/**
 * Код ошибки из ответа сервера в форме, которую бросает api-обёртка.
 *
 * Сервер всегда отвечает `{ error: { code, message } }` (lib/errors.ts), но
 * обёртка транспорта в приложении может бросить как сам этот объект, так и
 * ответ целиком — поэтому читаем три формы, а не одну, и молчим, если ни одна
 * не подошла: отсутствие кода не должно превращаться в исключение на входе.
 */
function codeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const box = error as Record<string, unknown>;
  const direct = box['code'];
  if (typeof direct === 'string') return direct;
  for (const key of ['body', 'response', 'data']) {
    const nested = box[key];
    if (typeof nested !== 'object' || nested === null) continue;
    const inner = (nested as Record<string, unknown>)['error'];
    if (typeof inner !== 'object' || inner === null) continue;
    const code = (inner as Record<string, unknown>)['code'];
    if (typeof code === 'string') return code;
  }
  return null;
}

/** Форма ответа маршрутов входа: только те поля, которые этот клиент читает. */
interface SessionEnvelope {
  token?: unknown;
  created?: unknown;
  user?: { id?: unknown };
  referral?: { ref?: unknown; source?: unknown; bound?: unknown; credited?: unknown; reason?: unknown };
}

export class VkAuthManager {
  private readonly storage: AuthStorage;
  private readonly retries: number;
  private cachedMode: AuthMode | null = null;
  private token: string | null = null;

  constructor(
    private readonly bridge: VkBridgeLike,
    private readonly options: VkAuthOptions
  ) {
    this.storage = options.storage ?? browserStorage();
    this.retries = Math.max(0, options.retries ?? 1);
  }

  /** Заголовок для авторизованных запросов; null — входа ещё нет. */
  get authorizationHeader(): string | null {
    return this.token ? `Bearer ${this.token}` : null;
  }

  /**
   * Достать токен из хранилища (пережить перезагрузку страницы).
   *
   * Здесь он только возвращается: проверять его на сервере без просьбы вызывающего
   * означало бы лишний запрос в минуту, когда у клиента ещё нет токена.
   */
  restore(): string | null {
    const saved = this.storage.load();
    if (saved) this.token = saved;
    return saved;
  }

  /** Забыть сессию (выход, смена аккаунта, 401 от любого маршрута). */
  signOut(): void {
    this.token = null;
    this.storage.clear();
  }

  /**
   * Режим входа этого сервера. Ответ кэшируется: `auth.mode` не меняется за
   * время жизни процесса, а спрашивать его на каждый вход — лишний запрос в
   * минуту, когда у клиента ещё нет токена.
   */
  async resolveMode(): Promise<AuthMode> {
    if (this.cachedMode) return this.cachedMode;
    try {
      const config = await this.options.api.get<{ auth?: { mode?: unknown } }>(AUTH_PATHS.config);
      const mode = config?.auth?.mode;
      this.cachedMode = mode === 'vk' || mode === 'dev' || mode === 'disabled' ? mode : 'disabled';
    } catch (error) {
      // Незвестность режима трактуется как «выключен»: выдумывать `vk` и ловить
      // 500 VK_NOT_CONFIGURED хуже, чем один раз сказать правду.
      this.log('Не удалось прочитать auth.mode из /v1/config', { error: this.text(error) });
      this.cachedMode = 'disabled';
    }
    return this.cachedMode;
  }

  /**
   * Строка запуска WebView.
   *
   * Первый источник — мост (`webview.getAppMetaData`): он отдаёт актуальную
   * `initData`, даже если страница живёт долго. Второй — URL iframe'а: ВКонтакте
   * грузит мини-приложение по адресу `https://<домен>/…?vk_app_id=…&sign=…`,
   * поэтому параметры запуска приходят вместе с запросом страницы.
   *
   * Пустой результат не подделывается: подпись ставит только площадка, поэтому
   * локально собранная строка сервером отвергается как подделка, и задача
   * клиента — сказать об этом, а не сделать вид, что входа не произошло.
   */
  async initData(): Promise<string | null> {
    if (typeof this.bridge.invokeAsync === 'function') {
      try {
        const meta = await this.bridge.invokeAsync<Record<string, unknown>>('webview.getAppMetaData', {});
        const value = meta?.['initData'];
        if (typeof value === 'string' && value.length > 0) return value;
        this.log('webview.getAppMetaData ответил без initData');
      } catch (error) {
        this.log('webview.getAppMetaData не ответил', { error: this.text(error) });
      }
    }
    const location = typeof globalThis !== 'undefined' ? (globalThis as Record<string, unknown>)['location'] : null;
    if (location && typeof location === 'object') {
      const box = location as { search?: unknown; hash?: unknown };
      const query = String(box.search ?? '').replace(/^\?/, '');
      const fragment = String(box.hash ?? '').replace(/^#/, '');
      if (looksLikeVkParams(query)) return query;
      if (looksLikeVkParams(fragment)) return fragment;
    }
    return null;
  }


  /**
   * Войти. Один раз — и дальше ходить с токеном (`authorizationHeader`).
   *
   * Повтор при `EXPIRED_INIT_DATA` нужен потому, что мост вправе вернуть
   * закэшированную строку запуска: перезапрос после отказа — единственный способ
   * отличить «игрок принёс вчерашнюю initData» от «секрет на сервере не тот» без
   * участия оператора и без логов.
   */
  async signIn(): Promise<SignInResult> {
    const mode = await this.resolveMode();
    if (mode === 'disabled') {
      return this.failure('misconfigured', mode, null, 'Вход отключён: на сервере нет VK_APP_ID + VK_SECRET_KEY');
    }
    if (mode === 'dev') {
      return this.exchange(AUTH_PATHS.devLogin, { socialId: this.options.devSocialId ?? '1' }, mode);
    }

    let last = this.failure('unsupported', mode, null, 'WebView не передал initData');
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const initData = await this.initData();
      if (!initData) {
        return this.failure(
          'unsupported',
          mode,
          null,
          'WebView не передал initData — откройте приложение через клиент ВК'
        );
      }
      last = await this.exchange(AUTH_PATHS.vkInitData, { initData }, mode);
      if (last.ok || last.status !== 'expired') return last;
      this.log('initData устарела — перезапрашиваю у моста', { attempt });
    }
    return last;
  }

  /** Жива ли восстановленная сессия (один запрос к /v1/me). */
  async probe(): Promise<boolean> {
    if (!this.token) return false;
    try {
      await this.options.api.get(AUTH_PATHS.me);
      return true;
    } catch (error) {
      this.log('Сохранённая сессия не принята сервером', { error: this.text(error) });
      this.signOut();
      return false;
    }
  }

  /** Обмен параметров запуска на сессию. */
  private async exchange(
    path: string,
    body: Record<string, unknown>,
    mode: AuthMode
  ): Promise<SignInResult> {
    try {
      const response = await this.options.api.post<SessionEnvelope>(path, body);
      const token = typeof response?.token === 'string' ? response.token : null;
      if (!token) return this.failure('error', mode, null, 'Сервер вернул сессию без токена');
      this.token = token;
      this.storage.save(token);
      const userId = typeof response.user?.id === 'string' ? response.user.id : null;
      const referral = response.referral;
      return {
        ok: true,
        status: 'signed_in',
        mode,
        created: response.created === true,
        userId,
        code: null,
        ...(referral
          ? {
              referral: {
                ref: String(referral.ref ?? ''),
                source: String(referral.source ?? ''),
                bound: referral.bound === true,
                credited: referral.credited === true,
                reason: String(referral.reason ?? '')
              }
            }
          : {}),
        message: userId ?? undefined
      };
    } catch (error) {
      const code = codeOf(error);
      const message = this.text(error);
      this.log('Сервер отклонил вход', { path, code, error: message });
      if (code === 'EXPIRED_INIT_DATA') return this.failure('expired', mode, code, message);
      if (code === 'INVALID_INIT_DATA') return this.failure('refused', mode, code, message);
      if (code === 'VK_NOT_CONFIGURED') return this.failure('misconfigured', mode, code, message);
      return this.failure('error', mode, code, message);
    }
  }

  private failure(status: AuthStatus, mode: AuthMode, code: string | null, message: string): SignInResult {
    return { ok: false, status, mode, created: false, userId: null, code, message };
  }

  private log(message: string, payload?: Record<string, unknown>): void {
    this.options.logger?.(message, payload);
  }

  private text(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}

/**
 * Пример подмены транспорта в тестах (реальный vk-bridge не нужен):
 *
 *   const bridge = { invokeAsync: async () => ({ initData: 'vk_app_id=1&sign=abc' }) };
 *   const calls: Array<[string, unknown]> = [];
 *   const api = {
 *     get: async () => ({ auth: { mode: 'vk' } }),
 *     post: async (path: string, body: unknown) => {
 *       calls.push([path, body]);
 *       return { token: 'jwt', created: true, user: { id: 'u-1' } };
 *     }
 *   };
 *   const auth = new VkAuthManager(bridge, { api, storage: browserStorage('test') });
 *   const result = await auth.signIn();
 *   // result.status === 'signed_in' · calls[0][0] === '/v1/auth/vk/init-data'
 */
