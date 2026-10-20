import { describe, expect, it } from 'vitest';

import { MAX_BUILD_QUEUE, MAX_INVENTORY_ITEMS } from '../src/config/workshop.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { BuildJob, InventoryItem } from '../src/modules/user/user.types.js';
import {
  buildersBusy,
  buildersFree,
  buildersMax,
  nextBuilderFreeAt,
  settleBuilds,
  startBuild
} from '../src/modules/workshop/craft.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MINUTE, T0, addMs, errorCode, newAccount, testConfig, withJunk, withResources } from './fixtures.js';

const config = testConfig();
const base = newAccount(config);
let seq = 0;
const idFactory = () => `gen-${++seq}`;

/** Лазер Mk.I: 200 железа + 100 кремния + 2 чипа, 10 минут стройки. */
const LASER = 'tower_laser_mk1';

function richAccount(patch: { ferrum?: number; silicium?: number; chips?: number } = {}) {
  const account = withResources(newAccount(config), {
    ferrum: patch.ferrum ?? 5000,
    silicium: patch.silicium ?? 5000
  });
  return withJunk(account, { chips: patch.chips ?? 50 });
}

function inventoryOf(count: number): InventoryItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `item-${index}`,
    kind: 'tower' as const,
    code: LASER,
    level: 1,
    acquiredAt: T0,
    source: 'build' as const,
    orderId: null
  }));
}

function queueOf(count: number, endsAt: Date): BuildJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `job-${index}`,
    code: LASER,
    kind: 'tower' as const,
    level: 1,
    startedAt: T0,
    endsAt
  }));
}

describe('мастерская: крафт по чертежу', () => {
  it('списывает материалы, занимает робота и ставит работу в очередь', () => {
    const account = richAccount();
    const result = startBuild(account, LASER, T0, idFactory);

    expect(result.drafts.map((draft) => draft.currency)).toEqual(['ferrum', 'silicium', 'junk_chips']);
    expect(result.drafts.map((draft) => draft.delta)).toEqual([-200, -100, -2]);
    expect(result.drafts.every((draft) => draft.reason === 'craft')).toBe(true);
    expect(result.drafts[0]?.refType).toBe('blueprint');
    expect(result.account.resources.ferrum).toBe(4800);
    expect(result.account.junk.chips).toBe(48);
    expect(result.job.endsAt.getTime() - result.job.startedAt.getTime()).toBe(10 * MINUTE);
    expect(result.busyAfter).toBe(1);
    expect(result.freeAfter).toBe(1);
  });

  it('неизвестный чертёж — UNKNOWN_BLUEPRINT', () => {
    expect(errorCode(() => startBuild(richAccount(), 'tower_secret_mk9', T0, idFactory))).toBe(
      ErrorCodes.UNKNOWN_BLUEPRINT
    );
  });

  it('не хватило одного материала — INSUFFICIENT_FUNDS и ни одна стройка не началась', () => {
    const account = richAccount({ chips: 1 });
    expect(errorCode(() => startBuild(account, LASER, T0, idFactory))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
    expect(account.resources.ferrum).toBe(5000);
    expect(account.builds).toHaveLength(0);
  });

  it('два робота по умолчанию: третий запрос — NO_FREE_BUILDER с временем освобождения', () => {
    const first = startBuild(richAccount(), LASER, T0, idFactory);
    const second = startBuild(first.account, LASER, addMs(T0, MINUTE), idFactory);

    expect(buildersBusy(second.account, addMs(T0, MINUTE))).toBe(2);
    expect(buildersFree(second.account, addMs(T0, MINUTE))).toBe(0);

    try {
      startBuild(second.account, LASER, addMs(T0, 2 * MINUTE), idFactory);
      throw new Error('ожидался NO_FREE_BUILDER');
    } catch (error) {
      const details = (error as { details?: Record<string, unknown> }).details ?? {};
      expect((error as { code: string }).code).toBe(ErrorCodes.NO_FREE_BUILDER);
      // Первый робот освободился в T0+10m, второй — в T0+11m: ждём ближайшего.
      expect((details.readyAt as Date).getTime()).toBe(addMs(T0, 10 * MINUTE).getTime());
    }
  });

  it('купленный слот увеличивает пул роботов', () => {
    const account = { ...richAccount(), buildRobots: 3 };
    expect(buildersMax(account, T0)).toBe(3);
    const started = startBuild(startBuild(startBuild(account, LASER, T0, idFactory).account, LASER, T0, idFactory).account, LASER, T0, idFactory);
    expect(buildersBusy(started.account, T0)).toBe(3);
    expect(errorCode(() => startBuild(started.account, LASER, T0, idFactory))).toBe(ErrorCodes.NO_FREE_BUILDER);
  });

  it('settleBuilds переносит готовое в инвентарь и освобождает робота', () => {
    const started = startBuild(richAccount(), LASER, T0, idFactory);
    expect(settleBuilds(started.account, addMs(T0, 9 * MINUTE), idFactory).items).toHaveLength(0);

    const settled = settleBuilds(started.account, addMs(T0, 10 * MINUTE), idFactory);
    expect(settled.items).toHaveLength(1);
    expect(settled.overflow).toBe(0);
    expect(settled.account.inventory[0]?.code).toBe(LASER);
    expect(settled.account.inventory[0]?.source).toBe('build');
    expect(settled.account.builds).toHaveLength(0);
    expect(buildersBusy(settled.account, addMs(T0, 10 * MINUTE))).toBe(0);
    // Идемпотентно: второй вызов не находит завершённых работ.
    expect(settleBuilds(settled.account, addMs(T0, 11 * MINUTE), idFactory).items).toHaveLength(0);
  });

  it('buildersBusy выводится из очереди, а не хранится: упавший запрос не «ломает» робота', () => {
    const account = { ...richAccount(), builds: queueOf(2, addMs(T0, 10 * MINUTE)) };
    expect(buildersBusy(account, T0)).toBe(2);
    // Время вышло — роботы свободны сами, без единой записи «освободить».
    expect(buildersBusy(account, addMs(T0, 10 * MINUTE))).toBe(0);
    expect(nextBuilderFreeAt(account, T0)?.getTime()).toBe(addMs(T0, 10 * MINUTE).getTime());
    expect(nextBuilderFreeAt(account, addMs(T0, 10 * MINUTE))).toBeNull();
  });
});

describe('мастерская: потолки и атомарность', () => {
  it('готовая постройка терпеливо ждёт места в инвентаре (взаимоблокировки нет)', () => {
    const account: typeof base = {
      ...base,
      inventory: inventoryOf(MAX_INVENTORY_ITEMS),
      builds: queueOf(1, addMs(T0, -MINUTE))
    };
    const settled = settleBuilds(account, T0, idFactory);

    // Ни одного предмета не влезло, работа осталась в очереди — и dismantle продолжит работать.
    expect(settled.items).toHaveLength(0);
    expect(settled.overflow).toBe(1);
    expect(settled.account).toBe(account);
  });

  it('инвентарь забит — новая стройка не принимается', () => {
    const account = { ...base, inventory: inventoryOf(MAX_INVENTORY_ITEMS) };
    expect(errorCode(() => startBuild(account, LASER, T0, idFactory))).toBe(ErrorCodes.INVENTORY_FULL);
  });

  it('очередь стройки имеет потолок', () => {
    const account = { ...base, buildRobots: MAX_BUILD_QUEUE + 5, builds: queueOf(MAX_BUILD_QUEUE, addMs(T0, 60 * MINUTE)) };
    expect(errorCode(() => startBuild(account, LASER, T0, idFactory))).toBe(ErrorCodes.BUILD_QUEUE_FULL);
  });

  it('упавший редуктор не оставляет следов в сторе (всё или ничего)', async () => {
    const store = new MemoryUserStore();
    const seed = richAccount({ chips: 0 });
    await store.save(seed);

    await expect(store.transact(seed.id, (current) => startBuild(current, LASER, T0, idFactory).account)).rejects.toThrow();

    const failed = await store.findById(seed.id);
    expect(failed?.resources.ferrum).toBe(5000);
    expect(failed?.builds).toHaveLength(0);
    expect(failed?.revision).toBe(seed.revision);

    const ok = await store.transact(seed.id, (current) =>
      startBuild({ ...current, junk: { ...current.junk, chips: 10 } }, LASER, T0, idFactory).account
    );
    expect(ok.resources.ferrum).toBe(4800);
    expect(ok.builds).toHaveLength(1);
    expect(ok.revision).toBe(seed.revision + 1);
  });
});
