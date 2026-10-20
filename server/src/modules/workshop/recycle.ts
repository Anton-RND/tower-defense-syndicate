import type { EconomyConfig } from '../../config/env.js';
import {
  RECYCLE_MAX_BATCH,
  RECYCLE_RECIPES,
  isJunkId,
  materialEntries,
  type JunkId,
  type MaterialCost
} from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { credit, gainMaterials, payMaterials, resource } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from '../user/user.types.js';

/**
 * Цех переработки: хлам → металлы (+ энергия из батареек).
 *
 * Это единственная воронка, превращающая боевой лут в сырьё для чертежей 2–3 тира.
 * Без неё junkInventory — мёртвый склад, а значит и PvP, и деконструкция теряют смысл.
 *
 * Две валюты в одном действии (минус хлам, плюс металлы) — две отдельные пачки
 * движений журнала: сверка «сколько цветмета дал один день игры» читается именно
 * по паре reason='recycle' (−хлам) / reason='recycle' (+металл).
 */

export interface RecycleResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  junk: JunkId;
  amount: number;
  /** Что начислено по металлам (и энергии — отдельным движением). */
  yielded: MaterialCost;
  /** Фактически выданная энергия (батарейки). */
  energy: number;
  /** Сколько энергии сгорело оверкапом — важно для честного UI «+N⚡». */
  wastedEnergy: number;
  junkLeft: number;
}

export interface RecycleOptions {
  /**
   * Ключ идемпотентности действия (HTTP-слой берёт его из заголовка Idempotency-Key и
   * ПРЕВЕРЯЕТ, не отработал ли уже такой запрос — см. recycleEntryKey и маршрут
   * /v1/workshop/recycle). Без предпроверки ретрай вторично сдал бы тот же хлам:
   * состояние аккаунта это ловит только пока хлам на складе есть, а журнал терял бы
   * связь «запрос → движение».
   */
  idempotencyKey?: string | null;
}

/**
 * Ключ идемпотентности движения переработки.
 *
 * Привязка к игроку ОБЯЗАТЕЛЬНА. `Idempotency-Key` приходит от клиента, и два разных
 * аккаунта вполне могут прислать одинаковую «1». Уникальность ключа в журнале
 * глобальная (уникальный индекс по idempotencyKey), поэтому без `userId` второй игрок
 * получил бы тихий отказ записей: хлам списан, награда выдана, аудиторского следа нет.
 * Остальные ключи проекта несут серверный идентификатор (order/ad/raid/jobId) — это
 * единственный путь, куда попадает клиентская строка.
 */
export function recycleEntryKey(userId: string, requestKey: string, suffix: string): string {
  return makeIdempotencyKey('recycle', `${userId}:${requestKey}:${suffix}`);
}

function assertBatch(amount: number, junkId: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError(ErrorCodes.RECYCLE_BATCH_INVALID, 400, 'Количество для переработки должно быть целым и > 0', {
      junk: junkId,
      amount
    });
  }
  if (amount > RECYCLE_MAX_BATCH) {
    throw new AppError(ErrorCodes.RECYCLE_BATCH_INVALID, 400, 'Слишком крупная партия для одной сдачи', {
      junk: junkId,
      amount,
      limit: RECYCLE_MAX_BATCH
    });
  }
}

/**
 * Сдать `amount` единиц хлама типа `junkId` в цех.
 * Валидация типа принимает string: параметр приходит из HTTP и не может быть
 * доверенным юнионом — guard `isJunkId` здесь обязателен, а не желателен.
 */
export function recycleJunk(
  account: UserAccount,
  junkId: string,
  amount: number,
  now: Date,
  config: EconomyConfig,
  options: RecycleOptions = {}
): RecycleResult {
  if (!isJunkId(junkId)) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 400, `Неизвестный тип хлама: ${junkId}`, { junk: junkId });
  }
  assertBatch(amount, junkId);

  const recipe = RECYCLE_RECIPES[junkId];
  if (!recipe) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 409, 'Рецепт переработки не настроен', { junk: junkId });
  }

  const baseKey = options.idempotencyKey ?? null;
  const keyFor = (suffix: string): string | null =>
    baseKey ? recycleEntryKey(account.id, baseKey, suffix) : null;

  const cost: MaterialCost = {};
  cost[junkId] = amount;

  // 1. Списываем хлам. Дефицит → INSUFFICIENT_FUNDS, редуктор падает до мутации.
  const paid = payMaterials(account, cost, {
    ts: now,
    reason: 'recycle',
    refType: null,
    refId: junkId,
    idempotencyKey: keyFor(junkId),
    meta: { batch: amount }
  });

  // 2. Начисляем металлы: выход рецепта × количество, целыми.
  const yields: MaterialCost = {};
  for (const [metalId, per] of materialEntries(recipe.yields)) {
    yields[metalId] = per * amount;
  }
  // Сырьё (хрониум/вольфрам/станиум) идёт тем же движением: игрок сдаёт одну партию
  // и получает один отчёт «что вышло из цеха», а не две разнесённые операции.
  for (const [techId, per] of materialEntries(recipe.tech ?? {})) {
    yields[techId] = per * amount;
  }
  const gained = gainMaterials(paid.account, yields, {
    ts: now,
    reason: 'recycle',
    refType: null,
    refId: junkId,
    idempotencyKeyFor: (id) => keyFor(id) ?? null,
    meta: { from: junkId, batch: amount }
  });

  // 3. Батарейки дают ещё и энергию/химию — с уважением к капу, как и реклама.
  let next = gained.account;
  const drafts: LedgerDraft[] = [...paid.drafts, ...gained.drafts];
  let energy = 0;
  let wastedEnergy = 0;

  const nominal = Math.floor((recipe.energyEach ?? 0) * amount);
  if (nominal > 0) {
    const room = Math.max(0, Math.min(nominal, config.energyCap - next.resources.energy));
    const movement = credit(next, resource('energy'), room, {
      ts: now,
      reason: 'recycle',
      refId: junkId,
      idempotencyKey: keyFor('energy'),
      meta: { from: junkId, nominal }
    });
    next = movement.account;
    drafts.push(movement.draft);
    energy = room;
    wastedEnergy = nominal - room;
  }

  return {
    account: next,
    drafts,
    junk: junkId,
    amount,
    yielded: gained.moved,
    energy,
    wastedEnergy,
    junkLeft: next.junk[junkId] ?? 0
  };
}