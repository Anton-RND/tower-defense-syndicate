import type { Platform } from '../../config/env.js';
import type { SocialIdentity } from '../auth/vk.adapter.js';
import type { UserAccount } from './user.types.js';

/**
 * Фильтр подбора соперника (Шаг 4). Границы коридора — включительные:
 * «±band» читается именно так, и округление вниз/вверх делает вызывающий слой.
 */
export interface OpponentFilter {
  /** Пулы VK и TG не смешиваются: разные id, разные правила площадок. */
  platform: Platform;
  /** Сам атакующий себе соперником не приходится. */
  excludeUserId: string;
  ratingMin: number;
  ratingMax: number;
  /** Потолок выборки: матчмейкинг проверяет несколько первых, а не весь коридор. */
  limit: number;
}

/**
 * Кандидат в соперники — проекция, а не аккаунт.
 *
 * Тянуть полные документы всех игроков коридора нельзя: документ игрока после
 * Шага 3 содержит инвентарь, планировку на 120 стен и историю привилегий. `walls`
 * и `units` нужны только для приоритетной выборки (пустые базы в приоритете не
 * состоят), полную базу победителя стор дочитывает отдельно — одним `findById`.
 */
export interface MatchCandidate {
  userId: string;
  rating: number;
  walls: number;
  units: number;
  /** Версия планировки: по ней фронт понимает, что база показана не «из кэша вчера». */
  baseVersion: number;
}

/**
 * Абстракция хранилища игроков. Два драйвера (memory / mongo) дают одинаковый контракт,
 * поэтому вся игровая математика живёт в чистых функциях modules/economy и не дублируется.
 *
 * Атомарность:
 *  - memory: критическая секция синхронна (Node — один поток), конфликтов нет по построению;
 *  - mongo: CAS по полю `revision` (оптимистичная блокировка) с повтором до N раз.
 * Для Шага 4 (PvP-рейды) и Шага 6 (нагрузка) планово заменяем на транзакции/Redis-lock.
 */
export interface UserStore {
  readonly driver: 'memory' | 'mongo';

  connect(): Promise<void>;
  disconnect(): Promise<void>;

  findById(id: string): Promise<UserAccount | null>;
  findBySocial(platform: Platform, socialId: string): Promise<UserAccount | null>;

  /**
     * Находит аккаунт по связке (platform, socialId) или создаёт новый.
     */
  getOrCreate(
    identity: Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>,
    now: Date,
    build: (identity: Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>, now: Date) => UserAccount
  ): Promise<{ account: UserAccount; created: boolean }>;

  /**
   * Атомарно применяет редуктор состояния. Если редуктор бросает исключение —
   * запись не меняется (транзакционная семантика «всё или ничего»).
   */
  transact(id: string, reducer: (current: UserAccount) => UserAccount): Promise<UserAccount>;

  /** Прямая запись нового состояния (используется сидированием тестов/дева). */
  save(account: UserAccount): Promise<UserAccount>;

  /**
   * Кандидаты в соперники внутри коридора рейтинга (Шаг 4).
   *
   * Метод абстракции стора, а не «магия Mongo»: memory-драйвер ровно так же сканирует
   * свою Map и сортирует по близости к середине коридора. Разные контракты драйверов
   * означали бы, что матчмейкинг по-разному ведёт себя в тестах и в проде, — а это
   * именно тот код, который обязан быть предсказуемым для игроков одного пула.
   */
  findOpponents(filter: OpponentFilter): Promise<MatchCandidate[]>;
}

export class ConcurrentUpdateError extends Error {
  constructor(readonly userId: string, readonly attempts: number) {
    super(`Не удалось обновить игрока ${userId}: конфликт версий после ${attempts} попыток`);
    this.name = 'ConcurrentUpdateError';
  }
}

export const MAX_TRANSACT_ATTEMPTS = 5;
