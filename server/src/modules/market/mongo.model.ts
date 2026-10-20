import { Schema, type Connection, type Model } from 'mongoose';

import type { LotState, LotStatus } from './lot.types.js';
import type { JunkId } from '../../config/workshop.js';
import { JUNK_IDS } from '../../config/workshop.js';

/** Плоский документ лота. Вложенных массивов нет — в отличие от клана, весь лот скалярен. */
export interface LotDoc {
  _id: string;
  sellerId: string;
  junk: string;
  amount: number;
  pricePerUnit: number;
  total: number;
  status: string;
  buyerId: string | null;
  purchasedAt: Date | null;
  payoutSettled: boolean;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  revision: number;
}

export const lotSchema = new Schema<LotDoc>(
  {
    _id: { type: String, required: true },
    sellerId: { type: String, required: true },
    junk: { type: String, required: true, enum: [...JUNK_IDS] },
    amount: { type: Number, required: true, min: 1 },
    pricePerUnit: { type: Number, required: true, min: 1 },
    total: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      required: true,
      enum: ['pending_escrow', 'listed', 'sold', 'cancelled', 'expired']
    },
    buyerId: { type: String, default: null },
    purchasedAt: { type: Date, default: null },
    payoutSettled: { type: Boolean, required: true, default: false },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    revision: { type: Number, required: true, default: 0 }
  },
  { collection: 'market_lots', versionKey: false }
);

/**
 * Витрина = «активные лоты по цене». Без этого индекса лента рынка — полный сбор
 * коллекции с сортировкой в памяти mongo, и растёт она линейно с историей торгов,
 * а не с числом живых объявлений.
 */
lotSchema.index({ status: 1, pricePerUnit: 1, createdAt: 1 }, { name: 'idx_lot_feed' });
/** Потолок активных лотов одного продавца (`countActiveBySeller`). */
lotSchema.index({ sellerId: 1, status: 1 }, { name: 'idx_lot_seller' });
/** Разбор зависших: просроченные витринные и проданные без выплаты. */
lotSchema.index({ status: 1, expiresAt: 1 }, { name: 'idx_lot_expiry' });
lotSchema.index({ status: 1, payoutSettled: 1 }, { name: 'idx_lot_payout' });

export function toLot(doc: LotDoc): LotState {
  return {
    id: String(doc._id),
    sellerId: doc.sellerId,
    junk: doc.junk as JunkId,
    amount: doc.amount,
    pricePerUnit: doc.pricePerUnit,
    total: doc.total,
    status: doc.status as LotStatus,
    buyerId: doc.buyerId ?? null,
    purchasedAt: doc.purchasedAt ? new Date(doc.purchasedAt) : null,
    payoutSettled: doc.payoutSettled === true,
    createdAt: new Date(doc.createdAt),
    updatedAt: new Date(doc.updatedAt),
    expiresAt: new Date(doc.expiresAt),
    revision: doc.revision
  };
}

/** Поля для `$set` (без `_id`). */
export function toLotSetPayload(lot: LotState): Omit<LotDoc, '_id'> {
  return {
    sellerId: lot.sellerId,
    junk: lot.junk,
    amount: lot.amount,
    pricePerUnit: lot.pricePerUnit,
    total: lot.total,
    status: lot.status,
    buyerId: lot.buyerId,
    purchasedAt: lot.purchasedAt,
    payoutSettled: lot.payoutSettled,
    createdAt: lot.createdAt,
    updatedAt: lot.updatedAt,
    expiresAt: lot.expiresAt,
    revision: lot.revision
  };
}

export type LotModel = Model<LotDoc>;

export function createLotModel(connection: Connection): LotModel {
  return connection.model<LotDoc>('MarketLot', lotSchema);
}
