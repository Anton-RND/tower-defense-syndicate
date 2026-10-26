import { describe, expect, it } from 'vitest';

import { diffSetPayload, sameState, sameValue } from '../src/modules/user/doc.diff.js';
import { toSetPayload } from '../src/modules/user/mongo.model.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import { applyEconomyTick } from '../src/modules/economy/tick.js';
import { cloneAccount } from '../src/modules/user/user.types.js';
import { MINUTE, addMs, newAccount, testConfig, T0 } from './fixtures.js';

/**
 * Тесты дельта-записи документа (modules/user/doc.diff.ts).
 *
 * Оптимизация трогает единственный, но критичный инвариант стора: «то, что уехало в
 * Mongo, обязано дать ровно тот документ, что дал бы полный `$set`». Вся остальная
 * математика здесь — защита от двух обратных ошибок: потерять изменение (игрок теряет
 * ресурсы) и записать холостое (растёт `revision`, плодятся CAS-конфликты).
 */

const config = testConfig();

describe('user/doc.diff: sameValue', () => {
  it('сравнивает даты по моменту времени, а не по ссылке', () => {
    // cloneAccount плодит новые Date на каждый transact: сравнение по ссылке считало
    // бы каждый догон изменением и обнуляло бы весь смысл дельты.
    expect(sameValue(new Date(T0.getTime()), new Date(T0.getTime()))).toBe(true);
    expect(sameValue(new Date(T0.getTime()), addMs(T0, 1))).toBe(false);
  });

  it('считает различием всё, что не умеет сравнивать уверенно', () => {
    expect(sameValue(NaN, NaN)).toBe(false);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameValue([1, 2], [1, 2, 3])).toBe(false);
    expect(sameValue('1', 1)).toBe(false);
  });

  it('ходит вглубь по объектам и массивам', () => {
    expect(sameValue({ a: { b: [1, { c: T0 }] } }, { a: { b: [1, { c: new Date(T0.getTime()) }] } })).toBe(true);
    expect(sameValue({ a: { b: [1, { c: T0 }] } }, { a: { b: [1, { c: addMs(T0, 1) }] } })).toBe(false);
  });
});

describe('user/doc.diff: diffSetPayload', () => {
  it('холостой пейлоад даёт пустую дельту, а не «весь документ»', () => {
    const account = newAccount(config);
    const payload = toSetPayload(account);
    expect(diffSetPayload(payload, toSetPayload(cloneAccount(account)))).toEqual({});
  });

  it('возвращает ровно изменённое поле и не трогает соседнее', () => {
    const account = newAccount(config);
    const prev = toSetPayload(account);
    const next = toSetPayload({ ...account, resources: { ...account.resources, ferrum: 12_345 } });
    expect(Object.keys(diffSetPayload(prev, next))).toEqual(['resources']);
  });

  it('инвариант: prev + дельта === next, байт в байт', () => {
    // Единственная проверка, которая делает оптимизацию легальной: документ, собранный
    // из дельты, обязан читаться тем же аккаунтом. Ошибка здесь — потерянные данные.
    const account = newAccount(config);
    const prev = toSetPayload(account);
    const mutated = {
      ...account,
      resources: { ...account.resources, ferrum: 999, energy: 3 },
      storages: { ...account.storages, deuterium: 42 },
      inventory: [...account.inventory, { ...account.inventory[0]!, id: 'item-x' }],
      pvp: { ...account.pvp, rating: account.pvp.rating + 30 },
      revision: account.revision + 1
    };
    const next = toSetPayload(mutated);
    const rebuilt = { ...prev, ...diffSetPayload(prev, next) };
    expect(sameValue(rebuilt, next)).toBe(true);
  });

  it('массив уезжает целиком, а не по индексам', () => {
    // Позиционный `$set` по сдвинутому массиву удалил бы элемент и оставил бы мусор
    // в хвосте: `$set` не умеет укорачивать массив.
    const account = newAccount(config);
    const withItems = { ...account, inventory: [0, 1, 2].map((i) => ({ ...account.inventory[0]!, id: `i-${i}` })) };
    const prev = toSetPayload(withItems);
    const next = toSetPayload({ ...withItems, inventory: withItems.inventory.slice(0, 2) });
    const diff = diffSetPayload(prev, next);
    expect(Object.keys(diff)).toEqual(['inventory']);
    expect((diff.inventory as unknown[]).length).toBe(2);
  });
});

describe('user/doc.diff: sameState', () => {
  it('служебный revision не считается изменением', () => {
    const account = newAccount(config);
    expect(sameState(account, { ...account, revision: account.revision + 7 })).toBe(true);
  });

  it('любое изменение состояния замечено', () => {
    const account = newAccount(config);
    expect(sameState(account, { ...account, buildRobots: account.buildRobots + 1 })).toBe(false);
  });
});

describe('user/doc.diff: экономический догон на живом аккаунте', () => {
  it('не трогает тяжёлые поля — в том и состоит перерасход полного $set', () => {
    const account = newAccount(config, T0, 'doc-diff');
    account.inventory.push({
      id: 'item-heavy',
      kind: 'tower',
      code: 'tower_laser_mk1',
      level: 3,
      acquiredAt: T0,
      source: 'build',
      orderId: null
    });
    const ticked = applyEconomyTick(account, addMs(T0, 5 * MINUTE), config.economy);
    const keys = Object.keys(diffSetPayload(toSetPayload(account), toSetPayload(ticked.account)));
    expect(keys).not.toContain('inventory');
    expect(keys).not.toContain('base');
    expect(keys).not.toContain('orders');
    expect(keys).not.toContain('entitlements');
    // Догон обязан что-то изменить, иначе проверка вырождается в «дельта пустая».
    expect(keys.length).toBeGreaterThan(0);
  });
});

describe('user/memory.store: холостой transact', () => {
  it('не пишет документ и не растит revision (паритет с Mongo-драйвером)', async () => {
    const store = new MemoryUserStore();
    const seed = newAccount(config, T0, 'store-diff');
    await store.save(seed);

    const noop = await store.transact(seed.id, (current) => current);
    expect(noop.revision).toBe(seed.revision);

    const changed = await store.transact(seed.id, (current) => ({
      ...current,
      resources: { ...current.resources, ferrum: current.resources.ferrum + 1 }
    }));
    expect(changed.revision).toBe(seed.revision + 1);
    expect((await store.findById(seed.id))?.revision).toBe(seed.revision + 1);
  });

  it('редуктор, вернувший эквивалентный клон, считается холостым', async () => {
    const store = new MemoryUserStore();
    const seed = newAccount(config, T0, 'store-clone');
    await store.save(seed);
    const result = await store.transact(seed.id, (current) => cloneAccount(current));
    expect(result.revision).toBe(seed.revision);
  });
});

