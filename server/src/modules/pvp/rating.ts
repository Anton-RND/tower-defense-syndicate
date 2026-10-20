import {
  LADDER_TIERS,
  PVP_RATING_FLOOR,
  RATING_K_BASE,
  RATING_K_PROVISIONAL,
  RATING_PROVISIONAL_BATTLES,
  ladderTierOf,
  type LadderTier
} from '../../config/pvp.js';
import type { BattleOutcome } from '../../config/workshop.js';

/**
 * Рейтинг (п.4 ТЗ): Эло, а не «±15 за исход».
 *
 * Фиксированный шаг ломает лестницу на двух краях сразу: фаворит, отбиравший у
 * аутсайдера по 15 очков, доходит до потолка за десять боёв и дальше играет впустую,
 * а новичок с 200 очками не может отыграться. Эло платит столько, насколько соперник
 * оказался сильнее ожидания: победа над более сильным — больше очков, поражение
 * более слабому — больше потерь. Это же даёт и свойство, важное для матчмейкинга:
 * в равной паре сумма нулёвая, система не «печатает» рейтинг.
 *
 * Чистые функции: HTTP-слой и резолвер рейда получают новые числа и сами пишут их в
 * документ через редуктор (см. pvp/raid.ts).
 */

/** Очки исхода: победа 1, ничья 0.5, поражение 0 — классическая схема Эло. */
export function outcomeScore(outcome: BattleOutcome): number {
  if (outcome === 'win') return 1;
  if (outcome === 'draw') return 0.5;
  return 0;
}

/** Ожидаемый результат атакующего против защитника (0..1). */
export function expectedScore(attackerRating: number, defenderRating: number): number {
  const diff = defenderRating - attackerRating;
  return 1 / (1 + 10 ** (diff / 400));
}

/**
 * K-фактор: необкатанный игрок (мало боёв) двигается быстрее.
 *
 * Берётся МАКСИМУМ из двух сторон боя, а не каждого своя: иначе в паре
 * «новичок ↔ ветеран» сумма дельт не сходится, и рейтинг начинает появляться из ниоткуда.
 */
export function kFactor(battles: number): number {
  return battles < RATING_PROVISIONAL_BATTLES ? RATING_K_PROVISIONAL : RATING_K_BASE;
}

export interface RatingPair {
  attacker: number;
  defender: number;
}

export interface RatingChangeInput {
  attackerRating: number;
  defenderRating: number;
  attackerBattles: number;
  defenderBattles: number;
  outcome: BattleOutcome;
}

/**
 * Симметричная дельта рейтинга за бой.
 *
 * Знак «минус» для защитника — не месть проигравшему: защита, пропустившая слабее
 * себя, по Эло теряет, и ровно это заставляет держать оборону, а не только ходить
 * в рейды. Ничья не обнуляет дельту: в паре разного силы ничья выгодна слабому.
 */
export function ratingChange(input: RatingChangeInput): RatingPair {
  const k = Math.max(kFactor(input.attackerBattles), kFactor(input.defenderBattles));
  const expected = expectedScore(input.attackerRating, input.defenderRating);
  const score = outcomeScore(input.outcome);
  const raw = k * (score - expected);
  return { attacker: Math.round(raw), defender: Math.round(-raw) };
}

/** Применение дельты с полом: рейтинг не уходит в отрицательные значения. */
export function applyRating(rating: number, delta: number): number {
  // Округляется СУММА, а не каждое слагаемое: иначе +0.4 и 1000.4 дали бы 1000,
  // и малые дельты (а они бывают у K=32 в парах с большой разницей сил) исчезали бы.
  return Math.max(PVP_RATING_FLOOR, Math.round(rating + delta));
}

export interface RatingProgress {
  tier: LadderTier;
  /** Следующая ступень (null — наивысшая). */
  next: LadderTier | null;
  /** До следующей ступени, очков (null — ступень максимальная). */
  toNext: number | null;
  /** 0..1 внутри текущей ступени — для прогресс-бара лестницы. */
  ratio: number;
}

/** Положение в лестнице: только витрина, на расчёт рейтинга не влияет. */
export function ratingProgress(rating: number): RatingProgress {
  const tier = ladderTierOf(rating);
  const index = LADDER_TIERS.findIndex((candidate) => candidate.code === tier.code);
  const next = index >= 0 ? (LADDER_TIERS[index + 1] ?? null) : null;
  const ceiling = next ? next.min : tier.min;
  const span = Math.max(1, ceiling - tier.min);
  const toNext = next ? Math.max(0, next.min - Math.round(rating)) : null;
  return {
    tier,
    next,
    toNext,
    ratio: next ? Math.min(1, Math.max(0, (rating - tier.min) / span)) : 1
  };
}
