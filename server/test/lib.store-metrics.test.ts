import { describe, expect, it } from 'vitest';

import { JUNK_IDS } from '../src/config/workshop.js';
import { loadConfig } from '../src/config/env.js';
import { buildApp } from '../src/http/app.js';
import { createContext } from '../src/http/context.js';
import { createStoreMetrics, createNoopAwareStoreMetrics } from '../src/lib/store.metrics.js';
import { MemoryClanStore } from '../src/modules/clan/clan.store.js';
import { MemoryCommodityStore } from '../src/modules/market/commodity.store.js';
import { neutralCommodity } from '../src/modules/market/commodity.types.js';
import { MemoryLotStore } from '../src/modules/market/lot.store.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import { cloneAccount } from '../src/modules/user/user.types.js';
import { newAccount, testConfig } from './fixtures.js';

/**
 * Счётчики сторов (lib/store.metrics.ts).
 *
 * Файл разложен по трём слоям, потому что у каждого своя причина падать:
 *
 *  1. сама арифметика (`createStoreMetrics`) — `noops` различает «не считалось» и
 *     «ноль», а `maxAttempts` обязан помнить худшую попытку, а не последнюю;
 *  2. места ВЫЗОВА в драйверах — счётчик, в который никто не позвонил, врёт молча.
 *     Здесь проверяются memory-драйверы всех четырёх сторов: только так видно
 *     разницу между «стор не различает холостые ходы» (`noops: null`) и «различает,
 *     но не вызывается»;
 *  3. `/health` — форма ответа оператора. Поле, не доехавшее до JSON, бесполезно.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ. CAS-конфликта и исчерпания попыток на НАСТОЯЩЕЙ базе.
 * Вызвать их детерминированно можно только швом в производственном коде: окно между
 * `findById` и `updateOne` закрывается в одной очереди событий, а `$unset revision`
 * не работает — mongoose вырезает `undefined` из фильтра, и CAS наоборот совпадает.
 * Поэтому арифметика конфликта покрыта в слое 1 напрямую, а звонок из цикла — слоем 2
 * (у memory-драйвера конфликтов нет по построению, и его `casConflicts: 0` сам по себе
 * утверждение: любой ненулевой конфликт в проде приходит из mongo). Дырка осознанная
 * и единственная в этом файле.
 */

const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

describe('lib/store-metrics: арифметика счётчиков', () => {
  it('`noops`: не измеряется — это null, измеряется и нет ходов — это 0', () => {
    // Различение принимается при сборке, а не по первому событию: иначе оператор
    // не может отличить «драйвер не сравнивает» от «ещё не было холостого хода».
    expect(createStoreMetrics().snapshot().noops).toBeNull();

    const metrics = createNoopAwareStoreMetrics();
    expect(metrics.snapshot().noops).toBe(0);
    metrics.noop();
    metrics.noop();
    expect(metrics.snapshot().noops).toBe(2);
  });

  it('`maxAttempts` помнит худшую попытку, а не последнюю', () => {
    const metrics = createStoreMetrics();
    metrics.conflict(4);
    metrics.conflict(2);
    const mid = metrics.snapshot();
    expect(mid.casConflicts).toBe(2);
    expect(mid.maxAttempts).toBe(4);

    // Исчерпание попыток — тоже попытка: рейд, сорванный на пятой, обязан попасть
    // в ту же метрику глубины, что и успешный на четвёртой.
    metrics.abandon(5);
    const done = metrics.snapshot();
    expect(done.abandoned).toBe(1);
    expect(done.maxAttempts).toBe(5);
  });

  it('момент конфликта фиксируется по каждому событию', () => {
    let clock = Date.UTC(2026, 9, 18, 0, 0, 0);
    const metrics = createStoreMetrics({ now: () => new Date(clock) });
    expect(metrics.snapshot().lastConflictAt).toBeNull();

    metrics.conflict(1);
    expect(metrics.snapshot().lastConflictAt).toBe('2026-10-18T00:00:00.000Z');

    clock += 1_000;
    metrics.conflict(1);
    expect(metrics.snapshot().lastConflictAt).toBe('2026-10-18T00:00:01.000Z');
  });

  it('снимок — копия: наружу не отдаётся живое состояние счётчиков', () => {
    const metrics = createStoreMetrics();
    metrics.write();
    const snapshot = metrics.snapshot() as unknown as Record<string, unknown>;
    snapshot.writes = 999;
    expect(metrics.snapshot().writes).toBe(1);
  });
});

describe('lib/store-metrics: места вызова в драйверах', () => {
  it('user: холостой ход не пишет и помечается noop-ом, реальный — пишет', async () => {
    const users = new MemoryUserStore();
    const account = newAccount(config);
    await users.save(account);

    // Нулевая форма, а не `undefined`: оператор, сравнивающий два снимка, обязан
    // вычитать поля, а не проверять их на существование.
    expect(users.metrics()).toEqual({
      transacts: 0,
      reads: 0,
      writes: 0,
      noops: 0,
      casConflicts: 0,
      abandoned: 0,
      maxAttempts: 0,
      lastConflictAt: null
    });

    await users.findById(account.id);
    // Редуктор-тождество: состояние не изменилось → ни записи, ни revision.
    await users.transact(account.id, (current) => cloneAccount(current));
    const idle = users.metrics();
    expect(idle.transacts).toBe(1);
    expect(idle.reads).toBe(2);
    expect(idle.writes).toBe(0);
    expect(idle.noops).toBe(1);

    await users.transact(account.id, (current) => ({
      ...current,
      resources: { ...current.resources, sec: current.resources.sec + 1 }
    }));
    const real = users.metrics();
    expect(real.transacts).toBe(2);
    expect(real.writes).toBe(1);
    expect(real.noops).toBe(1);
    expect((await users.findById(account.id))?.revision).toBe(1);
  });

  it('user: отказ редуктора не записывается и не считается холостым ходом', async () => {
    const users = new MemoryUserStore();
    const account = newAccount(config);
    await users.save(account);

    await expect(
      users.transact(account.id, () => {
        throw new Error('редуктор отказал');
      })
    ).rejects.toThrow('редуктор отказал');

    const after = users.metrics();
    expect(after.transacts).toBe(1);
    expect(after.writes).toBe(0);
    // Отказ — не холостой ход: смешать их значило бы показать оператору, что
    // половина запросов игроков «ничего не меняет», хотя на деле они падали.
    expect(after.noops).toBe(0);
  });

  it('lot и clan: noops остаётся null — различение стоит сравнения документов', async () => {
    expect(new MemoryLotStore().metrics().noops).toBeNull();
    expect(new MemoryClanStore().metrics().noops).toBeNull();
  });

  it('commodity: ревизия редуктора бесплатна и обнажает записанную впустую строку', async () => {
    const junk = JUNK_IDS[0]!;
    const commodities = new MemoryCommodityStore();
    await commodities.ensure(neutralCommodity(junk, new Date()));

    // Редуктор, не тронувший revision (пересчёт внутри паузы), всё равно пишет
    // документ целиком — именно эту цену пара `noops`/`writes` и обязана показывать.
    await commodities.transact(junk, (current) => current);
    const idle = commodities.metrics();
    expect(idle.noops).toBe(1);
    expect(idle.writes).toBe(1);
  });
});

describe('lib/store-metrics: /health', () => {
  it('отдаёт счётчики всех четырёх сторов и только числа', async () => {
    const users = new MemoryUserStore();
    const clans = new MemoryClanStore();
    const lots = new MemoryLotStore();
    const commodities = new MemoryCommodityStore();
    const app = await buildApp(
      createContext(testConfig({ DEV_SIGNER_ENABLED: 'true' }), {
        users,
        clans,
        lots,
        commodities,
        ledger: new MemoryLedgerStore()
      })
    );
    try {
      const response = await app.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { stores: Record<string, Record<string, unknown>> };

      expect(Object.keys(body.stores).sort()).toEqual(['clans', 'commodities', 'lots', 'users']);
      const fields = [
        'abandoned',
        'casConflicts',
        'lastConflictAt',
        'maxAttempts',
        'noops',
        'reads',
        'transacts',
        'writes'
      ];
      for (const [name, snapshot] of Object.entries(body.stores)) {
        expect(Object.keys(snapshot).sort(), name).toEqual([...fields].sort());
        // Персональных данных здесь нет по построению: целые числа и одна метка
        // времени (см. шапку lib/store.metrics.ts).
        for (const field of fields) {
          if (field === 'noops' || field === 'lastConflictAt') continue;
          expect(typeof snapshot[field], `${name}.${field}`).toBe('number');
        }
      }

      // Числа живые, а не застывшая форма: один ход — и счётчик сдвинулся.
      const account = newAccount(config);
      await users.save(account);
      await users.transact(account.id, (current) => cloneAccount(current));
      const after = (await app.inject({ method: 'GET', url: '/health' })).json() as typeof body;
      expect(after.stores.users?.transacts).toBe(1);
      expect(after.stores.users?.noops).toBe(1);
    } finally {
      await app.close();
    }
  });
});
