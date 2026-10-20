import {
  SALVAGE_LEVEL_STEP,
  getBlueprint,
  materialEntries,
  salvageRateOf,
  type Blueprint,
  type MaterialCost
} from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { formatCell } from '../../config/base.js';
import { gainMaterials } from '../economy/wallet.js';
import { placementOf } from '../pvp/defense.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { InventoryItem, UserAccount } from '../user/user.types.js';
import { settleBuilds } from './craft.js';

/**
 * Деконструкция построек, дронов и оружия (п.3 ТЗ).
 *
 * Два взаимоисключающих режима вместо «случайно, что-то одно»:
 *  - salvage — гарантированные 50% вложенных материалов. Быстрый путь переиграть
 *    планировку, но он не кормит цех переработки.
 *  - scrap   — таблица хлама с дисперсией. Средний EV выше, зато результат идёт
 *    в junkInventory и дальше в металлы, замыкая петлю «бой → хлам → цех → чертеж».
 *
 * Выбор режима — игровой, а не рандом сервера: игрок сам решает, ему сегодня
 * нужны материалы или цветмет. Это же и предсказуемость для тикетов поддержки.
 */

export const DISMANTLE_MODES = ['salvage', 'scrap'] as const;
export type DismantleMode = (typeof DISMANTLE_MODES)[number];

export function isDismantleMode(value: string): value is DismantleMode {
  return value === 'salvage' || value === 'scrap';
}

export interface DismantleResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Разобранный предмет (для ответа клиенту и для журнала по refId). */
  item: InventoryItem;
  mode: DismantleMode;
  /** Возвращённые материалы (режим salvage). */
  salvage: MaterialCost;
  /** Полученный хлам (режим scrap). */
  junk: MaterialCost;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Бросок таблицы хлама. `rng` инжектится: тесты должны быть детерминированы,
 * а «фортюна» в экономике — воспроизводима при разборе жалоб.
 * Порядок обращений к rng фиксирован: сначала шанс, затем количество.
 */
export function rollScrap(blueprint: Blueprint, rng: () => number): MaterialCost {
  const result: MaterialCost = {};
  for (const drop of blueprint.scrap) {
    const chance = clamp01(drop.chance);
    if (chance <= 0) continue;
    if (chance < 1 && rng() >= chance) continue;

    const min = Math.max(0, Math.trunc(drop.min));
    const max = Math.max(min, Math.trunc(drop.max));
    const span = max - min + 1;
    const amount = min + Math.min(span - 1, Math.floor(rng() * span));
    if (amount > 0) result[drop.junk] = (result[drop.junk] ?? 0) + amount;
  }
  return result;
}

/** Сколько материалов возвращается при разборе предмета уровня N. */
export function salvageYield(blueprint: Blueprint, level: number): MaterialCost {
  const rate = salvageRateOf(blueprint);
  const levelFactor = 1 + SALVAGE_LEVEL_STEP * Math.max(0, Math.trunc(level) - 1);
  const result: MaterialCost = {};
  for (const [id, amount] of materialEntries(blueprint.cost)) {
    const value = Math.floor(amount * rate * levelFactor);
    if (value > 0) result[id] = (result[id] ?? 0) + value;
  }
  return result;
}

/**
 * Разобрать предмет из инвентаря. Чистая функция — HTTP-слой оборачивает
 * в `UserStore.transact`, черновики уходят в `LedgerStore.appendMany`.
 */
export function dismantleItem(
  account: UserAccount,
  itemId: string,
  mode: DismantleMode | string,
  now: Date,
  idFactory: () => string,
  rng: () => number = Math.random
): DismantleResult {
  if (!isDismantleMode(mode)) {
    throw new AppError(ErrorCodes.INVALID_DISMANTLE_MODE, 400, `Неизвестный режим разбора: ${String(mode)}`, {
      allowed: DISMANTLE_MODES
    });
  }

  // Предмет мог «дозреть» в очереди прямо сейчас — догоняем, иначе его id не найдётся.
  const settled = settleBuilds(account, now, idFactory).account;
  const item = settled.inventory.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new AppError(ErrorCodes.ITEM_NOT_FOUND, 404, 'Предмет не найден в инвентаре', { itemId });
  }

  // Предмет стоит на оборонительной сетке: его разбор оставил бы на карте ссылку
  // в никуда — «башня есть в бою, и её нет в инвентаре». Порядок для игрока
  // однозначен: сначала снять с карты (это вернёт привязку и материалы за стены),
  // потом разбирать.
  const placement = placementOf(settled, itemId);
  if (placement) {
    throw new AppError(ErrorCodes.ITEM_DEPLOYED, 409, 'Единица стоит на оборонительной сетке — сначала снимите её с карты', {
      itemId,
      cell: formatCell(placement)
    });
  }

  const blueprint = getBlueprint(item.code);
  if (!blueprint) {
    throw new AppError(ErrorCodes.UNKNOWN_BLUEPRINT, 409, 'Чертёж предмета отсутствует в конфиге', {
      code: item.code,
      itemId: item.id
    });
  }

  const withoutItem: UserAccount = { ...settled, inventory: settled.inventory.filter((i) => i.id !== itemId) };
  const ctxBase = {
    ts: now,
    reason: 'dismantle' as const,
    refType: 'item' as const,
    refId: item.id,
    meta: { mode, code: item.code, level: item.level }
  };
  // Ключ на материал: в salvage их несколько, и все они — одно действие.
  const idempotencyKeyFor = (id: string): string => makeIdempotencyKey('dismantle', `${itemId}:${id}`);

  if (mode === 'scrap') {
    const junk = rollScrap(blueprint, rng);
    const gained = gainMaterials(withoutItem, junk, { ...ctxBase, idempotencyKeyFor });
    return { account: gained.account, drafts: gained.drafts, item, mode, salvage: {}, junk: gained.moved };
  }

  const salvage = salvageYield(blueprint, item.level);
  const gained = gainMaterials(withoutItem, salvage, { ...ctxBase, idempotencyKeyFor });
  return { account: gained.account, drafts: gained.drafts, item, mode, salvage: gained.moved, junk: {} };
}