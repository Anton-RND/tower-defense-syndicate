import {
  MATCH_BAND_MAX_ATTEMPTS,
  MATCH_BAND_START,
  MATCH_BAND_STEP,
  MATCH_POOL_SIZE,
  MATCH_PREFER_MIN_UNITS
} from '../../config/pvp.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { hashSeed, shuffled } from '../../lib/rng.js';
import { isShielded } from '../economy/entitlements.js';
import type { MatchCandidate, OpponentFilter, UserStore } from '../user/user.store.js';
import type { UserAccount } from '../user/user.types.js';
import { describeBase, type BaseReport } from './defense.js';

/**
 * Матчмейкинг (Шаг 4, п.4 ТЗ): подбор сохранённой базы подходящего уровня.
 *
 * ДВЕ ВЕТКИ ОТЛИЧАЮТСЯ ОТ ДРАФТА ТЗ, и обе — по существу, а не по вкусу:
 *
 *  1. Никакого `PvpDefense.find().populate('userId')` с фильтром по рейтингу в JS.
 *     Планировка Шага 3 живёт ВНУТРИ документа игрока (атомарность с инвентарём),
 *     поэтому кандидат — это и есть игрок: `UserStore.findOpponents` отдаёт
 *     проекцию по индексу `(platform, pvp.rating)`, а не всю коллекцию с последующей
 *     фильтрацией в памяти. Фильтр в JS означал бы «прочитать всех игроков сети» на
 *     каждый рейд — на 100k игроков это гарантированный отказ по таймауту.
 *
 *  2. Проходимость базы НЕ читается из хранимого флага `isValid`. Его нет и не будет
 *     (см. шапку pvp/defense): кандидат берёт в рейд только если `describeBase`
 *     прямо сейчас говорит `ready`. Мёртвый лабиринт, «валидный» со вчерашнего
 *     сохранения, в бой не попадает, потому что за ночь у его хозяина могли отозвать
 *     турель рефандом.
 *
 * Коридор рейтинга расширяется по попыткам: сначала честный бой, и только когда
 * соперников в нём нет — более дальний. Порядок кандидатов внутри коридора случаен
 * (ГСЧ передаётся параметром), иначе матчмейкинг всегда отдавал бы одного и того же
 * «первого по индексу» игрока и превратился в расписание, а не в подбор.
 */

/** Сколько документов проверять за одну попытку: больше — дороже, а шанс найти ready выше не становится. */
export const VERIFY_PER_ATTEMPT = 5;

/** Ширина коридора ±рейтинг на попытке `attempt` (0 — самая узкая и самая честная). */
export function bandFor(attempt: number): number {
  const step = Math.max(0, Math.trunc(attempt));
  return MATCH_BAND_START + step * MATCH_BAND_STEP;
}

export interface OpponentFilterInput {
  attacker: UserAccount;
  ratingMin: number;
  ratingMax: number;
}

/** Сборка фильтра стора: платформа атакующего, он же исключён, коридор вокруг его рейтинга. */
export function filterFor(input: OpponentFilterInput): OpponentFilter {
  return {
    platform: input.attacker.platform,
    excludeUserId: input.attacker.id,
    ratingMin: input.ratingMin,
    ratingMax: input.ratingMax,
    limit: MATCH_POOL_SIZE
  };
}

export interface OpponentPick {
  candidate: MatchCandidate;
  defender: UserAccount;
  report: BaseReport;
  /** Номер попытки (расширение коридора), на которой найден соперник. */
  attempt: number;
  band: number;
}

export interface FindOpponentOptions {
  now: Date;
  /** ГСЧ выбора — параметром, чтобы тесты подменяли его детерминированным. */
  rng?: () => number;
  /** Потолок попыток (по умолчанию MATCH_BAND_MAX_ATTEMPTS). */
  maxAttempts?: number;
}

/**
 * Найти соперника. Бросает NO_OPPONENT (409), если в расширенном до предела коридоре
 * не нашлось ни одной проходимой базы.
 *
 * 409, а не 404: «соперников нет» — штатное состояние сети в момент затишья, и фронт
 * на него отвечает кнопкой «попробуй позже» и подсказкой «попроси друга», а не
 * экраном ошибки.
 */
export async function findOpponent(
  store: UserStore,
  attacker: UserAccount,
  options: FindOpponentOptions
): Promise<OpponentPick> {
  const rng = options.rng ?? Math.random;
  const now = options.now;
  const maxAttempts = Math.max(
    1,
    Math.min(MATCH_BAND_MAX_ATTEMPTS, Math.trunc(options.maxAttempts ?? MATCH_BAND_MAX_ATTEMPTS))
  );
  const tried = new Set<string>();

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const band = bandFor(attempt);
    const pool = await store.findOpponents(
      filterFor({
        attacker,
        ratingMin: attacker.pvp.rating - band,
        ratingMax: attacker.pvp.rating + band
      })
    );
    const fresh = pool.filter((candidate) => !tried.has(candidate.userId) && candidate.userId !== attacker.id);
    if (fresh.length === 0) continue;

    const ordered = shuffled(rng, fresh);
    // Приоритет — базам с живой обороной: атаковать пустую базу заметно дешевле, и
    // если позволить такому подбору стать обычным делом, появляется стимул держать
    // алтов с нулевой обороной. Пустые базы отдаются, только иных в коридоре нет.
    const preferred = ordered.filter((candidate) => candidate.units >= MATCH_PREFER_MIN_UNITS);
    const queue = preferred.length > 0 ? preferred : ordered;

    for (const candidate of queue.slice(0, VERIFY_PER_ATTEMPT)) {
      tried.add(candidate.userId);
      const defender = await store.findById(candidate.userId);
      if (!defender || defender.id === attacker.id) continue;
      // «Щит покоя» — купленная привилегия (п. «Монетизация»): игрок заплатил за то,
      // чтобы его не трогали, и обходить это в матчмейкинге нельзя.
      if (isShielded(defender, now)) continue;
      const report = describeBase(defender);
      if (!report.ready) continue;
      return { candidate, defender, report, attempt, band };
    }
  }

  throw new AppError(ErrorCodes.NO_OPPONENT, 409, 'Соперников вашего уровня сейчас нет — попробуйте чуть позже', {
    rating: attacker.pvp.rating,
    attempts: maxAttempts,
    band: bandFor(maxAttempts - 1)
  });
}

/**
 * Публичный ярлык по внутреннему id.
 *
 * Ни `socialId`, ни имя из VK сюда не попадают: и бой, и рынок показывают чужую
 * сущность, и персональных данных для этого не нужно. Хеш внутреннего id стабилен
 * (один и тот же соперник в двух боях выглядит одинаково) и необратим.
 *
 * Функция принимает id, а не аккаунт, потому что у рынка нет чужого документа
 * игрока: есть только лот с `sellerId`. Значит, и ярлык продавца, и ярлык защитника
 * обязаны считаться ОДНИМ кодом — иначе один игрок получил бы два разных псевдонима
 * в двух панелях одного интерфейса, и это уже не приватность, а путаница.
 */
export function publicLabel(userId: string): string {
  const hash = hashSeed(userId).toString(36).padStart(7, '0');
  return `Игрок #${hash.slice(-4)}`;
}

/** Публичный ярлык защитника (см. `publicLabel`). */
export function defenderLabel(defender: UserAccount): string {
  return publicLabel(defender.id);
}