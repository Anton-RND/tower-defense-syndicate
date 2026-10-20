import {
  ASTERIUM_YIELD,
  CONVERSION_MAX_BATCH,
  STANIUM_FIELD_MAX_MS,
  STANIUM_MAX_BATCH,
  STANIUM_MS_PER_UNIT,
  STANIUM_SPEED_MULTIPLIER,
  TECH_LABEL
} from '../../config/materials.js';
import { METAL_IDS, isMetalId, type MaterialCost, type MetalId } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { asteriumTotal, gainMaterials, spendAsterium, spendTech } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';

/**
 * Материалы: Молекулярный станок и станиумный модуль.
 *
 * ЧИСТЫЕ ФУНКЦИИ, как и весь домен проекта: ни одна из них не знает ни про Mongo,
 * ни про HTTP. Хаб-слой (см. ./commit.ts) оборачивает их в `UserStore.transact`
 * и пишет черновики журнала. Благодаря этому станок тестируется без базы, а боевая
 * симуляция — без состояния.
 *
 * Чего здесь НЕТ: продажу материалов. Астерий приходит из заказов и рекламы, сырьё —
 * из цеха переработки и магазинных паков; всё это чужие маршруты (payment/orders,
 * ads, workshop/recycle), использующие те же функции кошелька.
 */

// ─── Молекулярный станок: астерий → базовые металлы ─────────────────────────────

export interface ConversionQuote {
  metal: MetalId;
  /** Сколько астерия сгорает. */
  asterium: number;
  /** Выход металла на единицу астерия (падающий по глубине переработки). */
  rate: number;
  /** Итоговый выход металла. */
  yields: number;
}

/**
 * Валидация и расчёт закладки станка. Отдельная функция потому, что витрина
 * обязана показать цену ДО запроса, а сервер — пересчитать её заново при списании:
 * клиент не передаёт ни выход, ни курс.
 */
export function quoteConversion(targetMetal: string, amountAsterium: number): ConversionQuote {
  if (!isMetalId(targetMetal)) {
    throw new AppError(ErrorCodes.CONVERSION_TARGET_INVALID, 400, `Неизвестный целевой металл: ${String(targetMetal)}`, {
      allowed: METAL_IDS
    });
  }
  if (!Number.isInteger(amountAsterium) || amountAsterium <= 0) {
    throw new AppError(ErrorCodes.CONVERSION_AMOUNT_INVALID, 400, 'Количество астерия должно быть целым и > 0', {
      metal: targetMetal,
      amount: amountAsterium
    });
  }
  if (amountAsterium > CONVERSION_MAX_BATCH) {
    throw new AppError(ErrorCodes.CONVERSION_AMOUNT_INVALID, 400, 'Слишком крупная закладка для одного цикла станка', {
      metal: targetMetal,
      amount: amountAsterium,
      limit: CONVERSION_MAX_BATCH
    });
  }

  const rate = ASTERIUM_YIELD[targetMetal];
  return { metal: targetMetal, asterium: amountAsterium, rate, yields: rate * amountAsterium };
}

export interface ConvertOptions {
  /**
   * Ключ идемпотентности действия (HTTP-слой берёт его из заголовка Idempotency-Key).
   * Расход и выход получают разные суффиксы одного ключа: иначе второе движение той же
   * закладки было бы отброшено уникальным индексом журнала как дубль первого.
   */
  idempotencyKey?: string | null;
}

export interface ConvertResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Списано астерия. */
  spent: number;
  metal: MetalId;
  /** Начислено металла. */
  yielded: number;
  /** Астерия осталось (оба кошелька) — витрина показывает «остаток после станка». */
  asteriumLeft: number;
}

/**
 * Переработать `amountAsterium` астерия в базовый металл `targetMetal`.
 *
 * Три правила, которые делают станок безопасным:
 *  1. Курс берётся ИЗ КОНФИГА, а не из запроса: игрок не может продать серверу
 *     «астерий по 100 драгметалла».
 *  2. Проверка долга по донату — ДО списания. Станок это канал отмывания
 *     (астерий → металл → клановая казна/чертеж), и игрок с неотработанным
 *     chargeback не должен иметь возможности вывести остатки в товары.
 *  3. Списали и начислили — в одном редукторе. Промежуточного состояния «астерий
 *     ушёл, металл ещё не пришёл» снаружи не видно: `UserStore.transact` пишет
 *     результат целиком или не пишет ничего.
 */
export function convertAsterium(
  account: UserAccount,
  targetMetal: string,
  amountAsterium: number,
  now: Date,
  options: ConvertOptions = {}
): ConvertResult {
  const quote = quoteConversion(targetMetal, amountAsterium);

  // Порядок проверок зеркалит shop/builders.buyBuilder: сначала долг по донату, потом
  // баланс. Меняешь их местами — и ветка PURCHASES_BLOCKED становится недостижимой:
  // при отрицательном `purchased` сумма двух кошельков ВСЕГДА меньше заработанного,
  // поэтому «не хватает» срабатывало бы раньше и вместо внятного «у вас возврат
  // не отработан» игрок получал бы голый INSUFFICIENT_FUNDS.
  if (account.materials.asterium.purchased < 0) {
    // Долг по возврату: тратить можно только заработанное, и доступная сумма — именно
    // `earned`, а не `asteriumTotal` (иначе минус по купленному отнял бы право тратить
    // честно заработанное).
    if (account.materials.asterium.earned < quote.asterium) {
      throw new AppError(
        ErrorCodes.PURCHASES_BLOCKED,
        403,
        `Есть неотработанный возврат платежа: станок доступен только за заработанный ${TECH_LABEL.asterium.label.toLowerCase()}`,
        { required: quote.asterium, earned: account.materials.asterium.earned }
      );
    }
  } else {
    const available = asteriumTotal(account);
    if (available < quote.asterium) {
      throw new AppError(
        ErrorCodes.INSUFFICIENT_FUNDS,
        409,
        `Недостаточно ${TECH_LABEL.asterium.label.toLowerCase()}: нужно ${quote.asterium}, есть ${available}`,
        { currency: 'asterium', required: quote.asterium, available, metal: quote.metal }
      );
    }
  }

  const baseKey = options.idempotencyKey ?? null;
  const spent = spendAsterium(account, quote.asterium, {
    ts: now,
    reason: 'convert',
    refType: 'conversion',
    refId: quote.metal,
    idempotencyKey: baseKey ? makeIdempotencyKey('convert', baseKey) : null,
    meta: { metal: quote.metal, rate: quote.rate, yields: quote.yields }
  });

  const cost: MaterialCost = { [quote.metal]: quote.yields };
  const gained = gainMaterials(spent.account, cost, {
    ts: now,
    reason: 'convert',
    refType: 'conversion',
    refId: quote.metal,
    idempotencyKeyFor: (id) => (baseKey ? makeIdempotencyKey('convert', `${baseKey}:${id}`) : null),
    meta: { asterium: quote.asterium, rate: quote.rate }
  });

  return {
    account: gained.account,
    drafts: [...spent.drafts, ...gained.drafts],
    spent: quote.asterium,
    metal: quote.metal,
    yielded: quote.yields,
    asteriumLeft: asteriumTotal(gained.account)
  };
}

// ─── Станиумный модуль: поле замедления базы ───────────────────────────────────

/** Сколько миллисекунд модуль проработает от текущего момента при заряде в `units`. */
export function staniumChargeMs(units: number): number {
  return units * STANIUM_MS_PER_UNIT;
}

/** Остаток срока работы модуля, мс (0 — поле выключено). */
export function staniumFieldRemaining(account: UserAccount, now: Date): number {
  const until = account.materials.staniumFieldUntil;
  if (!until) return 0;
  return Math.max(0, new Date(until).getTime() - now.getTime());
}

export function isStaniumFieldActive(account: UserAccount, now: Date): boolean {
  return staniumFieldRemaining(account, now) > 0;
}

/**
 * Множитель скорости наступающих роботов против этой базы.
 *
 * Это ЕДИНСТВЕННАЯ точка, где станиум касается боя: боевая симуляция остаётся
 * чистой функцией и не знает ни про часы, ни про кошельки — резолвер рейда
 * спрашивает множитель здесь и передаёт его в бой явным аргументом. Так бой
 * остаётся воспроизводимым по одному отчёту («поле было активно» записано в отчёте),
 * а не по косвенному признаку «сейчас в документе стоит срок в будущем».
 */
export function staniumSpeedMultiplier(account: UserAccount, now: Date): number {
  return isStaniumFieldActive(account, now) ? STANIUM_SPEED_MULTIPLIER : 1;
}

export interface StaniumFieldView {
  active: boolean;
  /** До какого момента активно (null — выключено). */
  until: Date | null;
  remainingMs: number;
  /** Множитель скорости атакующих: 1 = поля нет, STANIUM_SPEED_MULTIPLIER = поле работает. */
  speedMultiplier: number;
  /** Снижение скорости в процентах — для подписи в UI («−25% скорости»). */
  slowPercent: number;
  stanium: number;
  /** Сколько единиц станиума даёт одна зарядка и на какой срок (для витрины). */
  msPerUnit: number;
  maxMs: number;
}

export function describeStaniumField(account: UserAccount, now: Date): StaniumFieldView {
  const remainingMs = staniumFieldRemaining(account, now);
  return {
    active: remainingMs > 0,
    until: account.materials.staniumFieldUntil ? new Date(account.materials.staniumFieldUntil) : null,
    remainingMs,
    speedMultiplier: staniumSpeedMultiplier(account, now),
    slowPercent: Math.round((1 - STANIUM_SPEED_MULTIPLIER) * 100),
    stanium: account.materials.stanium,
    msPerUnit: STANIUM_MS_PER_UNIT,
    maxMs: STANIUM_FIELD_MAX_MS
  };
}

export interface ChargeOptions {
  /** Ключ идемпотентности зарядки (Idempotency-Key HTTP-слоя). */
  idempotencyKey?: string | null;
}

export interface StaniumChargeResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Списано станиума. */
  spent: number;
  /** Сколько запрошенных единиц реально пошло в срок (потолок 24 ч может обрезать). */
  addedUnits: number;
  /** На сколько увеличился срок работы модуля, мс. */
  addedMs: number;
  fieldUntil: Date;
  remainingMs: number;
}

/**
 * Зарядить станиумный модуль базы: `units` станиума → `units × 15 минут` поля замедления.
 *
 * Срок НАКАПЛИВАЕТСЯ (повторная зарядка продлевает существующее поле), а не
 * перезаписывается: иначе вторая зарядка «съедаала» бы первую и игрок терял бы
 * купленное время на ровном месте.
 *
 * Потолок STANIUM_FIELD_MAX_MS обрезает перекорм: модуль обязан оставаться
 * тактическим решением «перед ожидаемой атакой», а не постоянной привилегией,
 * купленной раз в месяц. Обрезка честная — списывается ровно то количество,
 * которое поместилось под потолок, излишек остаётся на балансе.
 */
export function chargeStaniumField(
  account: UserAccount,
  units: number,
  now: Date,
  options: ChargeOptions = {}
): StaniumChargeResult {
  if (!Number.isInteger(units) || units <= 0) {
    throw new AppError(ErrorCodes.STANIUM_CHARGE_INVALID, 400, 'Заряд модуля должен быть целым и > 0', { units });
  }
  if (units > STANIUM_MAX_BATCH) {
    throw new AppError(ErrorCodes.STANIUM_CHARGE_INVALID, 400, 'Слишком крупный заряд за одну операцию', {
      units,
      limit: STANIUM_MAX_BATCH
    });
  }

  const remainingMs = staniumFieldRemaining(account, now);
  const roomMs = STANIUM_FIELD_MAX_MS - remainingMs;
  if (roomMs <= 0) {
    throw new AppError(ErrorCodes.STANIUM_CHARGE_INVALID, 409, 'Станиумный модуль уже заряжен до потолка срока', {
      remainingMs,
      maxMs: STANIUM_FIELD_MAX_MS
    });
  }
  const addedUnits = Math.min(units, Math.floor(roomMs / STANIUM_MS_PER_UNIT));
  if (addedUnits <= 0) {
    throw new AppError(
      ErrorCodes.STANIUM_CHARGE_INVALID,
      409,
      'До потолка срока модуля не хватает даже одной единицы станиума',
      { remainingMs, roomMs, msPerUnit: STANIUM_MS_PER_UNIT }
    );
  }

  const baseKey = options.idempotencyKey ?? null;
  // debit бросит INSUFFICIENT_FUNDS на дефиците — редуктор не запишется, срок не сдвинется.
  const spent = spendTech(account, 'stanium', addedUnits, {
    ts: now,
    reason: 'stanium_field',
    refType: 'stanium_module',
    refId: null,
    idempotencyKey: baseKey ? makeIdempotencyKey('stanium', baseKey) : null,
    meta: { units: addedUnits, ms_per_unit: STANIUM_MS_PER_UNIT, slow_percent: Math.round((1 - STANIUM_SPEED_MULTIPLIER) * 100) }
  });

  const addedMs = staniumChargeMs(addedUnits);
  const fieldUntil = new Date(now.getTime() + remainingMs + addedMs);
  const next: UserAccount = {
    ...spent.account,
    materials: { ...spent.account.materials, staniumFieldUntil: fieldUntil }
  };

  return {
    account: next,
    drafts: [spent.draft],
    spent: addedUnits,
    addedUnits,
    addedMs,
    fieldUntil,
    remainingMs: staniumFieldRemaining(next, now)
  };
}

