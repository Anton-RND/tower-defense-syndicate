import type { LedgerDraft, LedgerEntry, LedgerQuery } from './ledger.types.js';

/**
 * Append-only журнал денег.
 *
 * Почему отдельная коллекция, а не массив в документе игрока:
 *  1) журнал безграничен растёт, а Mongo ограничивает документ 16 МБ;
 *  2) запись журнала не должна сбивать `revision` игрока и провоцировать CAS-конфликты;
 *  3) сверка с агентом выплат и антифрод читают именно журнал, а не состояние.
 *
 * Порядок фиксации (важно): сначала `UserStore.transact()` успешно меняет аккаунт,
 * затем `append()` пишет факт. Идемпотентность повторной выдачи обеспечивает не журнал,
 * а состояние аккаунта (заказ/`ads.pending`), защищённое CAS. Поэтому журнал — это
 * «журнал фактов», а не механизм блокировки двойных трат.
 */
export interface LedgerStore {
  readonly driver: 'memory' | 'mongo';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  /** @returns true — записано; false — такой idempotencyKey уже есть (дубль вебхука). */
  append(entry: LedgerEntry): Promise<boolean>;

  /**
   * Есть ли в журнале движение с таким ключом идемпотентности.
   *
   * Нужен не для блокировки (блокирует состояние аккаунта), а для РАЗБОРА половинчатых
   * операций: клановый вклад и оплата основания пишутся в два разных документа, и
   * единственный честный арбитр «игрок реально заплатил» — запись в журнале.
   */
  hasKey(idempotencyKey: string): Promise<boolean>;

  /** Пачка движений одного действия (например, сбор 4 ресурсов). Возвращает число новых. */
  appendMany(entries: LedgerEntry[]): Promise<number>;

  list(userId: string, query?: LedgerQuery): Promise<LedgerEntry[]>;

  /** Сумма дельт по валюты и окну — для отчётов (ARPPU, выдача за рекламу, потери рейдов). */
  sum(userId: string, currency: LedgerDraft['currency'], query?: LedgerQuery): Promise<number>;

  count(userId?: string): Promise<number>;
}