import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/http/app.js';
import { createContext } from '../src/http/context.js';
import { signVkParams, type VkParams } from '../src/modules/auth/vk.signature.js';
import { MemoryClanStore } from '../src/modules/clan/clan.store.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { MemoryCommodityStore } from '../src/modules/market/commodity.store.js';
import { MemoryLotStore } from '../src/modules/market/lot.store.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import { toSetPayload } from '../src/modules/user/mongo.model.js';
import { diffSetPayload } from '../src/modules/user/doc.diff.js';
import type { InventoryItem, UserAccount } from '../src/modules/user/user.types.js';
import { MINUTE, T0, testConfig } from './fixtures.js';

/**
 * Сколько обращений к стору стоит один HTTP-запрос (P6: узкое место синхронизации
 * экономики и резолва PvP-рейда).
 *
 * Доменные тесты (`pvp.raid.test.ts`, `user.doc-diff.test.ts`) проверяют редукторы и
 * маппинг, но ни один из них не видит ПОСЛЕДОВАТЕЛЬНОСТЬ обращений, которую собирает
 * HTTP-слой. Именно там жил главный перерасход: `POST /v1/pvp/raid` догонял ОБА
 * документа записью, затем `commitRaid` перечитывал и переписывал их же — четыре
 * полных `$set` по 17.4 КБ на один бой (замер: `npm run bench`, раздел 5). А
 * `GET /v1/economy` писал документ на каждый опрос, даже когда тик не изменил ни байта.
 *
 * Отсюда два замка, которые этот файл ставит на поведение, а не на реализацию:
 *
 *  1. холостой опрос витрины не пишет документ и не растит `revision`;
 *  2. рейд двигает документ ЗАЩИТНИКА ровно один раз — чужой документ по чужому
 *     запросу пишется только тогда, когда за него реально платят боем.
 *
 * Оба утверждения падают при возврате к старому потоку, и падают здесь, а не под
 * нагрузкой в проде.
 *
 * Часы заморожены ПОСЛЕ входа, но НЕ до него: токен выдаётся относительно `ctx.now()`,
 * и застывшие T0 сделали бы его просроченным ещё до первого запроса.
 */

const SECRET = 'amplification-secret';
const APP_ID = 777002;

const opened: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (opened.length > 0) {
    const app = opened.pop();
    if (app) await app.close();
  }
});

/** Стор, считающий обращения. Пишет только то, что реально уехало бы в Mongo. */
class CountingUserStore extends MemoryUserStore {
  reads = 0;
  writes = 0;

  override async findById(id: string): Promise<UserAccount | null> {
    this.reads += 1;
    return super.findById(id);
  }

  override async transact(id: string, reducer: (current: UserAccount) => UserAccount): Promise<UserAccount> {
    this.reads += 1;
    // Запоминаем revision ТОЧКИ ОТ СЧЁТА: драйвер растит его ПОСЛЕ возврата редуктора
    // (и только при реальном изменении состояния — sameState в doc.diff.ts), поэтому
    // сравнение «до/после» внутри редуктора всегда давало бы 0 записей.
    let base = -1;
    const result = await super.transact(id, (current) => {
      base = current.revision;
      return reducer(current);
    });
    if (result.revision !== base) this.writes += 1;
    return result;
  }
}

interface Stand {
  app: FastifyInstance;
  users: CountingUserStore;
  /** Перевести часы на `offsetMs` от момента вызова и заморозить их там. */
  freeze(offsetMs: number): void;
}

async function openStand(): Promise<Stand> {
  const config = testConfig({ VK_APP_ID: String(APP_ID), VK_SECRET_KEY: SECRET });
  const users = new CountingUserStore();
  let frozen: Date | null = null;
  const ctx = createContext(config, {
    users,
    clans: new MemoryClanStore(),
    lots: new MemoryLotStore(),
    commodities: new MemoryCommodityStore(),
    ledger: new MemoryLedgerStore(),
    now: () => frozen ?? new Date()
  });
  const app = await buildApp(ctx);
  opened.push(app);
  return {
    app,
    users,
    freeze: (offsetMs: number) => {
      frozen = new Date((frozen?.getTime() ?? Date.now()) + offsetMs);
    }
  };
}

interface Session {
  token: string;
  user: { id: string };
}

/** Вход по подписанной initData — тот же путь, что у игрока в WebView. */
async function login(app: FastifyInstance, socialId: number): Promise<Session> {
  const ts = String(Math.floor(Date.now() / 1000));
  const params: VkParams = {
    allow_preview: '0',
    is_app_user: '1',
    language: 'ru',
    platform: 'vk',
    platform_type: 'mobile_web',
    realm: 'vk.com',
    session_hash: `hash-${socialId}`,
    sign_version: '2',
    ts,
    vk_app_id: String(APP_ID),
    viewer_id: String(socialId)
  };
  const initData = signVkParams(params, { appId: APP_ID, secretKey: SECRET }).initData;
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/vk/init-data',
    payload: { initData },
    remoteAddress: '10.0.0.1'
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as Session;
}

/**
 * Запрос с сессией. Ветки GET/POST разведены явно, а не через условный spread:
 * `...(cond ? {} : { payload })` ломает вывод перегрузок `app.inject` и TS возвращает
 * из него `void & Promise<Response> & Chain` вместо ответа — сборка падала бы на
 * `statusCode`, а не на логике теста.
 */
function call(app: FastifyInstance, method: 'GET' | 'POST', url: string, token: string, payload?: unknown) {
  const headers = { authorization: `Bearer ${token}` };
  return method === 'GET'
    ? app.inject({ method: 'GET', url, headers, remoteAddress: '10.0.0.1' })
    : app.inject({ method: 'POST', url, headers, payload: payload as object, remoteAddress: '10.0.0.1' });
}

/** Выдать атакующему армию и энергию: стартовый комплект дрона не содержит (config/starter.ts). */
async function armAttacker(users: CountingUserStore, id: string, count = 3): Promise<string[]> {
  const account = await users.findById(id);
  if (!account) throw new Error('фикстура: атакующий не найден');
  const drones: InventoryItem[] = Array.from({ length: count }, (_, i) => ({
    id: `item-drone-${i}`,
    kind: 'drone' as const,
    code: 'drone_strike_mk2',
    level: 1,
    acquiredAt: T0,
    source: 'build' as const,
    orderId: null
  }));
  await users.save({
    ...account,
    inventory: [...account.inventory, ...drones],
    resources: { ...account.resources, energy: 100 },
    storages: { ...account.storages, deuterium: 100_000 }
  });
  return drones.map((drone) => drone.id);
}

/**
 * Завести игроку добычу. Без ставок тик не начисляет ни байта, и проверка «холостой
 * повтор не пишет» стала бы вакуумной: она зелёна и тогда, когда пишет каждый запрос.
 */
async function seedMining(users: CountingUserStore, id: string): Promise<void> {
  const account = await users.findById(id);
  if (!account) throw new Error(`фикстура: игрок ${id} не найден`);
  await users.save({
    ...account,
    structures: { ...account.structures, bore_ore_mk1: 4 },
    // Ставку задаём явно: вывод `miningRates` из сооружений — деталь тика, а не
    // условие этого теста.
    miningRates: { ...account.miningRates, ferrum: (account.miningRates.ferrum ?? 0) + 120 },
    storages: { ...account.storages, ferrum: 1_000 },
    resources: { ...account.resources, energy: 1 }
  });
}

describe('http/amplification: обращений к стору на запрос', () => {
  it('GET /v1/economy: такт с добычей пишет документ, повтор того же такта — нет', async () => {
    const { app, users, freeze } = await openStand();
    const session = await login(app, 90010001);
    await seedMining(users, session.user.id);
    freeze(5 * MINUTE);

    const first = await call(app, 'GET', '/v1/economy', session.token);
    expect(first.statusCode, first.body).toBe(200);
    // Тик обязан был начислить: без этого второй шаг тривиален.
    expect(users.writes).toBe(1);
    const revisionAfterTick = (await users.findById(session.user.id))?.revision;

    // Повтор того же такта: состояние не изменилось → ни записи, ни роста revision.
    const snapBefore = await users.findById(session.user.id);
    const second = await call(app, 'GET', '/v1/economy', session.token);
    expect(second.statusCode, second.body).toBe(200);
    const snapAfter = await users.findById(session.user.id);
    if (!snapBefore || !snapAfter) throw new Error('фикстура: игрок исчез');
    // Холостый повтор: состояние идентично, документ не переписан, revision стоит.
    expect(diffSetPayload(toSetPayload(snapBefore), toSetPayload(snapAfter))).toEqual({});
    expect(users.writes).toBe(1);
    expect(snapAfter.revision).toBe(revisionAfterTick);
  });

  it('POST /v1/pvp/raid: документ защитника двигается ровно один раз', async () => {
    const { app, users, freeze } = await openStand();
    const attacker = await login(app, 90020001);
    const defender = await login(app, 90020002);
    const armyItemIds = await armAttacker(users, attacker.user.id);
    await seedMining(users, defender.user.id);
    freeze(5 * MINUTE);

    const before = await users.findById(defender.user.id);
    if (!before) throw new Error('фикстура: защитник не найден');
    users.reads = 0;
    users.writes = 0;

    const response = await call(app, 'POST', '/v1/pvp/raid', attacker.token, {
      defenderId: defender.user.id,
      armyItemIds
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { result?: { battle?: { outcome?: string }; defenderCommitted?: boolean } };
    expect(body.result?.battle?.outcome).toBeDefined();
    expect(body.result?.defenderCommitted).toBe(true);

    // Ровно одна запись защитника за бой: его догон — чтение, а пишет только
    // `commitRaid`. Две записи означают, что пре-фрайт вернулся (см. pvpRoutes.ts).
    // Снимаем счётчики ДО собственного чтения: `findById` в ассертах — это тоже
    // обращение к стору, и оно иначе попало бы в замер маршрута.
    const routeReads = users.reads;
    const routeWrites = users.writes;
    const after = await users.findById(defender.user.id);
    expect((after?.revision ?? 0) - before.revision).toBe(1);
    // Потолок обращений: 4 чтения и 3 записи. Старый поток давал 5 и 4 именно за счёт
    // записи чужого документа до боя.
    expect(routeWrites).toBeLessThanOrEqual(3);
    expect(routeReads).toBeLessThanOrEqual(4);
  });
});
