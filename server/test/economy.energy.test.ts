import { describe, expect, it } from 'vitest';

import { MAX_STACK_MULTIPLIER } from '../src/modules/economy/entitlements.js';
import {
  applyEnergyTick,
  auditEnergy,
  energyCeiling,
  spendEnergy,
  type EnergyMovement
} from '../src/modules/economy/energy.js';
import { HOUR, MINUTE, addMs, entitlement, newAccount, testConfig, withResources, T0 } from './fixtures.js';
import type { UserAccount } from '../src/modules/user/user.types.js';

/**
 * Реген социальной энергии (п.2.3) — ленивый догон и его идемпотентность.
 *
 * Файл появился вместе с правкой `computeEnergyTick`: курсор `energyUpdatedAt` двигался
 * на `now` ТОЛЬКО при полном баке, тогда как начисление уже лежало в `resources.energy`.
 * Каждый последующий запрос заново добавлял всё окно от старой метки, то есть энергия
 * печаталась скоростью числа запросов — до упора в кап. Дёшево проверить это можно
 * только вызвав тик дважды на одной и той же метке времени, поэтому здесь именно такие
 * тесты, а не разбор формул.
 */

const config = testConfig();
const rules = config.economy;

/** Аккаунт с намеренно неполным баком: именно ниже капа курсор и залипал. */
function drained(energy = 1) {
  return withResources(newAccount(config, T0, 'energy'), { energy });
}

/** Контекст траты: рейд — единственный плательщик энергией (ATTACK_ENERGY_COST). */
function spendCtx(raidId = 'raid-1') {
  return { reason: 'raid_energy' as const, refType: 'raid' as const, refId: raidId };
}

/** Цена действия в этих тестах: целая, как того требует контракт `spendEnergy`. */
const RAID_COST = 15;

describe('economy/energy: идемпотентность догона', () => {
  it('повторный тик в тот же такт не печатает энергию', () => {
    const now = addMs(T0, 30 * 60_000);
    const once = applyEnergyTick(drained(), now, rules);
    const twice = applyEnergyTick(once, now, rules);
    // До правки: twice = 1 + 2×(0.5 часа × ставка), то есть второй запрос добавлял
    // ещё целый кусок регена за уже посчитанное окно.
    expect(twice.resources.energy).toBe(once.resources.energy);
    expect(twice.energyUpdatedAt.getTime()).toBe(now.getTime());
  });

  it('курсор догоняет now и ниже капа — иначе окно считается дважды', () => {
    const now = addMs(T0, 10 * 60_000);
    const ticked = applyEnergyTick(drained(), now, rules);
    expect(ticked.resources.energy).toBeLessThan(rules.energyCap);
    expect(ticked.energyUpdatedAt.getTime()).toBe(now.getTime());
  });

  it('за час набирается ровно ставка, а не ставка на каждый запрос', () => {
    const inOneHour = addMs(T0, HOUR);
    const ticked = applyEnergyTick(drained(0), inOneHour, rules);
    expect(ticked.resources.energy).toBe(rules.energyRegenPerHour);
    expect(applyEnergyTick(ticked, inOneHour, rules).resources.energy).toBe(rules.energyRegenPerHour);
  });

  it('полный бак не копит переполнение и не откатывает курсор', () => {
    const full = applyEnergyTick(withResources(newAccount(config, T0, 'energy-full'), { energy: rules.energyCap }), T0, rules);
    expect(full.resources.energy).toBe(rules.energyCap);
    // Тратим половину, потом крутим время: начисляться должно только окно ПОСЛЕ траты.
    const spent = spendEnergy(full, rules.energyCap / 2, T0, rules, spendCtx('raid-cap')).account;
    const later = addMs(T0, 10 * HOUR);
    const regened = applyEnergyTick(spent, later, rules);
    expect(regened.resources.energy).toBe(rules.energyCap);
    expect(regened.energyUpdatedAt.getTime()).toBe(later.getTime());
  });
});

describe('economy/energy: цена действия', () => {
  it('второй рейд в тот же такт не оплачивается энергией, набежавшей от числа запросов', () => {
    // Практическое следствие курсора: `spendEnergy` сама вызывает догон, и пока курсор
    // не двигался ниже капа, второй вызов в ту же метку времени заново начислял всё окно
    // от старой метки. Игрок, повторивший рейд «на одной кнопке», получал его бесплатно.
    const t1 = addMs(T0, 15 * MINUTE);
    const first = spendEnergy(drained(0), 1, t1, rules, spendCtx('raid-twice'));
    expect(Math.floor(first.account.resources.energy)).toBe(0);
    expect(() => spendEnergy(first.account, 1, t1, rules, spendCtx('raid-twice-2'))).toThrowError();

    // Отказ — про отсутствие энергии, а не про сломанное состояние: через час реген
    // приходит по времени, а не по числу обращений.
    const later = spendEnergy(first.account, 1, addMs(t1, HOUR), rules, spendCtx('raid-thrice'));
    expect(later.after).toBeGreaterThanOrEqual(0);
    expect(later.account.energyUpdatedAt.getTime()).toBe(addMs(t1, HOUR).getTime());
  });
});

describe('economy/energy: трата идёт через журнал', () => {
  it('списание энергии оставляет якорь balanceAfter', () => {
    // Вопрос «откуда у игрока 100 энергии» не имел ответа, пока рейд менял
    // `resources.energy` напрямую: реген — функция времени, и «мог просто ждать»
    // нельзя опровергнуть без точки отсчёта. Якорь — это и есть запись журнала.
    const t1 = addMs(T0, 15 * MINUTE);
    const spent = spendEnergy(drained(20), RAID_COST, t1, rules, spendCtx('raid-anchor'));
    const draft = spent.drafts[0];

    expect(draft?.currency).toBe('energy');
    expect(draft?.reason).toBe('raid_energy');
    expect(draft?.delta).toBe(-RAID_COST);
    expect(draft?.ts.getTime()).toBe(t1.getTime());
    // Якорь — точный (дробный) остаток, а не цементированная витрина `after`: аудит
    // сравнивает себя с тем, что реально лежит в документе.
    expect(draft?.balanceAfter).toBe(spent.account.resources.energy);
    // Ключ обязан содержать валюту: рейд пишет несколько валют одним действием, и без
    // суффикса эта запись была бы отброшена уникальным индексом журнала как дубль.
    expect(draft?.idempotencyKey).toBe('raid:raid-anchor:energy');
  });
});

describe('economy/energy: аудит переплаты (auditEnergy)', () => {
  const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

  /**
   * Точная копия СЛОМАННОГО догона (до правки курсора): начисление ложилось в
   * `resources.energy`, а метка ниже капа не ехала — и каждый следующий запрос заново
   * добавлял ВСЁ окно от старой метки. Копия нужна не ради ностальгии: проверке
   * подлежит следствие, а именно — способен ли аудит поймать ровно тот вред, который
   * эксплойт наносил, а не «что-то похожее».
   */
  function legacyPrint(account: UserAccount, at: Date): UserAccount {
    const elapsedMs = at.getTime() - account.energyUpdatedAt.getTime();
    const raw = account.resources.energy + (rules.energyRegenPerHour * elapsedMs) / HOUR;
    const energy = Math.min(rules.energyCap, raw);
    return {
      ...account,
      resources: { ...account.resources, energy },
      energyUpdatedAt: energy >= rules.energyCap ? at : account.energyUpdatedAt
    };
  }

  /**
   * Один и тот же сценарий — пять рейдов подряд после часа с залипшим курсором — двумя
   * способами: с печатью энергии запросами и без неё. Движения в обоих случаях те, что
   * лёг бы в журнал `spendEnergy` после правки: без них аудит не на что опереть.
   *
   * Тайминги выбраны не наугад, а по двум границам, которые эксплойт обязан нарушить:
   *  1. шаг в секунду, а не в минуту: печать за опрос = ставка × окно (5 × 1ч = 5
   *     единиц), а честный потолок за ту же секунду = ставка × 8 × 1с = 0,011 единицы.
   *     На минутном шаге печать (5) ещё помещается внутрь честного потолка (40/час) —
   *     и отличить фермера от игрока с максимальным бустом регена невозможно.
   *  2. бак не доезжает до капа: старый догон двигал метку именно на полном баке, и
   *     любой прогон, упирающийся в кап, эту метку «отбеливает» — след исчезает.
   *
   * В режиме 'exploit' списание считается вручную, а не через `spendEnergy`: живой
   * `spendEnergy` вызывает уже ИСПРАВЛЕННЫЙ догон и сам бы вылечил курсор, которого в
   * сломанную эпоху не двигали именно ниже капа.
   */
  function replay(mode: 'exploit' | 'honest', rounds: number) {
    let account = drained(rules.energyCap - RAID_COST + 1);
    const movements: EnergyMovement[] = [];
    for (let round = 1; round <= rounds; round += 1) {
      const at = addMs(T0, HOUR + (round - 1) * 1000);
      if (mode === 'exploit') {
        account = legacyPrint(account, at);
        const balanceAfter = round6(account.resources.energy - RAID_COST);
        account = withResources(account, { energy: balanceAfter });
        movements.push({ ts: at, delta: -RAID_COST, balanceAfter });
      } else {
        const spent = spendEnergy(account, RAID_COST, at, rules, spendCtx(`honest-${round}`));
        account = spent.account;
        const draft = spent.drafts[0];
        if (!draft) throw new Error('трата энергии не попала в журнал');
        movements.push({ ts: draft.ts, delta: draft.delta, balanceAfter: draft.balanceAfter });
      }
    }
    return { account, movements };
  }

  const auditAt = addMs(T0, HOUR + 10 * 1000);

  it('ловит энергию, напечатанную числом запросов', () => {
    const { account, movements } = replay('exploit', 5);
    const audit = auditEnergy(account, movements, auditAt, rules);

    expect(audit.firstDivergence).not.toBeNull();
    expect(audit.excess).toBeGreaterThan(0);
    // Излишек — ровно разрыв до потолка, не больше: ниже `honest` аудит не опускается
    // никогда, иначе он сам стал бы второй дырой вместо первой.
    expect(round6(account.resources.energy - audit.excess)).toBe(audit.honest);
  });

  it('не трогает игрока, который ходил в те же рейды тем же ритмом, но честно', () => {
    const { account, movements } = replay('honest', 5);
    const audit = auditEnergy(account, movements, auditAt, rules);

    expect(audit.firstDivergence).toBeNull();
    expect(audit.excess).toBe(0);
  });

  it('граница строится на потолке множителя, а не на текущей ставке', () => {
    // Протухшие привилегии вычищаются тиком, и их истории в документе нет: считай
    // аудит по ТЕКУЩЕЙ ставке — и вчерашний покупатель «Энерго-катализатора» стал бы
    // виноватым. Граница берётся по максимуму, который система вообще позволяет.
    const boosted = entitlement({ kind: 'energy_boost', value: 9, permanent: true });
    const account = { ...drained(10), entitlements: [boosted] };
    const inOneHour = addMs(T0, HOUR);
    const ticked = applyEnergyTick(account, inOneHour, rules);

    // x9 срезается потолком стека MAX_STACK_MULTIPLIER — той же константой, которой
    // пользуется аудит. Значит максимально легально быстрый реген границы достигает
    // ровно, но не пробивает: подозрений не будет ни у кого, кто платит за скорость.
    expect(energyCeiling({ ts: T0, balance: 10 }, inOneHour, rules)).toBe(
      Math.min(rules.energyCap, 10 + rules.energyRegenPerHour * MAX_STACK_MULTIPLIER)
    );
    expect(ticked.resources.energy).toBe(energyCeiling({ ts: T0, balance: 10 }, inOneHour, rules));
  });

  it('пустой журнал не обвиняет игрока, который просто не тратил энергию', () => {
    // Новичок стартует с полным баком (createAccount), и до первой траты любое число в
    // диапазоне [0..cap] ему законно: ловить тут нечего, и аудит обязан это знать.
    const idle = applyEnergyTick(drained(rules.energyCap), addMs(T0, 3 * HOUR), rules);
    const audit = auditEnergy(idle, [], addMs(T0, 3 * HOUR), rules);
    expect(audit.excess).toBe(0);
    expect(audit.firstDivergence).toBeNull();
  });
});
