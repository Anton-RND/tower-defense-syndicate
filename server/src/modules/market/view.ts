import {
  MARKET_COMMISSION,
  MARKET_CORRIDORS,
  MARKET_LOT_TTL_MS,
  MARKET_MAX_ACTIVE_LOTS,
  MARKET_MAX_LOT_UNITS,
  MARKET_MIN_LOT_UNITS
} from '../../config/market.js';
import { JUNK_IDS, type JunkId } from '../../config/workshop.js';
import { publicLabel } from '../pvp/matchmaking.js';
import type { UserAccount } from '../user/user.types.js';
import { lotTotal, type LotState, type LotStatus } from './lot.types.js';
import { lotNet } from './service.js';

/**
 * Витрина чёрного рынка (Часть 2).
 *
 * Клиенту отдаётся договорная пара цифр, а не одна: `total` платит покупатель,
 * `net` получает продавец, `commission` сгорает. Покажи витрина только `total`, и
 * продавец на ровном месте обнаружил бы «рынок съел 5%», которых ему не обещали.
 */
export interface LotView {
  id: string;
  /** Псевдоним продавца: чужой id наружу не идёт (см. pvp/matchmaking.publicLabel). */
  seller: string;
  /** true — лот свой: UI прячет «выкупить» и показывает «снять». */
  mine: boolean;
  junk: JunkId;
  amount: number;
  pricePerUnit: number;
  total: number;
  net: number;
  commission: number;
  status: LotStatus;
  expiresAt: Date;
  createdAt: Date;
}

export function describeLot(lot: LotState, viewerId: string): LotView {
  const net = lotNet(lot);
  return {
    id: lot.id,
    seller: lot.sellerId === viewerId ? 'вы' : publicLabel(lot.sellerId),
    mine: lot.sellerId === viewerId,
    junk: lot.junk,
    amount: lot.amount,
    pricePerUnit: lot.pricePerUnit,
    total: lotTotal(lot.amount, lot.pricePerUnit),
    net,
    commission: lot.total - net,
    status: lot.status,
    expiresAt: lot.expiresAt,
    createdAt: lot.createdAt
  };
}

/** Глубина рынка по виду хлама: «сколько вообще есть» и «почём крайние предложения». */
export interface DepthView {
  junk: JunkId;
  lots: number;
  units: number;
  minPerUnit: number;
  maxPerUnit: number;
}

export interface MarketView {
  /** Чужие активные лоты — то, что покупают. */
  lots: LotView[];
  /** Свои активные лоты — то, что продавец снимает или ждёт по ним денег. */
  mine: LotView[];
  depth: DepthView[];
  /** Хлам на складе зрителя: «что бы ещё выставить» без второго запроса. */
  myUnits: Record<JunkId, number>;
}

export function describeMarket(lots: readonly LotState[], viewer: UserAccount, limit: number): MarketView {
  const visible = [...lots]
    .sort((a, b) => a.pricePerUnit - b.pricePerUnit || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, Math.max(0, limit));

  const byJunk = new Map<JunkId, LotState[]>();
  for (const lot of visible) {
    const bucket = byJunk.get(lot.junk) ?? [];
    bucket.push(lot);
    byJunk.set(lot.junk, bucket);
  }

  // Глубина считается по ВСЕМ видимым лотам, включая свои: «на рынке 30 двигателей
  // по 40» — факт рынка, а не факт чужих объявлений.
  const depth: DepthView[] = JUNK_IDS.map((junk) => {
    const bucket = byJunk.get(junk) ?? [];
    const corridor = MARKET_CORRIDORS[junk];
    return {
      junk,
      lots: bucket.length,
      units: bucket.reduce((sum, lot) => sum + lot.amount, 0),
      minPerUnit: bucket.length ? Math.min(...bucket.map((lot) => lot.pricePerUnit)) : corridor.minPerUnit,
      maxPerUnit: bucket.length ? Math.max(...bucket.map((lot) => lot.pricePerUnit)) : corridor.maxPerUnit
    };
  });

  const described = visible.map((lot) => describeLot(lot, viewer.id));
  return {
    lots: described.filter((lot) => !lot.mine),
    mine: described.filter((lot) => lot.mine),
    depth,
    myUnits: { ...viewer.junk }
  };
}

/** Правила рынка наружу одним объектом: UI серит кнопки по ним, а не по догадкам. */
export function describeMarketRules() {
  return {
    commission: MARKET_COMMISSION,
    maxActiveLots: MARKET_MAX_ACTIVE_LOTS,
    lotTtlMs: MARKET_LOT_TTL_MS,
    minUnits: MARKET_MIN_LOT_UNITS,
    maxUnits: MARKET_MAX_LOT_UNITS,
    corridors: JUNK_IDS.map((junk) => ({ junk, ...MARKET_CORRIDORS[junk] }))
  };
}
