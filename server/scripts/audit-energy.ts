/**
 * `npm run audit:energy` — обнаружение (и по флагу — возврат) переплаты энергии.
 *
 * ЗАЧЕМ. Эксплойт с курсором энергии (см. computeEnergyTick) печатал энергию скоростью
 * числа запросов, и до правки `spendEnergy` это было необнаружимо в принципе: реген —
 * функция времени, поэтому «игрок мог просто ждать» не опровергается без точки отсчёта.
 * Точки отсчёта — записи журнала по валюте `energy`, а `auditEnergy` прогоняет их от
 * рождения аккаунта и возвращает излишек над честным потолком.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ. Не восстанавливает ущерб ДО этой правки: пока рейд списывал энергию
 * мимо журнала, у переплат того периода нет опоры, кроме «стартовый бак был полон», —
 * а при таком допущении любой игрок ниже капа выглядит честным. Решение по историческому
 * ущербу: не снимать. Энергия ограничена капом, значит верхняя оценка вреда на аккаунт —
 * `energyCap` единиц, и она неатрибутируема. Скрипт — защита от повторения, а не охота
 * за ведьмами.
 *
 * УПОТРЕБЛЕНИЕ.
 *   npm run audit:energy                      — отчёт по всем игрокам (только чтение)
 *   npm run audit:energy -- <userId> ...      — разбор конкретных игроков
 *   npm run audit:energy -- --apply <userId>  — вернуть переплату списанием (reason 'admin')
 *
 * Выход: 0 — переплат нет; 1 — найдены либо применено списание.
 */
import { createConnection } from 'mongoose';

import { loadConfig } from '../src/config/env.js';
import { Logger } from '../src/lib/logger.js';
import { auditEnergy, type EnergyMovement } from '../src/modules/economy/energy.js';
import { MongoLedgerStore } from '../src/modules/ledger/ledger.mongo.js';
import { createUserModel } from '../src/modules/user/mongo.model.js';
import { MongoUserStore } from '../src/modules/user/mongo.store.js';

const config = loadConfig();
const logger = new Logger(config.logLevel);

if (config.store.driver !== 'mongo' || !config.store.mongoUri) {
  process.stdout.write(
    'Аудит энергии требует STORE_DRIVER=mongo: в памяти истории журнала нет, ' +
      'проверять нечем, а гадать «мог игрок накопить или нет» — значит выдумывать доказательства.\n'
  );
  process.exit(1);
}

const uri = config.store.mongoUri;
const users = new MongoUserStore(uri, { logger });
const ledger = new MongoLedgerStore(uri, { logger });
await users.connect();
await ledger.connect();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const targets = args.filter((arg) => arg !== '--apply');

/**
 * Движения по энергии из журнала.
 *
 * Читаются ВСЕ записи игрока, а не только «способные дать энергию» причины: стоит
 * пропустить одну легальную выдачу (ивент, подписка, будущая причина), как следующая
 * запись окажется выше ожидаемого потолка — и честный игрок получит обвинение в
 * переплате. Лишняя причина в фильтре ошибается редко; недостающая — всегда вину возводит.
 */
async function energyMovements(userId: string): Promise<EnergyMovement[]> {
  const entries = await ledger.list(userId);
  return entries
    .filter((entry) => entry.currency === 'energy')
    .map((entry) => ({ ts: entry.ts, delta: entry.delta, balanceAfter: entry.balanceAfter }));
}


async function inspect(userId: string): Promise<number> {
  const account = await users.findById(userId);
  if (!account) {
    process.stdout.write(`  ? ${userId} — аккаунт не найден\n`);
    return 0;
  }
  const movements = await energyMovements(userId);
  const now = new Date();
  const audit = auditEnergy(account, movements, now, config.economy);
  const excess = Math.floor(audit.excess);

  if (excess <= 0) {
    process.stdout.write(
      `  ok ${userId} — энергия ${account.resources.energy} в потолке ${audit.honest} (записей ${movements.length})\n`
    );
    return 0;
  }

  process.stdout.write(
    `  !! ${userId} — переплата ${excess}: на руках ${account.resources.energy}, честно ${audit.honest}` +
      ` (записей ${movements.length}, первое расхождение ${audit.firstDivergence?.toISOString() ?? '—'})\n`
  );
  if (!apply) return excess;

  // Порядок «сначала состояние, потом журнал» (шапка ledger.store.ts): движение без
  // факта запрещено. Дедауплером выступает само состояние — повторный прогон найдёт
  // излишек 0 и ничего не спишет, поэтому ключ идемпотентности здесь не нужен.
  // Пересчёт внутри редуктора обязателен: CAS-повтор приходит на свежий баланс, и
  // списывать по устаревшему избытку — значит уйти в минус там, где игрок уже потратился.
  let applied = 0;
  const next = await users.transact(userId, (current) => {
    const fresh = auditEnergy(current, movements, now, config.economy);
    const take = Math.floor(fresh.excess);
    if (take <= 0) return current;
    applied = take;
    return { ...current, resources: { ...current.resources, energy: current.resources.energy - take } };
  });
  if (applied > 0) {
    await ledger.append({
      id: `energy-audit:${userId}:${now.getTime()}`,
      userId,
      currency: 'energy',
      delta: -applied,
      balanceAfter: next.resources.energy,
      reason: 'admin',
      refType: null,
      refId: null,
      idempotencyKey: null,
      ts: now,
      meta: { audit: 'energy', honest: audit.honest, movements: movements.length }
    });
    process.stdout.write(`  → списано ${applied}, остаток ${next.resources.energy}\n`);
  }
  return applied;
}

let ids = targets;
if (ids.length === 0) {
  // Сканирование по всей базе — диагностический путь, горячим он быть не обязан.
  // Отдельное соединение только за id: сторы своих моделей наружу не отдают, и
  // доставать их через внутренности класса означало бы привязать скрипт к реализации.
  const connection = await createConnection(uri, { serverSelectionTimeoutMS: 5000 });
  const model = createUserModel(connection);
  const docs = await model.find({}, { _id: 1 }).lean().exec();
  ids = docs.map((doc) => String(doc._id));
  await connection.close();
}

process.stdout.write(`Аудит энергии: ${ids.length} аккаунтов, режим ${apply ? 'ПРИМЕНЕНИЕ' : 'только отчёт'}\n`);
let offenders = 0;
let total = 0;
for (const id of ids) {
  const excess = await inspect(id);
  if (excess > 0) {
    offenders += 1;
    total += excess;
  }
}

if (offenders === 0) {
  process.stdout.write('Переплат не найдено.\n');
} else if (apply) {
  process.stdout.write(`Возвращено переплат: ${total} единиц с ${offenders} аккаунтов.\n`);
} else {
  process.stdout.write(
    `Найдено переплат: ${total} единиц на ${offenders} аккаунтах. Повтори с --apply <userId>, чтобы вернуть.\n`
  );
}

await users.disconnect();
await ledger.disconnect();
process.exit(offenders > 0 ? 1 : 0);
