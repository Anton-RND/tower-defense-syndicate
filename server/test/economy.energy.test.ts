import { describe, expect, it } from 'vitest';

import { applyEnergyTick, spendEnergy } from '../src/modules/economy/energy.js';
import { HOUR, MINUTE, addMs, newAccount, testConfig, withResources, T0 } from './fixtures.js';

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
    const spent = spendEnergy(full, rules.energyCap / 2, T0, rules).account;
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
    const first = spendEnergy(drained(0), 1, t1, rules);
    expect(Math.floor(first.account.resources.energy)).toBe(0);
    expect(() => spendEnergy(first.account, 1, t1, rules)).toThrowError();

    // Отказ — про отсутствие энергии, а не про сломанное состояние: через час реген
    // приходит по времени, а не по числу обращений.
    const later = spendEnergy(first.account, 1, addMs(t1, HOUR), rules);
    expect(later.after).toBeGreaterThanOrEqual(0);
    expect(later.account.energyUpdatedAt.getTime()).toBe(addMs(t1, HOUR).getTime());
  });
});
