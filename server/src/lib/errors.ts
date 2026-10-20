/**
 * Единый формат ошибок HTTP-API.
 * Клиент (SPA в WebView) всегда получает `{ error: { code, message, details? } }`.
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL',
  PLATFORM_NOT_SUPPORTED: 'PLATFORM_NOT_SUPPORTED',
  VK_NOT_CONFIGURED: 'VK_NOT_CONFIGURED',
  INVALID_INIT_DATA: 'INVALID_INIT_DATA',
  EXPIRED_INIT_DATA: 'EXPIRED_INIT_DATA',
  INVALID_TOKEN: 'INVALID_TOKEN',
  INSUFFICIENT_ENERGY: 'INSUFFICIENT_ENERGY',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  ASSIST_LIMIT_REACHED: 'ASSIST_LIMIT_REACHED',
  ALREADY_HELPED: 'ALREADY_HELPED',
  ADS_DISABLED: 'ADS_DISABLED',
  AD_LIMIT_REACHED: 'AD_LIMIT_REACHED',
  AD_TOO_SOON: 'AD_TOO_SOON',
  AD_SESSION_REQUIRED: 'AD_SESSION_REQUIRED',
  AD_SESSION_EXPIRED: 'AD_SESSION_EXPIRED',
  AD_ALREADY_CLAIMED: 'AD_ALREADY_CLAIMED',
  AD_NOT_VERIFIED: 'AD_NOT_VERIFIED',
  ENTITLEMENT_LIMIT: 'ENTITLEMENT_LIMIT',
  PURCHASE_LIMIT_REACHED: 'PURCHASE_LIMIT_REACHED',
  PURCHASES_BLOCKED: 'PURCHASES_BLOCKED',
  DUPLICATE_ORDER: 'DUPLICATE_ORDER',
  PAYMENTS_NOT_CONFIGURED: 'PAYMENTS_NOT_CONFIGURED',
  INVALID_PAYMENT_SIGNATURE: 'INVALID_PAYMENT_SIGNATURE',
  // Магазин роботов-строителей
  BUILDER_LIMIT_REACHED: 'BUILDER_LIMIT_REACHED',
  BUILDER_PRICE_MISSING: 'BUILDER_PRICE_MISSING',
  // Мастерская: чертежи, стройка, разбор
  UNKNOWN_BLUEPRINT: 'UNKNOWN_BLUEPRINT',
  NO_FREE_BUILDER: 'NO_FREE_BUILDER',
  BUILD_QUEUE_FULL: 'BUILD_QUEUE_FULL',
  INVENTORY_FULL: 'INVENTORY_FULL',
  ITEM_NOT_FOUND: 'ITEM_NOT_FOUND',
  INVALID_DISMANTLE_MODE: 'INVALID_DISMANTLE_MODE',
  // Сооружения (config/structures.ts): лимит вида/общий и непредстроенная предпосылка
  STRUCTURE_LIMIT: 'STRUCTURE_LIMIT',
  STRUCTURE_REQUIRES: 'STRUCTURE_REQUIRES',
  // Мгновенное ускорение стройки (хрониум)
  BUILD_NOT_FOUND: 'BUILD_NOT_FOUND',
  BUILD_ALREADY_DONE: 'BUILD_ALREADY_DONE',
  NOTHING_TO_RUSH: 'NOTHING_TO_RUSH',
  SPEEDUP_AMOUNT_INVALID: 'SPEEDUP_AMOUNT_INVALID',
  // Четыре высокотехнологичных материала (config/materials.ts)
  /** Молекулярный станок: неизвестный целевой металл. */
  CONVERSION_TARGET_INVALID: 'CONVERSION_TARGET_INVALID',
  /** Молекулярный станок: ноль, дробь, отрицательное или сверх потолка закладки. */
  CONVERSION_AMOUNT_INVALID: 'CONVERSION_AMOUNT_INVALID',
  /** Станиумный модуль: неверное количество заряда либо зарядка فوق потолка срока. */
  STANIUM_CHARGE_INVALID: 'STANIUM_CHARGE_INVALID',
  // Цех переработки
  RECYCLE_BATCH_INVALID: 'RECYCLE_BATCH_INVALID',
  JUNK_CAP_REACHED: 'JUNK_CAP_REACHED',
  // Боевой лут
  INVALID_BATTLE_REPORT: 'INVALID_BATTLE_REPORT',
  LOOT_LIMIT_REACHED: 'LOOT_LIMIT_REACHED',
  // PvP: рейд (Шаг 4)
  /** В коридоре рейтинга не нашлось соперника с проходимой базой. */
  NO_OPPONENT: 'NO_OPPONENT',
  /** База защитника не прошла проверку проходимости (мёртвый лабиринт, нет техники). */
  OPPONENT_UNREADY: 'OPPONENT_UNREADY',
  /** Защитник под «Щитом покоя» — атаковать нельзя (привилегия, п. «Монетизация»). */
  OPPONENT_SHIELDED: 'OPPONENT_SHIELDED',
  /** Атака самого себя — единственный способ накрутить рейтинг без матчмейкинга. */
  SELF_ATTACK: 'SELF_ATTACK',
  /** Суточный потолок атак (антифрод: бой — источник лута, значит его лимитируют). */
  ATTACK_LIMIT_REACHED: 'ATTACK_LIMIT_REACHED',
  /** Состав армии не прошёл проверку: чужой предмет, не штурмовик, стоит в обороне, пустой рейд. */
  ARMY_INVALID: 'ARMY_INVALID',
  /** Резолвер отчитался боем, которого сервер не выдавал (raidId не совпал). */
  RAID_MISMATCH: 'RAID_MISMATCH',
  // PvP: планировка обороны (Шаг 3)
  /** Структурная неправка в присланной сетке: координаты, дубли, занятые ворота, превышение лимитов. */
  PLACEMENT_INVALID: 'PLACEMENT_INVALID',
  /** Предмет есть, но на обороне не стоит (дрон). */
  UNIT_NOT_DEPLOYABLE: 'UNIT_NOT_DEPLOYABLE',
  /** Предмет снят с карты раньше, чем его разобрали. */
  ITEM_DEPLOYED: 'ITEM_DEPLOYED',
  /** Клиент прислал планировку по устаревшему снапшоту (версия не совпала). */
  STALE_LAYOUT: 'STALE_LAYOUT',
  // Монетизация: заказы на покупку (Часть 1: витрина + VKWebAppShowOrderBox)
  /** SKU нет в серверном каталоге: клиент просит то, что мы не продаём. */
  UNKNOWN_SKU: 'UNKNOWN_SKU',
  /** Заказ не найден по order id (подделка, чужой заказ или уже удалён). */
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  /** Заказ не подтверждён площадкой за отведённое окно — сгорел, деньги не списались. */
  ORDER_EXPIRED: 'ORDER_EXPIRED',
  /** Повторное подтверждение того же заказа (норма для вебхука, отказ для клиента). */
  ORDER_ALREADY_FULFILLED: 'ORDER_ALREADY_FULFILLED',
  /** Заказ ещё не оплачен: выдавать товар по просьбе клиента нельзя. */
  ORDER_UNPAID: 'ORDER_UNPAID',
  /** Возврат платежа пришёл позже окна приёма (limits.purchases.refundWindowDays). */
  REFUND_TOO_LATE: 'REFUND_TOO_LATE',
  // Кланы (Часть 2: основание за астериев, казна)
  /** Игрок уже состоит в клане. */
  ALREADY_IN_CLAN: 'ALREADY_IN_CLAN',
  /** Игрок не состоит в клане, а действие требует членства. */
  NOT_IN_CLAN: 'NOT_IN_CLAN',
  /** Имя клана не прошло правила (длина, символы, ненорматив, дубликаты пробелов). */
  CLAN_NAME_INVALID: 'CLAN_NAME_INVALID',
  /** Имя свободно только после нормализации: занято другим кланом. */
  CLAN_NAME_TAKEN: 'CLAN_NAME_TAKEN',
  /** Клан не найден. */
  CLAN_NOT_FOUND: 'CLAN_NOT_FOUND',
  /** Клан заполнен (потолок участников документа). */
  CLAN_FULL: 'CLAN_FULL',
  /** Действие доступно только основителю. */
  CLAN_LEADER_ONLY: 'CLAN_LEADER_ONLY',
  /** Взнос не прошёл проверку: ноль, дробь, чужой металл, дефицит, суточный потолок. */
  CLAN_DEPOSIT_INVALID: 'CLAN_DEPOSIT_INVALID',
  /** Клан основан, но оплата не прошла: повторное основание невозможно, пока висит слот. */
  CLAN_UNPAID: 'CLAN_UNPAID',
  /** Окно подтверждения взноса истекло, а доказательства списания в журнале нет. */
  CLAN_PENDING_EXPIRED: 'CLAN_PENDING_EXPIRED'
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'AppError';
  }

  toJSON(): Record<string, unknown> {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {})
      }
    };
  }
}

export const validationError = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError(ErrorCodes.VALIDATION_ERROR, 400, message, details);

export const unauthorized = (message = 'Требуется авторизация', details?: Record<string, unknown>): AppError =>
  new AppError(ErrorCodes.UNAUTHENTICATED, 401, message, details);

export const forbidden = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError(ErrorCodes.FORBIDDEN, 403, message, details);

export const notFound = (message: string): AppError => new AppError(ErrorCodes.NOT_FOUND, 404, message);

export const conflict = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError(ErrorCodes.CONFLICT, 409, message, details);

export const rateLimited = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError(ErrorCodes.RATE_LIMITED, 429, message, details);

export const internal = (message = 'Внутренняя ошибка сервера'): AppError =>
  new AppError(ErrorCodes.INTERNAL, 500, message);

/** Приводит любое thrown-значение к AppError, не теряя HTTP-статус для известных типов. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new AppError(ErrorCodes.INTERNAL, 500, err.message || 'Неизвестная ошибка');
  return internal(String(err));
}
