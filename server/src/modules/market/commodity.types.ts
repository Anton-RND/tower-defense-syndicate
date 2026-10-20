import {
  MARKET_CORRIDORS,
  MARKET_PRICE_DYNAMICS,
  corridorAt,
  hardBoundsOf,
  priceWithinBounds,
  scarcityFactorOf,
  type CorridorBounds
} from '../../config/market.js';
import type { JunkId } from '../../config/workshop.js';

/**
 * Снапшот товара рынка (Часть 2, P5): четвёртая учётная сущность после игрока,
 * клана и лота.
 *
 * ПОЧЕМУ ВООБЩЕ НУЖЕН ОТДЕЛЬНЫЙ ДОКУМЕНТ. Казалось бы, коридор — производная от
 * предложения, и считай его на каждом запросе. Но «производная» здесь не функция:
 * граница двигается к цели ПОПРОЦЕНТНЫМ ШАГОМ от того места, где она была, то есть
 * следующее значение зависит от предыдущего. Без памяти о предыдущем значении
 * ползучий коридор невозможно выразить формулой, и память эта должна переживать
 * рестарт процесса: иначе перезагрузка сервера обрубила бы край коридора к якорю,
 * а игрок, выставивший объявление вчера, обнаружил бы его вне рынка.
 *
 * ПОЧЕМУ НЕ ПОЛЕ В ДОКУМЕНТЕ ЛОТА. Лотов десятки, товар один; дёргать документ
 * каждого лота ради пересчёта края — это лишние записи ради значения, которое
 * читает вся витрина.
 *
 * ПОЧЕМУ НЕ ПОЛЕ В ДОКУМЕНТЕ ИГРОКА. Цена товара не принадлежит никому из
 * торгующих: и продавец, и покупатель видят один коридор и спорить о нём не должны.
 */

/**
 * Состояние товара.
 *
 * `factor` — первоисточник, `minPerUnit`/`maxPerUnit` — его производные до целых
 * монет. Держим и то и другое, а не вычисляем границы из множителя на каждом
 * чтении, по той же причине, что и `total` у лота: витрина не должна перемножать
 * заново, а игрок, сравнивший два соседних запроса, не должен видеть разных чисел
 * из одного и того же множителя.
 */
export interface CommodityState {
  junk: JunkId;
  /** Множитель дефицита: 1 — рынок в покое, >1 — дефицит, <1 — затоваривание. */
  factor: number;
  minPerUnit: number;
  maxPerUnit: number;
  /** Предложение, по которому посчитан последний пересчёт, единицы хлама. */
  supply: number;
  /** Абсолютные пределы динамики: дальше них коридор не уезжает никогда. */
  hardMinPerUnit: number;
  hardMaxPerUnit: number;
  /** Когда этот вид последний раз ПЫТАЛСЯ пересчитать (пауза `cooldownMs`). */
  repricedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
}

/** Множитель, с которым коридор равен якорю: им и измеряется «покой». */
export const NEUTRAL_FACTOR = 1;

export function cloneCommodity(state: CommodityState): CommodityState {
  return {
    ...state,
    repricedAt: new Date(state.repricedAt),
    createdAt: new Date(state.createdAt),
    updatedAt: new Date(state.updatedAt)
  };
}

/**
 * Товар в состоянии покоя: множитель 1, границы = якорный коридор из конфига.
 *
 * Именно это значение видит рынок ДО первого пересчёта, и именно к нему
 * возвращается витрина при эталонном предложении. Случай «документа нет» и случай
 * «рынок ровный» сознательно неразличимы: для листинга это одно и то же.
 */
export function neutralCommodity(junk: JunkId, now: Date): CommodityState {
  const corridor = MARKET_CORRIDORS[junk];
  const hard = hardBoundsOf(junk) as CorridorBounds;
  return {
    junk,
    factor: NEUTRAL_FACTOR,
    minPerUnit: corridor.minPerUnit,
    maxPerUnit: corridor.maxPerUnit,
    supply: corridor.referenceUnits,
    hardMinPerUnit: hard.minPerUnit,
    hardMaxPerUnit: hard.maxPerUnit,
    // Эпоха, а не `now`: свежесозданный товар должен быть пересчитаем сразу,
    // иначе первый запрос витрины навсегда заморозит его на якоре.
    repricedAt: new Date(0),
    createdAt: now,
    updatedAt: now,
    revision: 0
  };
}

/** Прошла ли пауза между пересчётами данного вида. */
export function isRepriceDue(state: CommodityState, now: Date): boolean {
  return now.getTime() - state.repricedAt.getTime() >= MARKET_PRICE_DYNAMICS.cooldownMs;
}

/**
 * Пересчёт товара по предложению — РЕДУКТОР для `CommodityStore.transact`.
 *
 * Порядок вычисления важен и выведен из двух ограничений:
 *
 *  1. Цель (`scarcityFactorOf`) — функция ТОЛЬКО от текущего предложения. Она и
 *     есть «закон спроса» из ТЗ: мало лома — дорого.
 *  2. Шаг к цели ограничен `maxMoveRatio`. Без него одно крупное объявление
 *     обрушило бы край коридора под себя же, и листинг падал бы отказом на цене,
 *     которую игрок только что выбрал по витрине.
 *
 * Пауза (`isRepriceDue`) проверяется ЗДЕСЬ, а не только вызывающим кодом, потому
 * что редуктор обязан быть самодостаточным: при CAS-повторе он запускается на
 * свежем документе, и «успеть дважды за паузу» должно быть невозможно и без
 * внешней проверки.
 *
 * Множитель округляется до 6 знаков. Не из экономии места: без округления
 * двоичный хвост делал бы каждое повторное чтение `factor` чуть-чуть иным, и
 * тесты на сходимость пришлось бы писать через `toBeCloseTo`, то есть перестать
 * проверять точное равенство там, где оно возможно.
 */
export function repriceCommodity(state: CommodityState, supply: number, now: Date): CommodityState {
  if (!isRepriceDue(state, now)) return state;

  const reference = MARKET_CORRIDORS[state.junk].referenceUnits;
  const target = scarcityFactorOf(supply, reference);
  const factor = roundFactor(stepTowards(state.factor, target, MARKET_PRICE_DYNAMICS.maxMoveRatio));
  const bounds = corridorAt(state.junk, factor) as CorridorBounds;

  return {
    ...state,
    factor,
    minPerUnit: bounds.minPerUnit,
    maxPerUnit: bounds.maxPerUnit,
    supply: Math.max(0, Math.trunc(supply)),
    repricedAt: now,
    updatedAt: now,
    revision: state.revision + 1
  };
}

/**
 * Относительный шаг: не больше `ratio` от текущего значения в любую сторону.
 *
 * Мультипликативно, а не аддитивно, потому что края коридоров различаются на
 * порядок (2 SEC у гильз против 30 у двигателей). Аддитивный шаг в «5 монет»
 * гнал бы гильзы через весь диапазон за пару пересчётов и не сдвигал бы
 * двигатели вообще.
 */
function stepTowards(current: number, target: number, ratio: number): number {
  if (!Number.isFinite(current) || current <= 0) return target;
  if (target === current) return current;
  const limit = current * ratio;
  const delta = target - current;
  if (Math.abs(delta) <= limit) return target;
  return current + Math.sign(delta) * limit;
}

function roundFactor(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Границы данного товара для проверки объявления. */
export function commodityBounds(state: CommodityState): CorridorBounds {
  return { minPerUnit: state.minPerUnit, maxPerUnit: state.maxPerUnit };
}

/**
 * Проходит ли цена за единицу ТЕКУЩИЙ коридор товара.
 *
 * Сравнения с `hardMin`/`hardMax` тут не нужно: границы товара уже никогда не
 * выходят за них по построению (`corridorAt` от множителя, зажатого в [пол,
 * потолок]), и проверять дважды одно и то же — значит завести второй источник
 * правды о том, чего и так не бывает.
 */
export function priceWithinCommodity(state: CommodityState, perUnit: number): boolean {
  return priceWithinBounds(commodityBounds(state), perUnit);
}

/**
 * Насколько рынок далеко от покоя: −1 максимум затоваривания, 0 покой,
 * +1 максимум дефицита. Наружу, в витрину, — чтобы игрок видел причину цены,
 * а не только цену.
 *
 * ЛОГАРИФМИЧЕСКАЯ шкала, а не линейная. Множитель — величина мультипликативная:
 * «вдвое дороже» и «вдвое дешевле» для игрока одинаково сильны, а на линейной
 * шкале от [0.5; 2.25] они ложатся на −0.43 и +0.71. Самое заметное следствие:
 * СПОКОЙНЫЙ рынок (множитель 1) на линейной шкале показал бы −0.43, то есть
 * витрина сказала бы игроку «хлама слишком много», когда хлама ровно сколько
 * надо. Делить логику цены на шкалу, которая её искажает, нельзя.
 *
 * Ветви нормируются раздельно (`log(потолок)` и `−log(пол)`), иначе асимметрия
 * предела [0.5; 2.25] не давала бы −1/+1 на самих краях: при едином знаменателе
 * пол доходил бы только до −0.85, и «максимум затоваривания» был бы недостижим.
 */
export function scarcityIndex(state: CommodityState): number {
  const log = Math.log(state.factor);
  if (!Number.isFinite(log) || state.factor <= 0) return 0;
  const up = Math.log(MARKET_PRICE_DYNAMICS.factorCeil);
  const down = -Math.log(MARKET_PRICE_DYNAMICS.factorFloor);
  if (log >= 0) return up <= 0 ? 0 : Math.min(1, log / up);
  return down <= 0 ? 0 : Math.max(-1, log / down);
}

