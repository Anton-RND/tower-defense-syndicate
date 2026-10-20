import { STARTER_KIT } from '../../config/starter.js';
import type { MaterialCost } from '../../config/workshop.js';
import { gainMaterials } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { UserAccount } from './user.types.js';

/**
 * Выдача стартового комплекта (config/starter.ts).
 *
 * ЧИСТАЯ ФУНКЦИЯ, как и весь домен: аккаунт на входе, аккаунт и черновики журнала
 * на выходе, никакого I/O. Вызывается ровно один раз — в момент рождения
 * документа (http/routes/authRoutes.ts), поэтому повторный вход комплекта не
 * дублирует: `getOrCreate` создаёт аккаунт, только когда его не было.
 *
 * ПОЧЕМУ ЧЕРЕЗ `gainMaterials`, А НЕ ПРАВКОЙ ПОЛЕЙ. `createAccount` возвращает
 * голый объект, и можно было бы дописать ему ресурсы литералом. Тогда стартовый
 * комплект стал бы единственным приходом ценностей в игре БЕЗ записи в журнал —
 * ровно тот класс дыр, из-за которых вопрос «откуда у игрока 10 000» перестаёт
 * отвечаться одним запросом (шапка economy/wallet.ts). Здесь комплект виден в
 * журнале под причиной `starter` и отличается от админского `admin` гранта.
 *
 * КЛЮЧ ИДЕМПОТЕНТНОСТИ привязан к игроку и материалу: `starter:<userId>:<id>`.
 * Валюта в ключе обязательна (инвариант 1 в ledger.types.ts) — бой из нескольких
 * материалов пишет несколько записей, и без суффикса вторая отбролась бы
 * уникальным индексом как дубль первой.
 */
export interface StarterOutcome {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Что реально начислено (после нормализации таблицы комплекта). */
  granted: MaterialCost;
}

export function applyStarterKit(account: UserAccount, now: Date): StarterOutcome {
  const gained = gainMaterials(account, STARTER_KIT, {
    ts: now,
    reason: 'starter',
    refType: null,
    refId: null,
    idempotencyKeyFor: (id) => makeIdempotencyKey('starter', `${account.id}:${id}`),
    meta: { source: 'starter_kit' }
  });
  return { account: gained.account, drafts: gained.drafts, granted: gained.moved };
}
