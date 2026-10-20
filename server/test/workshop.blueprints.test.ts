import { describe, expect, it } from 'vitest';

import {
  ADVANCED_TIME_SCALE,
  BLUEPRINTS,
  METAL_IDS,
  getBlueprint,
  materialEntries,
  salvageRateOf,
  type MaterialId,
  type MetalId
} from '../src/config/workshop.js';
import { isCraftTechId, type CraftTechId } from '../src/config/materials.js';
import { MINUTE } from './fixtures.js';

/**
 * Продвинутые чертежи из балансного драфта (металлы переработки → оружие).
 *
 * Конфигурация — это данные, и она обязана быть проверяемой: опечатка в ключе cost
 * («black» вместо «black_metal») молча превращается в бесплатный чертеж, потому что
 * materialEntries отбрасывает неизвестные материалы, а не бросает ошибку.
 */

const ADVANCED = ['weapon_plasma_cannon_mk3', 'weapon_railgun_heavy_mk3', 'drone_cerberus_mk3'] as const;
const MINING_IDS: readonly MaterialId[] = ['ferrum', 'silicium', 'uranium', 'plasma'];

function blueprint(code: string) {
  const found = getBlueprint(code);
  if (!found) throw new Error(`Чертёж ${code} отсутствует в конфиге`);
  return found;
}

function costIds(code: string): MaterialId[] {
  return materialEntries(blueprint(code).cost).map(([id]) => id);
}

describe('чертежи: целостность таблицы', () => {
  it('коды уникальны: карта BLUEPRINT_BY_CODE не должна терять предметы', () => {
    const codes = BLUEPRINTS.map((item) => item.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('каждый cost содержит только известные материалы (ловим опечатки в ключах)', () => {
    for (const item of BLUEPRINTS) {
      expect(materialEntries(item.cost).length, `мусор в cost у ${item.code}`).toBe(Object.keys(item.cost).length);
      for (const [id, amount] of materialEntries(item.cost)) {
        expect(Number.isInteger(amount) && amount > 0, `${item.code}:${id}`).toBe(true);
      }
    }
  });

  it('у каждого чертежа есть таблица хлама, шансы в 0..1, min <= max', () => {
    for (const item of BLUEPRINTS) {
      expect(item.scrap.length, item.code).toBeGreaterThan(0);
      for (const drop of item.scrap) {
        expect(drop.chance, `${item.code}:${drop.junk}`).toBeGreaterThanOrEqual(0);
        expect(drop.chance, `${item.code}:${drop.junk}`).toBeLessThanOrEqual(1);
        expect(drop.min, `${item.code}:${drop.junk}`).toBeLessThanOrEqual(drop.max);
        expect(drop.min, `${item.code}:${drop.junk}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('salvage-возврат никогда не превышает вложенное (потолок по уровню 1)', () => {
    for (const item of BLUEPRINTS) {
      expect(salvageRateOf(item), item.code).toBeGreaterThan(0);
      expect(salvageRateOf(item), item.code).toBeLessThanOrEqual(1);
    }
  });
});

describe('чертежи: продвинутое оружие за металлы переработки', () => {
  it('все три кода присутствуют и это тир-3', () => {
    for (const code of ADVANCED) {
      expect(blueprint(code).tier, code).toBe(3);
    }
  });

  it('оплата — металлы и сырьё чертежей: ни железа, ни ресурсов майнинга, ни хлама', () => {
    for (const code of ADVANCED) {
      const ids = costIds(code);
      expect(ids.length, code).toBeGreaterThan(0);
      for (const id of ids) {
        // Металлы переработки и высокотехнологичное сырьё — две половины одной полки
        // тира-3; астерий здесь не платит ни при каких обстоятельствах (деньги ≠ сырьё).
        const payable = METAL_IDS.includes(id as MetalId) || isCraftTechId(id);
        expect(payable, `${code}:${id}`).toBe(true);
        expect(MINING_IDS.includes(id), `${code}:${id}`).toBe(false);
      }
    }
  });

  it('вид предметов соответствует драфту: две пушки и один дрон', () => {
    expect(blueprint('weapon_plasma_cannon_mk3').kind).toBe('weapon');
    expect(blueprint('weapon_railgun_heavy_mk3').kind).toBe('weapon');
    expect(blueprint('drone_cerberus_mk3').kind).toBe('drone');
  });

  it('стоимость соответствует роли металла: рельсотрон — чёрмет и вольфрам, Цербер — драгметалл', () => {
    const metalCost = (code: string): Record<MetalId, number> => {
      const result: Record<MetalId, number> = { black_metal: 0, colored_metal: 0, precious_metal: 0 };
      for (const [id, amount] of materialEntries(blueprint(code).cost)) {
        if (METAL_IDS.includes(id as MetalId)) result[id as MetalId] = amount;
      }
      return result;
    };
    const techCost = (code: string): Record<CraftTechId, number> => {
      const result: Record<CraftTechId, number> = { chronium: 0, wolfram: 0, stanium: 0 };
      for (const [id, amount] of materialEntries(blueprint(code).cost)) {
        if (isCraftTechId(id)) result[id] = amount;
      }
      return result;
    };

    expect(metalCost('weapon_plasma_cannon_mk3')).toEqual({ black_metal: 20, colored_metal: 80, precious_metal: 15 });
    // Драгметалл из рельсотрона выведен полностью: его место занял промышленный вольфрам.
    expect(metalCost('weapon_railgun_heavy_mk3')).toEqual({ black_metal: 150, colored_metal: 40, precious_metal: 0 });
    expect(metalCost('drone_cerberus_mk3')).toEqual({ black_metal: 10, colored_metal: 50, precious_metal: 25 });

    // Вольфрам — сырьё тяжёлых чертежей: без него рельсотрон и «Цербер» не собираются,
    // а плазмаган (упор в драгметалл) обходится без него вовсе. Хрониум и станиум в
    // чертежах не платят никогда: это время и PvP, а не производство.
    expect(techCost('weapon_plasma_cannon_mk3')).toEqual({ chronium: 0, wolfram: 0, stanium: 0 });
    expect(techCost('weapon_railgun_heavy_mk3')).toEqual({ chronium: 0, wolfram: 50, stanium: 0 });
    expect(techCost('drone_cerberus_mk3')).toEqual({ chronium: 0, wolfram: 20, stanium: 0 });
  });

  it('ряд времени из драфта сохранён: 180 : 300 : 600 секунд → 45 : 75 : 150 минут', () => {
    const seconds = (code: string): number => blueprint(code).buildMs / 1000 / ADVANCED_TIME_SCALE;
    expect(seconds('drone_cerberus_mk3')).toBe(180);
    expect(seconds('weapon_plasma_cannon_mk3')).toBe(300);
    expect(seconds('weapon_railgun_heavy_mk3')).toBe(600);

    // Абсолюты обязаны попадать в тир-3 полку существующего каталога, иначе
    // дешёвое по времени тир-3 обесценит и дефицит металлов, и слоты строителей.
    const longestExisting = Math.max(...BLUEPRINTS.filter((item) => !ADVANCED.includes(item.code as never)).map((item) => item.buildMs));
    for (const code of ADVANCED) {
      const ms = blueprint(code).buildMs;
      expect(ms / MINUTE, code).toBeGreaterThanOrEqual(30);
      expect(ms, code).toBeLessThanOrEqual(longestExisting * 2);
    }
  });
});
