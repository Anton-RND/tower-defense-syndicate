import { Schema, type Connection, type Model } from 'mongoose';

import { METAL_IDS, type MetalId, type MetalsInventory } from '../../config/workshop.js';
import type { ClanContribution, ClanState, ClanStatus, ContributionStatus } from './clan.types.js';

/**
 * Документ `clans` в Mongo (Часть 2).
 *
 * Вложенные док-типы используют `cid` вместо `id` по той же причине, что и документ
 * игрока: в Mongoose `id` — служебный виртуальный путь, и переопределять его своими
 * данными сознательно не стали.
 */
interface ContributionDoc {
  cid: string;
  userId: string;
  metal: string;
  amount: number;
  createdAt: Date;
  settledAt: Date | null;
  status: string;
  note: string | null;
}

type TreasuryDoc = MetalsInventory;

export interface ClanDoc {
  _id: string;
  name: string;
  tag: string;
  leaderId: string;
  members: string[];
  status: string;
  treasury: TreasuryDoc;
  contributions: ContributionDoc[];
  createdAt: Date;
  updatedAt: Date;
  note: string | null;
  revision: number;
}

const treasurySchema = new Schema<TreasuryDoc>(
  {
    black_metal: { type: Number, required: true, default: 0, min: 0 },
    colored_metal: { type: Number, required: true, default: 0, min: 0 },
    precious_metal: { type: Number, required: true, default: 0, min: 0 }
  },
  { _id: false }
);

const contributionSchema = new Schema<ContributionDoc>(
  {
    cid: { type: String, required: true },
    userId: { type: String, required: true },
    metal: { type: String, required: true, enum: [...METAL_IDS] },
    amount: { type: Number, required: true, min: 1 },
    createdAt: { type: Date, required: true },
    settledAt: { type: Date, default: null },
    status: { type: String, required: true, enum: ['pending', 'settled', 'void'] },
    note: { type: String, default: null }
  },
  { _id: false }
);

export const clanSchema = new Schema<ClanDoc>(
  {
    _id: { type: String, required: true },
    name: { type: String, required: true, minlength: 3, maxlength: 24 },
    tag: { type: String, required: true, uppercase: true },
    leaderId: { type: String, required: true },
    members: { type: [String], default: [] },
    status: { type: String, required: true, enum: ['pending_payment', 'active', 'void'] },
    treasury: { type: treasurySchema, required: true, default: () => ({}) },
    contributions: { type: [contributionSchema], default: [] },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
    note: { type: String, default: null },
    revision: { type: Number, required: true, default: 0 }
  },
  { collection: 'clans', versionKey: false }
);

/**
 * Занятость имени — индексом, а не «проверкой перед вставкой».
 *
 * Проверка `findByName` → `insert` без уникального индекса даёт гонку: два игрока
 * с одинаковым названием проходят проверку и получают по два клана и по два списания
 * критания. Индекс делает второй `insert` отказом, и отказом дешёвым.
 */
clanSchema.index({ name: 1 }, { unique: true, name: 'uniq_clan_name' });
/** «В каком я клане» и разбор членства: массив участников индексируется по элементам. */
clanSchema.index({ members: 1 }, { name: 'idx_clan_members' });
/** Разбор зависших pending-взносов (reconcile) — выборка по статусу и возрасту. */
clanSchema.index({ status: 1, 'contributions.createdAt': 1 }, { name: 'idx_clan_pending' });

function contributionFromDoc(doc: ContributionDoc): ClanContribution {
  return {
    id: doc.cid,
    userId: doc.userId,
    metal: doc.metal as MetalId,
    amount: doc.amount,
    createdAt: new Date(doc.createdAt),
    settledAt: doc.settledAt ? new Date(doc.settledAt) : null,
    status: doc.status as ContributionStatus,
    note: doc.note ?? null
  };
}

function contributionToDoc(contribution: ClanContribution): ContributionDoc {
  return {
    cid: contribution.id,
    userId: contribution.userId,
    metal: contribution.metal,
    amount: contribution.amount,
    createdAt: contribution.createdAt,
    settledAt: contribution.settledAt ?? null,
    status: contribution.status,
    note: contribution.note ?? null
  };
}

export function toClan(doc: ClanDoc): ClanState {
  return {
    id: String(doc._id),
    name: doc.name,
    tag: doc.tag,
    leaderId: doc.leaderId,
    members: [...(doc.members ?? [])],
    status: doc.status as ClanStatus,
    treasury: {
      black_metal: doc.treasury?.black_metal ?? 0,
      colored_metal: doc.treasury?.colored_metal ?? 0,
      precious_metal: doc.treasury?.precious_metal ?? 0
    },
    contributions: (doc.contributions ?? []).map(contributionFromDoc),
    createdAt: new Date(doc.createdAt),
    updatedAt: new Date(doc.updatedAt),
    note: doc.note ?? null,
    revision: doc.revision
  };
}

/** Поля для `$set` (без `_id`). */
export function toSetPayload(clan: ClanState): Omit<ClanDoc, '_id'> {
  return {
    name: clan.name,
    tag: clan.tag,
    leaderId: clan.leaderId,
    members: [...clan.members],
    status: clan.status,
    treasury: { ...clan.treasury },
    contributions: clan.contributions.map(contributionToDoc),
    createdAt: clan.createdAt,
    updatedAt: clan.updatedAt,
    note: clan.note ?? null,
    revision: clan.revision
  };
}

export type ClanModel = Model<ClanDoc>;

export function createClanModel(connection: Connection): ClanModel {
  return connection.model<ClanDoc>('Clan', clanSchema);
}
