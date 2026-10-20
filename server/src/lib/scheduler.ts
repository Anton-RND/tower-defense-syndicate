/**
 * Фоновый цикл (backlog 4): единственный планировщик процесса.
 *
 * ЗАЧЕМ ОН, ЕСЛИ ВСЁ УЖЕ РАБОТАЕТ НА ЧТЕНИИ. До сих пор единственным моментом, когда
 * рынок доделывал зависшие сделки и двигал коридоры, был `GET /v1/market`. Это
 * работает ровно до первой ночи, когда витрину никто не откроет: лот, повисший на
 * полшаге, держит чужой хлам в эскроу, а игрок, заплативший за товар, не узнает, что
 * деньги уже ушли, — пока сам не заглянет в список. Информация «вы проданы» из ТЗ
 * (п. «Push-уведомления») тем более не имеет права ждать, пока продавец зайдёт в игру.
 *
 * ПОЧЕМУ `setTimeout` ЦЕПОЧКОЙ, А НЕ `setInterval`. `setInterval` ставит следующий
 * тик, не глядя на предыдущий: два пересчёта, идущих одновременно, читают одно и то
 * же предложение и пишут два разных множителя — CAS решает конфликт, но зря отданную
 * запись уже не вернуть. Цепочка «тик → пауза → тик» делает наложение
 * невозможным по построению, а не по договорённости, и не накапливает дрейф после
 * долгого прохода.
 *
 * ПОЧЕМУ ОДИН ПОТОК И ОДНА ЗАДАЧА В РУКЕ. Node однопоточен, а наши тики — это
 * последовательности обращений к БД, а не CPU. Отдельный воркер на каждый вид
 * работ потребовал бы очереди задач, дедлоков и наблюдаемости, то есть стоил бы
 * дороже, чем экономит на текущих объёмах (шесть документов товара, десятки лотов).
 * Когда рынок вырастет до тысяч лотов, масштабироваться будет не число циклов, а
 * число процессов — вот тогда этот файл станет точкой, где добавить шардинг по
 * `junk` или `shardId`.
 */

/** Инъекция таймеров: тесты подставляют свои, чтобы не ждать реальных пауз. */
export interface LoopTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LoopStats {
  /** Сколько проходов начато (включая те, что упали). */
  ticks: number;
  /** Сколько раз внешний `tick()` попросили, когда проход уже шёл. */
  overlaps: number;
  /** Подряд неудачных проходов; сбрасывается первым же успехом. */
  consecutiveFailures: number;
  running: boolean;
  started: boolean;
}

export interface LoopOptions {
  /** Имя в логи: `market_maintenance`, `notice_outbox`. */
  name: string;
  /** Пауза МЕЖДУ концом одного прохода и началом следующего. */
  intervalMs: number;
  run: () => Promise<void>;
  /**
   * Провал не роняет цикл: воркер, умерший на первом исключении, хуже воркера,
   * который пишет в лог каждую неудачу. Порог `alertAfter` поднимает уровень.
   */
  onError?: (error: Error, meta: LoopStats & { name: string }) => void;
  /** Сколько неудач подряд считаются инцидентом, а не шумом сети. */
  alertAfter?: number;
  onAlert?: (error: Error, meta: LoopStats & { name: string }) => void;
  now?: () => number;
  timers?: LoopTimers;
  /** Первый проход сразу при старте: рынок горячий с первой секунды, а не через минуту. */
  runImmediately?: boolean;
}

export interface Loop {
  readonly name: string;
  start(): void;
  /** Останавливает цепочку и дожидается идущего прохода: рвать середину протокола нельзя. */
  stop(): Promise<void>;
  /**
   * Один проход вне расписания. Возвращает false, если такой ход уже идёт, —
   * наложение невозможно даже из рук теста или dev-маршрута.
   */
  tick(): Promise<boolean>;
  stats(): LoopStats;
}

const nodeTimers: LoopTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function createLoop(options: LoopOptions): Loop {
  const now = options.now ?? (() => Date.now());
  const timers = options.timers ?? nodeTimers;
  const alertAfter = options.alertAfter ?? 3;

  let started = false;
  let stopped = false;
  let running = false;
  let ticks = 0;
  let overlaps = 0;
  let consecutiveFailures = 0;
  let pending: unknown = null;
  /** Обещание идущего прохода — из таймера ли, из `tick()` ли. Один источник истины. */
  let current: Promise<void> | null = null;

  const stats = (): LoopStats => ({ ticks, overlaps, consecutiveFailures, running, started });

  function schedule(): void {
    if (stopped) return;
    pending = timers.setTimeout(() => {
      pending = null;
      void pass();
    }, Math.max(0, options.intervalMs));
    // Таймер не должен удерживать процесс: остановка по SIGINT у нас своя, а
    // `vitest` убивает воркер-пул только когда активных handle'ов нет.
    (pending as { unref?: () => void }).unref?.();
  }

  /** Само тело прохода: никогда не бросает — исключение превращается в сигнал. */
  async function runPass(): Promise<void> {
    running = true;
    ticks += 1;
    const at = now();
    try {
      await options.run();
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const err = error instanceof Error ? error : new Error(String(error));
      const meta = { ...stats(), name: options.name, startedAt: at };
      options.onError?.(err, meta);
      // Ровно один `fatal` на пороге, а не каждый проход: иначе упавший VK API
      // зальет логи и утопит в них настоящую причину.
      if (consecutiveFailures === alertAfter) options.onAlert?.(err, meta);
    } finally {
      running = false;
    }
  }

  function pass(): Promise<void> {
    if (current) return current;
    const p = runPass().then(
      () => {
        current = null;
        schedule();
      },
      () => {
        // runPass глотает свои исключения; эта ветка — страховка на случай
        // собственной ошибки в обработчиках, и она не имеет права остановить цикл.
        current = null;
        schedule();
      }
    );
    current = p;
    return p;
  }

  const loop: Loop = {
    name: options.name,
    start(): void {
      if (started || stopped) return;
      started = true;
      if (options.runImmediately) void pass();
      else schedule();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (pending !== null) {
        timers.clearTimeout(pending);
        pending = null;
      }
      // Ждём ровно идущий проход: рывать середину протокола нельзя — у reconcile и
      // выплаты есть промежуточные состояния, которые переживают перезапуск, но
      // не должны оставаться на совести остановленного процесса.
      while (current) await current;
    },
    tick(): Promise<boolean> {
      // Остановленный цикл не обязан делать проход «по просьбе»: после `close()`
      // сторы уже закрыты, и тик вернул бы ошибку хранилища вместо честного «нет».
      if (stopped) return Promise.resolve(false);
      if (current) {
        overlaps += 1;
        return Promise.resolve(false);
      }
      return pass().then(() => true);
    },
    stats
  };
  return loop;
}
