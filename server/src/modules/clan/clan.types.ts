import {
  CLAN_NAME_MAX_LENGTH,
  CLAN_NAME_MIN_LENGTH,
  CLAN_NAME_PATTERN,
  CLAN_TAG_MAX_LENGTH,
  CLAN_TAG_MIN_LENGTH,
  CLAN_TAG_PATTERN
} from '../../config/clans.js';
import { emptyMetals, METAL_IDS, type MetalId, type MetalsInventory } from '../../config/workshop.js';

/**
 * Клан как доменная сущность (Часть 2).
 *
 * КЛАН — ОТДЕЛЬНЫЙ ДОКУМЕНТ, И ЭТО НЕ ВОПРОС ЭКОНОМИИ. Казну и состав читают и пишут
 * десятки разных игроков, а `UserStore` атомарен в пределах одного документа игрока.
 * Держать казну внутри документа участника означало бы, что взнос одного меняет
 * документы всех остальных. Здесь же клан живёт своей записью со своим CAS-счётчиком
 * (`revision`), а игрок хранит только `clanId` — кэш членства для быстрого вопроса
 * «в каком я клане» (источник истины при расхождении — клан, см. clan/commit.ts).
 *
 * СТАТУСЫ, А НЕ БуЛЕВЫ ФЛАГИ. `pending_payment` → `active` → `void` кодируют ровно
 * то, на какой стадии двухдокументной операции находится основание клана: оплата
 * астерием и вставка записи клана не могут быть одной транзакцией, и честный ответ
 * на вопрос «а клан-то оплачен?» — это состояние, а не догадка по наличию лидера.
 */

export type ClanStatus = 'pending_payment' | 'active' | 'void';

/** Взнос в казну. Один вклад одного игрока — одна запись с собственным id. */
export type ContributionStatus = 'pending' | 'settled' | 'void';

export interface ClanContribution {
  /** depositId: по нему же ключ идемпотентности списания у игрока (`deposit:<id>`). */
  id: string;
  userId: string;
  metal: MetalId;
  amount: number;
  createdAt: Date;
  settledAt: Date | null;
  status: ContributionStatus;
  /** Причина аннулирования («charge_failed», «expired», …) — для разбора и тикетов. */
  note: string | null;
}

export interface ClanState {
  id: string;
  /** Каноническое имя (после normalizeClanName): уникальность держится по нему. */
  name: string;
  tag: string;
  leaderId: string;
  /** Участники, включая лидера. Порядок = порядок вступления (для передачи лидерства). */
  members: string[];
  status: ClanStatus;
  /** Казна: только settled-взносы. Pending в ней НЕ учитывается — см. шапку commit.ts. */
  treasury: MetalsInventory;
  /** Журнал взносов: источник истины для неразобранных pending-записей. */
  contributions: ClanContribution[];
  createdAt: Date;
  updatedAt: Date;
  /** Причина аннулирования («unpaid_timeout», «disbanded», …) — для поддержки и reconcile. */
  note: string | null;
  /** Версия записи — CAS-блокировка, тот же механизм, что у игрока. */
  revision: number;
}

export function emptyTreasury(): MetalsInventory {
  return emptyMetals();
}

export function isMetalId(value: string): value is MetalId {
  return (METAL_IDS as readonly string[]).includes(value);
}

/**
 * Нормализация имени: последовательности пробелов в один, trim, нижний регистр.
 *
 * Без этого `unique: true` на имени бесполезен — «Клан », «клан» и «Клан» стали бы
 * тремя разными кланами, а таблица кланов превратилась бы в свалку похожих названий.
 */
export function normalizeClanName(raw: string): string {
  return String(raw ?? '').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('ru');
}

export type NameCheck = { ok: true; name: string } | { ok: false; reason: 'empty' | 'short' | 'long' | 'chars' };

export function checkClanName(raw: string): NameCheck {
  const name = normalizeClanName(raw);
  if (name.length === 0) return { ok: false, reason: 'empty' };
  if (name.length < CLAN_NAME_MIN_LENGTH) return { ok: false, reason: 'short' };
  if (name.length > CLAN_NAME_MAX_LENGTH) return { ok: false, reason: 'long' };
  // Регистр и пробелы уже нормализованы, поэтому проверяем нормализованную форму.
  if (!CLAN_NAME_PATTERN.test(name)) return { ok: false, reason: 'chars' };
  return { ok: true, name };
}

export type TagCheck = { ok: true; tag: string } | { ok: false };

/** Тег: заглавные буквы/цифры. Пустой вход — не ошибка, а «сгенерируй из имени». */
export function checkClanTag(raw: string | null | undefined): TagCheck | null {
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const tag = String(raw).replace(/\s+/gu, '').toLocaleUpperCase('ru');
  if (tag.length < CLAN_TAG_MIN_LENGTH || tag.length > CLAN_TAG_MAX_LENGTH) return { ok: false };
  if (!CLAN_TAG_PATTERN.test(tag)) return { ok: false };
  return { ok: true, tag };
}

export function clanMemberCount(clan: ClanState): number {
  return clan.members.length;
}

export function isMember(clan: ClanState, userId: string): boolean {
  return clan.members.includes(userId);
}

export function isLeader(clan: ClanState, userId: string): boolean {
  return clan.leaderId === userId;
}

/** Сумма всех металлов в казне — для потолка казны и витрины. */
export function treasuryUnits(clan: ClanState): number {
  return METAL_IDS.reduce((total, id) => total + clan.treasury[id], 0);
}

/** Взносы игрока за сутки UTC (включая pending: лимит — на попытки, а не на успех). */
export function contributionsToday(clan: ClanState, userId: string, day: string): { count: number; units: number } {
  let count = 0;
  let units = 0;
  for (const contribution of clan.contributions) {
    if (contribution.userId !== userId) continue;
    if (contribution.createdAt.toISOString().slice(0, 10) !== day) continue;
    if (contribution.status === 'void') continue;
    count += 1;
    units += contribution.amount;
  }
  return { count, units };
}

export function cloneClan(clan: ClanState): ClanState {
  return {
    ...clan,
    members: [...clan.members],
    treasury: { ...clan.treasury },
    contributions: clan.contributions.map((contribution) => ({ ...contribution })),
    createdAt: new Date(clan.createdAt),
    updatedAt: new Date(clan.updatedAt)
  };
}
