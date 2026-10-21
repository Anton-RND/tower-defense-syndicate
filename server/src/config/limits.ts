/**
 * Лимиты монетизации и виральных механик.
 *
 * Они вынесены отдельно от правил баланса (EconomyConfig): значения меняют не ради
 * экономики игры, а ради антифрода и требований площадки, и часто «горячо».
 * Хранится внутри EconomyConfig.limits, чтобы сигнатуры чистых функций тиков не распухали.
 */

/** «Помощь друга» (п.2.3) — виральный канал восстановления энергии. */
export interface AssistLimits {
  /** Сколько ассистов игрок может принять за сутки UTC. 0 — лимит отключён. */
  dailyLimit: number;
  /** % капа энергии, который даёт один ассист. */
  percent: number;
  /** Сколько helper-ов помним в документе (анти-чит «один друг — один раз»). */
  helpersHistory: number;
}

/** Rewarded-реклама: награда только за подтверждённый сервером показ. */
export interface AdLimits {
  /** Общий выключатель (монетизация в кабинете VK ещё не подключена → false). */
  enabled: boolean;
  /** Максимум наград за рекламу в сутки UTC. */
  dailyRewards: number;
  /** Пауза между наградами, мс — против «фарма подряд». */
  minIntervalMs: number;
  /** Сколько живёт незакрытая сессия показа: postback не пришёл — сессия сгорела. */
  sessionTtlMs: number;
  /** Сколько сессий может висеть одновременно (держим 1 — дешевле антифрод). */
  pendingSessions: number;
  /**
   * Как долго помним исполненные `reward_id` площадки, мс (анти-реплей постбэка).
   *
   * Повторная доставка того же постбэка — штатное поведение рекламных сетей, а
   * слот показа после выдачи пуст: без памяти повтор оплачивал бы СЛЕДУЮЩИЙ показ
   * игрока. Записи старше этого окна выбрасываются из документа, поэтому окно
   * служит и потолком размера, и глубиной защиты — реплей спустя месяц отбивается
   * уже не им, а TTL сессии и суточными лимитами.
   */
  replayWindowMs: number;
}

/** Внутриигровые покупки (Шаг 2: VK Pay / витрина; Часть 1: VKWebAppShowOrderBox). */
export interface PurchaseLimits {
  /**
   * Общий выключатель (как у ads). Площадка ещё не настроена → false, и любой
   * маршрут заказа отвечает PAYMENTS_NOT_CONFIGURED: дешевле отказать честно, чем
   * принять деньги и не суметь выдать товар.
   */
  enabled: boolean;
  /** Сколько раз в сутки можно купить один SKU. 0 — без ограничения. */
  dailyPerSku: number;
  /** Потолок активных entitlement'ов в документе игрока (размер документа != ∞). */
  maxActiveEntitlements: number;
  /** Окно приёма возврата платежа, дни. */
  refundWindowDays: number;
  /** Сколько живёт неподтверждённый заказ: площадка не подтвердила — заказ сгорел. */
  orderTtlMs: number;
  /** Сколько закрытых заказов помним в документе игрока (анти-дубль + тикеты поддержки). */
  orderHistory: number;
}

/**
 * Кланы (Часть 2). Стоимость основания и потолок участников — балансные решения,
 * они живут в config/clans.ts; здесь только антифрод-потолки и окно подтверждения:
 * взнос в казну пишется в два документа, и срок жизни неподтверждённого вклада —
 * вопрос надёжности записи, а не экономики.
 */
export interface ClanLimits {
  /** Сколько взносов в сутки UTC может сдать один игрок. 0 — без ограничения. */
  dailyDeposits: number;
  /** Сколько единиц металлов в сутки UTC может сдать один игрок. 0 — без ограничения. */
  dailyUnits: number;
  /** Сколько живёт вклад в статусе pending, мс, пока журнал не подтвердит списание. */
  pendingTtlMs: number;
  /** Сколько вкладов помним в документе клана (кроме pending — их не выбрасываем). */
  history: number;
}

/**
 * Боевой лут (хлам после PvP). Единственный канал, где игрок получает ценности
 * по результату боя, а значит — единственный, где клиент что-то «сообщает».
 * Оба потолка существуют до тех пор, пока Шаг 4 не начнёт считать разрушения сам.
 */
export interface LootLimits {
  /** Сколько боёв с выдачей лута засчитывается игроку за сутки UTC. 0 — без ограничения. */
  dailyEvents: number;
  /** Потолок суммарного хлама на складе: толкает игрока в цех переработки и ограничивает сток. */
  junkCap: number;
}

/**
 * PvP-рейды (Шаг 4). Единственный антифрод-потолок, которого нет в балансе:
 * энергия уже ограничивает число атак по природе (регеном), но её можно докупить
 * и «помощью друга», а суточный потолок атак держит бота, гоняющего рейды за лутом.
 */
export interface PvpLimits {
  /** Сколько атак в сутки UTC засчитывается игроку. 0 — без ограничения (энергия решает). */
  dailyAttacks: number;
}

/**
 * «Пригласи друга» (п.2.3). Здесь — только суточный потолок и размер истории:
 * сами награды (энергия, астериев) живут волей balancing-решения в modules/social,
 * а не в окружении. Причина та же, что у цен строителей в workshop.ts: награду за
 * приглашение правят ради экономики, и правка обязана идти через ревью в PR, а не
 * через .env на проде.
 */
export interface ReferralLimits {
  /** Сколько приглашений в сутки UTC засчитывается одному игроку. 0 — лимит отключён. */
  dailyMax: number;
  /** Сколько приглашённых помним в документе (анти-чит: один человек — одна награда). */
  history: number;
}

export interface LimitsConfig {
  assist: AssistLimits;
  ads: AdLimits;
  purchases: PurchaseLimits;
  clan: ClanLimits;
  loot: LootLimits;
  pvp: PvpLimits;
  referral: ReferralLimits;
}

export const DEFAULT_LIMITS: LimitsConfig = {
  assist: { dailyLimit: 10, percent: 25, helpersHistory: 100 },
  ads: {
    enabled: false,
    dailyRewards: 6,
    minIntervalMs: 120_000,
    sessionTtlMs: 180_000,
    pendingSessions: 1,
    replayWindowMs: 24 * 3_600_000
  },
  purchases: {
    enabled: false,
    dailyPerSku: 0,
    maxActiveEntitlements: 50,
    refundWindowDays: 14,
    orderTtlMs: 15 * 60_000,
    orderHistory: 20
  },
  clan: { dailyDeposits: 20, dailyUnits: 100_000, pendingTtlMs: 10 * 60_000, history: 200 },
  loot: { dailyEvents: 50, junkCap: 20_000 },
  pvp: { dailyAttacks: 30 },
  referral: { dailyMax: 20, history: 100 }
};

/** Слияние значений из окружения с дефолтами (числа уже распарсены в env.ts). */
export function buildLimits(input: {
  assistDailyLimit: number;
  assistPercent: number;
  adsEnabled: boolean;
  adsDailyRewards: number;
  adsMinIntervalSec: number;
  adsSessionTtlSec: number;
  adsReplayWindowSec: number;
  paymentsEnabled: boolean;
  purchaseDailyPerSku: number;
  maxActiveEntitlements: number;
  refundWindowDays: number;
  orderTtlSec: number;
  purchaseHistory: number;
  clanDailyDeposits: number;
  clanDailyUnits: number;
  clanPendingTtlSec: number;
  lootDailyEvents: number;
  junkCap: number;
  pvpDailyAttacks: number;
  referralDailyMax: number;
}): LimitsConfig {
  return {
    assist: {
      dailyLimit: input.assistDailyLimit,
      percent: input.assistPercent,
      helpersHistory: DEFAULT_LIMITS.assist.helpersHistory
    },
    ads: {
      enabled: input.adsEnabled,
      dailyRewards: input.adsDailyRewards,
      minIntervalMs: input.adsMinIntervalSec * 1000,
      sessionTtlMs: input.adsSessionTtlSec * 1000,
      pendingSessions: DEFAULT_LIMITS.ads.pendingSessions,
      replayWindowMs: input.adsReplayWindowSec * 1000
    },
    purchases: {
      enabled: input.paymentsEnabled,
      dailyPerSku: input.purchaseDailyPerSku,
      maxActiveEntitlements: input.maxActiveEntitlements,
      refundWindowDays: input.refundWindowDays,
      orderTtlMs: input.orderTtlSec * 1000,
      orderHistory: input.purchaseHistory
    },
    clan: {
      dailyDeposits: input.clanDailyDeposits,
      dailyUnits: input.clanDailyUnits,
      pendingTtlMs: input.clanPendingTtlSec * 1000,
      history: DEFAULT_LIMITS.clan.history
    },
    loot: {
      dailyEvents: input.lootDailyEvents,
      junkCap: input.junkCap
    },
    pvp: {
      dailyAttacks: input.pvpDailyAttacks
    },
    referral: {
      dailyMax: input.referralDailyMax,
      history: DEFAULT_LIMITS.referral.history
    }
  };
}