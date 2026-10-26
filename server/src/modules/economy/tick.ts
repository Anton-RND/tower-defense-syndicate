import type { EconomyConfig } from '../../config/env.js';
import type { LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';
import { pruneExpiredEntitlements, resolveEntitlements, type EntitlementEffects } from './entitlements.js';
import { applyEnergyTick } from './energy.js';
import { applyIndustryTick, computeIndustryTick, type IndustryTickResult } from './industry.js';
import { applyMiningTick, computeMiningTick, type MiningTickResult } from './mining.js';

/**
 * Поля аккаунта, которые догон поднимает на `now`.
 *
 * Список нужен не для красоты. Курсор — это поле, по которому следующий тик узнаёт,
 * сколько времени уже оплачено; забытый курсор означает, что интервал оплачивается
 * дважды. Баг с энергией был ровно этим: `energyUpdatedAt` ниже капа не ехал, и каждый
 * опрос печатал энергию скоростью числа запросов. Пока хвост `applyEconomyTick` берёт
 * поля отсюда, забытый курсор — падающий тест (см. test/economy.schedule.test.ts),
 * а не дырка в экономике.
 *
 * ЧТО В СПИСОК НЕ ВХОДИТ и почему: `createdAt`, `lastLoginAt` — метаданные входа, догон
 * к ним не относится; `entitlements[].expiresAt`, `builds[].endsAt`,
 * `materials.staniumFieldUntil` — сроки чужих контрактов, тронув которые, догон
 * продлил бы оплаченное. Ни одно из них не является точкой отсчёта начисления.
 */
export const RESOURCE_CURSORS = ['lastLootTime', 'energyUpdatedAt'] as const satisfies readonly (keyof UserAccount)[];

export type ResourceCursor = (typeof RESOURCE_CURSORS)[number];

/**
 * Поднимает все курсоры на `now` — единственное место, где догон говорит «время оплачено».
 *
 * Идемпотентно по построению: результат зависит только от `now`, поэтому сколько бы
 * опросов ни было внутри интервала, конец его не двигает.
 */
export function advanceCursors(account: UserAccount, now: Date): UserAccount {
  const patch: Partial<Record<ResourceCursor, Date>> = {};
  for (const cursor of RESOURCE_CURSORS) patch[cursor] = now;
  return { ...account, ...patch };
}

export interface EconomyTickResult {
  account: UserAccount;
  /**
   * Движения журнала, рождённые самим догоном. Сегодня это только SEC с ASIC.
   *
   * Они едут наверх, а не пишутся здесь, по двум причинам. Во-первых, тик вызывается
   * из редуктора транзакции, где I/O запрещён шапкой ledger.store.ts. Во-вторых, при
   * CAS-повторе редуктор отрабатывает несколько раз, и писать журнал изнутри значило
   * бы оставить в нём движения от отклонённых попыток.
   */
  drafts: LedgerDraft[];
}

/**
 * Точка входа экономики для «каждого запроса» (п.1 ТЗ: «при каждом запросе или входе
 * пользователя рассчитывает, сколько ресурсов намайнилось с момента lastLootTime»).
 *
 * Порядок фиксированный: сначала вычищаем протухшие привилегии, затем догоняем склад
 * (майнинг), затем промышленность, затем энергию. Все операции идемпотентны
 * относительно `now`, поэтому повторный вызов в тот же такт ничего не ломает.
 *
 * Привилегии чистятся ДО тиков намеренно: иначе буст склада x2, истёкший минуту назад,
 * всё равно увеличивал бы ёмкость при расчёте ночного офлайна — то есть игрок получал
 * оплаченный ресурс после окончания оплаты.
 *
 * ИНВАРИАНТ РАСПИСАНИЯ. Результат зависит только от пары (состояние, `now`) и не
 * зависит от того, сколько опросов успело влезть в интервал: час, разбитый на семь
 * запросов, обязан дать ровно то же, что один запрос через час. Это не любезность —
 * клиент ходит в сеть с произвольным ритмом, и без инварианта доход игрока стал бы
 * функцией от качества его связи. Держится он на том, что каждый тик вычисляет
 * ПРИРАЩЕНИЕ от курсора, а не состояние заново, и что курсор едет на `now` всегда
 * (advanceCursors ниже). Замеренный тестом, а не этим абзацем:
 * test/economy.schedule.test.ts.
 *
 * Границы инварианта названы в самом тесте: лимит офлайна (`maxOfflineHours`) и
 * истечение привилегии внутри интервала — единственные два случая, где дробление
 * интервала МЕНЯЕТ результат, и оба они правила игры, а не её поломка.
 */
export function applyEconomyTick(
  account: UserAccount,
  now: Date,
  config: EconomyConfig
): EconomyTickResult {
  const cleaned = pruneExpiredEntitlements(account, now);
  const mined = applyMiningTick(cleaned, now, config);
  // ЛОВУШКА ПОРЯДКА: applyMiningTick сдвинул `lastLootTime` на `now`, и промышленность,
  // посчитанная по новому документу, увидела бы горизонт 0 мс — то есть за ночь база не
  // сожгла бы ни грамма плазмы и не произвела бы азота. Поэтому цехам передаётся тот же
  // интервал: свежие склады, но ПРЕЖНЯЯ метка времени. Метку поднимаем только в самом
  // конце, когда оба тика отработали.
  const industrial = applyIndustryTick({ ...mined, lastLootTime: cleaned.lastLootTime }, now, config);
  const energized = applyEnergyTick(industrial.account, now, config);
  // Все курсоры поднимаются одним местом и в самом конце: майнинг, промышленность и
  // энергия отработали по ПРЕЖНЕЙ метке, и только теперь интервал считается оплаченным.
  // Раньше `lastLootTime: now` передавался внутрь тика энергии попутно с аргументом —
  // работало, но выглядело как случайность, а случайность легко потерять при правке.
  return { account: advanceCursors(energized, now), drafts: industrial.drafts };
}

/** Прогноз добычи без изменения состояния: что будет, если тикнуть прямо сейчас. */
export function peekMining(account: UserAccount, now: Date, config: EconomyConfig): MiningTickResult {
  return computeMiningTick(pruneExpiredEntitlements(account, now), now, config);
}

/** Прогноз промышленности без изменения состояния: включая накапавший SEC. */
export function peekIndustry(account: UserAccount, now: Date, config: EconomyConfig): IndustryTickResult {
  return computeIndustryTick(pruneExpiredEntitlements(account, now), now, config);
}

/** Эффект активных привилегий — используется рейд-логикой (щит) и витрией (бусты). */
export function peekEntitlements(account: UserAccount, now: Date): EntitlementEffects {
  return resolveEntitlements(account, now);
}