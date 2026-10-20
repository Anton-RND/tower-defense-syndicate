import { AppError, ErrorCodes } from '../../lib/errors.js';
import { asteriumTotal } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerEntry } from '../ledger/ledger.types.js';
import type { LedgerStore } from '../ledger/ledger.store.js';
import type { UserAccount } from '../user/user.types.js';
import type { UserStore } from '../user/user.store.js';
import {
  chargeStaniumField,
  convertAsterium as convertAsteriumPure,
  describeStaniumField,
  quoteConversion,
  type StaniumFieldView
} from './service.js';

/**
 * Протоколы записи операций с материалами (один документ — транзакция).
 *
 * В отличие от кланов (см. clan/commit.ts) здесь нет второго документа: и астерий,
 * и металлы, и срок модуля живут в аккаунте игрока. Значит, CAS по `revision`
 * закрывает вопрос атомарности целиком, и никакой двухфазной схемы не нужно.
 *
 * Порядок фиксированный: `UserStore.transact` меняет состояние и возвращает
 * черновики журнала, `LedgerStore.appendMany` пишет факты УЖЕ после успешной записи.
 * Журнал — это «журнал фактов», а не механизм блокировки двойных трат (см. шапку
 * ledger.store.ts), поэтому повтор клиента защищён здесь ДВАМИ средствами, и оба
 * обязательны:
 *  1. предпроверка `ledger.hasKey` по ключу действия — ретрай с тем же
 *     `Idempotency-Key` не должен списать второй раз то, что уже списано; без неё
 *     аккаунт изменился бы дважды, а уникальный индекс журнала отбросил бы вторую
 *     строку, оставив движение без факта (дыра в сверке и в антифроде);
 *  2. сам редуктор — списать чужой баланс он не может в принципе.
 * Честная оговорка: предпроверка не атомарна с записью (два параллельных ретрая
 * могут пройти обе), и на этом конце прикрывает CAS по `revision` — проигравший
 * транзакцию повтор уходит в редуктор заново уже с новым состоянием аккаунта.
 */

export interface MaterialsDeps {
  users: UserStore;
  ledger: LedgerStore;
  idFactory: () => string;
}

export interface MaterialRequest {
  /**
   * Ключ идемпотентности из заголовка `Idempotency-Key`. Нужен, чтобы ретрай клиента
   * по плохой сети лёгко в журнал одной строкой, а не двумя: без него повтор
   * отличается только моментом времени и выглядит как новое действие.
   */
  requestId?: string | null;
}

/** Собирает записи журнала из черновиков, снятых внутри редуктора. */
async function commitReducer<T>(
  deps: MaterialsDeps,
  userId: string,
  reducer: (current: UserAccount) => { account: UserAccount; drafts: LedgerEntry[]; meta: T }
): Promise<{ account: UserAccount; meta: T }> {
  let captured: { drafts: LedgerEntry[]; meta: T } | null = null;
  const account = await deps.users.transact(userId, (current) => {
    const result = reducer(current);
    captured = { drafts: result.drafts, meta: result.meta };
    return result.account;
  });
  const done = captured as { drafts: LedgerEntry[]; meta: T } | null;
  if (!done) throw new AppError(ErrorCodes.INTERNAL, 500, 'Материалы: редуктор не отработал ни разу', { userId });
  if (done.drafts.length > 0) await deps.ledger.appendMany(done.drafts);
  return { account, meta: done.meta };
}

function requireAccount(account: UserAccount | null, userId: string): UserAccount {
  if (!account) throw new AppError(ErrorCodes.NOT_FOUND, 404, 'Игрок не найден', { userId });
  return account;
}

/** Детерминированный ключ действия: requestId клиента либо подпись операции на сервере. */
function actionKey(prefix: string, userId: string, requestId: string | null | undefined, parts: (string | number)[]): string {
  const base = requestId && requestId.trim().length > 0 ? `${userId}:${requestId.trim()}` : `${userId}:${parts.join(':')}`;
  return `${prefix}:${base}`;
}

export interface ConvertCommitted {
  account: UserAccount;
  /** Списано астерия. */
  spent: number;
  metal: string;
  /** Начислено металла. */
  yielded: number;
  asteriumLeft: number;
  /** true — этот же `Idempotency-Key` уже отработал: состояние не менялось. */
  duplicate: boolean;
}

/**
 * Молекулярный станок: перегнать `amount` астерия в базовый металл `metal`.
 *
 * Вся проверка (курс, баланс, долг по донату) живёт в чистой функции
 * `service.convertAsterium` — здесь только обвязка хранилища.
 */
export async function convertAsterium(
  deps: MaterialsDeps,
  userId: string,
  input: { metal: string; amount: number },
  now: Date,
  request: MaterialRequest = {}
): Promise<ConvertCommitted> {
  const existing = requireAccount(await deps.users.findById(userId), userId);

  // Курс и количество валидируются ДО обращения к журналу: по ним строится ключ
  // действия, и мусор в этих полях не должен уметь попасть в чужой ключ.
  const quote = quoteConversion(input.metal, input.amount);
  const requestKey = actionKey('convert', userId, request.requestId, [quote.metal, quote.asterium, now.getTime()]);
  // Ищем по ключу ДВИЖЕНИЯ МЕТАЛЛА, а не по голому requestKey: списание астерия
  // получает суффикс кошелька (`:earned` / `:purchased`), поэтому голый ключ в журнале
  // не лежит никогда — его бы мы не нашли никогда же, и предпроверка стала бы декоративной.
  const entryKey = makeIdempotencyKey('convert', `${requestKey}:${quote.metal}`);
  if (await deps.ledger.hasKey(entryKey)) {
    return {
      account: existing,
      spent: 0,
      metal: quote.metal,
      yielded: 0,
      asteriumLeft: asteriumTotal(existing),
      duplicate: true
    };
  }

  const { account, meta } = await commitReducer(deps, userId, (current) => {
    const result = convertAsteriumPure(current, quote.metal, quote.asterium, now, { idempotencyKey: requestKey });
    return {
      account: result.account,
      drafts: result.drafts.map((draft) => ({ ...draft, id: deps.idFactory() })),
      meta: { spent: result.spent, metal: result.metal, yielded: result.yielded, asteriumLeft: result.asteriumLeft }
    };
  });

  return { account, ...meta, duplicate: false };
}

export interface StaniumChargeSummary {
  account: UserAccount;
  /** Списано станиума. */
  spent: number;
  field: StaniumFieldView;
  /** true — этот же `Idempotency-Key` уже отработал: срок модуля не продлевался повторно. */
  duplicate: boolean;
}

/** Зарядить станиумный модуль базы на `units` единиц станиума. */
export async function chargeStanium(
  deps: MaterialsDeps,
  userId: string,
  units: number,
  now: Date,
  request: MaterialRequest = {}
): Promise<StaniumChargeSummary> {
  const existing = requireAccount(await deps.users.findById(userId), userId);

  const requestKey = actionKey('stanium', userId, request.requestId, [units, now.getTime()]);
  if (await deps.ledger.hasKey(makeIdempotencyKey('stanium', requestKey))) {
    // Ретрай по тому же ключу: срок уже куплен, второй раз списывать станиум нельзя.
    return { account: existing, spent: 0, field: describeStaniumField(existing, now), duplicate: true };
  }

  const { account, meta } = await commitReducer(deps, userId, (current) => {
    const result = chargeStaniumField(current, units, now, { idempotencyKey: requestKey });
    return {
      account: result.account,
      drafts: result.drafts.map((draft) => ({ ...draft, id: deps.idFactory() })),
      meta: { spent: result.spent }
    };
  });

  return { account, spent: meta.spent, field: describeStaniumField(account, now), duplicate: false };
}
