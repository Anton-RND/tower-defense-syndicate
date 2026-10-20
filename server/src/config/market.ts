import { JUNK_IDS, type JunkId } from './workshop.js';

/**
 * Чёрный рынок (Часть 2): P2P-торговля боевым хламом за SEC.
 *
 * Зачем рынку быть, если есть цех переработки. Переработка — это фиксированный
 * курс, выставленный нами: 50 чипов → 100 драгметалла + 50 цветмета + 50 хрониума.
 * Такой курс делает хлам товаром одного назначения, и игрок с избытком двигателей
 * не может сказать «мне сейчас нужнее вольфрам». Рынок заменяет один фиксированный
 * курс тысячей договорных цен: хлам получает ПЛАВУЧУЮ стоимость, а SEC — второй
 * сток помимо ASIC-стоек (P1).
 *
 * ПОЧЕМУ КОМИССИЯ С НИЧЕГО, А НЕ ПЛАТА ЗА ВЫСТАВЛЕНИЕ. Плата за листинг — это
 * барьер на входе: игрок с полным складом хлама и пустым кошельком не смог бы начать
 * торговать, то есть мы вернули бы ровно тот класс взаимоблокировки, который P0
 * вылечил для стартового комплекта, а P1 — для первой ASIC-стойки. Комиссия с
 * продажи барьера не создаёт: платить нечем только в том случае, если продавать
 * нечего. Она же — настоящий сток: удержанные монеты НИКУДА не переводятся, а
 * сгорают, понижая общую эмиссию SEC.
 *
 * ПОЧЕМУ КОМИССИЯ НЕ РАВНЯЕТСЯ НУЛЮ НА МЕЛКИХ ЛОТАХ. 5% от 10 SEC = 0,5, и округление
 * вниз подарила бы продавцу половину монеты на каждой сделке, а вверх — оштрафовала бы
 * мелкий лот относительно крупного. Округляем вниз и НЕ скрываем это: цена лота
 * ограничена снизу коридором, поэтому «комиссия 0» возможна только на сознательно
 * дешёвом лоте и видна в витрине как 0.
 */

/** Доля цены, удерживаемая рынком при продаже. Сгорает, а не переходит платформе-владельцу. */
export const MARKET_COMMISSION = 0.05;

/** Сколько лотов продавец может держать выставленными одновременно. Анти-спам без платы на вход. */
export const MARKET_MAX_ACTIVE_LOTS = 10;

/** Срок жизни лота. Протухший возвращается продавцу: хлам не должен исчезать из-за сна игрока. */
export const MARKET_LOT_TTL_MS = 24 * 60 * 60_000;

/** Потолок единиц хлама в одном лоте: держит размер документа и делает Depth читаемым. */
export const MARKET_MAX_LOT_UNITS = 1_000;

/** Минимум в лоте: одиночная гильза за 1 SEC — шум в витрине, а не предложение. */
export const MARKET_MIN_LOT_UNITS = 1;

/**
 * Коридор цены за единицу, SEC.
 *
 * Рынок без коридора — это не рынок, а площадка для двух дефектов:
 *  1. лот за 1 SEC выкупает сам себя подставным аккаунтом и превращает астерий,
 *     заработанный рекламой, в переток монеты между своими же кошельками;
 *  2. лот за 10^9 SEC делает витрину бесполезной — игрок открывает список и не
 *     видит ничего применимого.
 * Границы выставлены от стоимости переработки того же хлама (config/workshop.ts:
 * RECYCLE_RECIPES): нижняя — чтобы рынок не уполномочивал демпинг ниже цеха,
 * верхняя — чтобы тираж монеты не обесценивал витрину.
 */
export interface Corridor {
  minPerUnit: number;
  maxPerUnit: number;
}

export const MARKET_CORRIDORS: Readonly<Record<JunkId, Corridor>> = {
  chips: { minPerUnit: 5, maxPerUnit: 200 },
  boards: { minPerUnit: 10, maxPerUnit: 400 },
  batteries: { minPerUnit: 4, maxPerUnit: 150 },
  ammo_casings: { minPerUnit: 2, maxPerUnit: 80 },
  transmissions: { minPerUnit: 20, maxPerUnit: 800 },
  engines: { minPerUnit: 30, maxPerUnit: 1_200 }
};

/** Сколько активных лотов рынка держит витрина одного запроса. */
export const MARKET_FEED_LIMIT = 50;

const corridorSet: ReadonlySet<string> = new Set<string>(JUNK_IDS);

export function isJunkTradable(id: string): id is JunkId {
  return corridorSet.has(id);
}

/** Границы для вида хлама; undefined — вид на рынок не пускается. */
export function corridorOf(id: string): Corridor | undefined {
  return isJunkTradable(id) ? MARKET_CORRIDORS[id] : undefined;
}

/** Комиссия с продажи, целое число монет (округление вниз — см. шапку файла). */
export function marketCommission(total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.floor(total * MARKET_COMMISSION);
}

/** Цена за единицу проходит свой коридор? */
export function priceWithinCorridor(id: string, perUnit: number): boolean {
  const corridor = corridorOf(id);
  if (!corridor) return false;
  return Number.isInteger(perUnit) && perUnit >= corridor.minPerUnit && perUnit <= corridor.maxPerUnit;
}
