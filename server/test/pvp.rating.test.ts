import { describe, expect, it } from 'vitest';

import {
  LADDER_TIERS,
  PVP_RATING_FLOOR,
  RATING_K_BASE,
  RATING_K_PROVISIONAL,
  RATING_PROVISIONAL_BATTLES
} from '../src/config/pvp.js';
import {
  applyRating,
  expectedScore,
  kFactor,
  outcomeScore,
  ratingChange,
  ratingProgress
} from '../src/modules/pvp/rating.js';

/**
 * Рейтинг (Шаг 4).
 *
 * Проверяются свойства, а не конкретные числа: Эло обязан оставаться нулевой суммой
 * в равной паре, платить больше за победу над сильным и меньше — за победу над слабым.
 * Конкретику K-фактора и границ лестницы ловит тест конфига (monotonic tiers).
 */

const equal = { attackerRating: 1000, defenderRating: 1000, attackerBattles: 50, defenderBattles: 50 };

describe('pvp/rating: ожидаемый результат', () => {
  it('равная пара даёт 0.5 — система не имеет предпочтения по стороне', () => {
    expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 10);
  });

  it('ожидание монотонно по силе и симметрично', () => {
    expect(expectedScore(1400, 1000)).toBeGreaterThan(expectedScore(1200, 1000));
    expect(expectedScore(1000, 1400)).toBeCloseTo(1 - expectedScore(1400, 1000), 10);
  });

  it('исход отображается в очки: победа 1, ничья 0.5, поражение 0', () => {
    expect(outcomeScore('win')).toBe(1);
    expect(outcomeScore('draw')).toBe(0.5);
    expect(outcomeScore('loss')).toBe(0);
  });
});

describe('pvp/rating: дельта', () => {
  it('в равной паре победа даёт ровно половину K', () => {
    const change = ratingChange({ ...equal, outcome: 'win' });
    expect(change.attacker).toBe(RATING_K_BASE / 2);
    expect(change.defender).toBe(-RATING_K_BASE / 2);
  });

  it('сумма дельт нулевая: рейтинг не печатается и не сгорает в бою', () => {
    for (const outcome of ['win', 'draw', 'loss'] as const) {
      for (const [a, d] of [[1000, 1000], [900, 1300], [1800, 1000]] as const) {
        const change = ratingChange({
          attackerRating: a,
          defenderRating: d,
          attackerBattles: 50,
          defenderBattles: 50,
          outcome
        });
        expect(change.attacker + change.defender).toBe(0);
      }
    }
  });

  it('победа аутсайдера стоит дороже победы фаворита', () => {
    const underdog = ratingChange({ ...equal, attackerRating: 800, defenderRating: 1200, outcome: 'win' });
    const favorite = ratingChange({ ...equal, attackerRating: 1200, defenderRating: 800, outcome: 'win' });
    expect(underdog.attacker).toBeGreaterThan(favorite.attacker);
  });

  it('поражение фаворита больнее поражения аутсайдера', () => {
    const favorite = ratingChange({ ...equal, attackerRating: 1400, defenderRating: 900, outcome: 'loss' });
    const underdog = ratingChange({ ...equal, attackerRating: 900, defenderRating: 1400, outcome: 'loss' });
    expect(favorite.attacker).toBeLessThan(underdog.attacker);
  });

  it('необкатанный игрок двигается быстрее, и порог — RATING_PROVISIONAL_BATTLES', () => {
    expect(kFactor(0)).toBe(RATING_K_PROVISIONAL);
    expect(kFactor(RATING_PROVISIONAL_BATTLES - 1)).toBe(RATING_K_PROVISIONAL);
    expect(kFactor(RATING_PROVISIONAL_BATTLES)).toBe(RATING_K_BASE);
    expect(kFactor(999)).toBe(RATING_K_BASE);
  });

  it('K берётся максимумом сторон: в паре новичок↔ветеран сумма всё равно нулевая', () => {
    const change = ratingChange({ ...equal, attackerBattles: 0, defenderBattles: 500, outcome: 'win' });
    expect(change.attacker).toBe(RATING_K_PROVISIONAL / 2);
    expect(change.attacker + change.defender).toBe(0);
  });
});

describe('pvp/rating: пол и лестница', () => {
  it('рейтинг не уходит ниже пола, сколько бы ни проигрывал', () => {
    expect(applyRating(5, -100)).toBe(PVP_RATING_FLOOR);
    expect(applyRating(1000, -20)).toBe(980);
    expect(applyRating(1000.4, 0.4)).toBe(1001);
  });

  it('ступень лестницы соответствует диапазону, а высшая не имеет следующей', () => {
    for (const tier of LADDER_TIERS) {
      expect(ratingProgress(tier.min).tier.code).toBe(tier.code);
    }
    const top = LADDER_TIERS[LADDER_TIERS.length - 1] as { code: string; min: number };
    expect(ratingProgress(top.min + 500).next).toBeNull();
    expect(ratingProgress(top.min + 500).ratio).toBe(1);
  });

  it('до следующей ступени считается остаток очков и заполнение внутри текущей', () => {
    const silver = LADDER_TIERS[1] as { min: number };
    const gold = LADDER_TIERS[2] as { min: number };
    const progress = ratingProgress(silver.min + (gold.min - silver.min) / 2);
    expect(progress.tier.code).toBe('silver');
    expect(progress.next?.code).toBe('gold');
    expect(progress.toNext).toBe((gold.min - silver.min) / 2);
    expect(progress.ratio).toBeCloseTo(0.5, 5);
  });
});
