import { describe, expect, it } from 'vitest';

import { Limiter, perMinutePolicy } from '../src/lib/limiter.js';

/**
 * lib/limiter: токен-бакет с потолком ключей.
 *
 * Часы инжектятся во всех тестах — не ради скорости (сюита и так бегает секунды),
 * а ради детерминированности: восстановление по времени нельзя проверить `sleep`-ом
 * честно, на медленной машине CI такой тест краснеет сам, а на быстрой — пропускает
 * регрессию. Здесь же каждый тик времени — явное утверждение.
 */

/** Часы, которыми управляет тест. */
function fakeClock(startMs = 0): { now: () => number; advance: (ms: number) => void } {
  let at = startMs;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    }
  };
}

const options = { maxKeys: 1_000, idleTtlMs: 60_000 };

describe('lib/limiter: всплеск и восстановление', () => {
  it('пропускает ровно ёмкость подряд и отказывает на переполнении', () => {
    const clock = fakeClock();
    const limiter = new Limiter({ capacity: 2, refillPerSec: 1 }, { ...options, now: clock.now });

    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(true);
    const third = limiter.take('a');
    expect(third.allowed).toBe(false);
    expect(third.remaining).toBe(0);
  });

  it('восстанавливает токены временем, а не числом отказов', () => {
    const clock = fakeClock();
    const limiter = new Limiter({ capacity: 2, refillPerSec: 1 }, { ...options, now: clock.now });

    limiter.take('a');
    limiter.take('a');
    expect(limiter.take('a').allowed).toBe(false);
    // Отказ не списывает токены и не накапливает штраф: повтор того же запроса
    // через половину секунды всё ещё должен проходить мимо.
    expect(limiter.take('a').allowed).toBe(false);

    clock.advance(1_000);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('не копит токены выше ёмкости: простой не даёт права на двойной всплеск', () => {
    const clock = fakeClock();
    const limiter = new Limiter({ capacity: 3, refillPerSec: 1 }, { ...options, now: clock.now });

    clock.advance(3_600_000);
    expect(limiter.take('a').remaining).toBe(2);
    expect(limiter.take('a').remaining).toBe(1);
    expect(limiter.take('a').remaining).toBe(0);
    expect(limiter.take('a').allowed).toBe(false);
  });

  it('retryAfterSec обещает срок, к которому токен действительно появится', () => {
    const clock = fakeClock();
    const limiter = new Limiter({ capacity: 1, refillPerSec: 0.5 }, { ...options, now: clock.now });

    limiter.take('a');
    const denied = limiter.take('a');
    expect(denied.allowed).toBe(false);
    // 1 токен при 0.5/сек = ровно 2 секунды. Меньше — клиент упрётся в повторный
    // отказ, больше — простоит без дела; обе цены оплачивает игрок с плохой сетью.
    expect(denied.retryAfterSec).toBe(2);
    clock.advance(2_000);
    expect(limiter.take('a').allowed).toBe(true);
  });

  it('cost больше ёмкости — постоянный отказ, но без деления на ноль и зависания', () => {
    const limiter = new Limiter({ capacity: 2, refillPerSec: 1 }, options);
    const verdict = limiter.take('a', 5);
    expect(verdict.allowed).toBe(false);
    expect(Number.isFinite(verdict.retryAfterSec)).toBe(true);
    expect(verdict.retryAfterSec).toBe(3);
  });

  it('ключи независимы: один адрес не может исчерпать бюджет другого', () => {
    const limiter = new Limiter({ capacity: 1, refillPerSec: 1 }, options);
    expect(limiter.take('a').allowed).toBe(true);
    expect(limiter.take('a').allowed).toBe(false);
    expect(limiter.take('b').allowed).toBe(true);
  });
});

describe('lib/limiter: потолок ключей — то, ради чего он написан', () => {
  it('карта не растёт бесконечно, сколько бы адресов ни приходило', () => {
    const limiter = new Limiter({ capacity: 10, refillPerSec: 1 }, { maxKeys: 3, idleTtlMs: 60_000 });
    for (let index = 0; index < 1_000; index += 1) limiter.take(`ip-10.0.${index >> 8}.${index & 255}`);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });

  it('вытесняется давно не трогаемый адрес, а не самый свежий', () => {
    const limiter = new Limiter({ capacity: 10, refillPerSec: 1 }, { maxKeys: 3, idleTtlMs: 60_000 });

    limiter.take('a');
    limiter.take('a'); // a: 8 токенов
    limiter.take('b');
    limiter.take('c');
    limiter.take('a'); // a снова свежий: 7 токенов, порядок b, c, a

    // Вставка d вытесняет b — наименее давно использовавшийся ключ.
    expect(limiter.take('d').remaining).toBe(9);
    // a выжил: после следующего хода у него 6 токенов. Был бы он вытеснен — бакет
    // начался бы с чистого, и различие составило бы ровно один шаг.
    expect(limiter.take('a').remaining).toBe(6);
    // b стёрт: начинается с чистой ёмкости.
    expect(limiter.take('b').remaining).toBe(9);
  });

  it('протухшие адреса выбрасываются сами, без обращения к потолку', () => {
    const clock = fakeClock();
    const limiter = new Limiter(
      { capacity: 5, refillPerSec: 1 },
      { maxKeys: 1_000, idleTtlMs: 1_000, now: clock.now }
    );

    limiter.take('a');
    limiter.take('b');
    expect(limiter.size).toBe(2);

    clock.advance(5_000);
    limiter.take('c');
    expect(limiter.size).toBe(1);
    // Свежий бакет: a был выброшен как протухший, а не разорён отказами.
    expect(limiter.take('a').remaining).toBe(4);
  });

  it('reset очищает карту целиком', () => {
    const limiter = new Limiter({ capacity: 5, refillPerSec: 1 }, options);
    limiter.take('a');
    limiter.take('b');
    limiter.reset();
    expect(limiter.size).toBe(0);
  });
});

describe('lib/limiter: границы политики', () => {
  it('perMinutePolicy: бакет равен минутному лимиту, восстановление — лимиту / 60', () => {
    expect(perMinutePolicy(30)).toEqual({ capacity: 30, refillPerSec: 0.5 });
    expect(perMinutePolicy(10).refillPerSec).toBeCloseTo(1 / 6, 10);
  });

  it('политика с пустым бакетом не создаётся: это ошибка конфигурации, а не режим', () => {
    expect(() => new Limiter({ capacity: 0, refillPerSec: 0 }, options)).toThrow(/capacity/);
    expect(() => new Limiter({ capacity: 10, refillPerSec: 0 }, options)).toThrow(/refillPerSec/);
    expect(() => new Limiter({ capacity: 10, refillPerSec: 1 }, { ...options, maxKeys: 0 })).toThrow(/maxKeys/);
    expect(() => new Limiter({ capacity: 10, refillPerSec: 1 }, { ...options, idleTtlMs: 0 })).toThrow(/idleTtlMs/);
  });
});
