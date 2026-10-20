import { Schema, type Connection, type Model } from 'mongoose';

import type { LedgerEntry } from './ledger.types.js';

/** Документ `ledger`. `_id` — наш строковый id, генерирует вызывающий код. */
export interface LedgerDoc {
  _id: string;
  userId: string;
  currency: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  refType: string | null;
  refId: string | null;
  idempotencyKey: string | null;
  ts: Date;
  meta?: Record<string, string | number | boolean | null>;
}

const ledgerSchema = new Schema<LedgerDoc>(
  {
    _id: { type: String, required: true },
    userId: { type: String, required: true },
    currency: { type: String, required: true },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    reason: { type: String, required: true },
    refType: { type: String, default: null },
    refId: { type: String, default: null },
    idempotencyKey: { type: String, default: null },
    ts: { type: Date, required: true },
    // Mixed-поле: состав движения (sku, amountRub, adNetwork…) — схема не строгая намеренно.
    meta: { type: Schema.Types.Mixed, default: undefined }
  },
  { collection: 'ledger', versionKey: false, timestamps: false }
);

// Защита от двойного вебхука/ретрая клиента: одна идемпотентная операция = одна запись.
ledgerSchema.index({ idempotencyKey: 1 }, { unique: true, sparse: true, name: 'uniq_idempotency_key' });
// Лента движений игрока (UI истории и антифрод-выгрузки).
ledgerSchema.index({ userId: 1, ts: -1 }, { name: 'idx_user_ts' });
// Выборки вида «все purchase за месяц» для сверки с агентом выплат.
ledgerSchema.index({ userId: 1, reason: 1, ts: -1 }, { name: 'idx_user_reason_ts' });

export function toLedgerEntry(doc: LedgerDoc): LedgerEntry {
  return {
    id: String(doc._id),
    userId: doc.userId,
    currency: doc.currency as LedgerEntry['currency'],
    delta: doc.delta,
    balanceAfter: doc.balanceAfter,
    reason: doc.reason as LedgerEntry['reason'],
    refType: (doc.refType ?? null) as LedgerEntry['refType'],
    refId: doc.refId ?? null,
    idempotencyKey: doc.idempotencyKey ?? null,
    ts: new Date(doc.ts),
    meta: doc.meta ?? undefined
  };
}

export type LedgerModel = Model<LedgerDoc>;

export function createLedgerModel(connection: Connection): LedgerModel {
  return connection.model<LedgerDoc>('Ledger', ledgerSchema, 'ledger');
}