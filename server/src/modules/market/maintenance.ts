import { MARKET_FEED_LIMIT } from '../../config/market.js';
import type { LogSink } from '../../lib/logger.js';
import { createLoop, type Loop, type LoopTimers } from '../../lib/scheduler.js';
import { reconcileMarket, type MarketDeps, type ReconcileResult } from './commit.js';
import { repriceMarket, type RepriceReport } from './economy.js';

/**
 * Фоновое обслуживание рынка (Часть 2, backlog 4).
 *
 * ЕДИНАЯ ТОЧКА ДЛЯ ДВУХ ВЫЗЫВАЮЩИХ. И чтение витрины (`marketRoutes`), и фоновый цикл
 * обязаны делать одно и то же, в одном и том же порядке и с одними и теми же логами.
 * Два места с копипастой `reconcileMarket` + `repriceMarket` разошлись бы при первом
 * же изменении: например, цикл забыл бы про `limit`, и ночной проход выгреб бы всю
 * коллекцию лотов в память. Здесь это невозможно — функция одна.
 *
 * ПОРЯДОК: СНАЧАЛА РАЗБОР, ПОТОМ ЦЕНЫ. `reconcileMarket` возвращает просроченный хлам
 * владельцам и доводит зависшие выплаты, то есть МЕНЯЕТ предложение рынка. `repriceMarket`
 * строит коридор по предложению. Переставь их — и ночной проход сначала обвалит цену
 * под затоваривание, которого через миллисекунду уже нет, а потом поднимет её обратно:
 * витрина дрогнет дважды на ровном месте.
 *
 * ЗАЧЕМ ЦИКЛ, ЕСЛИ ЧТЕНИЕ ВИТРИНЫ ВСЁ ДЕЛАЕТ. Потому что «игрок открыл рынок» — плохой
 * будильник. Лот, повисший на полшаге, держит чужой хлам в эскроу; невыплаченная продажа
 * держит чужие SEC; и то и другое длится ровно до тех пор, пока кто-нибудь не зайдёт в
 * витрину. В ночь, когда никто не зашёл, рынок стоит с чужими деньгами в подвешенном
 * состоянии — а push о продаже (backlog 3) тем более не имеет права ждать клика продавца.
 *
 * ПОЧЕМУ ОДИН ЦИКЛ НА ОБЕ РАБОТЫ, А НЕ ДВА. Они читают одни и те же документы и
 * пишутся в одном и том же порядке; распараллель их — и reprice увидит рынок, который
 * reconcile ещё не доделал, то есть ровно тот переворот порядка, которого мы здесь
 * береглись. Раздельные циклы имеют смысл, когда работы начинают мешать друг другу по
 * времени; на текущих объёмах (шесть документов товара, десятки лотов) обе занимают
 * единицы миллисекунд.
 */

export interface MaintenanceReport {
  activated: number;
  expired: number;
  paidOut: number;
  /** Виды, чей коридор действительно сдвинулся этим проходом. */
  moved: RepriceReport['moved'];
  held: number;
  paused: number;
}

/**
 * Один проход обслуживания: разбор зависших лотов, затем пересчёт коридоров.
 *
 * Возвращает отчёт, а не логирует «всё»: вызывающему (маршрут или тест) нужно
 * сравнить числа, а не разбирать лог. Логируем только содержательные исходы — пустой
 * ночной проход не имеет права оставлять след в логе на каждом тике.
 */
export async function runMarketMaintenance(
  deps: MarketDeps,
  now: Date,
  log: LogSink,
  limit = MARKET_FEED_LIMIT
): Promise<MaintenanceReport> {
  const reconciled: ReconcileResult = await reconcileMarket(deps, now, limit);
  const repriced: RepriceReport = await repriceMarket(deps, now);

  if (reconciled.activated > 0 || reconciled.expired > 0 || reconciled.paidOut > 0) {
    // Рынок что-то доделал за упавшим процессом: это событие, а не рутина. По этому
    // логу видно, насколько часто полшага вообще случается при данной нагрузке.
    log.info('market_reconciled', {
      activated: reconciled.activated,
      expired: reconciled.expired,
      paidOut: reconciled.paidOut
    });
  }
  if (repriced.moved.length > 0) {
    // Тот же формат записи, что был у read-path до появления цикла: `market_repriced`
    // уже ищется глазами в логах и графиками, менять его ради рефакторинга — значит
    // молча сломать наблюдение за ценами.
    log.info('market_repriced', {
      moved: repriced.moved.map((m) => `${m.junk}:${m.factorFrom}→${m.factorTo}`),
      paused: repriced.paused
    });
  }

  return {
    activated: reconciled.activated,
    expired: reconciled.expired,
    paidOut: reconciled.paidOut,
    moved: repriced.moved,
    held: repriced.held.length,
    paused: repriced.paused
  };
}

export interface MaintenanceLoopOptions {
  intervalMs: number;
  /** Часы процесса: подменяются в тестах, чтобы вести рынок по фиксированной оси времени. */
  now: () => Date;
  limit?: number;
  timers?: LoopTimers;
}

/** Сборка фонового цикла обслуживания рынка. Не запущен: `start()` делает вызывающий. */
export function createMarketMaintenanceLoop(
  deps: MarketDeps,
  log: LogSink,
  options: MaintenanceLoopOptions
): Loop {
  return createLoop({
    name: 'market_maintenance',
    intervalMs: options.intervalMs,
    run: async () => {
      await runMarketMaintenance(deps, options.now(), log, options.limit);
    },
    onError: (error, meta) =>
      log.error('market_maintenance_error', { error: error.message, ticks: meta.ticks }),
    onAlert: (error, meta) =>
      log.fatal('market_maintenance_down', {
        error: error.message,
        consecutiveFailures: meta.consecutiveFailures
      }),
    timers: options.timers
  });
}
