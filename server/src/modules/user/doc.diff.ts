/**
 * Дельта-запись документа игрока.
 *
 * Модуль нейтрален к драйверу (ни mongoose, ни Map): и `MongoUserStore`, и
 * `MemoryUserStore` обязаны отвечать на один и тот же вопрос «что изменилось»
 * ОДНИМ и тем же кодом. Два сравнители в двух драйверах — это гарантированное
 * расхождение, и проверяется оно на том драйвере, которого нет в проде.
 *
 * Зачем это вообще нужно. Замер горячего пути (`npm run bench`, документ игрока
 * среднего уровня: 68 предметов, 120 стен, 10 ордеров):
 *
 *   весь `$set`                     17.4 КБ
 *   ├─ inventory                    9.4 КБ   ← экономический догон не трогает
 *   ├─ orders                       2.9 КБ   ← не трогает
 *   ├─ base (стены + башни)         2.5 КБ   ← не трогает
 *   └─ остальное                    2.6 КБ
 *   не меняется на догоне           16.3 КБ (93%)
 *
 *   JSON.stringify всего `$set`      0.240 мс  — 92% стоимости оборота документа
 *   cloneAccount                     0.014 мс
 *   toSetPayload                     0.005 мс
 *   applyEconomyTick (догон, 5 мин)  0.115 мс
 *
 * То есть каждый GET витрины перетирал 17.4 КБ ради ~1 КБ изменений, а один PvP-рейд
 * делал четыре таких записи — 69.6 КБ в Mongo на бой. Узким местом была не экономика
 * (0.115 мс), а сериализация неизменившихся байтов.
 *
 * Побочный эффект важнее экономии CPU: запись меньше и быстрее → уже окно, в котором
 * параллельный запрос успевает увести `revision` → меньше CAS-повторов, каждый из которых
 * у рейда означает ПОВТОРНУЮ симуляцию боя (`commitRaid` пересчитывает `resolveRaid`
 * на свежем состоянии, см. raid.ts).
 */

/**
 * Глубокое структурное равенство.
 *
 * Консервативность односторонняя: всё, что функция не сравнивает уверенно (разные типы,
 * `NaN`, отсутствующий ключ против `undefined`), объявляется РАЗЛИЧИЕМ. Ложное
 * «изменилось» стоит один лишний байт в `$set`; ложное «не изменилось» — потерянная
 * запись в документе, где лежит кошелек.
 *
 * Даты сравниваются по моменту времени, а не по ссылке: `cloneAccount` плодит новые
 * объекты Date на каждом transact, и сравнение по ссылке считало бы каждый догон
 * изменением.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameValue(entry, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  return leftKeys.every((key) => sameValue(left[key], right[key]));
}

/**
 * Изменились ли два состояния (объект аккаунта или `$set`-пейлоад) — с точностью до
 * служебных полей из `ignore`.
 *
 * `revision` игнорируется везде: это счётчик оптимистичной блокировки, а не данные
 * игрока. Считать его изменением — значит растить его на каждом холостом запросе и
 * сами запросы делать конкурентными.
 *
 * Оба драйвера меряют своей единицей: memory — объектом аккаунта, mongo — пейлоадом.
 * Разойтись они могут только на кривом аккаунте (строка там, где `Date`), и разве что
 * в безопасную сторону: `toSetPayload` выведен из аккаунта тотально, поэтому реальное
 * различие данных всегда остаётся различием пейлоада, а обратный случай (пейлоад
 * совпал, данные разные) невозможен — лишняя запись, но не потерянная.
 */
export function sameState(prev: unknown, next: unknown, ignore: readonly string[] = ['revision']): boolean {
  if (ignore.length === 0) return sameValue(prev, next);
  const strip = (value: unknown): Record<string, unknown> => {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = { ...source };
    for (const key of ignore) delete copy[key];
    return copy;
  };
  return sameValue(strip(prev), strip(next));
}

/**
 * Дельта двух `$set`-пейлоадов: только изменившиеся поля верхнего уровня.
 *
 * Гранулярность именно верхнеуровневая, а не по путям (`resources.ferrum`):
 *  - массивы позиционным `$set` править нельзя — удаление сдвигает индексы, а `$set`
 *    не умеет укорачивать массив, поэтому `inventory`, `orders`, `builds`, `base.units`
 *    уезжают целиком в любом случае;
 *  - 93% байта выигрывается уже на этом уровне: тяжёлые поля либо не тронуты вовсе,
 *    либо меняются целиком. Листовой спуск добавил бы к этому машинерия на порядок
 *    ради последних нескольких процентов.
 *
 * Сравнение идёт по канонической форме пейлоада с обеих сторон, а не по сырому документу:
 * иначе миграции по чтению (`mined` → `storages`, отсутствующий `sec`, см. toAccount)
 * выглядели бы как изменение и порождали бы полную запись на каждом холостом запросе.
 * Цена этого решения — легаси-поля доедают в документе до того момента, когда поле-
 * преемник реально изменится; `toAccount` читает и ту, и другую форму тотально.
 */
export function diffSetPayload<T extends object>(prev: T, next: T): Partial<T> {
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(next) as Array<keyof T & string>) {
    if (!sameValue(prev[key], next[key])) diff[key] = next[key];
  }
  return diff as Partial<T>;
}
