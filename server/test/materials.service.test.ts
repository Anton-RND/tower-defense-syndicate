import { describe, expect, it } from 'vitest';

import {
  ASTERIUM_YIELD,
  CONVERSION_MAX_BATCH,
  STANIUM_FIELD_MAX_MS,
  STANIUM_MAX_BATCH,
  STANIUM_MS_PER_UNIT,
  STANIUM_SPEED_MULTIPLIER
} from '../src/config/materials.js';
import { isMetalId } from '../src/config/workshop.js';
import { ErrorCodes } from '../src/lib/errors.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import type { UserAccount } from '../src/modules/user/user.types.js';
import { chargeStanium, convertAsterium, type MaterialsDeps } from '../src/modules/materials/commit.js';
import {
  chargeStaniumField,
  convertAsterium as convertAsteriumPure,
  describeStaniumField,
  isStaniumFieldActive,
  quoteConversion,
  staniumChargeMs,
  staniumFieldRemaining,
  staniumSpeedMultiplier
} from '../src/modules/materials/service.js';
import { T0, addMs, errorCode, MINUTE, newAccount, testConfig, withAsterium, withTech } from './fixtures.js';

/**
 * Молекулярный станок и станиумный модуль (config/materials.ts).
 *
 * Два инварианта, ради которых эти материалы вообще выделены в отдельные роли:
 *  1. курс станка живёт на сервере. Клиент приносит только цель и количество — и если
 *     бы выход можно было передать, станок стал бы печатным станком металла;
 *  2. срок модуля накапливается и обрезается потолком 24 часов. Без потолка станиум
 *     превращался бы в постоянную привилегию, и покупать поле перед атакой не было бы
 *     никакого смысла.
 */

const config = testConfig();
let seq = 0;
const idFactory = () => `mat-${++seq}`;

function player(purchased = 0, earned = 0, stanium = 0) {
  return withTech(withAsterium(newAccount(config), purchased, earned), { stanium });
}

describe('станок: котировка', () => {
  it('выход падает по глубине переработки: чёрмет → цветмет → драгметалл', () => {
    expect(ASTERIUM_YIELD.black_metal).toBeGreaterThan(ASTERIUM_YIELD.colored_metal);
    expect(ASTERIUM_YIELD.colored_metal).toBeGreaterThan(ASTERIUM_YIELD.precious_metal);
    expect(quoteConversion('black_metal', 5)).toEqual({
      metal: 'black_metal',
      asterium: 5,
      rate: ASTERIUM_YIELD.black_metal,
      yields: ASTERIUM_YIELD.black_metal * 5
    });
    expect(quoteConversion('precious_metal', 7).yields).toBe(7);
  });

  it('целевой металл — только базовые металлы: астерий сам себя не перегоняет', () => {
    expect(isMetalId('asterium')).toBe(false);
    expect(errorCode(() => quoteConversion('asterium', 1))).toBe(ErrorCodes.CONVERSION_TARGET_INVALID);
    expect(errorCode(() => quoteConversion('chronium', 1))).toBe(ErrorCodes.CONVERSION_TARGET_INVALID);
    expect(errorCode(() => quoteConversion('plutonium', 1))).toBe(ErrorCodes.CONVERSION_TARGET_INVALID);
  });

  it('количество: целое, > 0, в пределах одной закладки', () => {
    [0, -1, 1.5, Number.NaN, CONVERSION_MAX_BATCH + 1].forEach((amount) => {
      expect(errorCode(() => quoteConversion('black_metal', amount)), String(amount)).toBe(
        ErrorCodes.CONVERSION_AMOUNT_INVALID
      );
    });
    expect(quoteConversion('black_metal', CONVERSION_MAX_BATCH).asterium).toBe(CONVERSION_MAX_BATCH);
  });
});

describe('станок: переработка', () => {
  it('астерий сгорает, металл приезжает, журнал — два движения с разными ключами', () => {
    const account = player(100, 50);
    const result = convertAsteriumPure(account, 'black_metal', 20, T0, { idempotencyKey: 'req-1' });

    expect(result.spent).toBe(20);
    expect(result.yielded).toBe(200);
    expect(result.asteriumLeft).toBe(130);
    expect(result.account.materials.asterium).toEqual({ purchased: 100, earned: 30 });
    expect(result.account.metals.black_metal).toBe(200);
    // Трата астерия начинается с заработанного — тот же порядок, что у всех трат.
    expect(result.drafts.map((draft) => draft.currency)).toEqual(['asterium_earned', 'black_metal']);
    expect(result.drafts.map((draft) => draft.delta)).toEqual([-20, 200]);
    expect(result.drafts.every((draft) => draft.reason === 'convert')).toBe(true);
    // Одно действие — две валюты: ключи обязаны различаться, иначе уникальный индекс
    // журнала отбросил бы начисление металла как дубль списания астерия.
    expect(result.drafts.map((draft) => draft.idempotencyKey)).toEqual([
      'convert:req-1:earned',
      'convert:req-1:black_metal'
    ]);
  });

  it('курс берётся из конфига, а не из запроса', () => {
    const account = player(0, 30);
    const precious = convertAsteriumPure(account, 'precious_metal', 30, T0);

    expect(precious.yielded).toBe(30 * ASTERIUM_YIELD.precious_metal);
    expect(precious.account.metals.precious_metal).toBe(30);
    expect(precious.asteriumLeft).toBe(0);
  });

  it('долг по донату: станок остаётся доступным только заработанным астерием', () => {
    // Станок — канал вывода (астерий → металл → чертёж/клан), поэтому игрок с
    // неотработанным chargeback не должен уметь вывести в товары остатки.
    const debtor = player(-10, 5);
    const ok = convertAsteriumPure(debtor, 'colored_metal', 5, T0);
    expect(ok.account.materials.asterium).toEqual({ purchased: -10, earned: 0 });
    expect(ok.yielded).toBe(20);

    expect(errorCode(() => convertAsteriumPure(ok.account, 'colored_metal', 1, T0))).toBe(
      ErrorCodes.PURCHASES_BLOCKED
    );
    // Доступная сумма при долге — `earned`, а не сумма двух кошельков: иначе минус по
    // купленному отнял бы право тратить честно заработанное, и ветка PURCHASES_BLOCKED
    // была бы недостижимой (всегда срабатывал бы более ранний INSUFFICIENT_FUNDS).
    expect(errorCode(() => convertAsteriumPure(player(-10, 5), 'colored_metal', 6, T0))).toBe(
      ErrorCodes.PURCHASES_BLOCKED
    );
  });

  it('не хватило астерия — INSUFFICIENT_FUNDS до малейшего движения', () => {
    const account = player(100, 50);
    try {
      convertAsteriumPure(account, 'black_metal', 1000, T0);
      throw new Error('ожидался INSUFFICIENT_FUNDS');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
      expect((error as { details?: { available?: number } }).details?.available).toBe(150);
    }
    expect(account.metals.black_metal).toBe(0);
    expect(account.materials.asterium).toEqual({ purchased: 100, earned: 50 });
  });

  it('металлы в астерий не перегоняются: обратного маршрута нет по определению', () => {
    const converted = convertAsteriumPure(player(0, 10), 'black_metal', 1, T0);

    expect(converted.account.metals.black_metal).toBe(ASTERIUM_YIELD.black_metal);
    // Продажа внутриигрового сырья была бы выводом донатной валюты из-под контроля
    // площадки, поэтому ни одно движение станка не начисляет астерий.
    expect(converted.drafts.some((draft) => draft.currency.startsWith('asterium_') && draft.delta > 0)).toBe(false);
  });
});

describe('станиумный модуль: зарядка', () => {
  it('одна единица = 15 минут поля, списывается ровно станиум', () => {
    const account = player(0, 0, 20);
    const charged = chargeStaniumField(account, 10, T0, { idempotencyKey: 'req-9' });

    expect(staniumChargeMs(4)).toBe(4 * STANIUM_MS_PER_UNIT);
    expect(charged.spent).toBe(10);
    expect(charged.addedUnits).toBe(10);
    expect(charged.addedMs).toBe(150 * MINUTE);
    expect(charged.fieldUntil).toEqual(addMs(T0, 150 * MINUTE));
    expect(charged.remainingMs).toBe(150 * MINUTE);
    expect(charged.account.materials.stanium).toBe(10);
    expect(charged.account.materials.staniumFieldUntil).toEqual(addMs(T0, 150 * MINUTE));
    expect(charged.drafts[0]?.currency).toBe('stanium');
    expect(charged.drafts[0]?.reason).toBe('stanium_field');
    expect(charged.drafts[0]?.idempotencyKey).toBe('stanium:req-9');
    expect(charged.drafts[0]?.meta?.slow_percent).toBe(25);
  });

  it('срок накапливается, а не перезаписывается: вторая зарядка продлевает поле', () => {
    const first = chargeStaniumField(player(0, 0, 20), 10, T0);
    const second = chargeStaniumField(first.account, 5, addMs(T0, 10 * MINUTE));

    // 150 минут первого заряда минус 10 минут хода часов плюс 75 минут второго.
    expect(second.fieldUntil).toEqual(addMs(T0, 225 * MINUTE));
    expect(second.addedMs).toBe(75 * MINUTE);
    expect(second.account.materials.stanium).toBe(5);
  });

  it('потолок 24 часов обрезает перекорм: списывается только то, что поместилось', () => {
    const first = chargeStaniumField(player(0, 0, 100), 90, T0);
    expect(first.remainingMs).toBe(1350 * MINUTE);

    const second = chargeStaniumField(first.account, 90, T0);
    // Места 90 минут → в срок войдут только 6 единиц из запрошенных 90, остальные 84
    // вернутся на баланс: перекорм обрезается, а не сгорает.
    expect(second.addedUnits).toBe(6);
    expect(second.spent).toBe(6);
    expect(second.remainingMs).toBe(STANIUM_FIELD_MAX_MS);
    expect(second.account.materials.stanium).toBe(4);

    // Дальше обрезать нечего: отказ до всякого списания.
    expect(errorCode(() => chargeStaniumField(second.account, 1, T0))).toBe(ErrorCodes.STANIUM_CHARGE_INVALID);
    // Через пять минут поле всё ещё у потолка, но свободных 5 минут не хватает даже на 1 единицу.
    expect(errorCode(() => chargeStaniumField(second.account, 1, addMs(T0, 5 * MINUTE)))).toBe(
      ErrorCodes.STANIUM_CHARGE_INVALID
    );
  });

  it('не хватило станиума — INSUFFICIENT_FUNDS, срок не сдвинулся', () => {
    const account = player(0, 0, 2);
    expect(errorCode(() => chargeStaniumField(account, 10, T0))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
    expect(account.materials.stanium).toBe(2);
    expect(account.materials.staniumFieldUntil).toBeNull();
  });

  it('заряд вне диапазона — STANIUM_CHARGE_INVALID', () => {
    const account = player(0, 0, 200);
    [0, -1, 1.5, Number.NaN, STANIUM_MAX_BATCH + 1].forEach((units) => {
      expect(errorCode(() => chargeStaniumField(account, units, T0)), String(units)).toBe(
        ErrorCodes.STANIUM_CHARGE_INVALID
      );
    });
    expect(chargeStaniumField(account, STANIUM_MAX_BATCH, T0).addedUnits).toBe(STANIUM_MAX_BATCH);
  });
});

describe('станиумный модуль: влияние на оборону', () => {
  it('без поля роботы идут с полной скоростью', () => {
    const account = player(0, 0, 10);
    expect(staniumFieldRemaining(account, T0)).toBe(0);
    expect(isStaniumFieldActive(account, T0)).toBe(false);
    expect(staniumSpeedMultiplier(account, T0)).toBe(1);
  });

  it('модуль снижает скорость наступающих ровно на (1 - множитель) и истекает по сроку', () => {
    const charged = chargeStaniumField(player(0, 0, 10), 4, T0);
    const until = addMs(T0, 60 * MINUTE);

    expect(staniumSpeedMultiplier(charged.account, T0)).toBe(STANIUM_SPEED_MULTIPLIER);
    expect(isStaniumFieldActive(charged.account, addMs(T0, 59 * MINUTE))).toBe(true);
    // Последняя миллисекунда срока ещё поле, следующая — уже нет: граница включается в срок.
    expect(staniumFieldRemaining(charged.account, until)).toBe(0);
    expect(staniumSpeedMultiplier(charged.account, until)).toBe(1);

    const view = describeStaniumField(charged.account, addMs(T0, 15 * MINUTE));
    expect(view).toEqual({
      active: true,
      until,
      remainingMs: 45 * MINUTE,
      speedMultiplier: STANIUM_SPEED_MULTIPLIER,
      slowPercent: 25,
      stanium: 6,
      msPerUnit: STANIUM_MS_PER_UNIT,
      maxMs: STANIUM_FIELD_MAX_MS
    });
  });
});

async function makeDeps(account: UserAccount): Promise<{ deps: MaterialsDeps; id: string; ledger: MemoryLedgerStore }> {
  const users = new MemoryUserStore();
  const ledger = new MemoryLedgerStore();
  await ledger.connect();
  const saved = await users.save(account);
  return { deps: { users, ledger, idFactory }, id: saved.id, ledger };
}

describe('материалы: протокол записи (hub)', () => {
  it('станок меняет аккаунт и пишет ровно два движения журнала', async () => {
    const { deps, id, ledger } = await makeDeps(player(100, 50));
    const result = await convertAsterium(deps, id, { metal: 'black_metal', amount: 20 }, T0, { requestId: 'req-1' });

    expect(result.duplicate).toBe(false);
    expect(result.spent).toBe(20);
    expect(result.yielded).toBe(200);
    expect(result.asteriumLeft).toBe(130);
    expect(await ledger.count(id)).toBe(2);
    expect(await ledger.sum(id, 'black_metal')).toBe(200);
    expect(await ledger.sum(id, 'asterium_earned')).toBe(-20);
  });

  it('ретрай с тем же Idempotency-Key не списывает повторно и не оставляет движение без факта', async () => {
    const { deps, id, ledger } = await makeDeps(player(0, 100));
    const once = await convertAsterium(deps, id, { metal: 'colored_metal', amount: 10 }, T0, { requestId: 'req-2' });
    const twice = await convertAsterium(deps, id, { metal: 'colored_metal', amount: 10 }, T0, { requestId: 'req-2' });

    expect(once.duplicate).toBe(false);
    expect(twice.duplicate).toBe(true);
    expect(twice.spent).toBe(0);
    expect(twice.yielded).toBe(0);
    expect(twice.account.metals.colored_metal).toBe(once.account.metals.colored_metal);
    expect(twice.account.materials.asterium).toEqual(once.account.materials.asterium);
    // Без предпроверки второй вызов списал бы астерий ещё раз, а журнал потерял бы
    // это списание: уникальный индекс отбросил бы дубль ключа.
    expect(await ledger.count(id)).toBe(2);

    const other = await convertAsterium(deps, id, { metal: 'colored_metal', amount: 10 }, addMs(T0, MINUTE), {
      requestId: 'req-3'
    });
    expect(other.duplicate).toBe(false);
    expect(await ledger.count(id)).toBe(4);
  });

  it('зарядка модуля: повтор по тому же ключу не продлевает срок и не списывает станиум', async () => {
    const { deps, id, ledger } = await makeDeps(player(0, 0, 30));
    const once = await chargeStanium(deps, id, 4, T0, { requestId: 'req-4' });
    const twice = await chargeStanium(deps, id, 4, T0, { requestId: 'req-4' });

    expect(once.duplicate).toBe(false);
    expect(once.spent).toBe(4);
    expect(once.field.active).toBe(true);
    expect(once.field.remainingMs).toBe(60 * MINUTE);
    expect(twice.duplicate).toBe(true);
    expect(twice.spent).toBe(0);
    expect(twice.field.until).toEqual(once.field.until);
    expect(twice.account.materials.stanium).toBe(26);
    expect(await ledger.count(id)).toBe(1);
  });

  it('несуществующий игрок — NOT_FOUND, а не станок «в пустоте»', async () => {
    const { deps } = await makeDeps(player(100, 100));
    await expect(convertAsterium(deps, 'no-such-player', { metal: 'black_metal', amount: 1 }, T0)).rejects.toMatchObject({
      code: ErrorCodes.NOT_FOUND
    });
    await expect(chargeStanium(deps, 'no-such-player', 1, T0)).rejects.toMatchObject({ code: ErrorCodes.NOT_FOUND });
  });
});
