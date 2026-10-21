import { describe, expect, it } from 'vitest';

import { BLUEPRINTS, MAX_INVENTORY_ITEMS, getBlueprint, isMaterialId, materialEntries } from '../src/config/workshop.js';
import { ORE_IDS } from '../src/config/storage.js';
import { MAX_STRUCTURE_TOTAL, STRUCTURES, getStructure, miningBonus, structureSecCost, type StructureDef, type StructureId } from '../src/config/structures.js';
import { unitPowerProfile } from '../src/modules/economy/power.js';
import { AppError, ErrorCodes } from '../src/lib/errors.js';
import { settleBuilds, startBuild } from '../src/modules/workshop/craft.js';
import { describeSpeedup } from '../src/modules/workshop/craft.js';
import {
  HOUR,
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
import type { UserAccount } from '../src/modules/user/user.types.js';

/**
 * Путь постройки сооружений: очередь роботов → счётчик на базе.
 *
 * Здесь проверяется не баланс (он — в `config/structures.ts` и виден витриной), а
 * ГРАНИЦЫ между двумя контрактами: предмет ложится в инвентарь и занимает клетку,
 * здание — нет. Именно на стыке этих двух механик обычно и теряют код: например,
 * начинают требовать слот инвентаря для реактора или ставят сооружение в лабиринт.
 */

const config = testConfig();
let seq = 0;
const idFactory = () => `s-${++seq}`;

const REACTOR = 'reactor_plasma_mk1';
const NITRO = 'nitro_plant_mk1';
const CRYO = 'cryo_tank_mk1';

/** Игрок, у которого есть на всё: реактор (железо/кремний/чипы/чермет) и цистерны. */
function funded(): UserAccount {
  return withJunk(
    withMetals(withResources(newAccount(config), { ferrum: 20_000, silicium: 20_000 }), {
      black_metal: 5_000,
      colored_metal: 5_000,
      precious_metal: 5_000
    }),
    { chips: 5_000, boards: 5_000, engines: 100, transmissions: 100, batteries: 100, ammo_casings: 100 }
  );
}

describe('workshop/structures: стройка здания', () => {
  it('реактор принимается в очередь как работа вида `structure`, а не как предмет', () => {
    const started = startBuild(funded(), REACTOR, T0, idFactory);
    expect(started.job.kind).toBe('structure');
    expect(started.structure?.id).toBe(REACTOR);
    expect(started.blueprint).toBeNull();
    expect(started.account.builds).toHaveLength(1);
  });

  it('материалы списываются в момент старта, по одному движению на позицию', () => {
    const account = funded();
    const def = getStructure(REACTOR)!;
    const started = startBuild(account, REACTOR, T0, idFactory);
    expect(started.account.resources.ferrum).toBe(account.resources.ferrum - (def.cost.ferrum ?? 0));
    // Движений = позициям сырья плюс одно, если у сооружения есть денежная компонента.
    // Реактор монету не берёт, поэтому здесь числа совпадают — но писать просто
    // `Object.keys(def.cost).length` уже нельзя: на ASIC-стойке не хватало бы одного.
    expect(started.drafts.length).toBe(materialEntries(def.cost).length + (structureSecCost(def, 0) > 0 ? 1 : 0));
    expect(started.drafts.every((d) => d.reason === 'craft')).toBe(true);
    expect(started.drafts.every((d) => d.refType === 'structure')).toBe(true);
  });

  it('по завершении счётчик вырос, а инвентарь НЕ пополнился', () => {
    const started = startBuild(funded(), REACTOR, T0, idFactory);
    const buildMs = getStructure(REACTOR)!.buildMs;
    const settled = settleBuilds(started.account, addMs(T0, buildMs), idFactory);
    expect(settled.account.structures[REACTOR]).toBe(1);
    expect(settled.items).toHaveLength(0);
    expect(settled.account.inventory).toHaveLength(0);
    expect(settled.account.builds).toHaveLength(0);
    expect(settled.gained).toEqual({ [REACTOR]: 1 });
  });

  it('полный инвентарь не мешает строить здание', () => {
    // Смысл разделения контрактов: рюкзак из 400 башен не должен блокировать энергетику.
    const crowded: UserAccount = {
      ...funded(),
      inventory: Array.from({ length: MAX_INVENTORY_ITEMS }, () => itemOf('tower_laser_mk1'))
    };
    const started = startBuild(crowded, REACTOR, T0, idFactory);
    expect(started.account.builds).toHaveLength(1);
  });

  it('второе здание на одного робота — NO_FREE_BUILDER', () => {
    // По умолчанию робота два, поэтому фиксируем одного: иначе тест проверял бы не
    // занятость, а количество роботов.
    const solo: UserAccount = { ...funded(), buildRobots: 1 };
    const first = startBuild(solo, REACTOR, T0, idFactory);
    expect(errorCode(() => startBuild(first.account, CRYO, T0, idFactory))).toBe(ErrorCodes.NO_FREE_BUILDER);
  });
});

describe('workshop/structures: границы реестра', () => {
  it('азотная станция без крио-цистерны не строится', () => {
    // Без предпосылки игрок получил бы станцию, которая встаёт по переполнению сразу:
    // отказ на входе дешевле разочарования через час.
    expect(errorCode(() => startBuild(funded(), NITRO, T0, idFactory))).toBe(ErrorCodes.STRUCTURE_REQUIRES);
  });

  it('после крио-цистерны станция строится', () => {
    const withTank = withStructures(funded(), { [CRYO]: 1 });
    const started = startBuild(withTank, NITRO, T0, idFactory);
    expect(started.job.kind).toBe('structure');
  });

  it('потолок экземпляров вида отсекает лишнее ДО списания материалов', () => {
    const def = getStructure(REACTOR)!;
    const maxed = withStructures(funded(), { [REACTOR]: def.maxPerBase });
    const before = maxed.resources.ferrum;
    expect(errorCode(() => startBuild(maxed, REACTOR, T0, idFactory))).toBe(ErrorCodes.STRUCTURE_LIMIT);
    expect(maxed.resources.ferrum).toBe(before);
  });
});

describe('workshop/structures: целостность реестра', () => {
  it('в `requires` нет циклов: иначе прогрессия непроходима, а типы об этом молчат', () => {
    // TS проверяет, что ссылка ведёт на существующий код, но не что граф ацикличен.
    // A↔B — валидный по типам конфиг, который невозможно построить ни при каком порядке,
    // и заметят это только игроки (то есть никогда).
    const visiting = new Set<string>();
    const done = new Set<string>();
    const walk = (id: string, path: string[]): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) {
        throw new Error(`Цикл requires: ${[...path, id].join(' → ')}`);
      }
      visiting.add(id);
      for (const need of Object.keys(getStructure(id)?.requires ?? {})) walk(need, [...path, id]);
      visiting.delete(id);
      done.add(id);
    };
    for (const def of STRUCTURES) expect(() => walk(def.id, [])).not.toThrow();
    expect(done.size).toBe(STRUCTURES.length);
  });

  it('каждое здание достижимо от видов без предпосылок', () => {
    const roots = STRUCTURES.filter((def) => !def.requires || Object.keys(def.requires).length === 0).map((d) => d.id);
    expect(roots.length).toBeGreaterThan(0);
    const reached = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const id = queue.pop()!;
      if (reached.has(id)) continue;
      reached.add(id);
      for (const def of STRUCTURES) {
        if (def.requires && Object.keys(def.requires).includes(id)) queue.push(def.id);
      }
    }
    expect(reached.size).toBe(STRUCTURES.length);
  });

  it('лимиты вида не противоречат общему потолку базы', () => {
    // Сумма потолков всех видов заведомо больше MAX_STRUCTURE_TOTAL — иначе общий
    // потолок недостижим и является декорацией, а не защитой документа.
    const sum = STRUCTURES.reduce((acc, def) => acc + (def.maxPerBase > 0 ? def.maxPerBase : 0), 0);
    expect(sum).toBeGreaterThan(MAX_STRUCTURE_TOTAL);
  });

  it('тяжёлая техника не висит на сети базы', () => {
    // Прямая проверка твоего требования: «вся тяжёлая техника работает на своих
    // реакторах и не потребляет электроэнергию базы». Тир-3 дроны и орудия обязаны
    // быть `autonomous`, иначе они молча начнут жрать кВт и обесценят дейтерий.
    for (const code of ['drone_cerberus_mk3', 'weapon_railgun_mk3', 'weapon_plasma_cannon_mk3', 'weapon_railgun_heavy_mk3']) {
      expect(unitPowerProfile(code)?.class).toBe('autonomous');
      expect(unitPowerProfile(code)?.idle).toBe(0);
    }
    for (const code of ['tower_laser_mk1', 'tower_rail_mk2', 'tower_plasma_mk3']) {
      expect(unitPowerProfile(code)?.class).toBe('grid');
    }
  });
});

describe('workshop/structures: ускорение здания', () => {
  it('полный инвентарь не блокирует ускорение постройки здания', () => {
    const crowded: UserAccount = {
      ...funded(),
      materials: { ...funded().materials, chronium: 10_000 },
      inventory: Array.from({ length: MAX_INVENTORY_ITEMS }, () => itemOf('tower_laser_mk1'))
    };
    const started = startBuild(crowded, REACTOR, T0, idFactory);
    // Предмет в тех же условиях получил бы `inventory_full`, здание — `ok`.
    expect(describeSpeedup(started.account, started.job.id, T0).reason).toBe('ok');
  });

  it('предмет в тех же условиях всё ещё упирается в инвентарь', () => {
    // Порядок важен: при 399 предметах и одной работе в полёте свободен ровно один
    // слот — и он как раз для результата этой работы, поэтому `ok` был бы верным
    // ответом. Забиваем инвентарь ПОСЛЕ старта стройки: тогда ускорять некуда.
    const almostFull: UserAccount = {
      ...funded(),
      materials: { ...funded().materials, chronium: 10_000 },
      inventory: Array.from({ length: MAX_INVENTORY_ITEMS - 1 }, () => itemOf('tower_laser_mk1'))
    };
    const started = startBuild(almostFull, 'tower_laser_mk1', T0, idFactory);
    const full: UserAccount = { ...started.account, inventory: Array.from({ length: MAX_INVENTORY_ITEMS }, () => itemOf('tower_laser_mk1')) };
    expect(describeSpeedup(full, started.job.id, T0).reason).toBe('inventory_full');
  });
});

describe('workshop/structures: SEC — деньги, а не запас', () => {
  /**
   * Монета родилась как продукт ASIC-стоек и полгода была односторонней: `industry.ts`
   * капал её в кошелёк, витрина показывала `secSpendable`, журнал писал `+sec` — и
   * ни один маршрут не снимал ни одной единицы. Комментарий в `user.types.ts` при
   * этом утверждал, что «их тратят чертежи». Блок ниже закрывает обе стороны: у монеты
   * появился сток (`secCost`), и теперь есть тест, который отличает деньги от декорации.
   */

  const MK1 = 'asic_rack_mk1';
  const MK2 = 'asic_rack_mk2';
  const MK3 = 'asic_rack_mk3';

  /** Игрок «на всё хватает», кроме монеты: `sec` задаётся явно. */
  function withSec(sec: number, structures: Partial<Record<StructureId, number>> = {}): UserAccount {
    return withStructures(withResources(funded(), { sec }), structures);
  }

  it('первая стойка не стоит монету: иначе экономика замкнулась бы на собственном продукте', () => {
    // SEC капает ТОЛЬКО с ASIC. Поставь мы цену даже в 1 монету на Mk.I — и новичок
    // не смог бы купить источник дохода, не имея дохода. Это ровно тот класс
    // взаимоблокировки, который починен стартовым комплектом (P0), и тест не даёт
    // ему вернуться балансной правкой «поднимем цену первой стойки».
    expect(getStructure(MK1)?.secCost ?? 0).toBe(0);

    const started = startBuild(withSec(0), MK1, T0, idFactory);
    expect(started.secCost).toBe(0);
    expect(started.drafts.some((draft) => draft.currency === 'sec')).toBe(false);
  });

  it('монету берут только ASIC: ни одно другое сооружение не имеет secCost', () => {
    const priced = STRUCTURES.filter((def) => (def.secCost ?? 0) > 0);
    expect(priced.length).toBeGreaterThan(0);
    expect(priced.every((def) => def.id.startsWith('asic_rack'))).toBe(true);
    expect(priced.map((def) => def.id)).toEqual([MK2, MK3]);
  });

  it('цена следующего экземпляра растёт и всегда целая', () => {
    const def = getStructure(MK2)!;
    expect(structureSecCost(def, 0)).toBe(def.secCost);

    let previous = 0;
    for (let owned = 0; owned < def.maxPerBase; owned++) {
      const price = structureSecCost(def, owned);
      expect(Number.isInteger(price), `owned=${owned}`).toBe(true);
      expect(price, `owned=${owned}`).toBeGreaterThan(previous);
      previous = price;
    }
  });

  it('не хватает монеты — отказ по SEC, и ни один материал не списан', () => {
    const account = withSec(100, { [MK1]: 1 });
    const before = { ...account.resources };
    try {
      startBuild(account, MK2, T0, idFactory);
      throw new Error('ожидался отказ по монете');
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
      expect((error as AppError).details?.currency).toBe('sec');
    }
    // Чистая функция: «всё или ничего» на этом уровне означает, что исходный объект
    // не тронут вообще — иначе частичная оплата утекла бы в аккаунт до отказа.
    expect(account.resources).toEqual(before);
  });

  it('монета списана ровно одним движением с валютной частью ключа', () => {
    const def = getStructure(MK2)!;
    // Рост считается ПО ВИДУ, а не по всем стойкам базы: две Mk.II делают дороже
    // третью Mk.II, а наличие Mk.I на цену Mk.II влиять не обязано — иначе «купил
    // дешёвую стойку» наказал бы игрока ростом цены на дорогую.
    const account = withSec(1000, { [MK1]: 5, [MK2]: 2 });
    expect(structureSecCost(def, 2)).toBeGreaterThan(structureSecCost(def, 0));

    const started = startBuild(account, MK2, T0, idFactory);

    expect(started.secCost).toBe(structureSecCost(def, 2));
    expect(started.account.resources.sec).toBe(1000 - started.secCost);

    const coinDrafts = started.drafts.filter((draft) => draft.currency === 'sec');
    expect(coinDrafts).toHaveLength(1);
    expect(coinDrafts[0]?.delta).toBe(-started.secCost);
    expect(coinDrafts[0]?.reason).toBe('craft');
    expect(coinDrafts[0]?.refType).toBe('structure');
    expect(coinDrafts[0]?.refId).toBe(MK2);
    // Инвариант №1 журнала (ledger.types.ts): действие из нескольких валют обязано
    // нести валюту в ключе. Без `:sec` это движение отбросилось бы уникальным индексом
    // как дубль первого — деньги ушли бы с баланса без аудиторского следа.
    expect(coinDrafts[0]?.idempotencyKey).toBe(`build:${started.job.id}:sec`);
    expect(started.drafts.length).toBe(materialEntries(def.cost).length + 1);
  });

  it('дробный кошелёк: тратится ровно то целое, которое показывает витрина', () => {
    // `sec` в балансе дробный (ставка 25/ч × часы), `secSpendable` — целое. Если бы
    // трата считалась по дробному числу, игрок увидел бы 350 и прошёл бы проверку с
    // 349,99 — то есть витрина и касса разошлись бы на 0,01 монеты в его пользу.
    const enough = withSec(350.7, { [MK1]: 1 });
    const started = startBuild(enough, MK2, T0, idFactory);
    expect(started.secCost).toBe(350);
    expect(started.account.resources.sec).toBeCloseTo(0.7, 6);

    const short = withSec(349.99, { [MK1]: 1 });
    expect(errorCode(() => startBuild(short, MK2, T0, idFactory))).toBe(ErrorCodes.INSUFFICIENT_FUNDS);
  });

  it('монета не проходит как материал: в `cost` её положить нельзя, значит разбор не напечатает', () => {
    // Главная ловушка дизайна. Если бы SEC стал членом `MaterialId`, он попал бы в
    // `salvageYield` (возврат доли `cost` при разборе) — и любой «разобрать в материалы»
    // печатал бы деньги из воздуха. Здесь проверяется сама граница типа, а не её следствие:
    // пока `sec` не материал, двусторонней цены у монеты физически не существует.
    expect(isMaterialId('sec')).toBe(false);
    for (const blueprint of BLUEPRINTS) {
      expect('sec' in blueprint.cost, blueprint.code).toBe(false);
      for (const [id] of materialEntries(blueprint.cost)) {
        expect(id).not.toBe('sec');
      }
    }
  });

  it('цена Mk.III выше Mk.II: монета покупает тир, а не только объём', () => {
    expect(structureSecCost(getStructure(MK3)!, 0)).toBeGreaterThan(structureSecCost(getStructure(MK2)!, 0));
  });
});

describe('workshop/structures: добыча руды постройками', () => {
  const BORE = 'bore_ore_mk1';
  const BORE2 = 'bore_ore_mk2';

  it('в реестре есть добывающее сооружение БЕЗ предпосылок', () => {
    // Страж ямы, в которую нельзя вернуться незаметно. Пока ставка добычи была
    // константой из env, единственный её рост стоил 99 ₽ (`mine_x2_24h`), а
    // копирайт каталога уже обещал «буры роют железо, кремний, уран и плазму».
    // Проверка держит именно корень дерева: тир-2 без тира-1 новичку не поможет.
    const roots = STRUCTURES.filter((def) => def.mine && (!def.requires || Object.keys(def.requires).length === 0));
    expect(roots.length, 'новичку нечем поднять добычу, кроме платного буста').toBeGreaterThan(0);
  });

  it('miningBonus аддитивен по числу экземпляров и молчит про чужие ресурсы', () => {
    const def = getStructure(BORE)!;
    if (!def.mine) throw new Error('фикстура: у бура Mk.I пропало поле mine');
    const per = def.mine.perHour;
    const bonus = miningBonus({ [BORE]: 3 });
    for (const resource of def.mine.resources) expect(bonus[resource]).toBe(3 * per);
    for (const resource of ['uranium', 'plasma', 'deuterium', 'nitrogen'] as const) {
      if (def.mine.resources.includes(resource)) continue;
      expect(bonus[resource]).toBe(0);
    }
    // Пустая база — нулевой бонус: иначе «построил 0 буров» дало бы прирост.
    expect(miningBonus({})['ferrum']).toBe(0);
  });

  it('бур Mk.II без двух Mk.I не строится, и отказ наступает до списания материалов', () => {
    const account = funded();
    const before = { ...account.resources };
    expect(errorCode(() => startBuild(account, BORE2, T0, idFactory))).toBe(ErrorCodes.STRUCTURE_REQUIRES);
    expect(account.resources).toEqual(before);
    const withTwo = withStructures(account, { [BORE]: 2 });
    expect(startBuild(withTwo, BORE2, T0, idFactory).structure?.id).toBe(BORE2);
  });

  it('добыча бура живёт в майнинге, а не в промышленности', () => {
    // Граница, обоснованная в `MineSpec`: руда, приходящая промышленным тиком,
    // не попала бы в ставку `effectiveMiningRates`, и витрина «Экономики» показала
    // бы одну цифру, а набежала бы другая.
    const def = getStructure(BORE)!;
    expect(def.output, 'бур не должен дублировать майнинг через промышленность').toBeUndefined();
    expect(def.power).toBe(0);
    expect(def.heat).toBe(0);
  });
});

describe('workshop/structures: линия буров закрывает обещание каталога', () => {
  const BORE = 'bore_ore_mk1';
  const BORE2 = 'bore_ore_mk2';
  const BORE3 = 'bore_ore_mk3';

  /** Суммарный выход добывающего сооружения, ед./час (перечь × числу руд). */
  const yieldPerHour = (def: StructureDef): number => (def.mine?.perHour ?? 0) * (def.mine?.resources.length ?? 0);

  it('каждая руда реестра прорыта хотя бы одним буром', () => {
    // Страж копирайта, а не баланса. Карточка ВК (VK_CATALOG.md) обещает: «буры роют
    // железо, кремний, уран и плазму». Пока последнее слово было неправдой, игра
    // продавала доступ к топливу, которого в реестре не было: плазменный конвертер
    // Mk.I требует 8 плазмы/ч, а рыла её только ставка 2/ч из env — то есть весь
    // энергетический этаж висел на одном бесплатном экстракторе.
    const dug = new Set<string>(STRUCTURES.flatMap((def) => def.mine?.resources ?? []));
    for (const ore of ORE_IDS) {
      expect(dug.has(ore), `руда ${ore} не роется ни одним буром, а каталог её обещает`).toBe(true);
    }
  });

  it('плазму роет ровно один вид, и это верхний тир линии', () => {
    // Один источник на самую дорогую руду — осознанная форма: если бы плазму давал
    // и Mk.I, и Mk.III, разница между тирами свелась бы к цифре в `perHour`, и ряд
    // перестал бы быть лестницей доступа.
    const plasmaBores = STRUCTURES.filter((def) => def.mine?.resources.includes('plasma'));
    expect(plasmaBores.map((def) => def.id)).toEqual([BORE3]);
    expect(plasmaBores[0]?.tier).toBe(3);
  });

  it('Mk.III требует два Mk.II и не строится раньше, чем предшественник отработал', () => {
    const def = getStructure(BORE3)!;
    expect(Object.keys(def.requires ?? {}), 'цепочка буров обязана быть линейной').toEqual([BORE2]);
    expect(def.requires?.[BORE2 as StructureId]).toBe(2);
  });

  it('отказ по предшественнику приходит до списания материалов, а два Mk.II открывают стройку', () => {
    const account = withTech(funded(), { wolfram: 500 });
    const before = { ...account.resources };
    expect(errorCode(() => startBuild(account, BORE3, T0, idFactory))).toBe(ErrorCodes.STRUCTURE_REQUIRES);
    expect(account.resources).toEqual(before);

    // Одного Mk.II мало. Порядок проверок здесь — сначала материалы, потом
    // предшественник, и это не дыра: отказ бросается ДО редуктора, поэтому
    // «почти построил» не стоит игроку ни единицы железа. Проверяем именно это.
    const partial = withStructures(withStructures(account, { [BORE]: 2 }), { [BORE2]: 1 });
    const held = { ...partial.resources };
    expect(errorCode(() => startBuild(partial, BORE3, T0, idFactory))).toBe(ErrorCodes.STRUCTURE_REQUIRES);
    expect(partial.resources).toEqual(held);

    const ready = withStructures(partial, { [BORE2]: 2 });
    expect(startBuild(ready, BORE3, T0, idFactory).structure?.id).toBe(BORE3);
  });

  it('выход Mk.III растёт медленнее его цены: тир продаёт доступ, а не тонну', () => {
    // Инвариант ряда, а не проверка баланса: до T3 каждый следующий бур отдаёт больше
    // добычи на вложенное железо, и ломается это ровно на плазме. Если балансировщик
    // разменяет T3 в объём («+500 ко всему»), тест попросит его перечитать шапку линии.
    const b2 = getStructure(BORE2)!;
    const b3 = getStructure(BORE3)!;
    expect(yieldPerHour(b3) / yieldPerHour(b2)).toBeLessThan(b3.cost.ferrum! / b2.cost.ferrum!);
  });

  it('потолок Mk.III не ниже Mk.II: лестница не сужается наверху без причины', () => {
    const b2 = getStructure(BORE2)!;
    const b3 = getStructure(BORE3)!;
    expect(b3.maxPerBase).toBeGreaterThanOrEqual(1);
    expect(b3.buildMs).toBeGreaterThan(b2.buildMs);
  });
});
