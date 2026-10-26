import { describe, expect, it } from 'vitest';

import type { AppConfig, EconomyConfig } from '../src/config/env.js';
import { RESOURCE_CURSORS, applyEconomyTick } from '../src/modules/economy/tick.js';
import { syncState } from '../src/http/helpers.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import {
  HOUR,
  MINUTE,
  T0,
  addMs,
  newAccount,
  testConfig,
  withResources,
  withStorages,
  withStructures
} from './fixtures.js';

/**
 * Инвариант расписания: результат догона зависит от (состояния, `now`), а не от того,
 * сколько запросов попало в интервал.
 *
 * ПОЧЕМУ ЭТО ТЕСТ, А НЕ КОММЕНТАРИЙ. Клиент ходит в сеть с произвольным ритмом:
 * вкладка в фоне, разбудили пушем, потеряли связь на минуту. Если доход игрока —
 * функция от числа опросов, то экономика награждает болтательный клиент и наказывает
 * экономный, а это уже не баланс, а лотерея связи.
 *
 * Ровно так и случилось с энергией (commit «energy: the regen cursor must always
 * advance»): курсор ниже капа не ехал, каждый запрос начислял окно заново, и два
 * опроса в один такт давали 1 + 2×0.4167 вместо 1 + 0.4167. Ни один тест того не
 * поймал: `economy.energy.test.ts` проверяет арифметику одного тика, а не составную
 * последовательность. Здесь проверяется именно последовательность.
 *
 * РОВНО ТУТ ПРОХОДИТ ГРАНЬ МЕЖДУ «ПРОВЕРЕНО» И «СЛОВЕСНО». Два мутанта прогнаны на
 * этом файле, и результаты разные — обоими они важны:
 *
 *  1. возвращённый баг с энергией (`updated = energy >= cap ? now : energyUpdatedAt`) —
 *     файл остаётся ЗЕЛЁНЫМ (13/13), а `test/economy.energy.test.ts` падает в 4 местах.
 *     Не потому, что тест плохой: хвост `applyEconomyTick` поднимает ВСЕ курсоры через
 *     `advanceCursors` независимо от того, что сделал отдельный тик, — то есть R2 сделал
 *     исходный эксплойт на составном пути структурно невозможным. Ловить его здесь было
 *     бы дублированием;
 *  2. сброс остатка в `computeMiningTick` (`raw = rate * hours` вместо `before + ...`) —
 *     падают 9 тестов из 13, в обоих окнах, включая «повтор в тот же такт» (склады
 *     обнулялись вместо накопления). Вот это и есть класс бага, ради которого файл
 *     написан: состояние, пересчитанное от абсолютного времени там, где нужно
 *     ПРИРАЩЕНИЕ от курсора.
 *
 * Отсюда формулировка инварианта точнее, чем «результат не зависит от расписания»:
 * догон обязан быть аддитивным по интервалу и идемпотентным по точке. Курсор —
 * гарантия второго, `before +` — первого, и проверяются они здесь вместе.
 *
 * СРАВНИВАЕТСЯ ВСЁ СОСТОЯНИЕ, а не список полей: сравнение по названным полям
 * проверяло бы только те из них, о которых автор подумал, — а курсор, забытый в
 * `RESOURCE_CURSORS`, как раз и живёт в поле, которое никто не назвал. Числа
 * сравниваются с допуском: дробление интервала добавляет лишних `round6` на такт,
 * и потребовать побайтового равенства значило бы заставить тест падать на
 * 1e-9 от плавающей запятой, а не на ошибке.
 */

const config = testConfig();
const economy = config.economy;
let ids = 0;
const idFactory = (): string => `sched-${(ids += 1)}`;

/**
 * База со всеми тремя догонами сразу: майнинг копает, реактор питает контуры охлаждения,
 * те разблокируют ASIC — и только он печатает SEC (реактор сам по себе монету не даёт),
 * энергия ниже капа (выше капа баг с курсором был невиден: `Math.min` его и прятал).
 * Привилегий нет намеренно: их истечение внутри интервала меняет результат по правилам
 * игры, и это отдельная проверка, а не шум в этой.
 */
function richBase(cfg: AppConfig = config): UserAccount {
  return withResources(
    withStorages(
      withStructures(newAccount(cfg), {
        bore_ore_mk1: 2,
        reactor_plasma_mk1: 1,
        cooler_loop_mk1: 2,
        asic_rack_mk1: 1
      }),
      // Азота с запасом: кончится — контуры встанут, ASIC заглушится, и монета перестанет
      // капать посреди окна. Тогда тест сравнивал бы две разные физики, а не два
      // способа задать один и тот же интервал.
      { plasma: 200, nitrogen: 500, ferrum: 10 }
    ),
    { energy: 5 }
  );
}

/** Прогон по N опросов на равных шагах от `from` до `to`. */
function pollOver(
  account: UserAccount,
  from: Date,
  to: Date,
  polls: number,
  cfg: EconomyConfig = economy
): { account: UserAccount; sec: number } {
  let current = account;
  let sec = 0;
  for (let index = 1; index <= polls; index += 1) {
    const span = to.getTime() - from.getTime();
    const at = new Date(from.getTime() + Math.round((span * index) / polls));
    const sync = syncState(current, at, cfg, idFactory);
    current = sync.account;
    // Сумма начисленного по черновикам: журнал обязан отражать тот же интервал,
    // сколько и кошелёк, — иначе поддержка видит одно, а игрок другое.
    sec += sync.drafts.reduce((total, draft) => total + draft.delta, 0);
  }
  return { account: current, sec };
}

const EPS = 1e-6;

/** Расхождения состояний дальше допуска: пустой массив — состояния эквивалентны. */
function numericDiff(left: unknown, right: unknown, path: string, eps: number = EPS, out: string[] = []): string[] {
  if (typeof left === 'number' || typeof right === 'number') {
    if (typeof left !== 'number' || typeof right !== 'number' || Math.abs(left - right) > eps) {
      out.push(`${path}: ${JSON.stringify(left)} ≠ ${JSON.stringify(right)}`);
    }
    return out;
  }
  if (left instanceof Date || right instanceof Date) {
    const same =
      left instanceof Date && right instanceof Date && Math.abs(left.getTime() - right.getTime()) <= EPS;
    if (!same) out.push(`${path}: ${String(left)} ≠ ${String(right)}`);
    return out;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      out.push(`${path}: длина массивов ${Array.isArray(left) ? left.length : '—'} ≠ ${Array.isArray(right) ? right.length : '—'}`);
      return out;
    }
    left.forEach((item, index) => numericDiff(item, (right as unknown[])[index], `${path}[${index}]`, eps, out));
    return out;
  }
  if (left !== null && right !== null && typeof left === 'object' && typeof right === 'object') {
    const lo = left as Record<string, unknown>;
    const ro = right as Record<string, unknown>;
    for (const key of new Set([...Object.keys(lo), ...Object.keys(ro)])) {
      numericDiff(lo[key], ro[key], path ? `${path}.${key}` : key, eps, out);
    }
    return out;
  }
  if (left !== right) out.push(`${path}: ${JSON.stringify(left)} ≠ ${JSON.stringify(right)}`);
  return out;
}

describe('economy/schedule: курсоры догона', () => {
  it('список непустой, и всё в нём — даты аккаунта', () => {
    // Без этой проверки первая ниже стала бы вакуумной: пустой список курсоров
    // проходит любой цикл `for (const cursor of RESOURCE_CURSORS)`.
    expect(RESOURCE_CURSORS.length).toBeGreaterThan(0);
    const account = richBase();
    for (const cursor of RESOURCE_CURSORS) {
      expect(account[cursor] instanceof Date, cursor).toBe(true);
    }
  });

  it('фикстура ниже капа по энергии — иначе баг класса «курсор не уехал» невиден', () => {
    // `Math.min(cap, raw)` прятал его ровно на полном баке: при энергии на пределе
    // и старый, и новый код дают то же самое. Проверка на то, что тест есть чему
    // учиться, а не что он всегда зелёный.
    expect(richBase().resources.energy).toBeLessThan(economy.energyCap);
  });

  it('каждый курсор уезжает на now, в том числе ниже капа', () => {
    const now = addMs(T0, HOUR);
    const { account } = applyEconomyTick(richBase(), now, economy);
    for (const cursor of RESOURCE_CURSORS) {
      expect(account[cursor], cursor).toEqual(now);
    }
  });
});

describe('economy/schedule: дробление интервала', () => {
  const from = T0;
  // ОДИН документ на все прогоны. `newAccount` выдаёт новый id, и сравнение двух
  // случайно разных игроков показывало бы расхождение `id`, а не экономики.
  const base = richBase();

  // ОКНА ДВА, И ОДНО ДРУГОЕ НЕ ЗАМЕНЯЕТ.
  //
  //  - короткое: энергия за него до капа не доходит. Только в таком окне курсор
  //    различим, то есть только здесь ловится баг класса «курсор не уехал». Проверено
  //    намеренно: с возвращённой старой ветвью (`energy >= cap ? now : energyUpdatedAt`)
  //    падает именно это окно, а длинное — нет;
  //  - длинное: энергия упирается в кап, и старый курсор на капе ехал бы тоже, поэтому
  //    инвариант в нём выполняется СЛУЧАЙНО. Зато окно прогоняет насыщение складов и
  //    почасовой режим промышленности.
  //
  // Оставить одно длинное окно значило бы написать тест, который зелёный всегда.
  const windows = [
    { label: 'четыре минуты: энергия ниже капа, курсор различим', ms: 4 * MINUTE },
    { label: 'час: энергия на капе, кап маскирует курсор', ms: HOUR }
  ];
  const baseline = new Map<number, { account: UserAccount; sec: number }>(
    windows.map((window) => [window.ms, pollOver(base, from, addMs(from, window.ms), 1)])
  );
  const cases = windows.flatMap((window) =>
    [2, 3, 7].map((polls) => ({ ...window, polls }))
  );

  it.each(cases)('$label → $polls опросов дают тот же результат, что один', ({ label, ms, polls }) => {
    // Допуск растёт с числом тактов: каждый округляет свои поля (`round6`), и семь
    // опросов имеют право разойтись с одним на единицу младшего знака на такт, но не
    // на произвольную величину. Постоянный допуск либо скрывал бы накопление ошибки,
    // либо падал бы на ней — и то, и другое хуже явной функции от `polls`.
    const split = pollOver(base, from, addMs(from, ms), polls);
    expect(numericDiff(baseline.get(ms)!.account, split.account, '', EPS * polls), label).toEqual([]);
  });

  it('короткое окно не насыщает кап — иначе оно теряет различающую силу', () => {
    // Ставка регена или ёмкость бака могут поменяться в балансе, и тогда «короткое»
    // окно станет таким же слепым, как длинное. Этот тест превращает молчаливую
    // потерю покрытия в падающий тест.
    const short = windows[0]!;
    const saturated = pollOver(base, from, addMs(from, short.ms), 7);
    expect(saturated.account.resources.energy).toBeLessThan(economy.energyCap);
  });

  it('за час начисляется SEC, и его сумма не зависит от числа опросов', () => {
    // Положительная планка обязательна: два нуля прошли бы сравнение молча.
    const one = baseline.get(HOUR)!;
    expect(one.sec).toBeGreaterThan(0);
    expect(pollOver(base, from, addMs(from, HOUR), 7).sec).toBeCloseTo(one.sec, 5);
  });

  it('повтор в тот же такт не меняет ни состояния, ни журнала', () => {
    const to = addMs(from, HOUR);
    const one = baseline.get(HOUR)!;
    const again = pollOver(one.account, to, to, 1);
    expect(numericDiff(one.account, again.account, '')).toEqual([]);
    expect(again.sec).toBe(0);
  });

  it('граница инварианта: лимит офлайна дробление выгоднее, и это правило, а не поломка', () => {
    // Всё, что выше `maxOfflineHours`, один запрос теряет намеренно (иначе неделя
    // отсутствия стала бы бесконечным банкомом). Дробление эти потери возвращает —
    // и тест существует ровно для того, чтобы это было известно, а не обнаружено
    // игроком: перевод GET на непишущий путь (R5) не должен случайно изменить
    // количество опросов, из-за которых тут что-то начисляется.
    const wide = testConfig({ STORAGE_CAPACITY: '1000000000' });
    const account = richBase(wide);
    const span = (wide.economy.maxOfflineHours + 6) * HOUR;
    const end = addMs(T0, span);
    const single = pollOver(account, T0, end, 1, wide.economy);
    const hourly = pollOver(account, T0, end, Math.round(span / HOUR), wide.economy);
    expect(single.account.storages.ferrum).toBeLessThan(hourly.account.storages.ferrum);
  });
});

