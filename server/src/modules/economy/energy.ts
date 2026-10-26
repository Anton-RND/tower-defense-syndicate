import type { EconomyConfig } from '../../config/env.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import type { UserAccount } from '../user/user.types.js';
import { effectiveEnergyRegenPerHour, MAX_STACK_MULTIPLIER } from './entitlements.js';
import { makeIdempotencyKey, type LedgerDraft, type LedgerReason } from '../ledger/ledger.types.js';
import { credit, debit, resource } from './wallet.js';
import { HOUR_MS } from './mining.js';

/**
 * Социальная энергия (п.2.3) — «виральный движок».
 *
 * Реген и траты считаются лениво (lazy): энергия «догоняется» до `now` при каждом
 * запросе/входе игрока. Так мы не держим воркеров на каждого пользователя и получаем
 * идемпотентность повторных расчётов.
 */
export interface EnergyTickResult {
  /** Новое (дробное) значение энергии, не выше капа. */
  energy: number;
  energyUpdatedAt: Date;
  /** Когда энергия станет полной (null — уже полная или реген отключён). */
  fullAt: Date | null;
  /** Через сколько мс появится следующая целая единица. */
  msToNextUnit: number | null;
}

/** Ключ суток UTC — для суточных лимитов (ассисты, дейлики). */
export function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export function computeEnergyTick(account: UserAccount, now: Date, config: EconomyConfig): EnergyTickResult {
  const elapsedMs = Math.max(0, now.getTime() - account.energyUpdatedAt.getTime());
  // Бусты регена («Энерго-катализатор» из магазина/рекламы) применяются поверх базовой ставки.
  const perHour = effectiveEnergyRegenPerHour(account, now, config.energyRegenPerHour);
  const cap = config.energyCap;

  const raw = account.resources.energy + (perHour * elapsedMs) / HOUR_MS;
  const energy = round6(Math.min(cap, raw));
  // Точка отсчёта ВСЕГДА поднимается на `now`. Раньше здесь был `energy >= cap ? now :
  // account.energyUpdatedAt` — и ниже капа курсор не двигался никогда, тогда как строка
  // выше уже положила начисленное в `energy`. Следствие: каждый запрос заново добавлял
  // ВСЁ окно от старой метки, то есть игрок, кликавший в клиент, печатал себе энергию
  // скоростью числа запросов (замер: два опроса в один такт дали 1 + 2×0.4167 вместо
  // 1 + 0.4167). «Заморозка на полном баке» в комментарии к прошлой версии защищала от
  // переполнения, которого нет: `Math.min(cap, raw)` его уже отсёк, а накопление сверху
  // капа — и есть смысл капа. Дробная часть теряться не может: она живёт в `energy`,
  // поэтому полный переход курсора ничего не должен ни игроку, ни журналу.
  const updated = now;

  let fullAt: Date | null = null;
  if (energy < cap && perHour > 0) {
    fullAt = new Date(now.getTime() + ((cap - energy) / perHour) * HOUR_MS);
  }

  let msToNextUnit: number | null = null;
  if (energy < cap && perHour > 0) {
    const fractionNeeded = Math.ceil(energy) - energy;
    const units = fractionNeeded <= 1e-9 ? 1 : fractionNeeded;
    msToNextUnit = Math.max(0, Math.round((units / perHour) * HOUR_MS));
  }

  return { energy, energyUpdatedAt: updated, fullAt, msToNextUnit };
}

/** Догоняет реген энергии до `now`. Идемпотентна. */
export function applyEnergyTick(account: UserAccount, now: Date, config: EconomyConfig): UserAccount {
  const tick = computeEnergyTick(account, now, config);
  return {
    ...account,
    resources: { ...account.resources, energy: tick.energy },
    energyUpdatedAt: tick.energyUpdatedAt
  };
}

export interface SpendResult {
  account: UserAccount;
  /** Движение энергии в журнал — тот самый якорь, без которого переплата необнаружима. */
  drafts: LedgerDraft[];
  /** Целые единицы до траты (после тика регена). */
  before: number;
  after: number;
  cost: number;
}

/**
 * Контекст траты энергии.
 *
 * Параметр ОБЯЗАТЕЛЕН, и не для строгости стиля: пока у вызывающего слоя нет причины и
 * id действия, движение уходит в журнал пустым, и энергия остаётся единственной
 * валютой кошелька без якорей (см. причину 'raid_energy' в ledger.types.ts).
 * Компилятор должен мешать этому, а не комментарий.
 */
export interface EnergySpendContext {
  reason: LedgerReason;
  /** Тип и id внешнего объекта: попадают в журнал и в ключ идемпотентности. */
  refType: 'raid';
  refId: string;
}

/**
 * Трата энергии на действие (PvP-атака, ускорение крафта — п.2.3, п.3.1).
 * Сначала реген, потом списание; не хватает — AppError(409), и стор (благодаря
 * транзакционной семантике) не пишет ничего.
 *
 * Списывает через `debit`, а не правкой `resources.energy`: только `debit` проставляет
 * `balanceAfter` — точку отсчёта, по которой `energyCeiling` потом отличает честно
 * накопленное от напечатанного багом. Дробный остаток сохраняется как раньше
 * (`before` — цементированная витрина, `account` — точное значение).
 */
export function spendEnergy(
  account: UserAccount,
  cost: number,
  now: Date,
  config: EconomyConfig,
  ctx: EnergySpendContext
): SpendResult {
  if (!Number.isInteger(cost) || cost <= 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, 'Стоимость действия должна быть целым числом > 0', {
      cost
    });
  }

  const ticked = applyEnergyTick(account, now, config);
  const before = Math.floor(ticked.resources.energy);
  if (before < cost) {
    const tick = computeEnergyTick(ticked, now, config);
    throw new AppError(ErrorCodes.INSUFFICIENT_ENERGY, 409, `Недостаточно энергии: нужно ${cost}, есть ${before}`, {
      cost,
      available: before,
      cap: config.energyCap,
      /** Ориентир для UI / апселла доната: когда накопится нужное. */
      readyInMs: tick.msToNextUnit ? (cost - before) * tick.msToNextUnit : null,
      assistAvailable: ticked.assist.count < config.limits.assist.dailyLimit
    });
  }

  const movement = debit(ticked, resource('energy'), cost, {
    ts: now,
    reason: ctx.reason,
    refType: ctx.refType,
    refId: ctx.refId,
    // Ключ включает валюту: одно действие списывает несколько ценностей (лут, трофеи),
    // и без суффикса `energy` эта запись была бы отброшена уникальным индексом журнала
    // как дубль первой — вариант 1 шапки ledger.types.ts.
    idempotencyKey: makeIdempotencyKey(ctx.refType, `${ctx.refId}:energy`)
  });

  return {
    account: movement.account,
    drafts: [movement.draft],
    before,
    after: before - cost,
    cost
  };
}

/**
 * Якорь энергии: точный баланс в точный момент.
 *
 * Берётся ИСКЛЮЧИТЕЛЬНО из журнала (`balanceAfter` + `ts` последней записи по валюте).
 * Других источников точного баланса в системе нет: `resources.energy` в документе —
 * это то самое число, которое проверяется.
 */
export interface EnergyAnchor {
  ts: Date;
  balance: number;
}

/**
 * Верхняя граница того, сколько энергии у игрока МОГЛО быть честно в момент `now`,
 * если в момент `anchor.ts` у него было честно `anchor.balance`.
 *
 * Между двумя якорями энергию меняют только две силы: реген (чистая функция времени и
 * ставки) и траты (каждая — запись в журнал, то есть новый якорь). Поэтому граница
 * строится без истории игрока и без догадок о его клиенте.
 *
 * Ставка берётся ПОТОЛКОМ (`MAX_STACK_MULTIPLIER`), а не текущей: протухшие
 * привилегии вычищаются тиком и их история в документе не живёт, а граница обязана
 * быть верхней — иначе проверка обвинит честного игрока, купившего
 * «Энерго-катализатор» на прошлой неделе. Цена завышения — не обнаружить часть
 * переплат; цена занижения — снять энергию с правого.
 */
export function energyCeiling(anchor: EnergyAnchor, now: Date, config: EconomyConfig): number {
  const hours = Math.max(0, now.getTime() - anchor.ts.getTime()) / HOUR_MS;
  const maxPerHour = config.energyRegenPerHour * MAX_STACK_MULTIPLIER;
  return round6(Math.min(config.energyCap, Math.max(0, anchor.balance) + maxPerHour * hours));
}

/**
 * Одно движение по энергии из журнала — ровно то, что нужно для прогона границы.
 *
 * Берётся из записей с `currency = 'energy'` (любая причина: 'raid_energy', 'assist',
 * 'starter', 'admin'). `balanceAfter` — число, зафиксированное в момент движения;
 * доверять ему надо, но проверять: именно расхождение `balanceAfter` с границей и есть
 * сигнал переплаты.
 */
export interface EnergyMovement {
  ts: Date;
  /** Знак как в журнале: + начисление, − списание. */
  delta: number;
  balanceAfter: number;
}

export interface EnergyAudit {
  /** Потолок честного баланса в момент `now` — столько игрок мог иметь, не нарушая правил. */
  honest: number;
  /** `resources.energy − honest`, не меньше нуля. То, что подлежит возврату. */
  excess: number;
  /** Момент первого расхождения журнала с границей; null — расхождений нет. */
  firstDivergence: Date | null;
}

/** Допуск на шум округления: все балансы энергии считаются через round6. */
const ENERGY_EPSILON = 1e-6;

/**
 * Прогон журнала энергии от рождения аккаунта: сколько игрок мог иметь честно и есть
 * ли излишек.
 *
 * Почему НЕ достаточно одной последней записи. Граница по одному якорю
 * (`energyCeiling` от последнего движения) наивна: эксплойт с курсором портил именно
 * тот баланс, из которого якорь и делается, — проверять испорченное число по самому
 * себе значит никогда ничего не найти. Здесь же журнал проходится ПОСЛЕДОВАТЕЛЬНО, и
 * каждое движение сверяется с границей, построенной от ПРЕДЫДУЩЕГО, ещё не испорченного
 * значения. Расхождение фиксируется один раз, и спорный баланс в дальнейший расчёт
 * не пускается: курсор остаётся на последней достоверной записи.
 *
 * Начало отсчёта — `createAccount`: новичок получает полный бак (`energyCap`) в момент
 * `createdAt`, и это единственная легальная точка, не требующая записей в журнале.
 *
 * Все расхождения трактуются в пользу игрока: вниз по границе идём по `min` журнала и
 * потолка, излишек накапливаем только там, где зафиксированный баланс ПРЕВЫСИЛ потолок.
 * Цена такой стороны — не заметить часть краж, где игрок тратил украденное быстрее, чем
 * его успели проверить; цена обратной стороны — снять энергию с честного игрока, у
 * которого привилегии истекли между записями.
 */
export function auditEnergy(
  account: UserAccount,
  movements: readonly EnergyMovement[],
  now: Date,
  config: EconomyConfig
): EnergyAudit {
  const ordered = [...movements].sort((a, b) => a.ts.getTime() - b.ts.getTime());
  // Новичок стартует с полным баком (createAccount) — другой легальной точки отсчёта нет.
  let honest = config.energyCap;
  let cursor = account.createdAt;
  let firstDivergence: Date | null = null;

  for (const movement of ordered) {
    const ceiling = energyCeiling({ ts: cursor, balance: honest }, movement.ts, config);
    const expected = Math.max(0, Math.min(config.energyCap, ceiling + movement.delta));
    if (movement.balanceAfter > expected + ENERGY_EPSILON) {
      if (firstDivergence === null) firstDivergence = movement.ts;
      honest = expected;
      continue;
    }
    // Движение не превысило потолок — верим журналу (он может быть НИЖЕ границы: игрок
    // терял энергию в окнах, когда списания ещё не писались, и это не его вина).
    honest = Math.max(0, movement.balanceAfter);
    cursor = movement.ts;
  }

  const ceilingNow = energyCeiling({ ts: cursor, balance: honest }, now, config);
  return {
    honest: round6(ceilingNow),
    excess: round6(Math.max(0, account.resources.energy - ceilingNow)),
    firstDivergence
  };
}


/** Сколько единиц даёт одна «Помощь друга» (25% капа по умолчанию). */
export function assistGainUnits(config: EconomyConfig): number {
  return Math.floor((config.energyCap * config.limits.assist.percent) / 100);
}

export interface AssistResult {
  account: UserAccount;
  /** Движение энергии в журнал (reason = 'assist'). */
  drafts: LedgerDraft[];
  /** Фактически выданное (может быть меньше номинала, если упираемся в кап). */
  granted: number;
  /** Номинал «Помощи друга» до ограничения капом. */
  nominal: number;
  energy: number;
  /** Осталось ассистов сегодня; -1 — лимит отключён. */
  remainingToday: number;
}

/**
 * Механика «Помощь друга» (п.2.3): друг перешёл по ссылке → получил свой бонус →
 * владельцу мгновенно восстанавливается 25% капа.
 *
 * Анти-чит: один друг помогает игроку ровно один раз (массив helpers) и всего
 * `limits.assist.dailyLimit` ассистов в сутки. Ключ идемпотентности привязан к
 * (игрок, сутки, номер ассиста) — повторный клик по той же ссылке не удвоит энергию.
 */
export function grantAssistEnergy(
  account: UserAccount,
  helperId: string,
  now: Date,
  config: EconomyConfig
): AssistResult {
  const ticked = applyEnergyTick(account, now, config);
  const limits = config.limits.assist;
  const today = dayKey(now);
  const assist =
    ticked.assist.day === today
      ? { day: today, count: ticked.assist.count, helpers: [...ticked.assist.helpers] }
      : { day: today, count: 0, helpers: [...ticked.assist.helpers] };

  if (limits.dailyLimit > 0 && assist.count >= limits.dailyLimit) {
    throw new AppError(
      ErrorCodes.ASSIST_LIMIT_REACHED,
      429,
      'Суточный лимит восстановлений энергии исчерпан — дождитесь регена или попробуйте завтра',
      { limit: limits.dailyLimit, used: assist.count }
    );
  }

  if (helperId && assist.helpers.includes(helperId)) {
    throw new AppError(ErrorCodes.ALREADY_HELPED, 409, 'Этот друг уже помогал вам', { helperId });
  }

  const nominal = assistGainUnits(config);
  const room = Math.max(0, Math.min(nominal, config.energyCap - ticked.resources.energy));
  const movement = credit(ticked, resource('energy'), room, {
    ts: now,
    reason: 'assist',
    refId: helperId || null,
    idempotencyKey: makeIdempotencyKey('event', `assist:${account.id}:${today}:${assist.count}`)
  });

  assist.helpers.push(helperId);
  if (limits.helpersHistory > 0 && assist.helpers.length > limits.helpersHistory) {
    assist.helpers.splice(0, assist.helpers.length - limits.helpersHistory);
  }
  assist.count += 1;

  return {
    account: {
      ...movement.account,
      // После ручного восстановления точка отсчёта регена — сейчас.
      energyUpdatedAt: now,
      assist
    },
    drafts: [movement.draft],
    granted: round6(room),
    nominal,
    energy: movement.account.resources.energy,
    remainingToday: limits.dailyLimit > 0 ? Math.max(0, limits.dailyLimit - assist.count) : -1
  };
}
