import type { EconomyConfig } from '../../config/env.js';
import type { LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';
import { pruneExpiredEntitlements, resolveEntitlements, type EntitlementEffects } from './entitlements.js';
import { applyEnergyTick } from './energy.js';
import { applyIndustryTick, computeIndustryTick, type IndustryTickResult } from './industry.js';
import { applyMiningTick, computeMiningTick, type MiningTickResult } from './mining.js';

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
  const energized = applyEnergyTick({ ...industrial.account, lastLootTime: now }, now, config);
  return { account: energized, drafts: industrial.drafts };
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