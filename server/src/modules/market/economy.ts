import { JUNK_IDS, type JunkId } from '../../config/workshop.js';
import { isRepriceDue, neutralCommodity, repriceCommodity, type CommodityState } from './commodity.types.js';
import { toCommodityMap, type CommodityMap, type CommodityStore } from './commodity.store.js';
import type { LotStore } from './lot.store.js';

/**
 * Живая экономика чёрного рынка (Часть 2, P5): `recalculatePrices` из ТЗ.
 *
 * ХАБ, а не домен: чистая математика коридора лежит в commodity.types.ts и
 * config/market.ts, здесь — только обход шести видов, чтение сторов и решение,
 * КОГДА рынок имеет право двинуться. Тот же раздел ответственности, что у
 * market/commit.ts по отношению к market/service.ts.
 *
 * ГДЕ ВЫЗЫВАЕТСЯ. Только на чтении витрины, рядом с `reconcileMarket`. Три причины
 * не вызывать его из листинга и из покупки:
 *
 *  1. ОБЪЯВЛЕНИЕ НЕ ДОЛЖНО УДАРЯТЬ САМО ПО СЕБЕ. Игрок выбирает цену по витрине.
 *     Если листинг сперва двигает коридор, а потом проверяет по нему же цену
 *     игрока, то крупное объявление обрубает край под собственным автором, и
 *     отказ приходит на цифру, которая секунду назад была разрешена. Проверка
 *     идёт по ПОСЛЕДНЕМУ зафиксированному коридору — ровно как ордер на бирже
 *     исполняется по цене стакана на момент выставления, а не по цене, которую
 *     сам же и создал.
 *  2. ПОКУПКА УМЕНЬШАЕТ ПРЕДЛОЖЕНИЕ, и мгновенный пересчёт сделал бы каждый
 *     выкуп триггером движения. При популярном лоте это дёрганая витрина и
 *     записанный впустую документ товара на каждую сделку.
 *  3. ЦЕНА ЗАПРОСА. Пересчёт — шесть документов на чтение; на покупке он встал бы
 *     пятым шагом протокола из четырёх, то есть между списанием монет у покупателя
 *     и выплатой продавцу. Лишняя запись внутри денежного протокола — это лишнее
 *     окно для зависшей сделки, и платить за неё скачками ценников смысла нет.
 *
 * Отсюда правило: коридор — НЕ состояние сделки, а состояние рынка, и обновляется
 * он тогда, когда на рынок смотрят, а не тогда, когда на нём торгуют.
 */

export interface EconomyDeps {
  lots: LotStore;
  commodities: CommodityStore;
}

/** Исход пересчёта одного вида. Нужен логу и тестам, а не игроку. */
type RepriceOutcome = 'moved' | 'held' | 'paused';

interface Outcome {
  kind: RepriceOutcome;
  from: number;
  to: number;
}

export interface RepriceReport {
  /** Виды, чей множитель действительно изменился. */
  moved: Array<{ junk: JunkId; factorFrom: number; factorTo: number }>;
  /** Виды, пересчитанные, но оставшиеся на своём множителе (шаг меньше округления). */
  held: JunkId[];
  /** Виды внутри паузы `cooldownMs`. */
  paused: number;
  /** Суммарное предложение по всем видам, ед. хлама — снятое тем же запросом. */
  supply: Record<JunkId, number>;
}

/**
 * Пересчёт всех шести товаров по текущему предложению.
 *
 * ЧИТАЕТ ОДИН РАЗ: предложение (`sumActiveUnits`) и все снапшоты (`list`)
 * снимаются ДО записей. Иначе шестой вид пересчитывался бы по предложению, на
 * которое уже повлиял пересчёт первого, и порядок обхода шести видов начал бы
 * влиять на цены — то есть результат зависел бы от детали цикла, а не от рынка.
 * Записи поверх снятого снимка — это не «устаревшие данные», а атомарный снимок
 * рынка на момент запроса, ровно то, что должно лежать в основе пересчёта.
 */
export async function repriceMarket(deps: EconomyDeps, now: Date): Promise<RepriceReport> {
  const supply = await deps.lots.sumActiveUnits();
  const snapshot: CommodityMap = toCommodityMap(await deps.commodities.list());

  const report: RepriceReport = { moved: [], held: [], paused: 0, supply };

  for (const junk of JUNK_IDS) {
    const outcome = await repriceOne(deps, junk, supply[junk] ?? 0, now, snapshot[junk]);
    if (outcome.kind === 'moved') {
      report.moved.push({ junk, factorFrom: outcome.from, factorTo: outcome.to });
    } else if (outcome.kind === 'held') {
      report.held.push(junk);
    } else {
      report.paused += 1;
    }
  }

  return report;
}

/**
 * Пересчёт одного вида.
 *
 * Двойная проверка паузы — не дублирование, а разделение ролей: внешняя экономит
 * запись (внутри паузы стор вообще не трогаем), внутренняя гарантирует, что
 * CAS-повтор или гонка двух читателей не проведут второй пересчёт за ту же паузу.
 * Выбросить любую из двух — значит либо писать впустую, либо нарушить инвариант
 * «не быстрее `cooldownMs`».
 */
async function repriceOne(
  deps: EconomyDeps,
  junk: JunkId,
  units: number,
  now: Date,
  known?: CommodityState
): Promise<Outcome> {
  let current = known ?? (await deps.commodities.find(junk));

  if (!current) {
    // Холодный старт: покой, а не «самая дорогая цена». Множитель 1 означает, что
    // до первого пересчёта рынок живёт якорными границами конфига — ровно так, как
    // он жил до появления динамики, и то же поведение получает база после рестарта.
    // `neutralCommodity` ставит `repricedAt` в эпоху, поэтому созданный здесь
    // снапшот пересчитывается этим же вызовом, а не замерзает на якоре.
    current = await deps.commodities.ensure(neutralCommodity(junk, now));
  }

  if (!isRepriceDue(current, now)) return { kind: 'paused', from: current.factor, to: current.factor };

  // Флаг ставится ВНУТРИ редуктора, а не выводится сравнением ревизий: `current` —
  // снимок, взятый до записи, и при гонке двух читателей победивший уже успел её
  // увеличить. Сравнение «ревизия после vs снимок до» давало проигравшему ложное
  // «сдвинулось», и в логах появлялся `market_repriced` с `factorFrom === factorTo`,
  // то есть рынок обвиняли в движении, которого не было. Редуктор же вызывается
  // именно на ТОМ документе, который уходит в запись, — и его слово окончательное.
  //
  // При CAS-повторе флаг перезаписывается каждый раз; последнее присваивание
  // соответствует попытке, выигравшей запись, потому что синхронный вызов редуктора
  // и `updateOne` идут парами и перемешаться не могут.
  let written = false;
  const next = await deps.commodities.transact(junk, (state) => {
    const projected = repriceCommodity(state, units, now);
    written = projected.revision !== state.revision;
    return projected;
  });

  if (!written) return { kind: 'paused', from: current.factor, to: next.factor };

  return next.factor === current.factor
    ? { kind: 'held', from: current.factor, to: next.factor }
    : { kind: 'moved', from: current.factor, to: next.factor };
}

/**
 * Коридор для проверки нового объявления.
 *
 * Отдельная точка доступа, а не прямое чтение стора из commit.ts, по той же
 * причине, что `commodityOrNeutral`: «документа нет» и «рынок пуст» — разные
 * вещи, и различать их должен один человек в коде, а не шесть вызывающих мест.
 */
export async function commodityForListing(
  deps: EconomyDeps,
  junk: JunkId,
  now: Date
): Promise<CommodityState> {
  return (await deps.commodities.find(junk)) ?? neutralCommodity(junk, now);
}

