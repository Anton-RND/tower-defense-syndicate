/**
 * Интеграция с ВКонтакте (Часть 2 ТЗ: «Попросить энергию», приглашения, рефералы).
 *
 * ЧТО ЗДЕСЬ КЛИЕНТСКОЕ, А ЧТО СЕРВЕРНОЕ — и почему важно не путать.
 *
 *  Клиент решает одно: показать нативное окно ВК и отдать ссылку другу. Всё
 *  остальное — начисление энергии, зачёт приглашения, суточные лимиты, антифрод —
 *  живёт на сервере (modules/social/referral.ts, modules/economy/energy.ts).
 *  Клиент, «знающий», что он поделился, ничего не доказывает: подделать WebView
 *  дешевле, чем написать бота. Поэтому здесь нет ни одного начисления — только
 *  «показать окно» и «собрать ссылку».
 *
 * ТРАНСПОРТ ИНЖЕКТИТСЯ, а не импортируется.
 *  `@vkontakte/vk-bridge` в package.json этого монорепо нет, и тянуть рантайм-
 *  зависимость ради четырёх вызовов — значит сделать фронт неотделимым от VK SDK.
 *  Вместо этого модуль принимает объект с одним методом `send` — ровно той формы,
 *  которую имеет `vkBridge` из пакета:
 *
 *      import vkBridge from '@vkontakte/vk-bridge';
 *      const social = new VkSocialManager(vkBridge, { appId: 1234567, api });
 *
 *  Побочный эффект приятный: модуль тестируется в node без WebView — достаточно
 *  подменить `send` на spy (пример в конце файла).
 *
 * НАЗВАНИЯ МЕТОДОВ BRIDGE. `VKWebAppInit`, `VKWebAppShare`, `VKWebAppShowInviteBox`
 * и `VKWebAppGetUserInfo` соответствуют публичному API VK Mini Apps, но офлайн
 * сверить их сигнатуры было нельзя: пакета bridge в репозитории нет. Поэтому каждый
 * вызов обёрнут в try/catch и возвращает результат-объект, а не бросает наружу:
 * если клиент не знает метода, игра деградирует до обычной ссылки шеринга, а не
 * падает на кнопке «Попросить энергию». Это единственный честный вариант для кода,
 * который нельзя прогнать против реальной площадки отсюда.
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

export interface VkSocialOptions {
  /** App ID мини-приложения: из него собирается каноническая ссылка vk.com/app<id>. */
  appId: number;
  /** Переопределение ссылки (например, домен таппа). По умолчанию — vk.com/app<appId>. */
  appUrl?: string;
  api?: GameApiLike;
  /** Сюда ложатся отказы bridge: тихая деградация не должна означать потерю диагностики. */
  logger?: (message: string, payload?: Record<string, unknown>) => void;
}

/** Результат шеринга: различаем «отправил», «отменил» и «площадка не поддержала». */
export interface ShareResult {
  ok: boolean;
  status: 'shared' | 'cancelled' | 'unsupported' | 'error';
  link: string;
  message?: string;
}

export interface VkUserInfo {
  id: number;
  firstName?: string;
  lastName?: string;
  photo?: string;
}

/** Префикс реферальной метки — зеркалит серверный REFERRAL_PREFIX. */
export const REFERRAL_PREFIX = 'inv_';

export class VkSocialManager {
  private initialized = false;

  constructor(
    private readonly bridge: VkBridgeLike,
    private readonly options: VkSocialOptions
  ) {}

  /**
   * VKWebAppInit обязателен перед любым другим вызовом bridge: без него площадка
   * не считает приложение запущенным в своём контейнере, и шеринг возвращает ошибку
   * вместо окна. Вызывается один раз при старте игры.
   */
  async initGame(): Promise<boolean> {
    if (this.initialized) return true;
    try {
      await this.bridge.send('VKWebAppInit');
      this.initialized = true;
      this.log('VK Bridge запущен');
      return true;
    } catch (error) {
      this.log('Ошибка инициализации VK Bridge', { error: this.text(error) });
      return false;
    }
  }

  /**
   * Реферальная ссылка друга.
   *
   * `ref` уходит в хэш, а не в query: ВК перезапускает мини-апп с параметрами
   * запуска, и сервер при авторизации читает его из подписанных initData
   * (verifyVkInitData → identity.meta.ref). Внутренний id аккаунта, а не VK id:
   * ссылка не раздаёт персональные данные и не поддаётся перебору чужих профилей.
   */
  referralLink(userId: string, fragment = ''): string {
    const base = this.options.appUrl ?? `https://vk.com/app${this.options.appId}`;
    const ref = `${REFERRAL_PREFIX}${userId}`;
    const hash = fragment ? `${ref}/${fragment}` : ref;
    return `${base}#${hash}`;
  }

  /**
   * «Попросить энергию у друга» (п.2.3): нативное окно выбора контактов ВК.
   *
   * Награда приходит НЕ за факт отправки, а когда друг откроет приложение по ссылке
   * и сервер привяжет его к пригласившему (modules/social/referral.ts). Клиент,
   * сообщающий «я поделился» и получающий энергию, — дыра: один fetch в цикле
   * превращает виральный канал в ферму. Поэтому здесь только шеринг.
   */
  async requestEnergyFromFriends(userId: string): Promise<ShareResult> {
    const link = this.referralLink(userId, 'energy');
    return this.share(link, {
      title: 'Tower Defense Syndicate',
      message: 'Я держу осаду в Tower Defense Syndicate: у штаба кончилась энергия. Закинь батарейку — и строй свой лабиринт.',
      description: 'Асинхронный PvP tower defense: строй лабиринт, майни SEC, ходи в рейды.'
    });
  }

  /**
   * Окно приглашений: ВК сам показывает друзей, которых ещё нет в игре.
   *
   * `VKWebAppShowInviteBox` поддержан не всеми клиентами, поэтому при отказе
   * возвращаем статус 'unsupported', а не падаем: кнопка «Пригласить друзей» не
   * должна зависеть от версии приложения ВК на телефоне игрока. Вызовивший слой на
   * 'unsupported' показывает обычный шеринг со ссылкой.
   */
  async inviteNewFriends(userId: string): Promise<ShareResult> {
    if (!this.initialized) await this.initGame();
    try {
      await this.bridge.send('VKWebAppShowInviteBox', { inviteTypes: ['user'] });
      return { ok: true, status: 'shared', link: this.referralLink(userId, 'invite') };
    } catch (error) {
      const text = this.text(error);
      this.log('VKWebAppShowInviteBox недоступен', { error: text });
      if (/cancel|abort/i.test(text)) return { ok: false, status: 'cancelled', link: '', message: text };
      return { ok: false, status: 'unsupported', link: this.referralLink(userId, 'invite'), message: text };
    }
  }

  /** Профиль вошедшего: нужен для отладки и для «привет, Имя» — не для начислений. */
  async getUserInfo(): Promise<VkUserInfo | null> {
    try {
      const raw = await this.bridge.send<Record<string, unknown>>('VKWebAppGetUserInfo');
      const id = Number(raw?.id ?? 0);
      if (!Number.isFinite(id) || id <= 0) return null;
      return {
        id,
        firstName: typeof raw?.first_name === 'string' ? raw.first_name : undefined,
        lastName: typeof raw?.last_name === 'string' ? raw.last_name : undefined,
        photo: typeof raw?.photo_100 === 'string' ? raw.photo_100 : undefined
      };
    } catch (error) {
      this.log('VKWebAppGetUserInfo недоступен', { error: this.text(error) });
      return null;
    }
  }

  /** Общий шеринг с заголовком и описанием (итог рейда, победный скриншот и т.п.). */
  async share(
    link: string,
    content: { title?: string; message?: string; description?: string; image?: string }
  ): Promise<ShareResult> {
    if (!this.initialized) await this.initGame();
    try {
      await this.bridge.send('VKWebAppShare', { link, ...content });
      return { ok: true, status: 'shared', link };
    } catch (error) {
      const text = this.text(error);
      // Отмена пользователем — штатная ситуация, а не ошибка: не пишем её в лог ошибок.
      if (/cancel|abort/i.test(text)) return { ok: false, status: 'cancelled', link, message: text };
      this.log('VKWebAppShare отклонён', { error: text, link });
      return { ok: false, status: 'error', link, message: text };
    }
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
 * Чтение реферальной метки из параметров запуска.
 *
 * Сервер проверяет `ref` строже — он берётся из подписанных initData, а не из URL,
 * который клиент мог бы подправить. Этот хелпер нужен только чтобы показать
 * «вы пришли по приглашению» до первого запроса к API.
 */
export function readReferralFragment(hash: string = ''): string | null {
  const raw = String(hash).replace(/^#/, '').trim();
  if (!raw) return null;
  const first = raw.split(/[/?&]/)[0] ?? '';
  if (!first.startsWith(REFERRAL_PREFIX)) return null;
  const id = first.slice(REFERRAL_PREFIX.length);
  return id.length >= 6 ? id : null;
}

/**
 * Пример подмены транспорта в тестах (реальный vk-bridge не нужен):
 *
 *   const calls: Array<[string, unknown]> = [];
 *   const bridge = { send: async (m: string, p?: unknown) => { calls.push([m, p]); return {}; } };
 *   const social = new VkSocialManager(bridge, { appId: 1234567 });
 *   await social.requestEnergyFromFriends('u-1');
 *   // calls[0] === ['VKWebAppInit', undefined], calls[1][0] === 'VKWebAppShare'
 */