import { describe, expect, it } from 'vitest';

import { createLoop, type LoopTimers } from '../src/lib/scheduler.js';

/**
 * Планировщик фоновых циклов (Часть 2, backlog 4).
 *
 * Проверяются три свойства, ради которых этот файл вообще существует:
 *  1. НАЛОЖЕНИЕ НЕВОЗМОЖНО — длинный проход не должен позволить начаться второму,
 *     иначе два пересчёта коридора читают один рынок и пишут два результата;
 *  2. ИСКЛЮЧЕНИЕ НЕ УБИРАЕТ ЦИКЛ — упавший ВК или Mongo не имеет права оставить
 *     рынок без обслуживания до перезапуска;
 *  3. ОСТАНОВКА ДОЖИДАЕТСЯ ИДУЩИЙ ПРОХОД — рвать середину денежного протокола нельзя.
 *
 * Таймеры подставляются ручные: реальные паузы в тесте означали бы либо медленный
 * прогон, либо гонку с флак-ассертами.
 */

interface FakeTimers extends LoopTimers {
  /** Сколько колбэков ждут. */
  pending(): number;
  /** Прокручивает всё ожидающее один раз. */
  fire(): number;
}

function fakeTimers(): FakeTimers {
  let seq = 0;
  const scheduled = new Map<number, () => void>();
  return {
    setTimeout(fn: () => void, _ms: number): unknown {
      seq += 1;
      scheduled.set(seq, fn);
      return seq;
    },
    clearTimeout(handle: unknown): void {
      scheduled.delete(handle as number);
    },
    pending: () => scheduled.size,
    fire: () => {
      const jobs = [...scheduled.values()];
      scheduled.clear();
      for (const job of jobs) job();
      return jobs.length;
    }
  };
}

/** Обещание, которое тест разрешает сам, в нужный момент. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Прокрутка микрозадач: сколько бы await ни накопилось внутри цепочки. */
async function flush(steps = 12): Promise<void> {
  for (let i = 0; i < steps; i++) await Promise.resolve();
}

describe('scheduler: один проход за раз', () => {
  it('длинный проход не планирует следующий, пока не завершился', async () => {
    const timers = fakeTimers();
    const gate = deferred();
    let entered = 0;
    const loop = createLoop({
      name: 'test',
      intervalMs: 1000,
      timers,
      run: async () => {
        entered += 1;
        await gate.promise;
      }
    });

    loop.start();
    expect(timers.pending()).toBe(1);
    timers.fire();
    await flush();
    expect(entered).toBe(1);
    // Проход идёт: новый тик НЕ запланирован — иначе наложение стало бы возможным.
    expect(timers.pending()).toBe(0);
    expect(loop.stats().running).toBe(true);

    gate.resolve();
    await flush();
    expect(loop.stats().running).toBe(false);
    expect(timers.pending()).toBe(1);
    await loop.stop();
  });

  it('внешний tick во время прохода возвращается false и не запускает второй', async () => {
    const timers = fakeTimers();
    const gate = deferred();
    let entered = 0;
    const loop = createLoop({
      name: 'test',
      intervalMs: 1000,
      timers,
      run: async () => {
        entered += 1;
        await gate.promise;
      }
    });

    const running = loop.tick();
    await flush();
    expect(entered).toBe(1);

    const overlapped = await loop.tick();
    expect(overlapped).toBe(false);
    expect(loop.stats().overlaps).toBe(1);
    expect(entered).toBe(1);

    gate.resolve();
    await running;
    expect(loop.stats().ticks).toBe(1);
    await loop.stop();
  });

  it('runImmediately делает первый проход без ожидания паузы', async () => {
    const timers = fakeTimers();
    let ran = 0;
    const loop = createLoop({
      name: 'test',
      intervalMs: 1000,
      timers,
      runImmediately: true,
      run: async () => {
        ran += 1;
      }
    });
    loop.start();
    await flush();
    expect(ran).toBe(1);
    expect(timers.pending()).toBe(1);
    await loop.stop();
  });
});

describe('scheduler: устойчивость к отказам', () => {
  it('исключение не рвёт цепочку и зовёт onError каждый раз', async () => {
    const timers = fakeTimers();
    const errors: string[] = [];
    let passes = 0;
    const loop = createLoop({
      name: 'test',
      intervalMs: 500,
      timers,
      run: async () => {
        passes += 1;
        throw new Error(`boom-${passes}`);
      },
      onError: (error) => errors.push(error.message)
    });

    loop.start();
    timers.fire();
    await flush();
    timers.fire();
    await flush();

    expect(passes).toBe(2);
    expect(errors).toEqual(['boom-1', 'boom-2']);
    expect(loop.stats().consecutiveFailures).toBe(2);
    // Цепочка жива после двух падений: следующий тик всё ещё запланирован.
    expect(timers.pending()).toBe(1);
    await loop.stop();
  });

  it('onAlert срабатывает ровно один раз на пороге, а не каждый проход', async () => {
    const timers = fakeTimers();
    const alerts: number[] = [];
    const loop = createLoop({
      name: 'test',
      intervalMs: 10,
      timers,
      alertAfter: 3,
      run: async () => {
        throw new Error('down');
      },
      onAlert: (_error, meta) => alerts.push(meta.consecutiveFailures)
    });

    loop.start();
    for (let i = 0; i < 5; i++) {
      timers.fire();
      await flush();
    }
    expect(alerts).toEqual([3]);
    expect(loop.stats().consecutiveFailures).toBe(5);
    await loop.stop();
  });

  it('успех обнуляет счётчик неудач, и порог проходит заново', async () => {
    const timers = fakeTimers();
    let shouldFail = true;
    const alerts: number[] = [];
    const loop = createLoop({
      name: 'test',
      intervalMs: 10,
      timers,
      alertAfter: 2,
      run: async () => {
        if (shouldFail) throw new Error('down');
      },
      onAlert: (_error, meta) => alerts.push(meta.consecutiveFailures)
    });

    loop.start();
    timers.fire();
    await flush();
    timers.fire();
    await flush();
    expect(alerts).toEqual([2]);

    shouldFail = false;
    timers.fire();
    await flush();
    expect(loop.stats().consecutiveFailures).toBe(0);

    shouldFail = true;
    timers.fire();
    await flush();
    timers.fire();
    await flush();
    expect(alerts).toEqual([2, 2]);
    await loop.stop();
  });
});

describe('scheduler: остановка', () => {
  it('stop дожидается идущего прохода и больше не планирует', async () => {
    const timers = fakeTimers();
    const gate = deferred();
    let entered = 0;
    let left = 0;
    const loop = createLoop({
      name: 'test',
      intervalMs: 1000,
      timers,
      run: async () => {
        entered += 1;
        await gate.promise;
        left += 1;
      }
    });

    loop.start();
    timers.fire();
    await flush();
    expect(entered).toBe(1);

    const stopping = loop.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await flush();
    // Остановили, пока шёл проход: обещание остановки не должно исполниться раньше.
    expect(stopped).toBe(false);
    expect(timers.pending()).toBe(0);

    gate.resolve();
    await stopping;
    expect(left).toBe(1);
    expect(timers.pending()).toBe(0);

    timers.fire();
    await flush();
    expect(entered).toBe(1);
  });

  it('stop на ожидающем цикле отменяет тик и безопасен повторно', async () => {
    const timers = fakeTimers();
    let ran = 0;
    const loop = createLoop({
      name: 'test',
      intervalMs: 1000,
      timers,
      run: async () => {
        ran += 1;
      }
    });
    loop.start();
    expect(timers.pending()).toBe(1);
    await loop.stop();
    expect(timers.fire()).toBe(0);
    expect(ran).toBe(0);
    // Повторная остановка безопасна: `ctx.close()` вызывает её безусловно.
    await loop.stop();
    expect(ran).toBe(0);
  });

  it('start идемпотентен: второй вызов не заводит вторую цепочку таймеров', async () => {
    const timers = fakeTimers();
    const loop = createLoop({
      name: 'test',
      intervalMs: 1000,
      timers,
      run: async () => {}
    });
    loop.start();
    loop.start();
    loop.start();
    expect(timers.pending()).toBe(1);
    await loop.stop();
  });
});
