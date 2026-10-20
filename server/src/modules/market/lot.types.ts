import { isJunkId, junkTotal, JUNK_IDS, type JunkId } from '../../config/workshop.js';

/**
 * Состояние лота (Часть 2, чёрный рынок).
 *
 * Лот — ТРЕТЬЯ учётная сущность проекта, и она не помещается ни в документ игрока,
 * ни в журнал:
 *  - в документе игрока лот жил бы чужой ценностью (продавец удалил аккаунт — а лот
 *    висит), и его нельзя было показать витрине, не собрав N документов;
 *  - в журнале лот был бы не движением, а объектом со сроком жизни и статусом.
 * Поэтому отдельный документ, ровно как клан, и по той же причине: у него есть
 * собственная конкуренция читателей (двое купили один лот одновременно), которую
 * решает CAS по `revision`, а не «прочитали и записали».
 */

/**
 * Статусы лота.
 *
 * `pending_escrow` и `sold` без `payoutSettled` разведены намеренно: и то и другое —
 * следование «дописи не хватает», и оба читаются журналом как арбитром.
 *  - `pending_escrow` — документ лота уже есть, а хлам у продавца ещё НЕ списан.
 *    В витрине его не существует: показать товар, которого нет, значит продать его
 *    дважды. Падение после вставки оставляет именно это состояние, и reconcile
 *    активзирует лот по доказательству списания в журнале (или отменяет).
 *  - `sold` + `payoutSettled: false` — покупатель заплатил, продавец ещё не получил.
 * Смешай их с рабочими статусами — и «продано» станет вопросом о том, успела ли
 * дописаться третья запись.
 */
export type LotStatus = 'pending_escrow' | 'listed' | 'sold' | 'cancelled' | 'expired';

export interface LotState {
  id: string;
  sellerId: string;
  junk: JunkId;
  amount: number;
  /** Цена за единицу, SEC. Хранится именно за единицу: коридор задан на неё же. */
  pricePerUnit: number;
  /** amount × pricePerUnit. Держим вычисленное, чтобы витрина не перемножала заново. */
  total: number;
  status: LotStatus;
  /** Покупатель. Заполняется в момент атомарного захвата лота. */
  buyerId: string | null;
  purchasedAt: Date | null;
  /** true — деньги продавцу доведены. `false` на sold лоте = работа для reconcile. */
  payoutSettled: boolean;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  revision: number;
}

export function lotTotal(amount: number, pricePerUnit: number): number {
  return amount * pricePerUnit;
}

/** Лот можно захватить: он выставлен, не просрочен и не чужой покупателю. */
export function isClaimable(lot: LotState, buyerId: string, now: Date): boolean {
  return (
    lot.status === 'listed' &&
    lot.expiresAt.getTime() > now.getTime() &&
    lot.sellerId !== buyerId
  );
}

/** Активен ли лот для витрины и для захвата (эскроу уже подтверждён). */
export function isActiveLot(lot: LotState): boolean {
  return lot.status === 'listed';
}

/** Лот вставлен, но хлам ещё не списан: не виден никому, кроме reconcile. */
export function isPendingEscrow(lot: LotState): boolean {
  return lot.status === 'pending_escrow';
}

/** Просрочен, но всё ещё висит в витрине: такие лоты возвращают хлам продавцу. */
export function isExpired(lot: LotState, now: Date): boolean {
  return lot.status === 'listed' && lot.expiresAt.getTime() <= now.getTime();
}

export function cloneLot(lot: LotState): LotState {
  return {
    ...lot,
    createdAt: new Date(lot.createdAt),
    updatedAt: new Date(lot.updatedAt),
    expiresAt: new Date(lot.expiresAt),
    purchasedAt: lot.purchasedAt ? new Date(lot.purchasedAt) : null
  };
}

/** Guard для HTTP-параметров: вид хлама приходит из тела запроса. */
export function isLotJunkId(value: string): value is JunkId {
  return isJunkId(value);
}

/** Сколько единиц хлама у игрока сейчас (для проверки потолка перед покупкой). */
export function junkUnitsOf(account: { junk: Record<JunkId, number> }): number {
  return junkTotal(account.junk);
}

/**
 * Карта предложения, заполненная нулями по всем шести видам.
 *
 * Заполненная, а не пустая: `sumActiveUnits` обязан отличать «этого хлама на рынке
 * нет» (0 → максимум дефицита, коридор едет вверх) от «мы не спросили» (undefined
 * → пересчёт падает или, что хуже, молча принимает 1). Нули — единственная форма,
 * при которой отсутствие лотов вида остаётся экономическим сигналом.
 */
export function emptyJunkTotals(): Record<JunkId, number> {
  const totals = {} as Record<JunkId, number>;
  for (const id of JUNK_IDS) totals[id] = 0;
  return totals;
}

