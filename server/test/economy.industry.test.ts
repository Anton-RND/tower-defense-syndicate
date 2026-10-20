import { describe, expect, it } from 'vitest';

import { HOUR, T0, addMs, newAccount, testConfig, withStorages, withStructures } from './fixtures.js';
import type { AppConfig } from '../src/config/env.js';
import { computeIndustryTick, applyIndustryTick } from '../src/modules/economy/industry.js';
import { applyEconomyTick } from '../src/modules/economy/tick.js';

/**
 * Промышленный тик: как база ведёт себя ЗА НОЧЬ, а не в момент запроса.
 *
 * Мгновенный баланс сети покрыт `economy.power.test.ts`; здесь — другое, более
 * коварное: тик обязан корректно разрезать интервал, когда СОБЫТИЕ (кончилось топливо,
 * наполнилась цистерна) происходит ПОСЕРЕДИНЕ офлайна. Ошибка здесь не видна в UI до
 * утра, а когда видна — игрок уже потерял топливо или получил напечатанную из воздуха
 * мощность.
 */

const config = testConfig();
const economy = config.economy;

function base(
  cfg: AppConfig = config,
  patch: { structures?: Parameters<typeof withStructures>[1]; storages?: Parameters<typeof withStorages>[1] } = {}
) {
  // Конфиг параметризуется явно, а не берётся модульной константой: ёмкость склада
  // живёт в `account.storageCapacity`, который копируется из конфига при создании
  // аккаунта. Построить аккаунт на одном конфиге, а тикнуть другим — значит проверить
  // не ту ёмкость, и это ровно та ошибка, которую здесь легко было бы не заметить.
  return withStorages(withStructures(newAccount(cfg), patch.structures ?? {}), patch.storages ?? {});
}

describe('economy/industry: голая база', () => {
  it('без построек тик ничего не меняет и не тратит ни такта', () => {
    const account = base();
    const tick = computeIndustryTick(account, addMs(T0, 8 * HOUR), economy);
    expect(tick.storages).toEqual(account.storages);
    expect(tick.burned.plasma).toBe(0);
    expect(tick.produced.nitrogen).toBe(0);
    expect(tick.stages).toBe(1);
    expect(tick.truncated).toBe(false);
  });
});

describe('economy/industry: реактор жжёт плазму', () => {
  it('восемь часов ровной работы — один этап, расход ровно по ставке', () => {
    const account = base(config, { structures: { reactor_plasma_mk1: 1 }, storages: { plasma: 100 } });
    const tick = computeIndustryTick(account, addMs(T0, 8 * HOUR), economy);
    // 8 плазмы/час × 8 часов = 64; событие внутри интервала отсутствует.
    expect(tick.stages).toBe(1);
    expect(tick.burned.plasma).toBeCloseTo(64, 6);
    expect(tick.storages.plasma).toBeCloseTo(36, 6);
  });

  it('топливо кончилось посреди ночи — тик режется, а не домножает', () => {
    const account = base(config, { structures: { reactor_plasma_mk1: 1 }, storages: { plasma: 20 } });
    const tick = computeIndustryTick(account, addMs(T0, 8 * HOUR), economy);
    // 20 / 8 = 2,5 часа, дальше конвертер глушится по топливу.
    expect(tick.stages).toBeGreaterThanOrEqual(2);
    expect(tick.burned.plasma).toBeCloseTo(20, 6);
    expect(tick.storages.plasma).toBe(0);
    expect(tick.grid.supplyOnline).toBe(20);
    expect(tick.grid.rows.find((r) => r.code === 'reactor_plasma_mk1')?.reason).toBe('fuel');
    // Наивное «8 × 8 = 64» сожгло бы 44 единицы, которых у базы никогда не было.
    expect(tick.burned.plasma).toBeLessThan(64);
  });

  it('пустой бункер — нулевой расход, а не отрицательный остаток', () => {
    const account = base(config, { structures: { reactor_plasma_mk1: 1 }, storages: { plasma: 0 } });
    const tick = computeIndustryTick(account, addMs(T0, 8 * HOUR), economy);
    expect(tick.storages.plasma).toBe(0);
    expect(tick.burned.plasma).toBe(0);
  });
});

describe('economy/industry: переполнение цистерны', () => {
  it('станция встаёт, когда азоту некуда лить, и не льёт его мимо', () => {
    // Ёмкость 100 без крио-цистерны: при выпуске 40/ч бак полон за 2,5 часа — то есть
    // событие гарантированно попадает внутрь 8-часового офлайна.
    const narrow = testConfig({ STORAGE_CAPACITY: '100' });
    const account = base(narrow, {
      structures: { reactor_plasma_mk1: 1, nitro_plant_mk1: 1 },
      storages: { plasma: 1000 }
    });
    const tick = computeIndustryTick(account, addMs(T0, 8 * HOUR), narrow.economy);
    expect(tick.storages.nitrogen).toBeCloseTo(100, 6);
    // Вета при целой стадии не бывает: граница — это ровно момент заполнения.
    expect(tick.vented.nitrogen).toBeCloseTo(0, 6);
    expect(tick.produced.nitrogen).toBeCloseTo(100, 6);
    expect(tick.stages).toBeGreaterThanOrEqual(2);
    const plant = tick.grid.rows.find((r) => r.code === 'nitro_plant_mk1');
    expect(plant?.online).toBe(0);
    expect(plant?.reason).toBe('output');
    // Свободные 5,5 часа стоит ТОЛЬКО станция. Конвертер при этом исправно пашет всю
    // ночь: ему переполнение чужого бака не помеха. 8/ч × 8 ч = 64 — и это число тут
    // ровно для того, чтобы поймать обратную ошибку: если тик начнёт глушить реактор
    // из-за вставшей станции, база потеряет мощность без всякой причины.
    expect(tick.burned.plasma).toBeCloseTo(8 * 8, 6);
  });
});

describe('economy/industry: азотное кольцо', () => {
  it('кулеры сжигают азот, и на его конце тик останавливает их, а не весь расчёт', () => {
    const account = base(config, {
      structures: { reactor_plasma_mk1: 1, cooler_loop_mk1: 2, asic_rack_mk1: 1 },
      storages: { plasma: 1000, nitrogen: 100 }
    });
    const tick = computeIndustryTick(account, addMs(T0, 4 * HOUR), economy);
    // Тепло 30+60=90, пассивный радиатор забирает 45 → сгорает (90−45)/6,67 ≈ 6,74/ч.
    expect(tick.burned.nitrogen).toBeGreaterThan(0);
    expect(tick.storages.nitrogen).toBeLessThan(100);
    // ASIC за 4 часа успевает наработать, а не встать сразу.
    expect(tick.grid.coinRate.sec).toBe(25);
  });
});

describe('economy/industry: идемпотентность и лимит офлайна', () => {
  it('повторный тик в тот же момент ничего не меняет', () => {
    const account = base(config, { structures: { reactor_plasma_mk1: 1 }, storages: { plasma: 100 } });
    const now = addMs(T0, 5 * HOUR);
    const first = computeIndustryTick(account, now, economy);
    const second = computeIndustryTick(account, now, economy);
    expect(second.storages).toEqual(first.storages);
    expect(second.burned).toEqual(first.burned);
  });

  it('неделя офлайна режется тем же лимитом, что и майнинг', () => {
    const account = base(config, { structures: { reactor_plasma_mk1: 1 }, storages: { plasma: 100000 } });
    const tick = computeIndustryTick(account, addMs(T0, 168 * HOUR), economy);
    // Горизонт = maxOfflineHours, а не 168: иначе топливо сгорало бы за срок, за который
    // руда не набежала, и база «худела» бы во сне.
    expect(tick.burned.plasma).toBeCloseTo(economy.maxOfflineHours * 8, 6);
  });
});

describe('economy/tick: порядок майнинг → промышленность', () => {
  it('ночная добыча доступна реактору в том же такте', () => {
    // Главный не-очевидный инвариант связки: `applyMiningTick` сдвигает `lastLootTime`,
    // и если промышленность посчитать ПОСЛЕ этого сдвига, она увидит горизонт 0 мс и за
    // ночь не сожжёт ни грамма. Отсюда точное число: 8 часов × 50/ч = 400 намахнено,
    // 8 часов × 8/ч = 64 сожжено → 336. Любое из «0» или «400» означает распавшуюся связку.
    const tuned = testConfig({ MINING_RATE_PLASMA: '50' });
    const built = withStructures(newAccount(tuned), { reactor_plasma_mk1: 1 });
    const after = applyEconomyTick(built, addMs(T0, 8 * HOUR), tuned.economy).account;
    expect(after.storages.plasma).toBeCloseTo(8 * 50 - 8 * 8, 6);
    expect(after.lastLootTime).toEqual(addMs(T0, 8 * HOUR));
  });

  it('промышленность не может сжечь то, чего не намахнилось', () => {
    // Ставка 1/ч за 8 часов даёт 8 плазмы — ровно час работы конвертера. Остаток 0,
    // и он НЕ отрицательный: тик не имеет права уйти в минус по топливу, даже когда
    // добыча и расход сошлись в одном такте.
    const lean = testConfig({ MINING_RATE_PLASMA: '1' });
    const built = withStructures(newAccount(lean), { reactor_plasma_mk1: 1 });
    const after = applyEconomyTick(built, addMs(T0, 8 * HOUR), lean.economy).account;
    expect(after.storages.plasma).toBe(0);
    expect(after.storages.plasma).not.toBeLessThan(0);
  });
});

describe('economy/industry: SEC капает в кошелёк', () => {
  const racks = { reactor_plasma_mk1: 1, cooler_loop_mk1: 2, asic_rack_mk1: 1 };

  it('стойка в сети и под охлаждением наработала ровно ставка × часы', () => {
    const account = base(config, { structures: racks, storages: { plasma: 1000, nitrogen: 100 } });
    const tick = computeIndustryTick(account, addMs(T0, 4 * HOUR), economy);
    expect(tick.grid.coinRate.sec).toBe(25);
    expect(tick.secGained).toBeCloseTo(100, 6);
  });

  it('нет теплоотвода — нет монет: веер глушит стойку по cooling, а не печатает впустую', () => {
    // Тот же состав, но азот пуст: кулеры без хладагента не охлаждают, тепло 60 кВт
    // не влезает в пассивный радиатор 45 кВт, и стойка снимается. Монета обязана
    // идти за теплом, иначе «поставь ASIC без крио-контура» стало бы победной
    // стратегией, а весь контур охлаждения — декорацией.
    const account = base(config, { structures: racks, storages: { plasma: 1000, nitrogen: 0 } });
    const tick = computeIndustryTick(account, addMs(T0, 4 * HOUR), economy);
    expect(tick.grid.coinRate.sec).toBe(0);
    expect(tick.secGained).toBe(0);
  });

  it('начисление идёт в кошелёк одним движением журнала с причиной industry', () => {
    const account = base(config, { structures: racks, storages: { plasma: 1000, nitrogen: 100 } });
    const now = addMs(T0, 4 * HOUR);
    const result = applyIndustryTick(account, now, economy);

    expect(result.account.resources.sec).toBeCloseTo(100, 6);
    expect(result.drafts).toHaveLength(1);
    const draft = result.drafts[0];
    expect(draft?.currency).toBe('sec');
    expect(draft?.reason).toBe('industry');
    expect(draft?.delta).toBeCloseTo(100, 6);
    // balanceAfter — то, по чему журнал восстанавливается без пересчёта.
    expect(draft?.balanceAfter).toBeCloseTo(100, 6);
    expect(draft?.userId).toBe(account.id);
  });

  it('дробный остаток монеты не округляется и не теряется', () => {
    // 25/ч × 0.4 ч = 10 ровно; берём 36 минут (0.6 ч) → 15. Смысл теста не в числе,
    // а в том, что в кошельке лежит ТОЧНОЕ значение: витрина покажет `floor`, а
    // округление здесь печатало бы или съедало монеты на каждом тике.
    const account = base(config, { structures: racks, storages: { plasma: 1000, nitrogen: 100 } });
    const result = applyIndustryTick(account, addMs(T0, 36 * 60_000), economy);
    expect(result.secGained).toBeCloseTo(15, 6);
    expect(result.account.resources.sec).toBeCloseTo(15, 6);
    expect(Number.isInteger(result.account.resources.sec)).toBe(true);
  });

  it('повторный тик на то же время не печатает монеты второй раз', () => {
    // Ключ идемпотентности собран из игрока и момента, а не из счётчика вызовов:
    // CAS-повтор и клиентский ретрай обязаны давать ОДИН ключ, иначе журнал
    // потеряет дубль, а кошелёк — удвоение.
    const account = base(config, { structures: racks, storages: { plasma: 1000, nitrogen: 100 } });
    const now = addMs(T0, 4 * HOUR);
    const first = applyIndustryTick(account, now, economy).drafts[0];
    const second = applyIndustryTick(account, now, economy).drafts[0];
    expect(first?.idempotencyKey).toBeTruthy();
    expect(second?.idempotencyKey).toBe(first?.idempotencyKey);
  });

  it('без наработанной монеты журнал не трогается вообще', () => {
    // Нулевое движение на каждом опросе витрины раздуло бы журнал темпом heartbeat'а
    // и не объяснило бы в нём ровно ничего.
    const account = base(config, { structures: { reactor_plasma_mk1: 1 }, storages: { plasma: 1000 } });
    const result = applyIndustryTick(account, addMs(T0, 8 * HOUR), economy);
    expect(result.secGained).toBe(0);
    expect(result.drafts).toHaveLength(0);
    expect(result.account.resources.sec).toBe(0);
  });

  it('гоная база без построек не начисляет ничего', () => {
    const result = applyIndustryTick(base(), addMs(T0, 8 * HOUR), economy);
    expect(result.drafts).toHaveLength(0);
    expect(result.account.resources.sec).toBe(0);
  });
});

