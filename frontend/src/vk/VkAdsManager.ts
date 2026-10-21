/**
 * Rewarded-реклама ВКонтакте (Часть 1.5 ТЗ: «награда за просмотр ролика»).
 *
 * ГЛАВНОЕ, ЧЕГО ЗДЕСЬ НЕТ: выдачи награды. Резолв `VKWebAppShowNativeAds`
 * означает, что ЗАКРЫЛОСЬ окно ролика, — это сигнал интерфейса, а не факт
 * показа: подделать его из консоли WebView так же легко, как резолв
 * `VKWebAppShowOrderBox` в платежах, и по нему нельзя выдавать энергию. Награду
 * выдаёт ТОЛЬКО сервер — по подписанному постбэку рекламной сети
 * (`/callbacks/vk/ads`, см. http/routes/adsPostbackRoutes.ts). Клиенту известны
 * ровно два факта: открылся ли слот показа и вырос ли `economy.ads.claimedToday`.
 * Поэтому `watch` возвращает `granted: false` даже при успешном досмотре:
 * постбэк асинхронен, и UI обязан показать «награда придёт сию минуту», а не
 * «ошибка».
 *
 * ПОЧЕМУ СЕССИЯ ОТКРЫВАЕТСЯ НА СЕРВЕРЕ ДО ПРОСМОТРА, А НЕ ПОСЛЕ. Мост площадки
 * не умеет принимать наш идентификатор показа: в `@vkontakte/vk-bridge@3.0.2`
 * (packages/core/src/types/data.ts)
 *
 *     export type EAdsFormats = 'reward' | 'interstitial';
 *     export type ShowNativeAdsRequest = { ad_format: EAdsFormats; use_waterfall?: boolean };
 *     VKWebAppShowNativeAds:  { result: true };    // ответ моста
 *     VKWebAppCheckNativeAds: { result: boolean };
 *
 * своего поля под id награды нет вовсе. Значит постбэк привязывается к ИГРОКУ, а
 * не к номеру показа, и серверу нужно заранее знать, какой SKU игрок выбрал:
 * слот `ads.pending` открывается запросом `/v1/ads/session` ДО ролика и
 * закрывается постбэком. Обязанность клиента — освободить слот, если показа не
 * случилось (`/v1/ads/abandon`), иначе игрок упрётся в «Показ уже открыт».
 *
 * ТРАНСПОРТ ИНЖЕКТИТСЯ, а не импортируется — тот же принцип, что у
 * VkPaymentManager и VkSocialManager: `@vkontakte/vk-bridge` в package.json
 * этого монорепо нет, и рантайм-зависимость ради двух вызовов отделила бы фронт
 * от SDK площадки. Пути — ЛИТЕРАЛЬНЫЕ константы, а не склейка из `basePath`:
 * контрактный тест (server/test/http.frontend-contract.test.ts) сверяет с
 * маршрутами сервера ровно строковые литералы, и префикс, собранный в рантайме,
 * ушёл бы от проверки — тот же класс ошибки, из-за которого платежи когда-то
 * стучались в несуществующий `/v1/payments/orders`.
 *
 *     import vkBridge from '@vkontakte/vk-bridge';
 *     const ads = new VkAdsManager(vkBridge, { api });
 *     const result = await ads.watch('ad_energy_25');
 *     // result.status === 'completed' · result.granted — награда уже пришла
 */

/** Минимальная форма vkBridge: один метод send с произвольным payload. */
export interface VkBridgeLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

/** Узкий интерфейс к серверу игры (в приложении — обёртка над fetch с JWT в заголовке). */
export interface GameApiLike {
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  get<T = unknown>(path: string): Promise<T>;
}

/** Литеральные пути рекламного блока сервера (см. шапку файла про контрактный тест). */
export const ADS_PATHS = {
  offers: '/v1/ads/offers',
  session: '/v1/ads/session',
  abandon: '/v1/ads/abandon'
} as const;

export interface VkAdsOptions {
  api: GameApiLike;
  /** Сюда ложатся отказы bridge и сервера: тихая деградация не должна терять диагностику. */
  logger?: (message: string, payload?: Record<string, unknown>) => void;
  /** Сколько раз спросить сервер о награде после досмотра и с каким шагом. */
  poll?: { attempts?: number; delayMs?: number };
}

/** Позиция витрины: sku и label приходят с сервера, состав награды клиент не читает. */
export interface AdOffer {
  sku: string;
  label: string;
}

/** Срез economy.ads из серверного вью (даты — ISO-строками). */
export interface AdsState {
  enabled: boolean;
  claimedToday: number;
  /** 0 или меньше — лимит отключён. */
  dailyLimit: number;
  remainingToday: number;
  minIntervalMs: number;
  /** Когда можно снова; null — прямо сейчас. */
  nextAvailableAt: string | null;
  pendingSessionId: string | null;
  pendingExpiresAt: string | null;
}

/**
 * Итог попытки посмотреть ролик. Каждый отказ — отдельный статус, потому что
 * тексты в UI у них разные: «отменил» не должно звучать как «ошибка рекламы».
 */
export type AdWatchStatus =
  /** Ролик досмотрен. Награда может ещё быть в пути — смотри `granted`. */
  | 'completed'
  /** Игрок закрыл окно сам. */
  | 'cancelled'
  /** Площадка не дала реклам (нет инвентаря, гео, блокировщик). */
  | 'unavailable'
  /** Контейнер не знает метода bridge: десктоп или старый клиент ВК. */
  | 'unsupported'
  /** Суточный лимит/интервал: сервер сам сказал «рано», ролик не показываем. */
  | 'too_soon'
  /** Сервер не открыл слот (реклама выключена, уже есть открытый показ, нет прав). */
  | 'rejected'
  /** Всё остальное: сеть, 5xx, неожиданная форма ответа. */
  | 'error';

export interface AdWatchResult {
  /** true только при `status === 'completed'`. */
  ok: boolean;
  status: AdWatchStatus;
  sku: string;
  /** Id открытого слота; null — слот не открылся. */
  sessionId: string | null;
  /** true — сервер подтвердил выдачу до конца окна опроса. */
  granted: boolean;
  /** Последний прочитанный economy.ads (null — прочитать не удалось). */
  state: AdsState | null;
  message?: string;
}

/** Форма ответов сервера: только те поля, которые этот клиент читает. */
interface AdsEnvelope {
  economy?: { ads?: AdsState };
  result?: { session?: { id?: string } };
  offers?: Array<{ sku?: unknown; label?: unknown }>;
}


export class VkAdsManager {
  constructor(
    private readonly bridge: VkBridgeLike,
    private readonly options: VkAdsOptions
  ) {}

  /** Витрина наград. Каталог выбирает сервер — клиент не предлагает свой SKU. */
  async offers(): Promise<AdOffer[]> {
    try {
      const response = await this.options.api.get<AdsEnvelope>(ADS_PATHS.offers);
      const offers = Array.isArray(response?.offers) ? response.offers : [];
      return offers
        .filter(
          (offer): offer is { sku: string; label: string } =>
            typeof offer?.sku === 'string' && typeof offer?.label === 'string'
        )
        .map((offer) => ({ sku: offer.sku, label: offer.label }));
    } catch (error) {
      this.log('Не удалось получить витрину рекламных наград', { error: this.text(error) });
      return [];
    }
  }

  /** Состояние рекламного крана: лимиты, открытый слот, когда можно снова. */
  async state(): Promise<AdsState | null> {
    try {
      const response = await this.options.api.get<AdsEnvelope>(ADS_PATHS.offers);
      const ads = response?.economy?.ads ?? null;
      if (!ads) this.log('Сервер вернул вью без economy.ads');
      return ads;
    } catch (error) {
      this.log('Не удалось прочитать состояние рекламы', { error: this.text(error) });
      return null;
    }
  }

  /**
   * Полный цикл: слот → ролик → опрос награды.
   *
   * Порядок именно такой, а не «сначала ролик, потом сессия»: сервер обязан
   * зафиксировать SKU ДО показа, иначе постбэк, пришедший без индекса, будет не
   * к чему привязать.
   */
  async watch(sku: string): Promise<AdWatchResult> {
    const before = await this.state();
    if (before && !before.enabled) {
      return this.refuse('rejected', sku, null, before, 'Реклама выключена на сервере');
    }
    if (before && !this.isAvailableNow(before)) {
      return this.refuse('too_soon', sku, null, before, 'Следующая награда ещё не доступна');
    }
    const baseline = before?.claimedToday ?? 0;

    let sessionId: string | null = null;
    let opened: AdsState | null = before;
    try {
      const response = await this.options.api.post<AdsEnvelope>(ADS_PATHS.session, { sku });
      sessionId =
        typeof response?.result?.session?.id === 'string' ? response.result.session.id : null;
      opened = response?.economy?.ads ?? before;
    } catch (error) {
      const message = this.text(error);
      this.log('Сервер не открыл слот показа', { sku, error: message });
      return this.refuse('rejected', sku, null, before, message);
    }
    if (!sessionId) {
      this.log('Сервер вернул слот без id', { sku });
      return this.refuse('rejected', sku, null, opened, 'Слот показа не создан');
    }

    // «Есть ли что показывать» спрашиваем до ролика: отказ до открытия окна
    // честнее, чем пустое окно после занятого слота.
    const available = await this.checkAvailable();
    if (available === false) {
      await this.abandon(sessionId);
      return this.refuse(
        'unavailable',
        sku,
        sessionId,
        await this.state(),
        'Площадка не дала реклам'
      );
    }

    try {
      await this.bridge.send('VKWebAppShowNativeAds', { ad_format: 'reward' });
    } catch (error) {
      const message = this.text(error);
      // Показа не было → слот обязан освободиться, иначе кнопка умрёт до TTL.
      await this.abandon(sessionId);
      this.log('Показ ролика не состоялся', { sku, sessionId, error: message });
      const state = await this.state();
      if (/cancel|abort|clos/i.test(message)) {
        return this.refuse('cancelled', sku, sessionId, state, message);
      }
      if (/support|unknown method|not implemented/i.test(message)) {
        return this.refuse('unsupported', sku, sessionId, state, message);
      }
      return this.refuse('error', sku, sessionId, state, message);
    }

    // Резолв моста — ещё не награда. Спрашиваем сервер, успел ли прийти постбэк.
    const attempts = Math.max(1, this.options.poll?.attempts ?? 4);
    const delayMs = Math.max(0, this.options.poll?.delayMs ?? 1500);
    const state = await this.waitForReward(baseline, attempts, delayMs);
    const granted = (state?.claimedToday ?? baseline) > baseline;
    if (!granted) {
      this.log('Ролик досмотрен, награды в окне опроса нет — ждём постбэк', { sku, sessionId });
    }
    return { ok: true, status: 'completed', sku, sessionId, granted, state };
  }

  /** Освободить слот, если показа не было. Ошибка не бросается: слот сгорит по TTL. */
  async abandon(sessionId: string): Promise<void> {
    try {
      await this.options.api.post(ADS_PATHS.abandon, { sessionId });
    } catch (error) {
      this.log('Слот не освобождён вручную (сгорит по TTL)', {
        sessionId,
        error: this.text(error)
      });
    }
  }

  /** true/false — ответ площадки; null — мост не ответил вразумительно (не блокируем). */
  private async checkAvailable(): Promise<boolean | null> {
    try {
      const raw = await this.bridge.send<{ result?: unknown }>('VKWebAppCheckNativeAds', {
        ad_format: 'reward'
      });
      return typeof raw?.result === 'boolean' ? raw.result : null;
    } catch (error) {
      this.log('VKWebAppCheckNativeAds недоступен', { error: this.text(error) });
      return null;
    }
  }

  /** Опрос до награды или до конца окна: не более `attempts` запросов подряд. */
  private async waitForReward(
    baseline: number,
    attempts: number,
    delayMs: number
  ): Promise<AdsState | null> {
    let last: AdsState | null = null;
    for (let i = 0; i < attempts; i += 1) {
      last = await this.state();
      if (last && last.claimedToday > baseline) return last;
      if (i + 1 < attempts && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return last;
  }

  /** `nextAvailableAt` в будущем — награда ещё не положена (межнаградовый интервал). */
  private isAvailableNow(state: AdsState): boolean {
    if (!state.nextAvailableAt) return true;
    const until = Date.parse(state.nextAvailableAt);
    if (Number.isNaN(until)) return true;
    return until <= Date.now();
  }

  private refuse(
    status: AdWatchStatus,
    sku: string,
    sessionId: string | null,
    state: AdsState | null,
    message: string
  ): AdWatchResult {
    return { ok: false, status, sku, sessionId, granted: false, state, message };
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
 *   const calls: Array<[string, unknown]> = [];
 *   const bridge = { send: async (m: string, p?: unknown) => { calls.push([m, p]); return { result: true }; } };
 *   const adsState = { enabled: true, claimedToday: 0, dailyLimit: 6, remainingToday: 6, minIntervalMs: 120000, nextAvailableAt: null, pendingSessionId: null, pendingExpiresAt: null };
 *   const api = {
 *     // Первый ответ — «ещё не выдано», второй — «постбэк пришёл».
 *     get: async () => ({ economy: { ads: { ...adsState, claimedToday: api.claimed } }, offers: [{ sku: 'ad_energy_25', label: '25 энергии' }] }),
 *     post: async () => ({ economy: { ads: { ...adsState, pendingSessionId: 's-1' } }, result: { session: { id: 's-1' } } }),
 *     claimed: 0
 *   };
 *   setTimeout(() => { api.claimed = 1; }, 0);
 *   const ads = new VkAdsManager(bridge, { api, poll: { attempts: 3, delayMs: 0 } });
 *   const result = await ads.watch('ad_energy_25');
 *   // result.status === 'completed', result.granted === true,
 *   // calls[0][0] === 'VKWebAppCheckNativeAds', calls[1][0] === 'VKWebAppShowNativeAds'
 */
