/**
 * Счётчики обращений к стору за жизнь процесса.
 *
 * ЗАЧЕМ ЭТО ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ПРОСТО ЛОГ. Оптимистичная блокировка (CAS по
 * `revision`) — единственная атомарность в проекте, и она невидима. Конфликт версий
 * либо тихо повторяется до пяти попыток, либо бросается наружу; ни один исход нельзя
 * увидеть со стороны. Рейд при конфликте пересчитывает бой заново (~2.5 мс синхронного
 * CPU, modules/pvp/raid.ts), покупка лота при исчерпании попыток отдаёт игроку ошибку
 * на ровном месте, а пересчёт товара пишет документ целиком даже тогда, когда редуктор
 * не изменил ничего. Всё это логируется на уровне `debug`, который в проде выключен, —
 * то есть ровно там, где эти числа и нужны. «Посмотреть лог» требует доступа к хосту,
 * `/health` — нет (тот же аргумент, что и у modules/auth/vk.telemetry.ts).
 *
 * ЧТО ЗДЕСЬ СОБИРАЕТСЯ, а что НЕТ. Только целые счётчики и одна метка времени. Ни id
 * игрока, ни id лота, ни содержимого документов: эндпоинт не требует аутентификации и
 * не должен становиться копией персональных данных. Байтовый вес ходов сюда не входит
 * намеренно: честный замер стоил бы `JSON.stringify` на каждом обращении, то есть
 * ровно той работы, ради которой всё затевается. Вес измеряется офлайн — `npm run bench`.
 *
 * СЧЁТЧИКИ НЕ СБРАСЫВАЮТСЯ И НЕ ОГРАНИЧЕНЫ ПО ВРЕМЕНИ: процесс живёт от деплоя до
 * деплоя, и этого хватает на вопрос «что случилось сегодня». Доля конфликтов здесь не
 * хранится — она считается как Δcas_conflicts / Δtransacts между двумя снимками.
 *
 * ЦЕНА. Несколько инкрементов целого на ход стора, без аллокаций. Единственная
 * аллокация — `snapshot()`, а его вызывает только оператор из `/health`.
 *
 * ЧТО НЕ СЧИТАЕТСЯ ВОВСЕ. Массовые выборки и обслуживание: `listActive`, `listExpired`,
 * `sumActiveUnits`, `listUnpaidPayouts`, `listPendingEscrow`, `ensure`, прямой `save` и
 * вход через `getOrCreate`. Это фоновые проходы воркера и сидирование, и, попав в
 * `reads`, они сделали бы долю конфликтов нечитаемой: оператор сравнивает её с
 * трафиком игроков, а не с работой таймеров.
 */

export interface StoreMetricsSnapshot {
  /** Вызовов `transact` (успешных и брошенных вместе). */
  transacts: number;
  /** Обращений за документом: чтение витрины, подбор соперников, CAS-чтение внутри хода. */
  reads: number;
  /** Физических записей, дошедших до БД. */
  writes: number;
  /**
   * Ходов, где редуктор вернул состояние, идентичное прочитанному.
   *
   * `null` — этот драйвер холостые ходы не различает, и это не ноль. Различение стоит
   * сравнения документов (`sameState` в modules/user/doc.diff.ts): бесплатно там, где
   * сравнение уже идёт (user-store, commodity — у последнего ревизию ведёт редуктор, и
   * неизменная ревизия означает неизменное состояние), и дорого там, где его нет
   * (clan, lot). Значение принимается ОДИН раз при сборке рекордера, поэтому `null`
   * означает «не измеряется» всегда, а не «ещё не измерилось»: оператор может
   * вычитать поля из двух снимков, не гадая, успел ли стор насчитать первый холостой ход.
   *
   * Сама пара чисел отвечает на вопрос «сколько ходов можно выбросить»: у user-store
   * холостой ход не пишет ничего, у commodity — пишет зря, и разница видна только
   * рядом с `writes`.
   */
  noops: number | null;
  /** CAS не сошёлся (документ успели изменить) — идёт повтор. */
  casConflicts: number;
  /** Попытки кончились, стор бросил ConflictError. Для рейда это несостоявшийся бой. */
  abandoned: number;
  /** Наибольшее число попыток на один ход: «единичные конфликты» от «кто-то держит документ». */
  maxAttempts: number;
  /** Момент последнего конфликта (ISO): по нему строка сопоставляется с логом. */
  lastConflictAt: string | null;
}

export interface StoreMetrics {
  /** Открыт ход (один вызов `transact`, сколько бы попыток он ни стоил). */
  transact(): void;
  /** Прочитан документ — отдельно от хода (чтение витрины, подбор соперников, CAS). */
  read(): void;
  /** Запись дошла до БД. */
  write(): void;
  /** CAS не сошёлся на попытке `attempt`, впереди ещё одна. */
  conflict(attempt: number): void;
  /** Попыток не осталось, ход будет брошен. */
  abandon(attempt: number): void;
  snapshot(): StoreMetricsSnapshot;
}

/**
 * Драйвер, который различает холостые ходы.
 *
 * Отдельный тип, а не флаг: вызвать `noop()` в сторе, который для `null` собран,
 * нельзя должно быть на стадии компиляции, а не по молчаливой потере события в рантайме.
 */
export interface NoopAwareStoreMetrics extends StoreMetrics {
  /** Редуктор вернул то же состояние, что прочитал. */
  noop(): void;
}

export interface StoreMetricsOptions {
  /** Часы (в тестах — замороженные). */
  now?: () => Date;
}

function build(noopAware: boolean, options: StoreMetricsOptions): StoreMetrics {
  const now = options.now ?? (() => new Date());
  let transacts = 0;
  let reads = 0;
  let writes = 0;
  let noops: number | null = noopAware ? 0 : null;
  let casConflicts = 0;
  let abandoned = 0;
  let maxAttempts = 0;
  let lastConflictAt: string | null = null;

  const noteAttempt = (attempt: number): void => {
    if (attempt > maxAttempts) maxAttempts = attempt;
  };

  const metrics: StoreMetrics & { noop?(): void } = {
    transact(): void {
      transacts += 1;
    },
    read(): void {
      reads += 1;
    },
    write(): void {
      writes += 1;
    },
    conflict(attempt): void {
      casConflicts += 1;
      noteAttempt(attempt);
      lastConflictAt = now().toISOString();
    },
    abandon(attempt): void {
      abandoned += 1;
      noteAttempt(attempt);
    },
    snapshot(): StoreMetricsSnapshot {
      return { transacts, reads, writes, noops, casConflicts, abandoned, maxAttempts, lastConflictAt };
    }
  };
  if (noopAware) {
    metrics.noop = (): void => {
      noops = (noops ?? 0) + 1;
    };
  }
  return metrics;
}

/** Рекордер драйвера, который документы не сравнивает: `noop()` у него отсутствует в типе. */
export function createStoreMetrics(options: StoreMetricsOptions = {}): StoreMetrics {
  return build(false, options);
}

/** Рекордер драйвера, который холостые ходы различает (user, commodity). */
export function createNoopAwareStoreMetrics(options: StoreMetricsOptions = {}): NoopAwareStoreMetrics {
  return build(true, options) as NoopAwareStoreMetrics;
}
