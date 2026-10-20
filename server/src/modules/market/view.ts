import {
  MARKET_COMMISSION,
  MARKET_CORRIDORS,
  MARKET_LOT_TTL_MS,
  MARKET_MAX_ACTIVE_LOTS,
  MARKET_MAX_LOT_UNITS,
  MARKET_MIN_LOT_UNITS,
  MARKET_PRICE_DYNAMICS,
  hardBoundsOf,
  type CorridorBounds
} from '../../config/market.js';
import { JUNK_IDS, type JunkId } from '../../config/workshop.js';
import { NEUTRAL_FACTOR, scarcityIndex, type CommodityState } from './commodity.types.js';
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
  /**
   * Крайние ЦЕНЫ среди лотов этой витрины. Внимание: это не коридор, а факт
   * предложения — `minPerUnit` здесь может оказаться ниже коридорного минимума,
   * если объявление было выставлено при другом рынке (см. `corridor`).
   */
  minPerUnit: number;
  maxPerUnit: number;
  /** Текущий коридор: границы, в которые попадёт НОВОЕ объявление этого вида. */
  corridor: CorridorBounds;
  /** Абсолютные пределы коридора: дальше них динамика не уедет никогда. */
  hard: CorridorBounds;
  /** Эталонная ликвидность вида, ед.: при таком предложении коридор = якорь. */
  referenceUnits: number;
  /** Предложение по всему рынку (не по витрине), ед. */
  supply: number;
  /** Множитель дефицита: 1 — покой, больше — дефицит. */
  factor: number;
  /** Тот же множитель в масштабе [−1; +1]: −1 затоварено, +1 голод. */
  scarcity: number;
}

/**
 * Живой коридор вида наружу.
 *
 * Отсутствие снапшота трактуется КАК ПОКОЙ, а не как ошибка и не как «пустой
 * рынок»: документ товара создаётся первым же пересчётом, и до этого момента
 * игрок должен видеть ровно те границы, по которым рынок жил до появления
 * динамики. Показать `supply: 0` на ещё не рождённом товаре — значит наврать про
 * дефицит, которого никто не мерил.
 */
function corridorView(
  junk: JunkId,
  state: CommodityState | undefined
): { corridor: CorridorBounds; hard: CorridorBounds; referenceUnits: number; supply: number; factor: number; scarcity: number } {
  const anchor = MARKET_CORRIDORS[junk];
  const fallback = { minPerUnit: anchor.minPerUnit, maxPerUnit: anchor.maxPerUnit };
  return {
    corridor: state ? { minPerUnit: state.minPerUnit, maxPerUnit: state.maxPerUnit } : fallback,
    hard: hardBoundsOf(junk) as CorridorBounds,
    referenceUnits: anchor.referenceUnits,
    supply: state ? state.supply : anchor.referenceUnits,
    factor: state ? state.factor : NEUTRAL_FACTOR,
    scarcity: state ? scarcityIndex(state) : 0
  };
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

export function describeMarket(
  lots: readonly LotState[],
  viewer: UserAccount,
  limit: number,
  commodities?: readonly CommodityState[]
): MarketView {
  const visible = [...lots]
    .sort((a, b) => a.pricePerUnit - b.pricePerUnit || a.createdAt.getTime() - b.createdAt.getTime())
    .slice(0, Math.max(0, limit));

  const byJunk = new Map<JunkId, LotState[]>();
  for (const lot of visible) {
    const bucket = byJunk.get(lot.junk) ?? [];
    bucket.push(lot);
    byJunk.set(lot.junk, bucket);
  }
  const snapshot = new Map<JunkId, CommodityState>((commodities ?? []).map((state) => [state.junk, state]));

  // Глубина считается по ВСЕМ видимым лотам, включая свои: «на рынке 30 двигателей
  // по 40» — факт рынка, а не факт чужих объявлений.
  const depth: DepthView[] = JUNK_IDS.map((junk) => {
    const bucket = byJunk.get(junk) ?? [];
    const anchor = MARKET_CORRIDORS[junk];
    return {
      junk,
      lots: bucket.length,
      units: bucket.reduce((sum, lot) => sum + lot.amount, 0),
      minPerUnit: bucket.length ? Math.min(...bucket.map((lot) => lot.pricePerUnit)) : anchor.minPerUnit,
      maxPerUnit: bucket.length ? Math.max(...bucket.map((lot) => lot.pricePerUnit)) : anchor.maxPerUnit,
      ...corridorView(junk, snapshot.get(junk))
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

/**
 * Правила рынка наружу одним объектом: UI серит кнопки по ним, а не по догадкам.
 *
 * `corridors` — ТЕКУЩИЕ границы, а не якорь: селект вида хлама в панели обязан
 * показывать тот диапазон, который примет объявление сейчас. Якорь и пределы
 * едут рядом отдельными полями, чтобы игрок видел не только «мне можно от 40 до
 * 90», но и «это потому, что на рынке 1200 двигателей при эталоне 250».
 */
export function describeMarketRules(commodities?: readonly CommodityState[]) {
  const snapshot = new Map<JunkId, CommodityState>((commodities ?? []).map((state) => [state.junk, state]));
  return {
    commission: MARKET_COMMISSION,
    maxActiveLots: MARKET_MAX_ACTIVE_LOTS,
    lotTtlMs: MARKET_LOT_TTL_MS,
    minUnits: MARKET_MIN_LOT_UNITS,
    maxUnits: MARKET_MAX_LOT_UNITS,
    dynamics: {
      elasticity: MARKET_PRICE_DYNAMICS.elasticity,
      factorFloor: MARKET_PRICE_DYNAMICS.factorFloor,
      factorCeil: MARKET_PRICE_DYNAMICS.factorCeil,
      maxMoveRatio: MARKET_PRICE_DYNAMICS.maxMoveRatio,
      cooldownMs: MARKET_PRICE_DYNAMICS.cooldownMs
    },
    corridors: JUNK_IDS.map((junk) => ({ junk, ...corridorView(junk, snapshot.get(junk)) }))
  };
}
