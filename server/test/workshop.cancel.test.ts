import { describe, expect, it } from 'vitest';

import { BUILD_CANCEL_GRACE_RATIO, BUILD_CANCEL_REFUND_RATE, getBlueprint, MAX_INVENTORY_ITEMS, materialEntries } from '../src/config/workshop.js';
import { getStructure, structureSecCost } from '../src/config/structures.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { cancelBuild, describeCancel, settleBuilds, startBuild } from '../src/modules/workshop/craft.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import {
  MINUTE,
  T0,
  addMs,
  errorCode,
  itemOf,
  newAccount,
  testConfig,
  withJunk,
  withMetals,
  withResources,
  withStructures,
  withTech
} from './fixtures.js';

/**
 * Отмена стройки: снятие работы из очереди с возвратом списанного.
 *
 * Здесь проверяется не цена (она — в `config/workshop.ts`), а три границы механизма:
 *
 *  1. Льгота считается по ПРОЙДЕННОЙ доле таймера, и граница в неё ВХОДИТ: «не дальше
 *     25%» — это ≤ 25%, а не < 25%. Плавающая точка на четвёртой минуте десятиминутки
 *     не имеет права стоить игроку половины вольфрама.
 *  2. Возврат округляется ВНИЗ. Округление вверх сделало бы штраф выгоднее покупки:
 *     25 вольфрама вернулись бы 13 — и «отменить» стало бы способом печатать сырьё.
 *  3. Монета возвращается по ФАКТУ списания (`job.secSpent`), а не по нынешней
 *     лестнице `structureSecCost`: стойка дорожает с каждым экземпляром, и вывод
 *     «верни по ценнику» вернул бы чужие деньги.
 *
 * Отдельный сюжет — журнал: причина `build_cancel` отличает откат незавершённой работы
 * от утилизации готового предмета (`dismantle`), а ключ идемпотентности обязан
 * содержать валюту, иначе из пачки материалов дописалась бы одна запись.
 */

const config = testConfig();
let seq = 0;
const idFactory = () => `c-${++seq}`;

/** Лазер Mk.I: 10 минут, 200 железа + 100 кремния + 2 чипа, монету не берёт. */
const LASER = 'tower_laser_mk1';
/** Рельсотрон Mk.II: 45 минут, 25 вольфрама — единственная нечётная позиция на полке. */
const RAIL = 'tower_rail_mk2';
const ASIC1 = 'asic_rack_mk1';
/** ASIC Mk.II: 350 SEC × 1,12^n — единственный в реестре источник денежной лестницы. */
const ASIC2 = 'asic_rack_mk2';

function funded(sec = 0): UserAccount {
  const base = withResources(newAccount(config), { ferrum: 20_000, silicium: 20_000, uranium: 20_000, sec });
  const junk = withJunk(base, {
    chips: 5_000,
    boards: 5_000,
    engines: 5_000,
    transmissions: 5_000,
    batteries: 5_000,
    ammo_casings: 5_000
  });
  const metals = withMetals(junk, { black_metal: 5_000, colored_metal: 5_000, precious_metal: 5_000 });
  return withTech(metals, { chronium: 100, wolfram: 5_000, stanium: 100 });
}

/** Игрок, которому можно построить ASIC Mk.II: предшественник на базе уже стоит. */
function asicOwner(sec = 5_000): UserAccount {
  return withStructures(funded(sec), { [ASIC1]: 1 });
}

/** Цена чертежа в той же форме, в какой её возвращают (`materialEntries` нормализует). */
function costOf(code: string): Record<string, number> {
  return Object.fromEntries(materialEntries(getBlueprint(code)!.cost));
}

describe('workshop/cancel: льготное окно', () => {
  it('отмена в первые 25% таймера возвращает материалы целиком и не трогает остальной кошелёк', () => {
    const account = funded();
    const started = startBuild(account, LASER, T0, idFactory);
    const cancelled = cancelBuild(started.account, started.job.id, addMs(T0, MINUTE), idFactory);

    expect(cancelled.rate).toBe(1);
    expect(cancelled.grace).toBe(true);
    expect(cancelled.refund.materials).toEqual(costOf(LASER));
    // Возврат обязан совпасть со списанием до единицы: иначе «отменил» отличается от
    // «не строил» ровно на ту разницу, которую игрок заметит на сотом действии.
    expect(cancelled.account.resources).toEqual(account.resources);
    expect(cancelled.account.junk).toEqual(account.junk);
    expect(cancelled.account.metals).toEqual(account.metals);
    expect(cancelled.account.materials.chronium).toBe(account.materials.chronium);
    expect(cancelled.account.builds).toHaveLength(0);
  });

  it('граница 25% входит в льготу, а не открывает штраф', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const onBoundary = addMs(T0, getBlueprint(LASER)!.buildMs * BUILD_CANCEL_GRACE_RATIO);

    expect(cancelBuild(started.account, started.job.id, onBoundary, idFactory).rate).toBe(1);
    // На миллисекунду позже — уже штраф. Граница одна и та же с обеих сторон, и именно
    // поэтому она проверяется здесь: `<=` против `<` в таком месте глазу не видно.
    expect(cancelBuild(started.account, started.job.id, addMs(onBoundary, 1), idFactory).rate).toBe(
      BUILD_CANCEL_REFUND_RATE
    );
  });

  it('сооружение отменяется без слота инвентаря и не двигает счётчик на базе', () => {
    const account = asicOwner();
    const started = startBuild(account, ASIC2, T0, idFactory);
    const cancelled = cancelBuild(started.account, started.job.id, addMs(T0, MINUTE), idFactory);

    expect(cancelled.account.structures[ASIC2] ?? 0).toBe(0);
    expect(cancelled.account.structures[ASIC1]).toBe(1);
  });
});

describe('workshop/cancel: штраф вне окна', () => {
  it('за 25% таймера возвращается половина, округлённая вниз', () => {
    const account = funded();
    const started = startBuild(account, RAIL, T0, idFactory);
    const late = addMs(T0, getBlueprint(RAIL)!.buildMs * 0.5);
    const cancelled = cancelBuild(started.account, started.job.id, late, idFactory);

    expect(cancelled.rate).toBe(BUILD_CANCEL_REFUND_RATE);
    expect(cancelled.grace).toBe(false);
    // 25 вольфрама → 12. Тринадцатая единица сделала бы отмену выгоднее стройки.
    expect(cancelled.refund.materials).toEqual({
      ferrum: 300,
      silicium: 125,
      black_metal: 60,
      wolfram: 12,
      boards: 2
    });

    const back = cancelled.account;
    expect(back.resources.ferrum).toBe(account.resources.ferrum - 300);
    expect(back.metals.black_metal).toBe(account.metals.black_metal - 60);
    expect(back.materials.wolfram).toBe(account.materials.wolfram - 13);
  });
});

describe('workshop/cancel: монета', () => {
  it('SEC возвращаются по факту списания, а не по нынешней лестнице', () => {
    const account = asicOwner();
    const started = startBuild(account, ASIC2, T0, idFactory);
    // Первый экземпляр стойки: owned = 0, поэтому 350, а не 350×1,12.
    const charged = structureSecCost(getStructure(ASIC2)!, 0);
    expect(started.secCost).toBe(charged);
    expect(started.job.secSpent).toBe(charged);

    // Пока стойка строилась, на базе выросли ещё три экземпляра: лестница уехала, и
    // возврат «по нынешней цене» вернул бы больше, чем списали.
    const drifted = withStructures(started.account, { [ASIC1]: 1, [ASIC2]: 3 });
    const cancelled = cancelBuild(drifted, started.job.id, addMs(T0, MINUTE), idFactory);

    expect(cancelled.refund.sec).toBe(charged);
    expect(cancelled.refund.sec).toBeLessThan(structureSecCost(getStructure(ASIC2)!, 3));
    expect(cancelled.account.resources.sec).toBe(account.resources.sec);
  });

  it('документ без `secSpent` оценивается по лестнице (миграция по чтению)', () => {
    const account = withStructures(asicOwner(), { [ASIC1]: 1, [ASIC2]: 2 });
    const started = startBuild(account, ASIC2, T0, idFactory);
    const legacy: UserAccount = {
      ...started.account,
      builds: started.account.builds.map((job) => ({ ...job, secSpent: undefined }))
    };

    const cancelled = cancelBuild(legacy, started.job.id, addMs(T0, MINUTE), idFactory);
    expect(cancelled.refund.sec).toBe(structureSecCost(getStructure(ASIC2)!, 2));
  });

  it('стройка без денежной компоненты не создаёт движения по SEC', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const cancelled = cancelBuild(started.account, started.job.id, addMs(T0, MINUTE), idFactory);

    expect(cancelled.refund.sec).toBe(0);
    expect(cancelled.drafts.some((draft) => draft.currency === 'sec')).toBe(false);
  });
});

describe('workshop/cancel: границы', () => {
  it('дозревшая работа уходит в инвентарь раньше отмены: отмена получает BUILD_NOT_FOUND', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const later = addMs(T0, getBlueprint(LASER)!.buildMs + MINUTE);

    // `cancelBuild` первым делом догоняет очередь — тот же порядок, что у
    // applyChroniumSpeedup. Работы, которую игрок просил отменить, к этому моменту
    // уже нет: предмет в инвентаре, материалы списаны один раз и по факту.
    // Отдать здесь возврат значило бы «постройка и башня, и деньги».
    expect(errorCode(() => cancelBuild(started.account, started.job.id, later, idFactory))).toBe(
      ErrorCodes.BUILD_NOT_FOUND
    );
    expect(settleBuilds(started.account, later, idFactory).items).toHaveLength(1);
  });

  it('застрявшая в забитом инвентаре работа не отменяется: BUILD_ALREADY_DONE', () => {
    const almostFull: UserAccount = {
      ...funded(),
      inventory: Array.from({ length: MAX_INVENTORY_ITEMS - 1 }, () => itemOf(LASER))
    };
    const first = startBuild(almostFull, LASER, T0, idFactory);
    const second = startBuild(first.account, LASER, T0, idFactory);
    const later = addMs(T0, getBlueprint(LASER)!.buildMs + MINUTE);

    // Догон вместил только одну из двух дозревших работ: вторая остаётся в очереди с
    // прошедшим сроком (толерантный режим settleBuilds — иначе игрок с забитым
    // рюкзаком не смог бы освободить место). Это единственная ситуация, где достижим
    // BUILD_ALREADY_DONE: результат произведён, и отмена вернула бы материалы за уже
    // готовую вещь.
    const settled = settleBuilds(second.account, later, idFactory);
    expect(settled.overflow).toBe(1);
    const stuck = settled.account.builds[0];
    // Без этой проверки тест деградировал бы молча: `stuck` равный undefined дал бы
    // TypeError вместо BUILD_ALREADY_DONE, а пустая очередь — BUILD_NOT_FOUND, и тот,
    // и другой выглядели бы как «отмена не работает», хотя настоящая причина — догон.
    expect(stuck, 'застрявшая работа обязана остаться в очереди').toBeDefined();
    expect(errorCode(() => cancelBuild(settled.account, stuck!.id, later, idFactory))).toBe(
      ErrorCodes.BUILD_ALREADY_DONE
    );
  });

  it('несуществующая работа — BUILD_NOT_FOUND, очередь не трогается', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    expect(errorCode(() => cancelBuild(started.account, 'nope', addMs(T0, MINUTE), idFactory))).toBe(
      ErrorCodes.BUILD_NOT_FOUND
    );
    expect(started.account.builds).toHaveLength(1);
  });

  it('отмена освобождает робота: следующим же действием строится новая работа', () => {
    const solo: UserAccount = { ...funded(), buildRobots: 1 };
    const started = startBuild(solo, LASER, T0, idFactory);
    expect(started.freeAfter).toBe(0);

    const cancelled = cancelBuild(started.account, started.job.id, addMs(T0, MINUTE), idFactory);
    expect(cancelled.freeAfter).toBe(1);
    expect(startBuild(cancelled.account, LASER, addMs(T0, MINUTE), idFactory).account.builds).toHaveLength(1);
  });

  it('повторная отмена той же работы невозможна: работы в очереди больше нет', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const now = addMs(T0, MINUTE);
    const cancelled = cancelBuild(started.account, started.job.id, now, idFactory);

    expect(errorCode(() => cancelBuild(cancelled.account, started.job.id, now, idFactory))).toBe(
      ErrorCodes.BUILD_NOT_FOUND
    );
  });
});

describe('workshop/cancel: журнал', () => {
  it('каждая валюта пачки получает свой ключ, причина — `build_cancel`', () => {
    const started = startBuild(asicOwner(), ASIC2, T0, idFactory);
    const cancelled = cancelBuild(started.account, started.job.id, addMs(T0, MINUTE), idFactory);

    // Материалы + монета: без валюты в ключе вторая запись пачки упала бы под
    // уникальный индекс первой и потерялась бы без аудиторского следа.
    expect(cancelled.drafts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cancelled.drafts.map((draft) => draft.idempotencyKey)).size).toBe(cancelled.drafts.length);
    expect(cancelled.drafts.every((draft) => draft.idempotencyKey?.startsWith('build:'))).toBe(true);
    expect(cancelled.drafts.every((draft) => draft.reason === 'build_cancel')).toBe(true);
    expect(cancelled.drafts.every((draft) => draft.refType === 'build_job' && draft.refId === started.job.id)).toBe(
      true
    );
    // Возврат — начисление. Минус в журнале на отмене выглядел бы как вторая плата
    // за ту же стройку и сделал бы сверку «куда делись материалы» неразрешимой.
    expect(cancelled.drafts.every((draft) => draft.delta > 0)).toBe(true);
  });
});

describe('workshop/cancel: котировка витрины', () => {
  it('прогресс и доля возврата считаются сервером, а не таймером клиента', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const quote = describeCancel(started.account, started.job.id, addMs(T0, 5 * MINUTE));

    expect(quote.canCancel).toBe(true);
    expect(quote.reason).toBe('ok');
    expect(quote.progress).toBe(0.5);
    expect(quote.refundRate).toBe(BUILD_CANCEL_REFUND_RATE);
    expect(quote.graceLeftMs).toBe(0);
    expect(quote.materials).toEqual({ ferrum: 100, silicium: 50, chips: 1 });
  });

  it('в льготном окне котировка обещает полный возврат и показывает остаток окна', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const quote = describeCancel(started.account, started.job.id, addMs(T0, MINUTE));

    expect(quote.refundRate).toBe(1);
    // Окно — 25% от 10 минут (150с), прошло 60с → осталось 90с.
    expect(quote.graceLeftMs).toBe(1.5 * MINUTE);
    expect(quote.materials).toEqual(costOf(LASER));
  });

  it('просроченная и несуществующая работы отвечают отказом, а не исключением', () => {
    const started = startBuild(funded(), LASER, T0, idFactory);
    const later = addMs(T0, getBlueprint(LASER)!.buildMs + MINUTE);

    const done = describeCancel(started.account, started.job.id, later);
    expect(done.canCancel).toBe(false);
    expect(done.reason).toBe('done');
    expect(done.materials).toEqual({});

    const missing = describeCancel(started.account, 'nope', addMs(T0, MINUTE));
    expect(missing.canCancel).toBe(false);
    expect(missing.reason).toBe('not_found');
  });
});
