import type { FastifyRequest } from 'fastify';

import type { AppConfig, EconomyConfig } from '../config/env.js';
import { internal, notFound, validationError } from '../lib/errors.js';
import { describeEconomy, describeUser, type EconomyView, type PublicUser } from '../modules/economy/view.js';
import { applyEconomyTick } from '../modules/economy/tick.js';
import type { LedgerDraft } from '../modules/ledger/ledger.types.js';
import { voidExpiredOrders } from '../modules/payment/orders.js';
import type { UserAccount } from '../modules/user/user.types.js';
import { settleBuilds } from '../modules/workshop/craft.js';
import type { AppContext } from './context.js';

/**
 * Общие строительные блоки HTTP-слоя.
 *
 * Два инварианта проекта повторяются в каждом маршруте, и каждый раз вручную их
 * легко потерять:
 *  1. состояние игрока сначала ДОГОНЯЕТСЯ до `now` (тик майнинга/энергии, выдача
 *     дозревших построек, аннулирование сгоревших заказов), и только потом
 *     применяется действие запроса;
 *  2. порядок фиксации: `UserStore.transact` меняет аккаунт → `LedgerStore.appendMany`
 *     пишет факты (см. шапку ledger.store.ts).
 *
 * `accountAction` закрывает оба: редуктор транзакции получает уже синхронизированный
 * аккаунт, а черновики журнала пишутся только после успешной записи. При CAS-повторе
 * редуктор вызывается заново на свежем состоянии — сохраняется последний черновик,
 * поэтому двойного списания не возникает.
 */

export interface ActionOut<T> {
  account: UserAccount;
  meta: T;
}

/**
 * Догоняющее состояние: тик экономики → выдача построек → чистка заказов.
 *
 * Черновики журнала догона едут вместе с аккаунтом: догон уже умеет печатать деньги
 * (SEC с ASIC), и потерять их здесь означало бы кошелёк без аудиторского следа.
 */
export interface SyncState {
  account: UserAccount;
  drafts: LedgerDraft[];
}

export function syncState(
  account: UserAccount,
  now: Date,
  config: EconomyConfig,
  idFactory: () => string
): SyncState {
  const ticked = applyEconomyTick(account, now, config);
  const settled = settleBuilds(ticked.account, now, idFactory).account;
  return { account: voidExpiredOrders(settled, now).account, drafts: ticked.drafts };
}

/**
 * Применяет действие к синхронизированному аккаунту внутри одной транзакции и
 * пишет движения журнала после успеха.
 */
export async function accountAction<T>(
  ctx: AppContext,
  userId: string,
  now: Date,
  action: (synced: UserAccount) => { account: UserAccount; drafts?: LedgerDraft[]; meta: T }
): Promise<ActionOut<T>> {
  // Массив, а не переменная: TS не верит присваиваниям внутри колбэка (тот же приём,
  // что в materials/commit.ts и payment/commit.ts).
  const captured: Array<{ drafts: LedgerDraft[]; meta: T }> = [];
  const account = await ctx.users.transact(userId, (current) => {
    const sync = syncState(current, now, ctx.config.economy, ctx.idFactory);
    const result = action(sync.account);
    // Черновик догона идёт ПЕРВЫМ: если действие запроса тоже двигает SEC, порядок
    // в журнале обязан совпадать с порядком в реальности — иначе «сначала начислили,
    // потом потратили» прочитается наоборот.
    captured.push({ drafts: [...sync.drafts, ...(result.drafts ?? [])], meta: result.meta });
    return result.account;
  });
  const done = captured[captured.length - 1];
  if (!done) throw internal(`Действие игрока ${userId} не отработало ни разу`);
  if (done.drafts.length > 0) {
    const written = await ctx.ledger.appendMany(done.drafts.map((draft) => ({ ...draft, id: ctx.idFactory() })));
    if (written < done.drafts.length) {
      // Деньги УЖЕ ушли: транзакция аккаунта закоммичена, откатывать задним числом
      // поздно. Но и молчать нельзя: пропуск записи по дубликату ключа — это дыра в
      // аудите, где «списали дважды» неотличимо от «списали раз». Единственная честная
      // реакция — громкий след, по которому операцию можно разобрать вручную.
      ctx.logger.warn('ledger_drafts_dropped', {
        userId,
        attempted: done.drafts.length,
        written,
        keys: done.drafts.map((draft) => draft.idempotencyKey ?? null)
      });
    }
  }
  return { account, meta: done.meta };
}

export interface View {
  user: PublicUser;
  economy: EconomyView;
}

/** Единый снимок для ответа: наружу уходит только витрина, никогда не аккаунт. */
export function viewOf(config: AppConfig, account: UserAccount, now: Date): View {
  return { user: describeUser(account, now, config), economy: describeEconomy(account, now, config) };
}

/** Ответ «действие сделано»: обновлённая витрина + что именно изменилось. */
export function resultOf<T>(
  config: AppConfig,
  account: UserAccount,
  now: Date,
  result: T
): View & { result: T } {
  return { ...viewOf(config, account, now), result };
}

// ─── Разбор тела запроса ────────────────────────────────────────────────────────

export function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const body = request.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

function toNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim().length > 0) return Number(raw);
  return Number.NaN;
}

/** Обязательное целое с границами. Приходит из HTTP → доверять нельзя. */
export function intOf(
  body: Record<string, unknown>,
  field: string,
  bounds: { min?: number; max?: number } = {}
): number {
  const value = toNumber(body[field]);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw validationError(`Поле «${field}» должно быть целым числом`, { field });
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw validationError(`Поле «${field}» не может быть меньше ${bounds.min}`, { field, min: bounds.min });
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw validationError(`Поле «${field}» не может быть больше ${bounds.max}`, { field, max: bounds.max });
  }
  return value;
}

export function optionalIntOf(
  body: Record<string, unknown>,
  field: string,
  bounds: { min?: number; max?: number } = {}
): number | undefined {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return undefined;
  return intOf(body, field, bounds);
}

export function stringOf(body: Record<string, unknown>, field: string, maxLength = 128): string {
  const raw = body[field];
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw validationError(`Поле «${field}» обязательно`, { field });
  }
  const value = raw.trim();
  if (value.length > maxLength) {
    throw validationError(`Поле «${field}» длиннее ${maxLength} символов`, { field });
  }
  return value;
}

export function optionalStringOf(
  body: Record<string, unknown>,
  field: string,
  maxLength = 128
): string | null {
  const raw = body[field];
  if (raw === undefined || raw === null || raw === '') return null;
  return stringOf(body, field, maxLength);
}

/** Массив строковых id (армия, клетки). Пустой массив — осознанный «снять всё». */
export function stringArrayOf(body: Record<string, unknown>, field: string, limit = 500): string[] {
  const raw = body[field];
  if (!Array.isArray(raw)) {
    throw validationError(`Поле «${field}» должно быть массивом`, { field });
  }
  if (raw.length > limit) {
    throw validationError(`Поле «${field}» длиннее ${limit} элементов`, { field, limit });
  }
  return raw.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw validationError(`Поле «${field}[${index}]» должно быть непустой строкой`, { field, index });
    }
    return item.trim();
  });
}

export function queryInt(
  request: FastifyRequest,
  field: string,
  bounds: { min?: number; max?: number; fallback?: number } = {}
): number {
  const query = request.query as Record<string, unknown>;
  if (query[field] === undefined || query[field] === '') {
    if (bounds.fallback !== undefined) return bounds.fallback;
    throw validationError(`Параметр «${field}» обязателен`, { field });
  }
  return intOf(query, field, bounds);
}

/**
 * Ключ идемпотентности запроса. Обязательным он не является: без него повтор всё
 * равно гасится состоянием аккаунта (заказ, pending-сессия, CAS), но журнал теряет
 * связь «запрос → движение», а игрок видит ошибку вместо тихого déjà vu.
 */
export function idempotencyKeyOf(request: FastifyRequest): string | null {
  const raw = request.headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

