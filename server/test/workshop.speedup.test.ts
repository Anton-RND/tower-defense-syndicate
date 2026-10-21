import { describe, expect, it } from 'vitest';

import {
  CHRONIUM_BUNDLE_DISCOUNT,
  CHRONIUM_MAX_BATCH,
  CHRONIUM_MIN_COST,
  CHRONIUM_MS_PER_UNIT
} from '../src/config/materials.js';
import { MAX_INVENTORY_ITEMS, getBlueprint } from '../src/config/workshop.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import type { LedgerDraft } from '../src/modules/ledger/ledger.types.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { BuildJob, InventoryItem, UserAccount } from '../src/modules/user/user.types.js';
import {
  applyChroniumSpeedup,
  buildersBusy,
  chroniumBundlePrice,
  chroniumPrice,
  chroniumToMs,
  describeSpeedup,
  describeSpeedupAll,
  settleBuilds,
  speedupAllBuilds,
  speedupCraft,
  startBuild
} from '../src/modules/workshop/craft.js';
import {
  HOUR,
  MINUTE,
  T0,
  addMs,
  errorCode,
  newAccount,
  testConfig,
  withJunk,
  withMetals,
  withResources,
  withTech
} from './fixtures.js';

/**
 * Мгновенное ускорение стройки за хрониум и сырьевая стоимость тяжёлых чертежей.
 *
 * Главное здесь не цена, а порядок операций: списание обязано происходить ПОСЛЕ всех
 * проверок и ПЕРЕД выдачей предмета. Тогда невыразимо состояние «хрониум ушёл, товар
 * не пришёл» — и симметрично «товар пришёл, хрониум остался».
 *
 * Второй сквозной сюжет — разделение ролей материалов: ускорение времени списывает
 * хрониум и никогда не трогает астерий (деньги) или вольфрам (сырьё чертежей). Каждый
 * тест, где это заметно, проверяет соседние счётчики явно: подмена роли валится тихо,
 * по одному движению в журнале.
 */

const config = testConfig();
let seq = 0;
const idFactory = () => `gen-${++seq}`;

/** Лазер Mk.I: 10 минут стройки, железо/кремний/чипы. */
const LASER = 'tower_laser_mk1';
/** Плазменная пушка P-1: тир-3, оплата только металлами, 75 минут. */
const PLASMA = 'weapon_plasma_cannon_mk3';
/** Тяжёлый рельсотрон: тир-3, единственные «тяжёлые» 50 вольфрама в чертеже. */
const RAILGUN = 'weapon_railgun_heavy_mk3';

/** Игрок с полным складом всего, кроме сырья: сырьё — параметром, чтобы тесты не спорили о норме. */
function funded(chronium = 1000, wolfram = 0, stanium = 0): UserAccount {
  const account = withResources(newAccount(config), { ferrum: 100_000, silicium: 100_000, uranium: 100_000 });
  const junk = withJunk(account, {
    chips: 500,
    boards: 500,
    engines: 500,
    transmissions: 500,
    batteries: 500,
    ammo_casings: 500
  });
  const metals = withMetals(junk, { black_metal: 5000, colored_metal: 5000, precious_metal: 5000 });
  return withTech(metals, { chronium, wolfram, stanium });
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

function queueOf(count: number, endsAt: Date, prefix = 'job'): BuildJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${index}`,
    code: LASER,
    kind: 'tower' as const,
    level: 1,
    startedAt: T0,
    endsAt
  }));
}

describe('speedup: цена хрониума', () => {
  it('нулевой и отрицательный остаток не стоят ничего (просроченную работу продать нельзя)', () => {
    expect(chroniumPrice(0)).toBe(0);
    expect(chroniumPrice(-MINUTE)).toBe(0);
    expect(chroniumPrice(Number.NaN)).toBe(0);
    expect(chroniumPrice(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('одна единица срезает ровно минуту, остаток округляется вверх, ниже минимального чека — чек', () => {
    expect(CHRONIUM_MS_PER_UNIT).toBe(MINUTE);
    expect(chroniumPrice(CHRONIUM_MS_PER_UNIT)).toBe(CHRONIUM_MIN_COST);
    // Округление вверх: 61 секунда стоит 2 хрониума. Вниз подарило бы игроку минуту
    // за половину единицы и сделало бы цену непонятной («заплатил 1, а ускорилось на 61с»).
    expect(chroniumPrice(CHRONIUM_MS_PER_UNIT + 1)).toBe(CHRONIUM_MIN_COST + 1);
    expect(chroniumPrice(30_000)).toBe(CHRONIUM_MIN_COST);
    expect(chroniumPrice(9 * MINUTE)).toBe(9);
    expect(chroniumPrice(HOUR)).toBe(60);
    expect(chroniumToMs(3)).toBe(3 * CHRONIUM_MS_PER_UNIT);
  });

  it('пачка дешевле суммы отдельных кнопок, но никогда не нулевая', () => {
    const jobs = [...queueOf(2, addMs(T0, 60 * MINUTE), 'a'), ...queueOf(1, addMs(T0, 30 * MINUTE), 'b')];
    const singles = jobs.reduce((sum, job) => sum + chroniumPrice(job.endsAt.getTime() - T0.getTime()), 0);
    expect(singles).toBe(150);
    expect(chroniumBundlePrice(jobs, T0)).toBe(135);
    expect(chroniumBundlePrice([], T0)).toBe(0);

    // 1 секунда остатка: ceil(1 * 0.9) = 1 — скидка не должна обнулять чек.
    const crumbs = queueOf(1, addMs(T0, 1_000), 'c');
    expect(chroniumBundlePrice(crumbs, T0)).toBe(CHRONIUM_MIN_COST);
    expect(CHRONIUM_BUNDLE_DISCOUNT).toBeLessThan(1);
  });
});

describe('speedup: мгновенное завершение одной работы', () => {
  it('списывает хрониум, обнуляет таймер, выдаёт предмет и освобождает робота', () => {
    const started = startBuild(funded(), PLASMA, T0, idFactory);
    const jobId = started.job.id;

    const rushed = applyChroniumSpeedup(started.account, jobId, addMs(T0, 15 * MINUTE), idFactory);

    expect(rushed.cost).toBe(60);
    expect(rushed.savedMs).toBe(60 * MINUTE);
    expect(rushed.drafts.map((draft) => draft.currency)).toEqual(['chronium']);
    expect(rushed.drafts[0]).toMatchObject({
      delta: -60,
      balanceAfter: 940,
      reason: 'upgrade',
      refType: 'build_job',
      refId: jobId,
      idempotencyKey: `rush:${jobId}:60`
    });
    expect(rushed.account.materials.chronium).toBe(940);
    // Роль материала проверяется соседними счётчиками: ускорение времени не должно
    // ни съесть донатный кошелёк, ни потратить сырьё чертежа.
    expect(rushed.account.materials.asterium).toEqual(started.account.materials.asterium);
    expect(rushed.account.materials.wolfram).toBe(0);
    expect(rushed.account.builds).toHaveLength(0);
    expect(rushed.items.map((item) => item.code)).toEqual([PLASMA]);
    expect(buildersBusy(rushed.account, addMs(T0, MINUTE))).toBe(0);
    expect(rushed.freeAfter).toBe(2);
  });

  it('материалы чертежа списываются один раз — на старте, а не на ускорении', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const rushed = applyChroniumSpeedup(started.account, started.job.id, addMs(T0, MINUTE), idFactory);

    expect(rushed.account.resources.ferrum).toBe(started.account.resources.ferrum);
    expect(rushed.drafts.every((draft) => draft.reason === 'upgrade')).toBe(true);
  });

  it('долг по сырью не тратится: отрицательный баланс — INSUFFICIENT_FUNDS', () => {
    // Возврат платежа оставляет минус (wallet.refundTech). Он гасится новыми
    // начислениями хрониума, но ни в коем случае не становится «кредитом», за который
    // можно ускорить стройку: debit откажет на любом положительном количестве.
    const started = startBuild(funded(-5), PLASMA, T0, idFactory);
    expect(started.account.materials.chronium).toBe(-5);

    expect(errorCode(() => applyChroniumSpeedup(started.account, started.job.id, addMs(T0, MINUTE), idFactory))).toBe(
      ErrorCodes.INSUFFICIENT_FUNDS
    );
  });

  it('дозревшую работу не продаёт: сначала settle, потом отказ', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const stale = addMs(T0, 10 * MINUTE);

    // Есть место — работа уезжает в инвентарь бесплатно, и ускорять становится нечего:
    // команды «ускорить завершённое» просто не существует в данных.
    expect(errorCode(() => applyChroniumSpeedup(started.account, started.job.id, stale, idFactory))).toBe(
      ErrorCodes.BUILD_NOT_FOUND
    );
    expect(started.account.materials.chronium).toBe(1000);
    expect(settleBuilds(started.account, stale, idFactory).items).toHaveLength(1);

    // Места нет — работа висит в очереди с прошедшим сроком. Продать её как
    // «ускоряемую» нельзя: игрок видел бы нулевой таймер и платил за него.
    const stuck: UserAccount = { ...started.account, inventory: inventoryOf(MAX_INVENTORY_ITEMS) };
    expect(errorCode(() => applyChroniumSpeedup(stuck, started.job.id, stale, idFactory))).toBe(
      ErrorCodes.BUILD_ALREADY_DONE
    );
    expect(stuck.materials.chronium).toBe(1000);
  });

  it('нет такой работы — BUILD_NOT_FOUND, пустая очередь — NOTHING_TO_RUSH', () => {
    const account = funded();
    expect(errorCode(() => applyChroniumSpeedup(account, 'job-nope', T0, idFactory))).toBe(ErrorCodes.BUILD_NOT_FOUND);
    expect(errorCode(() => speedupAllBuilds(account, T0, idFactory))).toBe(ErrorCodes.NOTHING_TO_RUSH);
  });
});


describe('speedup: частичное ускорение (игрок вливает количество)', () => {
  it('срезает ровно столько времени, сколько куплено, и предмет не выдаёт', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const part = speedupCraft(started.account, started.job.id, 4, T0, idFactory);

    expect(part.cost).toBe(4);
    expect(part.requested).toBe(4);
    expect(part.leftover).toBe(0);
    expect(part.done).toBe(false);
    expect(part.savedMs).toBe(4 * MINUTE);
    expect(part.job.endsAt).toEqual(addMs(T0, 6 * MINUTE));
    expect(part.items).toHaveLength(0);
    expect(part.account.builds).toHaveLength(1);
    expect(part.account.materials.chronium).toBe(996);
    expect(part.drafts[0]?.idempotencyKey).toBe(`rush:${started.job.id}:4`);
  });

  it('правило честности: излишек влитого не списывается, а работа доезжает до нуля', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const over = speedupCraft(started.account, started.job.id, 50, T0, idFactory);

    expect(over.cost).toBe(10);
    expect(over.requested).toBe(50);
    expect(over.leftover).toBe(40);
    expect(over.done).toBe(true);
    expect(over.account.materials.chronium).toBe(990);
    expect(over.items.map((item) => item.code)).toEqual([LASER]);
    expect(over.account.builds).toHaveLength(0);
  });

  it('количество вне диапазона — SPEEDUP_AMOUNT_INVALID до любых списаний', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const jobId = started.job.id;

    [0, -1, 1.5, Number.NaN, CHRONIUM_MAX_BATCH + 1].forEach((amount) => {
      expect(errorCode(() => speedupCraft(started.account, jobId, amount, T0, idFactory))).toBe(
        ErrorCodes.SPEEDUP_AMOUNT_INVALID
      );
    });
    expect(started.account.materials.chronium).toBe(1000);
  });

  it('место в инвентаре нужно только когда работа доезжает до нуля', () => {
    const started = startBuild(funded(), PLASMA, T0, idFactory);
    const crowded: UserAccount = { ...started.account, inventory: inventoryOf(MAX_INVENTORY_ITEMS) };

    // Частичное ускорение предмет не выдаёт, поэтому и блокировать полным складом незачем.
    const part = speedupCraft(crowded, started.job.id, 5, T0, idFactory);
    expect(part.done).toBe(false);
    expect(part.account.materials.chronium).toBe(995);

    // А полное — отказ ДО списания: хрониум обязан остаться на балансе.
    expect(errorCode(() => applyChroniumSpeedup(crowded, started.job.id, T0, idFactory))).toBe(
      ErrorCodes.INVENTORY_FULL
    );
    expect(errorCode(() => speedupCraft(crowded, started.job.id, 500, T0, idFactory))).toBe(ErrorCodes.INVENTORY_FULL);
    expect(crowded.materials.chronium).toBe(1000);
  });
});

describe('speedup: атомарность сквозь стор', () => {
  it('не хватило хрониума — INSUFFICIENT_FUNDS и ни одного изменения записи', async () => {
    const store = new MemoryUserStore();
    const started = startBuild(funded(0), PLASMA, T0, idFactory);
    const seed = withTech(started.account, { chronium: 2 });
    await store.save(seed);

    await expect(
      store.transact(
        seed.id,
        (current) => applyChroniumSpeedup(current, started.job.id, addMs(T0, MINUTE), idFactory).account
      )
    ).rejects.toMatchObject({ code: ErrorCodes.INSUFFICIENT_FUNDS });

    const failed = await store.findById(seed.id);
    expect(failed?.materials.chronium).toBe(2);
    expect(failed?.builds).toHaveLength(1);
    expect(failed?.inventory).toHaveLength(0);
  });

  it('успешное ускорение пишет и аккаунт, и движение журнала; дубль движения отбрасывается', async () => {
    const store = new MemoryUserStore();
    const ledger = new MemoryLedgerStore();
    await ledger.connect();
    const started = startBuild(funded(60), PLASMA, T0, idFactory);
    await store.save(started.account);

    let drafts: LedgerDraft[] = [];
    const saved = await store.transact(started.account.id, (current) => {
      const rushed = applyChroniumSpeedup(current, started.job.id, addMs(T0, 15 * MINUTE), idFactory);
      drafts = rushed.drafts;
      return rushed.account;
    });

    expect(saved.materials.chronium).toBe(0);
    expect(saved.builds).toHaveLength(0);
    expect(drafts).toHaveLength(1);

    const entry = { ...(drafts[0] as LedgerDraft), id: 'entry-1' };
    expect(await ledger.appendMany([entry])).toBe(1);
    // Ретрай того же действия: уникальный индекс по idempotencyKey, а не по id.
    expect(await ledger.appendMany([{ ...entry, id: 'entry-2' }])).toBe(0);
    expect(await ledger.count(saved.id)).toBe(1);
  });
});


describe('speedup: вся очередь за один чек', () => {
  /** Смешанная очередь: лазер (10 мин) + плазмаган (75 мин), ускорение в момент старта. */
  function twoJobs(): { account: UserAccount; ids: string[] } {
    const first = startBuild(funded(), LASER, T0, idFactory);
    const second = startBuild(first.account, PLASMA, T0, idFactory);
    return { account: second.account, ids: [first.job.id, second.job.id] };
  }

  it('выдаёт один черновик на пачку со скидкой и заполняет инвентарь обоими предметами', () => {
    const { account, ids } = twoJobs();
    // 10 (лазер) + 75 (плазмаган) = 85, скидка на пачку 0.9 → ceil(76.5) = 77.
    const rushed = speedupAllBuilds(account, T0, idFactory);

    expect(rushed.cost).toBe(77);
    expect(rushed.savedMs).toBe(85 * MINUTE);
    expect(rushed.drafts).toHaveLength(1);
    expect(rushed.drafts[0]).toMatchObject({
      delta: -77,
      balanceAfter: 923,
      currency: 'chronium',
      reason: 'upgrade',
      refType: 'build_job',
      idempotencyKey: `rush:all:${ids[0]}+${ids[1]}`
    });
    expect(rushed.account.materials.chronium).toBe(923);
    expect(rushed.account.materials.asterium).toEqual(account.materials.asterium);
    expect(rushed.account.builds).toHaveLength(0);
    expect(rushed.items.map((item) => item.code).sort()).toEqual([LASER, PLASMA].sort());
    expect(rushed.jobs.map((job) => job.id)).toEqual(ids);
    expect(rushed.busyAfter).toBe(0);
  });

  it('места на всю пачку не хватает — отказ до списания', () => {
    const { account } = twoJobs();
    const crowded: UserAccount = { ...account, inventory: inventoryOf(MAX_INVENTORY_ITEMS - 1) };

    expect(errorCode(() => speedupAllBuilds(crowded, T0, idFactory))).toBe(ErrorCodes.INVENTORY_FULL);
    expect(crowded.materials.chronium).toBe(1000);
  });

  it('кнопка «Ускорить всё» гаснет при нехватке хрониума, но не бросает', () => {
    const poor = withTech(twoJobs().account, { chronium: 10 });
    expect(describeSpeedupAll(poor, T0)).toMatchObject({ count: 2, cost: 77, canSpeedup: false, reason: 'funds' });
    expect(errorCode(() => speedupAllBuilds(poor, T0, idFactory))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);

    expect(describeSpeedupAll(twoJobs().account, T0)).toMatchObject({ count: 2, canSpeedup: true, reason: 'ok' });
    expect(describeSpeedupAll(funded(), T0).reason).toBe('empty');

    const crowded: UserAccount = { ...twoJobs().account, inventory: inventoryOf(MAX_INVENTORY_ITEMS - 1) };
    expect(describeSpeedupAll(crowded, T0).reason).toBe('inventory_full');
  });

  it('повтор того же запроса не выписывает второй чек в журнале', async () => {
    const store = new MemoryLedgerStore();
    await store.connect();

    const rushed = speedupAllBuilds(twoJobs().account, T0, idFactory);
    const asEntry = (draft: LedgerDraft, id: string) => ({ ...draft, id });

    expect(await store.appendMany(rushed.drafts.map((draft, index) => asEntry(draft, `a-${index}`)))).toBe(1);
    expect(await store.appendMany(rushed.drafts.map((draft, index) => asEntry(draft, `b-${index}`)))).toBe(0);
    expect(await store.count(rushed.account.id)).toBe(1);
  });
});

describe('speedup: пресет кнопки для витрины', () => {
  it('описывает каждую работу отдельно и не трогает аккаунт', () => {
    const started = startBuild(withTech(funded(), { chronium: 30 }), PLASMA, T0, idFactory);
    const snapshot = JSON.stringify(started.account);
    const mid = addMs(T0, 15 * MINUTE);

    expect(describeSpeedup(started.account, started.job.id, mid)).toMatchObject({
      jobId: started.job.id,
      code: PLASMA,
      remainingMs: 60 * MINUTE,
      cost: 60,
      msPerUnit: CHRONIUM_MS_PER_UNIT,
      canSpeedup: false,
      reason: 'funds'
    });
    expect(describeSpeedup(started.account, 'job-nope', T0).reason).toBe('not_found');
    expect(describeSpeedup(started.account, started.job.id, addMs(T0, 75 * MINUTE)).reason).toBe('done');
    // Тот же аккаунт, но с полным балансом хрониума: причина отказа «не хватило»
    // меняется на «ок» без всякого другого изменения.
    expect(describeSpeedup(withTech(started.account, { chronium: 1000 }), started.job.id, mid).reason).toBe('ok');
    const crowded: UserAccount = { ...started.account, inventory: inventoryOf(MAX_INVENTORY_ITEMS) };
    expect(describeSpeedup(crowded, started.job.id, mid).reason).toBe('inventory_full');
    expect(JSON.stringify(started.account)).toBe(snapshot);
  });
});

describe('роли материалов: вольфрам — сырьё тяжёлых чертежей', () => {
  it('чертежи-фикстуры не разъехались с конфигом', () => {
    expect(getBlueprint(PLASMA)?.buildMs).toBe(75 * MINUTE);
    expect(getBlueprint(RAILGUN)?.buildMs).toBe(150 * MINUTE);
    expect(getBlueprint(RAILGUN)?.cost).toMatchObject({ wolfram: 50 });
  });

  it('без вольфрама тяжёлый чертёж не стартует, с вольфрамом — списывает только его', () => {
    expect(errorCode(() => startBuild(funded(), RAILGUN, T0, idFactory))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);

    const started = startBuild(funded(1000, 50), RAILGUN, T0, idFactory);
    expect(started.account.materials.wolfram).toBe(0);
    expect(started.account.materials.chronium).toBe(1000);
    expect(started.account.materials.asterium).toEqual(funded().materials.asterium);
    expect(started.drafts.some((draft) => draft.currency === 'wolfram' && draft.delta === -50)).toBe(true);
    expect(started.job.endsAt).toEqual(addMs(T0, 150 * MINUTE));
  });

  it('ускорение тяжёлой стройки списывает хрониум, а не вольфрам', () => {
    const started = startBuild(funded(1000, 50), RAILGUN, T0, idFactory);
    const rushed = applyChroniumSpeedup(started.account, started.job.id, addMs(T0, 30 * MINUTE), idFactory);

    expect(rushed.cost).toBe(120);
    expect(rushed.account.materials.wolfram).toBe(0);
    expect(rushed.account.materials.chronium).toBe(880);
    expect(rushed.items.map((item) => item.code)).toEqual([RAILGUN]);
  });
});

describe('speedup: сооружение — счётчик, а не предмет', () => {
  const REACTOR = 'reactor_plasma_mk1';
  const BORE = 'bore_ore_mk1';

  /**
   * Регресс найденной ямы. Проверка «после ускорения в инвентаре ровно один предмет»
   * была сквозной, а сооружение не приезжает в инвентарь BY CONSTRUCTION (`settleBuilds`
   * для него возвращает пустой `items` и прирост в `gained`). Значит ОДИНОЧНОЕ
   * ускорение ЛЮБОГО здания — реактора, силоса, бура — отдавало 500. Хрониум при этом
   * не списывался (транзакция откатывалась), но и ускорение не покупалось никогда.
   *
   * Путь «ускорить всё» такой поправки уже не касался: он сверяет число работ-предметов,
   * поэтому работал. Два близнеца расходились, и выглядело это как «одна кнопка
   * ломается, другая нет», а не как сломанная механика зданий.
   *
   * Яма была жива с P6 и стала бы видна массово ровно в тот момент, когда новичку
   * дали бы доступное первое сооружение: 15-минутный бур + кнопка «Ускорить» = 500.
   * Ни один тест выше её не ловил, потому что все гоняли чертежи (`LASER`,
   * `PLASMA`, `RAILGUN`), а не реестр сооружений.
   */
  it('мгновенное завершение здания достраивает его и не бросает', () => {
    const started = startBuild(funded(), BORE, T0, idFactory);
    expect(started.job.kind).toBe('structure');

    const rushed = applyChroniumSpeedup(started.account, started.job.id, T0, idFactory);

    expect(rushed.account.structures[BORE]).toBe(1);
    expect(rushed.account.builds).toHaveLength(0);
    expect(rushed.items).toHaveLength(0);
    expect(rushed.cost).toBe(15);
    expect(rushed.account.materials.chronium).toBe(1000 - 15);
  });

  it('забитый инвентарь не мешает ускорить здание — ни полному, ни частичному', () => {
    // Слот здания не нужен, поэтому и платить за «освободи место» ему не за что
    // (см. `describeSpeedup`: проверка комнаты стоит только на работах-предметах).
    // До правки хаб этой разницы не делал: витрина рисовала кнопку активной, а
    // запрос отвечал 409 — расхождение витрины и касы в сторону отказа платить.
    const started = startBuild(funded(), BORE, T0, idFactory);
    const crowded: UserAccount = { ...started.account, inventory: inventoryOf(MAX_INVENTORY_ITEMS) };

    const rushed = applyChroniumSpeedup(crowded, started.job.id, T0, idFactory);
    expect(rushed.account.structures[BORE]).toBe(1);
    expect(rushed.account.inventory).toHaveLength(MAX_INVENTORY_ITEMS);

    // Симметричный путь: «долить с избытком» над зданием при полном рюкзаке.
    const second = startBuild(crowded, BORE, T0, idFactory);
    const partial = speedupCraft(second.account, second.job.id, 999, T0, idFactory);
    expect(partial.done).toBe(true);
    expect(partial.account.structures[BORE]).toBe(1);
    expect(partial.leftover).toBe(999 - 15);
  });

  it('частичное ускорение здания сдвигает таймер, не трогая счётчик', () => {
    const started = startBuild(funded(), BORE, T0, idFactory);
    const rushed = speedupCraft(started.account, started.job.id, 5, T0, idFactory);

    expect(rushed.account.structures[BORE]).toBe(0);
    expect(rushed.job.endsAt).toEqual(addMs(T0, 10 * MINUTE));
    expect(rushed.account.materials.chronium).toBe(995);
  });

  it('смешанная очередь: «ускорить всё» выдаёт и предмет, и здание', () => {
    const first = startBuild(funded(), LASER, T0, idFactory);
    const second = startBuild(first.account, REACTOR, T0, idFactory);

    const rushed = speedupAllBuilds(second.account, T0, idFactory);

    expect(rushed.items.map((item) => item.code)).toEqual([LASER]);
    expect(rushed.account.structures[REACTOR]).toBe(1);
    expect(rushed.account.builds).toHaveLength(0);
  });
});

