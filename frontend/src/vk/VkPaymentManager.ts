/**
 * Оплата через ВКонтакте (Часть 1 ТЗ: паки Астерия за Голоса / VK Pay).
 *
 * ГЛАВНОЕ, ЧЕГО ЗДЕСЬ НЕТ: выдачи товара. `VKWebAppShowOrderBox` резолвится тогда,
 * когда пользователь ЗАКРЫЛ окно платежа. Это сигнал интерфейса, а не факт оплаты:
 * он ничего не доказывает площадке и легко подделывается тем, кто умеет открывать
 * DevTools в WebView. Поэтому клиент делает ровно три вещи:
 *
 *   1. просит у сервера заказ (`POST /v1/payments/orders`) — цену и SKU выбирает
 *      сервер, клиент не имеет права предлагать свою;
 *   2. показывает нативное окно площадки;
 *   3. сообщает серверу номер платежа из ответа bridge (`.../receipt`) — это только
 *      диагностика для поддержки, и товар оно НЕ выдаёт.
 *
 * Товар появляется у игрока, когда площадка пришлёт серверу подписанное подтверждение
 * (server-to-server), и фронт узнаёт об этом единственным честным способом: опросом
 * статуса заказа (`GET /v1/payments/orders`). Пока заказ не в `fulfilled`, интерфейс
 * обязан показывать «оплата обрабатывается», а не «купите ещё раз».
 *
 * ТРАНСПОРТ ИНЖЕКТИТСЯ, а не импортируется — тот же принцип, что у VkSocialManager:
 * `@vkontakte/vk-bridge` в этом монорепо нет, и тянуть рантайм-зависимость ради одного
 * вызова значит сделать фронт неотделимым от SDK площадки. Форму bridge задаёт
 * интерфейс `VkBridgeLike` (ровно тот же, что у `vkBridge` из пакета):
 *
 *     import vkBridge from '@vkontakte/vk-bridge';
 *     const payments = new VkPaymentManager(vkBridge, { api });
 *     const result = await payments.purchase('asterium_pack_500');
 *
 * ОТКАЗ ДЕГРАДИРУЕТ, А НЕ ПАДАЕТ. Окно оплаты может не поддерживаться (браузер на
 * десктопе, старая версия клиента ВК), пользователь может отменить платёж, сеть может
 * моргнуть. Каждый случай возвращается отдельным `status`, а не исключением: UI рисует
 * по ним разные тексты, и «отменил» не должно выглядеть как «ошибка платежа».
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

export interface VkPaymentOptions {
  api: GameApiLike;
  /** true — тестовый режим площадки (не списывает реальные Голоса). Только для отладки. */
  testPaymentMode?: boolean;
  /** Сюда ложатся отказы bridge: тихая деградация не должна означать потерю диагностики. */
  logger?: (message: string, payload?: Record<string, unknown>) => void;
  /** Путь маршрута заказов. По умолчанию — как в серверном HTTP-слое. */
  basePath?: string;
}

/** Параметры окна оплаты, которые выбрал СЕРВЕР (клиент их не конструирует). */
export interface OrderQuote {
  orderId: string;
  sku: string;
  box: { type: 'votes' | 'item'; item: string | null };
  priceRub: number;
  /** true — заказ уже был создан ранее (ретрай), новый не создавался. */
  resumed: boolean;
}

/** Статус заказа из серверной витрины: единственная истина о том, выдан ли товар. */
export interface OrderState {
  id: string;
  sku: string;
  status: 'pending' | 'paid' | 'fulfilled' | 'void' | 'refunded';
  amount: number;
}

export type PurchaseStatus = 'submitted' | 'cancelled' | 'unsupported' | 'error' | 'quote_failed';

/** Итог попытки оплаты. ВАЖНО: `submitted` — это «окно закрыто», а не «товар выдан». */
export interface PurchaseOutcome {
  ok: boolean;
  status: PurchaseStatus;
  orderId: string | null;
  /** order_id площадки из ответа bridge — для сверки и тикетов поддержки. */
  providerOrderId: string | null;
  message?: string;
}

/** Распознавание отмены: bridge бросает объект с именем UserCanceledError. */
export function isCancellation(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  const text = error instanceof Error ? error.message : String(error ?? '');
  return /canceled|cancelled|abort/i.test(`${name} ${text}`);
}


export class VkPaymentManager {
  constructor(
    private readonly bridge: VkBridgeLike,
    private readonly options: VkPaymentOptions
  ) {}

  private get basePath(): string {
    return this.options.basePath ?? '/v1/payments/orders';
  }

  /** Шаг 1: сервер создаёт заказ и говорит, какими параметрами открывать окно оплаты. */
  async quote(sku: string): Promise<OrderQuote | null> {
    try {
      return await this.options.api.post<OrderQuote>(this.basePath, { sku });
    } catch (error) {
      this.log('Сервер отклонил запрос заказа', { sku, error: this.text(error) });
      return null;
    }
  }

  /**
   * Полный флоу: заказ → окно ВК → квитанция. Товар не выдаёт ни на одном шаге.
   * У каждого `status` обязан свой текст в UI — особенно у `submitted`.
   */
  async purchase(sku: string): Promise<PurchaseOutcome> {
    const quote = await this.quote(sku);
    if (!quote || !quote.orderId) {
      return { ok: false, status: 'quote_failed', orderId: null, providerOrderId: null, message: 'Заказ не создан' };
    }

    let providerOrderId: string | null = null;
    try {
      const raw = await this.bridge.send<Record<string, unknown>>('VKWebAppShowOrderBox', {
        type: quote.box.type,
        // Для type='votes' площадка игнорирует item: Голоса — единая валюта, а не SKU.
        ...(quote.box.type === 'item' && quote.box.item ? { item: quote.box.item } : {}),
        ...(this.options.testPaymentMode ? { test_payment_mode: true } : {})
      });
      const id = raw?.order_id ?? raw?.orderId;
      providerOrderId = id === undefined || id === null ? null : String(id);
    } catch (error) {
      const text = this.text(error);
      if (isCancellation(error)) {
        return { ok: false, status: 'cancelled', orderId: quote.orderId, providerOrderId: null, message: text };
      }
      // Метод не поддержан контейнером: игрок всё равно может оплатить через витрину ВК.
      this.log('VKWebAppShowOrderBox недоступен', { error: text, sku });
      return { ok: false, status: 'unsupported', orderId: quote.orderId, providerOrderId: null, message: text };
    }

    // Квитанция — только диагностика: настоящая выдача идёт по подтверждению площадки.
    try {
      await this.options.api.post(`${this.basePath}/${encodeURIComponent(quote.orderId)}/receipt`, {
        providerOrderId
      });
    } catch (error) {
      this.log('Квитанция не принята сервером (товар придёт по подтверждению площадки)', {
        orderId: quote.orderId,
        error: this.text(error)
      });
    }

    return { ok: true, status: 'submitted', orderId: quote.orderId, providerOrderId };
  }

  /** Статус заказа: UI опрашивает его после `submitted`, пока не появится `fulfilled`. */
  async orderState(orderId: string): Promise<OrderState | null> {
    try {
      return await this.options.api.get<OrderState>(`${this.basePath}/${encodeURIComponent(orderId)}`);
    } catch (error) {
      this.log('Не удалось прочитать статус заказа', { orderId, error: this.text(error) });
      return null;
    }
  }

  /** Опрос до выдачи или до истечения окна: не более `attempts` запросов подряд. */
  async waitForFulfilment(orderId: string, attempts = 5, delayMs = 2000): Promise<OrderState | null> {
    for (let i = 0; i < Math.max(1, attempts); i += 1) {
      const state = await this.orderState(orderId);
      if (state && state.status !== 'pending' && state.status !== 'paid') return state;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return this.orderState(orderId);
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
 *   const bridge = { send: async (m: string, p?: unknown) => { calls.push([m, p]); return { order_id: 77 }; } };
 *   const api = { post: async () => ({ orderId: 'order:u1:1', sku: 'asterium_pack_500', box: { type: 'item', item: 'asterium_pack_500' }, priceRub: 49, resumed: false }), get: async () => null };
 *   const payments = new VkPaymentManager(bridge, { api });
 *   const result = await payments.purchase('asterium_pack_500');
 *   // result.status === 'submitted', result.providerOrderId === '77', calls[0][0] === 'VKWebAppShowOrderBox'
 */
