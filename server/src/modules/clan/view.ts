import { CLAN_CREATE_COST, CLAN_MAX_MEMBERS } from '../../config/clans.js';
import type { EconomyConfig } from '../../config/env.js';
import { METAL_IDS, type MetalsInventory } from '../../config/workshop.js';
import { contributionsToday, treasuryUnits, type ClanState, type ClanStatus } from './clan.types.js';
import type { UserAccount } from '../user/user.types.js';

/**
 * Витрина клана (Часть 2).
 *
 * Клиенту отдаётся состояние, а не доменный документ: список участников наружу не
 * идёт целиком (это персональные данные десятков людей на один запрос), а идёт счётчик
 * — его хватает и на «42/50», и на запрет вступления.
 */
export interface ClanView {
  id: string;
  name: string;
  tag: string;
  status: ClanStatus;
  leaderId: string;
  members: number;
  limit: number;
  treasury: MetalsInventory;
  treasuryUnits: number;
  /** Взносы, ещё не подтверждённые журналом: UI рисует по ним «обрабатывается». */
  pending: number;
  createdAt: Date;
  updatedAt: Date;
}

export function describeClan(clan: ClanState): ClanView {
  return {
    id: clan.id,
    name: clan.name,
    tag: clan.tag,
    status: clan.status,
    leaderId: clan.leaderId,
    members: clan.members.length,
    limit: CLAN_MAX_MEMBERS,
    treasury: { ...clan.treasury },
    treasuryUnits: treasuryUnits(clan),
    pending: clan.contributions.filter((c) => c.status === 'pending').length,
    createdAt: clan.createdAt,
    updatedAt: clan.updatedAt
  };
}

/** Что игрок внёс сегодня: витрина обязана показывать потолок до того, как он упрётся. */
export interface MyContributionView {
  count: number;
  units: number;
  dailyDeposits: number;
  dailyUnits: number;
}

export function describeMyContributions(
  clan: ClanState,
  userId: string,
  day: string,
  config: EconomyConfig
): MyContributionView {
  const today = contributionsToday(clan, userId, day);
  return {
    count: today.count,
    units: today.units,
    dailyDeposits: config.limits.clan.dailyDeposits,
    dailyUnits: config.limits.clan.dailyUnits
  };
}

export interface ClanMembershipView {
  clanId: string | null;
  /** null — игрока нет в клане (или его клан расформирован). */
  clan: ClanView | null;
  cost: number;
  asterium: number;
  canCreate: boolean;
  /** Причина отказа для UI: 'ok' | 'member' | 'funds' | 'debt'. */
  reason: 'ok' | 'member' | 'funds' | 'debt';
}

/**
 * Готовность основать клан — без бросания исключений, ровно как `describeBuilderShop`.
 *
 * Кнопка «Основать клан» не имеет права сереться от ошибки 409: фронт обязан показать
 * «нужно ещё 120 астерия» до нажатия, а не после.
 */
export function describeClanMembership(
  account: Pick<UserAccount, 'clanId' | 'materials'>,
  clan: ClanState | null,
  config: EconomyConfig
): ClanMembershipView {
  const total = account.materials.asterium.purchased + account.materials.asterium.earned;
  const base = {
    clanId: account.clanId,
    clan: clan ? describeClan(clan) : null,
    cost: CLAN_CREATE_COST,
    asterium: total
  };
  if (account.clanId) return { ...base, canCreate: false, reason: 'member' };
  // Долг по донату: платить можно только заработанным астерием (то же правило, что в магазине).
  if (account.materials.asterium.purchased < 0 && account.materials.asterium.earned < CLAN_CREATE_COST) {
    return { ...base, canCreate: false, reason: 'debt' };
  }
  if (total < CLAN_CREATE_COST) return { ...base, canCreate: false, reason: 'funds' };
  return { ...base, canCreate: true, reason: 'ok' };
}

/** Потолок казны по всем трём металлам — для прогресс-бара в интерфейсе клана. */
export function treasuryFill(clan: ClanState, cap: number): number {
  if (cap <= 0) return 0;
  const total = METAL_IDS.reduce((sum, id) => sum + (clan.treasury[id] ?? 0), 0);
  return Math.min(1, total / cap);
}
