import { ORE_IDS } from '../../config/storage.js';
import type { EconomyConfig } from '../../config/env.js';
import { ATTACK_ENERGY_COST, ATTACK_MIN_ROBOTS, OUTCOME_STEAL_FACTOR } from '../../config/pvp.js';
import type { MaterialCost } from '../../config/workshop.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { rngFromKey } from '../../lib/rng.js';
import { isShielded } from '../economy/entitlements.js';
import { dayKey, spendEnergy } from '../economy/energy.js';
import { applyMiningTick } from '../economy/mining.js';
import { gainMaterials } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft, type LedgerEntry } from '../ledger/ledger.types.js';
import type { LedgerStore } from '../ledger/ledger.store.js';
import { staniumSpeedMultiplier } from '../materials/service.js';
import { generateBattleLoot } from '../raid/loot.js';
import type { StoragePools, UserAccount } from '../user/user.types.js';
import type { UserStore } from '../user/user.store.js';
import { resolveArmy, simulateBattle, type ArmyResolution, type BattleResult } from './battle.js';
import { describeBase } from './defense.js';
import { applyRating, ratingChange } from './rating.js';

/**
 * Резолвер рейда (Шаг 4): энергия → бой → рейтинг → лут → трофеи.
 *
 * ЧИСТЫЕ ФУНКЦИИ, как и весь домен проекта: `resolveRaid` ничего не читает и не пишет
 * в стор, он принимает оба аккаунта и возвращает оба новых состояния вместе с
 * черновиками журнала. HTTP-слой оборачивает результат в два `UserStore.transact`
 * (см. порядок коммита в `commitRaid` ниже) — и это единственное место, где решение
 * «в каком порядке писать два документа» вообще существует.
 *
 * ПОРЯДОК ЗАЩИТЫ ОТ ДВОЙНОГО ЗАЧЁТА. `raidId` выдаёт сервер (matchmaking → бой) и
 * кладётся в `pvp.lastRaidId` атакующего; `generateBattleLoot` отказывает на повторе
 * того же raidId (DUPLICATE_ORDER, 409). Поэтому ретрай клиента с тем же боем не
 * даёт ни второго лута, ни второго рейтинга.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: «урона по базе» защитника. Стены и башни на его карте не меняются
 * (см. шапку pvp/battle) — он теряет только несобранные склады и рейтинг.
 */

/** raidId — идентификатор боя, выданный сервером. Клиенту на выдачу боя не отдаётся «свой» id. */
export function makeRaidId(attackerId: string, defenderId: string, nonce: string | number): string {
  return `raid:${attackerId}:${defenderId}:${nonce}`;
}

/** Сколько атак засчитано игроку сегодня (суточный лимит — антифрод, п.4). */
export function attacksToday(account: UserAccount, now: Date): number {
  return account.pvp.day === dayKey(now) ? account.pvp.attacksToday : 0;
}

export function attacksRemainingToday(account: UserAccount, now: Date, config: EconomyConfig): number {
  const limit = config.limits.pvp.dailyAttacks;
  if (limit <= 0) return -1;
  return Math.max(0, limit - attacksToday(account, now));
}

export interface RaidGuards {
  attacker: UserAccount;
  defender: UserAccount;
  now: Date;
  config: EconomyConfig;
}

/**
 * Проверка «можно ли вообще начинать бой».
 *
 * Дешёвые и вероятные отказы идут первыми: атака на себя и щит защитника стоят
 * одну операцию сравнения, а `describeBase` — BFS по полю, и платить им за рейд,
 * который запретит суточный лимит, незачем.
 */
export function assertAttackable(input: RaidGuards): void {
  const { attacker, defender, now, config } = input;

  if (attacker.id === defender.id) {
    throw new AppError(ErrorCodes.SELF_ATTACK, 400, 'Атаковать собственную базу нельзя', {
      userId: attacker.id
    });
  }
  if (isShielded(defender, now)) {
    throw new AppError(ErrorCodes.OPPONENT_SHIELDED, 403, 'Соперник под «Щитом покоя» — выберите другую базу', {
      defenderId: defender.id
    });
  }
  if (!describeBase(defender).ready) {
    throw new AppError(ErrorCodes.OPPONENT_UNREADY, 409, 'База соперника больше не пригодна для боя — обновите подбор', {
      defenderId: defender.id
    });
  }
  const remaining = attacksRemainingToday(attacker, now, config);
  if (remaining === 0) {
    throw new AppError(ErrorCodes.ATTACK_LIMIT_REACHED, 429, 'Суточный лимит атак исчерпан', {
      limit: config.limits.pvp.dailyAttacks,
      used: attacksToday(attacker, now)
    });
  }
}

export interface RaidInput {
  /** id атакующего: редуктору стора он нужен до того, как станет известен аккаунт. */
  attackerId: string;
  defender: UserAccount;
  /** itemId дронов. Все боевые цифры сервер берёт из инвентаря атакующего, не из запроса. */
  armyItemIds: readonly string[];
  raidId: string;
  now: Date;
  config: EconomyConfig;
  /** ГСЧ броска лута. По умолчанию — выведенный из raidId: тот же бой даёт тот же лут. */
  rng?: () => number;
}

export interface SideRating {
  before: number;
  after: number;
  delta: number;
}

export interface RaidResult {
  attacker: UserAccount;
  defender: UserAccount;
  drafts: LedgerDraft[];
  battle: BattleResult;
  army: ArmyResolution;
  rating: { attacker: SideRating; defender: SideRating };
  loot: MaterialCost;
  /** Что вынесено с несобранных складов защитника (п.4.1). */
  stolen: StoragePools;
  energy: { before: number; after: number; cost: number };
  raidId: string;
  attacksRemaining: number;
}

function emptyStolen(): StoragePools {
  return { ferrum: 0, silicium: 0, uranium: 0, plasma: 0, deuterium: 0, nitrogen: 0 };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Полный расчёт рейда. Чисто, без I/O: два аккаунта на входе, два аккаунта и
 * черновики журнала на выходе.
 *
 * Порядок операций внутри редуктора значим:
 *  1. дешёвые отказы (себя, щит, чужая база, суточный лимит);
 *  2. состав армии — пока он невалиден, энергию не списываем;
 *  3. энергия;
 *  4. бой;
 *  5. рейтинг;
 *  6. лут (бросок, привязанный к raidId) и трофеи со складов защитника.
 * Любой шаг, бросивший исключение, отменяет весь рейд: HTTP-слой вызывает эту функцию
 * ВНУТРИ `UserStore.transact`, и неотработанный редуктор не оставляет ни списаний,
 * ни следов в журнале.
 */
export function resolveRaid(attacker: UserAccount, input: RaidInput): RaidResult {
  const { defender, now, config } = input;
  assertAttackable({ attacker, defender, now, config });

  const raidId = typeof input.raidId === 'string' ? input.raidId.trim() : '';
  if (raidId.length === 0 || raidId.length > 128) {
    throw new AppError(ErrorCodes.RAID_MISMATCH, 400, 'Некорректный идентификатор боя', { length: raidId.length });
  }

  const army = resolveArmy(attacker, input.armyItemIds);
  if (army.robots < ATTACK_MIN_ROBOTS) {
    throw new AppError(ErrorCodes.ARMY_INVALID, 400, `В рейде не может быть меньше ${ATTACK_MIN_ROBOTS} дрона`, {
      robots: army.robots,
      min: ATTACK_MIN_ROBOTS
    });
  }

  const energy = spendEnergy(attacker, ATTACK_ENERGY_COST, now, config);
  // Станиумное поле защитника (config/materials.ts) — единственное, что из «материалов»
  // касается боя. Срок проверяем по `now` рейда, а не по внутренним часам симуляции,
  // иначе одно состояние давало бы разный исход в зависимости от длины боя; множитель
  // едет в бой явным аргументом и попадает в отчёт (`battle.attackerSpeedMultiplier`),
  // поэтому разбор боя видит факт поля, а не выводит его по таймингам.
  const attackerSpeedMultiplier = staniumSpeedMultiplier(defender, now);
  const battle = simulateBattle({ defender, army, attackerSpeedMultiplier });
  const rng = input.rng ?? rngFromKey(raidId);

  const change = ratingChange({
    attackerRating: attacker.pvp.rating,
    defenderRating: defender.pvp.rating,
    attackerBattles: attacker.pvp.battles,
    defenderBattles: defender.pvp.battles,
    outcome: battle.outcome
  });
  const attackerRating = applyRating(attacker.pvp.rating, change.attacker);
  const defenderRating = applyRating(defender.pvp.rating, change.defender);

  // Лут — существующий резолвер Шага 2 (п.4): суточный потолок событий, потолок склада
  // хлама и дедупликация по raidId уже там. Дублировать эту математику здесь — значит
  // однажды забыть в новой ветке лимит и получить ферму хлама.
  const lootResult = generateBattleLoot(
    energy.account,
    { raidId, outcome: battle.outcome, destroyed: battle.destroyed },
    now,
    config,
    rng
  );

  // Трофеи (п.4.1): доля НЕСОБРАННЫХ складов защитника. Склад сначала «догоняется»
  // тиком майнинга — иначе рейд крадёт по устаревшему снимку и игрок теряет добычу,
  // набежавшую за время, пока он не заходил в игру (её ведь уже никто не увидит).
  const ticked = applyMiningTick(defender, now, config);
  const share = config.lootShare * OUTCOME_STEAL_FACTOR[battle.outcome];
  const stolen = emptyStolen();
  const storages: StoragePools = { ...ticked.storages };
  const trophy: MaterialCost = {};
  for (const resource of ORE_IDS) {
    const stored = storages[resource] ?? 0;
    const take = Math.floor(stored * share);
    if (take <= 0) continue;
    stolen[resource] = take;
    storages[resource] = round6(stored - take);
    trophy[resource] = take;
  }
  // Топливо автономной техники — часть предпросмотра защитника, а не только дельта
  // редуктора: `result.attacker` уносит своё списание уже здесь, и асимметрия
  // заставила бы вызывающий слой показывать «итог боя» с несходящимся баком.
  // `applyRaidToDefender` применяет ту же дельту к ТЕКУЩЕМУ документу — это разные
  // вещи, и обе нужны: снимок для витрины против записи в живую базу.
  const defenderBurn = battle.fuel.defenderDeuterium;
  if (defenderBurn > 0) {
    storages.deuterium = round6(Math.max(0, (storages.deuterium ?? 0) - defenderBurn));
  }

  const gained = gainMaterials(lootResult.account, trophy, {
    ts: now,
    reason: 'raid_loot',
    refType: 'raid',
    refId: raidId,
    // Суффикс `trophy` различает ключи лута (хлам) и трофеев (ресурсы) одного боя:
    // без них вторая пачка была бы отброшена уникальным индексом как дубль первой.
    idempotencyKeyFor: (id) => makeIdempotencyKey('raid', `${raidId}:trophy:${id}`),
    meta: { defender: defender.id, outcome: battle.outcome, share: Math.round(share * 1e4) / 1e4 }
  });

  // Дейтерий, сожжённый автономной техникой атакующего. Это НЕ трофей и НЕ плата за
  // вход: топливо сгорает в реакторах машин независимо от исхода, поэтому списывается
  // по ФАКТУ длительности боя, а резерв на весь горизонт служил только допуском к
  // вылету (см. resolveArmy). `max(0, …)` страхует от случая, когда вызывающий слой
  // укоротил или удлинил бой переопределением потолка тиков.
  const attackerStorages: StoragePools = { ...gained.account.storages };
  const attackerBurn = battle.fuel.attackerDeuterium;
  if (attackerBurn > 0) {
    attackerStorages.deuterium = round6(Math.max(0, (attackerStorages.deuterium ?? 0) - attackerBurn));
  }

  const today = dayKey(now);
  const nextAttacksToday = attacksToday(attacker, now) + 1;
  const attackerPvp = {
    ...attacker.pvp,
    day: today,
    attacksToday: nextAttacksToday,
    battles: attacker.pvp.battles + 1,
    wins: attacker.pvp.wins + (battle.outcome === 'win' ? 1 : 0),
    draws: attacker.pvp.draws + (battle.outcome === 'draw' ? 1 : 0),
    losses: attacker.pvp.losses + (battle.outcome === 'loss' ? 1 : 0),
    rating: attackerRating,
    bestRating: Math.max(attacker.pvp.bestRating, attackerRating),
    streak: battle.outcome === 'win' ? attacker.pvp.streak + 1 : 0,
    lastRaidId: raidId,
    lastBattleAt: now
  };
  // Для защитника исход зеркальный: его победа — это поражение атакующего.
  const defenderPvp = {
    ...defender.pvp,
    battles: defender.pvp.battles + 1,
    wins: defender.pvp.wins + (battle.outcome === 'loss' ? 1 : 0),
    draws: defender.pvp.draws + (battle.outcome === 'draw' ? 1 : 0),
    losses: defender.pvp.losses + (battle.outcome === 'win' ? 1 : 0),
    rating: defenderRating,
    bestRating: Math.max(defender.pvp.bestRating, defenderRating),
    streak: battle.outcome === 'loss' ? defender.pvp.streak + 1 : 0,
    lastBattleAt: now
  };

  return {
    attacker: { ...gained.account, storages: attackerStorages, pvp: attackerPvp },
    defender: { ...ticked, storages, pvp: defenderPvp },
    drafts: [...lootResult.drafts, ...gained.drafts],
    battle,
    army,
    rating: {
      attacker: { before: attacker.pvp.rating, after: attackerRating, delta: attackerRating - attacker.pvp.rating },
      defender: { before: defender.pvp.rating, after: defenderRating, delta: defenderRating - defender.pvp.rating }
    },
    loot: lootResult.loot,
    stolen,
    energy: { before: energy.before, after: energy.after, cost: energy.cost },
    raidId,
    // Остаток считается ПОСЛЕ засчитанной атаки: витрина показывает «осталось на сегодня»,
    // а не «сколько было до нажатия кнопки».
    attacksRemaining:
      config.limits.pvp.dailyAttacks > 0
        ? Math.max(0, config.limits.pvp.dailyAttacks - nextAttacksToday)
        : -1
  };
}

/**
 * Применение итогов боя к документу защитника.
 *
 * РЕДУКТОР ПО ДЕЛЬТАМ, а не «запиши готовый аккаунт». Разница проявляется в гонке:
 * пока атакующий бился, защитник мог собрать склады, получить свой рейд или купить щит.
 * Слепая запись вернула бы былое состояние (`mined`, `pvp.rating`) и утопила его
 * изменения. Здесь же: рейтинг двигается на дельту, счётчики инкрементируются,
 * трофеи вычитаются из фактического остатка — и ничего сверх того.
 *
 * Отдельно: стены и башни защитника НЕ меняются. Бой — штурм копии (см. pvp/battle),
 * иначе каждый вход в игру начинался бы с починки лабиринта.
 */
export function applyRaidToDefender(current: UserAccount, result: RaidResult, now: Date): UserAccount {
  const storages: StoragePools = { ...current.storages };
  for (const resource of ORE_IDS) {
    const stored = storages[resource] ?? 0;
    const take = Math.min(stored, result.stolen[resource] ?? 0);
    if (take <= 0) continue;
    storages[resource] = round6(stored - take);
  }

  // Топливо тяжёлой техники защитника. Кражей оно не является и от исхода не зависит:
  // рельсотрон сжёг дейтерий ровно в той мере, в какой оборона стреляла, — выиграл
  // хозяин базы или проиграл. Списывается ПО ДЕЛЬТЕ, а не «запиши остаток из снимка»:
  // пока атакующий бился, защитник мог наполнить цистерну, и слепая запись стёрла бы
  // его приход (см. шапку функции).
  const defenderBurn = result.battle.fuel.defenderDeuterium;
  if (defenderBurn > 0) {
    storages.deuterium = round6(Math.max(0, (storages.deuterium ?? 0) - defenderBurn));
  }

  const rating = applyRating(current.pvp.rating, result.rating.defender.delta);
  const outcome = result.battle.outcome;

  return {
    ...current,
    storages,
    pvp: {
      ...current.pvp,
      battles: current.pvp.battles + 1,
      wins: current.pvp.wins + (outcome === 'loss' ? 1 : 0),
      draws: current.pvp.draws + (outcome === 'draw' ? 1 : 0),
      losses: current.pvp.losses + (outcome === 'win' ? 1 : 0),
      rating,
      bestRating: Math.max(current.pvp.bestRating, rating),
      streak: outcome === 'loss' ? current.pvp.streak + 1 : 0,
      lastBattleAt: now
    }
  };
}

export interface CommitOptions {
  store: UserStore;
  ledger: LedgerStore;
  /** Генератор id записей журнала (в проде — UUID; в тестах — детерминированный). */
  idFactory: () => string;
  /** Колбэк провала записи защитника: HTTP-слой обязан залоировать это с raidId. */
  onDefenderError?: (error: Error) => void;
}

export interface CommitResult {
  result: RaidResult;
  attacker: UserAccount;
  defender: UserAccount;
  /**
   * true — документ защитника обновлён. false — бой засчитан, а списание у защитника
   * не прошло (он удалил аккаунт, CAS-конфликт, БД моргнула).
   */
  defenderCommitted: boolean;
}

/**
 * Протокол записи рейда на два документа.
 *
 * Стор атомарен в пределах одного документа (CAS по `revision`), поэтому рейд —
 * единственная операция в проекте, где атомарности нет в принципе. Порядок выбран
 * такой: СНАЧАЛА атакующий, ЗАТЕМ защитник.
 *
 *  - Атакующий — источник истины и идемпотентности: его `pvp.lastRaidId` помнит бой,
 *    поэтому ретрай клиента не выдаст лут и рейтинг второй раз. Провал его транзакции
 *    = рейда не было вовсе (ни энергии, ни лута, ни журнала) — клиент может повторить.
 *  - Провал транзакции защитника не откатывает бой намеренно: откатить означало бы
 *    оставить игрока без результата, за который он уже заплатил энергией. Ситуация
 *    редкая (защитник удалил аккаунт или держит CAS-конфликт) и безопасная по знаку:
 *    защитник СОХРАНЯЕТ ресурсы, то есть деньги не создаются из ниоткуда — они
 *    просто не снимаются. Вызывающий слой обязан по `defenderCommitted === false`
 *    поднять алерт: это сигнал для фоновой компенсации, а не тихая потеря.
 */
export async function commitRaid(input: RaidInput, options: CommitOptions): Promise<CommitResult> {
  // Редуктор пересчитывает бой на СВЕЖЕМ состоянии: CAS-повтор в Mongo-сторе обязан
  // прийти к тому же результату (кроме случая, когда игрок успел потратить энергию —
  // тогда он ловит INSUFFICIENT_ENERGY, и рейд отменяется целиком).
  // Массив, а не переменная: TS не отслеживает присваивания внутри колбэка и в
  // переменную с union-типом «null потом заполнится» не верит.
  const captured: RaidResult[] = [];
  const attacker = await options.store.transact(input.attackerId, (current) => {
    const result = resolveRaid(current, input);
    captured.push(result);
    return result.attacker;
  });
  const result = captured[captured.length - 1];
  if (!result) throw new AppError(ErrorCodes.INTERNAL, 500, 'Резолвер рейда не вернул результата');

  const entries: LedgerEntry[] = result.drafts.map((draft) => ({ ...draft, id: options.idFactory() }));
  if (entries.length > 0) await options.ledger.appendMany(entries);

  let defenderCommitted = true;
  let defender = result.defender;
  try {
    defender = await options.store.transact(input.defender.id, (current) =>
      applyRaidToDefender(current, result, input.now)
    );
  } catch (error) {
    // Не глотаем молча: вызывающий слой видит флаг и поднимает алерт с raidId.
    defenderCommitted = false;
    options.onDefenderError?.(error instanceof Error ? error : new Error(String(error)));
  }

  return { result, attacker, defender, defenderCommitted };
}
