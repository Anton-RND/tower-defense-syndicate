/**
 * Бенчмарк горячего пути (экономика + PvP-рейд).
 *
 * Зачем существует: «узкое место» в ТЗ про нас написано как допущение, а допущения
 * правят только замерами. Скрипт измеряет четыре вещи, из которых складывается
 * стоимость одного HTTP-запроса на сервере-авторитете:
 *
 *  1. чистый CPU догона экономики (`syncState`);
 *  2. стоимость оборота документа (клон → редуктор → `$set`-пейлоад) и его вес в байтах;
 *  3. стоимость боя (`resolveRaid` с разбивкой по этапам);
 *  4. как пункты 1–3 ложатся на event loop: какой лаг ловят СОСЕДИ по процессу,
 *     пока один игрок дерётся.
 *
 * Плюс счётчик обращений к стору на один запрос: read/write amplification видно только
 * в цифрах, а не в комментариях.
 *
 * Запуск: `npm run bench` из каталога server (tsx, без сборки).
 */
import { performance } from 'node:perf_hooks';

import { loadConfig } from '../src/config/env.js';
import {
  DEFAULT_HQ,
  GRID_HEIGHT,
  GRID_WIDTH,
  MAX_WALLS,
  MIN_PATH_TILES,
  SPAWN_CELLS,
  type Cell
} from '../src/config/base.js';
import { DEFAULT_SPEC, NEIGHBOR_OFFSETS, analyzeLayout, inBounds } from '../src/modules/pvp/grid.js';
import { applyEconomyTick } from '../src/modules/economy/tick.js';
import { settleBuilds } from '../src/modules/workshop/craft.js';
import { voidExpiredOrders } from '../src/modules/payment/orders.js';
import { describeBase, saveLayout } from '../src/modules/pvp/defense.js';
import { resolveRaid, makeRaidId, commitRaid } from '../src/modules/pvp/raid.js';
import { simulateBattle, resolveArmy } from '../src/modules/pvp/battle.js';
import { MemoryUserStore } from '../src/modules/user/memory.store.js';
import { MemoryLedgerStore } from '../src/modules/ledger/ledger.memory.js';
import { cloneAccount, createAccount, type InventoryItem, type UserAccount } from '../src/modules/user/user.types.js';
import { toAccount, toSetPayload } from '../src/modules/user/mongo.model.js';
import { diffSetPayload, sameState } from '../src/modules/user/doc.diff.js';
import { syncState } from '../src/http/helpers.js';
import type { AppConfig } from '../src/config/env.js';

const T0 = new Date('2026-10-18T00:00:00.000Z');
const HOUR = 3_600_000;

const config: AppConfig = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

let seq = 0;
// Префикс НЕОБЯЗАТЕЛЕН: half of the production reducers take `idFactory: () => string`
// (settleBuilds, syncState, commitRaid), и функция с обязательным аргументом под этот
// тип не подходит.
const nextId = (prefix: string = 'id'): string => `${prefix}-${(seq += 1)}`;

function item(cfg: AppConfig, code: string, level = 1): InventoryItem {
  return {
    id: nextId('item'),
    kind: code.startsWith('tower') ? 'tower' : code.startsWith('drone') ? 'drone' : 'weapon',
    code,
    level,
    acquiredAt: T0,
    source: 'build',
    orderId: null
  };
}

/**
 * База «среднего» игрока: под потолок стен (120) и максимальный депплой башен (24).
 *
 * Планировка СТРОИТСЯ жадно, а не рисуется руками, и вот почему: первая же ручная
 * змейка запечатала нижние ворота рядом стоящей стеной (y=14), валидатор вернул
 * `no_path`, и бенчмарк мерил бы отказ рейда вместо боя. Жадный проход с проверкой
 * производственным `analyzeLayout` даёт ту же гарантию, что и редактор игрока:
 * все восемь ворот достают до штаба, «сирот» нет, маршрут не короче порога.
 *
 * Порядок клеток фиксирован семенем ГПСЧ: прогон обязан повторяться байт в байт,
 * иначе сравнение «до оптимизации / после» теряет смысл.
 */
const cellKey = (cell: Cell): string => `${cell.x},${cell.y}`;

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** Проходима ли планировка по всем трём критериям, что важны для замера боя. */
function passable(blocked: readonly Cell[], hq: Cell): boolean {
  const analysis = analyzeLayout({ spawns: SPAWN_CELLS, hq, blocked });
  return analysis.ok && analysis.orphans === 0 && analysis.pathTiles >= MIN_PATH_TILES;
}

interface Maze {
  walls: Cell[];
  towers: Cell[];
  pathTiles: number;
}

function buildMaze(hq: Cell, towerCount: number, seed = 20261018): Maze {
  const rnd = lcg(seed);
  const reserved = new Set<string>([cellKey(hq), ...SPAWN_CELLS.map(cellKey)]);

  const cells: Cell[] = [];
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!reserved.has(cellKey({ x, y }))) cells.push({ x, y });
    }
  }
  for (let i = cells.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    const swap = cells[i]!;
    cells[i] = cells[j]!;
    cells[j] = swap;
  }

  const walls: Cell[] = [];
  for (const cell of cells) {
    if (walls.length >= MAX_WALLS) break;
    walls.push(cell);
    if (!passable(walls, hq)) walls.pop();
  }

  // Башни — вдоль худшего подхода, а не в случайных тупиках: замер обязан захватывать
  // реальные залпы, иначе `simulateBattle` покажет дешёвые холостые тики.
  const worstPath = analyzeLayout({ spawns: SPAWN_CELLS, hq, blocked: walls }).path ?? [];
  const taken = new Set<string>([...walls.map(cellKey), ...reserved]);
  const spots: Cell[] = [];
  const claim = (cell: Cell): void => {
    const key = cellKey(cell);
    if (taken.has(key) || !inBounds(DEFAULT_SPEC, cell)) return;
    taken.add(key);
    spots.push(cell);
  };
  for (const cell of worstPath) {
    for (const { dx, dy } of NEIGHBOR_OFFSETS) claim({ x: cell.x + dx, y: cell.y + dy });
  }
  for (const cell of cells) claim(cell); // добиваем, если коридор уже towerCount

  const towers: Cell[] = [];
  for (const cell of spots) {
    if (towers.length >= towerCount) break;
    if (passable([...walls, ...towers, cell], hq)) towers.push(cell);
  }

  return { walls, towers, pathTiles: analyzeLayout({ spawns: SPAWN_CELLS, hq, blocked: [...walls, ...towers] }).pathTiles };
}

const TOWER_CODES = ['tower_laser_mk1', 'tower_rail_mk2', 'tower_plasma_mk3'];

function buildPlayer(cfg: AppConfig, socialId: string, opts: { towers: number; drones: number; shield: boolean }): UserAccount {
  const base = createAccount({ platform: 'vk', socialId, appId: null, groupId: null }, T0, cfg.economy, () =>
    nextId('user')
  );
  const towers = Array.from({ length: opts.towers }, (_, i) => item(cfg, TOWER_CODES[i % TOWER_CODES.length]!, 3));
  const drones = Array.from({ length: opts.drones }, (_, i) => item(cfg, i % 3 === 0 ? 'drone_cerberus_mk3' : 'drone_strike_mk2', 3));
  const junkItems = Array.from({ length: 20 }, () => item(cfg, 'weapon_cannon_mk1', 1));

  const structures = { ...base.structures };
  structures.bore_ore_mk1 = 6;
  structures.bore_ore_mk2 = 4;
  structures.reactor_plasma_mk1 = 4;
  structures.reactor_plasma_mk2 = 2;
  structures.cooler_loop_mk1 = 3;
  structures.nitro_plant_mk1 = 2;
  structures.centrifuge_mk1 = 2;
  structures.asic_rack_mk1 = 3;
  structures.silo_mk1 = 4;
  structures.gasometer_mk1 = 2;
  structures.cryo_tank_mk1 = 2;

  const rich: UserAccount = {
    ...base,
    resources: { ...base.resources, energy: 100, ferrum: 5_000_000, silicium: 5_000_000, uranium: 500_000, plasma: 500_000, sec: 100_000 },
    metals: { black_metal: 500_000, colored_metal: 500_000, precious_metal: 500_000 },
    // Склады полные: тяжёлый дрон без дейтерия не вылетает (`resolveArmy` ставит его на
    // землю), и бенчмарк мерил бы половину армии, занизив и `simulateBattle`, и рейд.
    storages: {
      ...base.storages,
      ferrum: 400_000,
      silicium: 400_000,
      uranium: 120_000,
      plasma: 120_000,
      deuterium: 200_000,
      nitrogen: 120_000
    },
    structures,
    inventory: [...towers, ...drones, ...junkItems],
    // Щит — только атакующему. Защитник под «Щитом покоя» отсеивается `assertAttackable`
    // на самой первой проверке, и вместо замера боя бенчмарк показал бы 403.
    entitlements: [
      { id: nextId('ent'), sku: 'warehouse_x2_7d', kind: 'warehouse_boost', value: 2, permanent: false, expiresAt: new Date(T0.getTime() + 24 * HOUR), source: 'purchase', grantedAt: T0, orderId: null },
      { id: nextId('ent'), sku: 'energy_boost_2x', kind: 'energy_boost', value: 2, permanent: false, expiresAt: new Date(T0.getTime() + 6 * HOUR), source: 'ad_reward', grantedAt: T0, orderId: null },
      ...(opts.shield
        ? [{ id: nextId('ent'), sku: 'shield_1h', kind: 'shield' as const, value: 1, permanent: false, expiresAt: new Date(T0.getTime() + HOUR), source: 'event' as const, grantedAt: T0, orderId: null }]
        : [])
    ],
    orders: Array.from({ length: 10 }, (_, i) => ({
      id: `order:${base.id}:${i}`,
      sku: `pack_${i % 4}`,
      amount: 100 + i,
      priceRub: 99 + i,
      status: 'fulfilled' as const,
      createdAt: T0,
      expiresAt: new Date(T0.getTime() + HOUR),
      paidAt: T0,
      fulfilledAt: T0,
      refundedAt: null,
      providerOrderId: `vk-${i}`,
      note: null
    })),
    assist: { day: '2026-10-18', count: 3, helpers: Array.from({ length: 12 }, (_, i) => `friend-${i}`) },
    revision: 1234
  };

  const maze = buildMaze(DEFAULT_HQ, opts.towers);
  const placements = towers.slice(0, maze.towers.length).map((tower, i) => ({
    itemId: tower.id,
    ...maze.towers[i]!
  }));
  const saved = saveLayout(rich, { walls: maze.walls, units: placements, hq: DEFAULT_HQ }, T0).account;
  if (maze.towers.length < opts.towers) {
    console.warn(`предупреждение: башен размещено ${maze.towers.length} из ${opts.towers} — лабиринт тесен`);
  }
  return { ...saved, lastLootTime: new Date(T0.getTime() - 8 * HOUR), energyUpdatedAt: new Date(T0.getTime() - 40 * 60_000) };
}


/**
 * Максимальный по бюджету отряд — подбирает сам резолвер, а не константа в скрипте.
 *
 * `ATTACK_MAX_ROBOTS` считается по роботам склада (`profile.squad`), а не по числу
 * предметов: 24 дрона — это 50 роботов, и рейд на них отваливается с ARMY_INVALID,
 * после чего замер показывает отказ вместо боя. Перебор префиксов инвентаря через
 * production-`resolveArmy` честнее хардкода «48 / 2»: баланс складов изменится —
 * бенчмарк подстроится сам.
 */
function pickArmy(attacker: UserAccount): string[] {
  const ids: string[] = [];
  for (const entry of attacker.inventory) {
    if (!entry.code.startsWith('drone')) continue;
    try {
      resolveArmy(attacker, [...ids, entry.id]);
      ids.push(entry.id);
    } catch {
      // Бюджет армии исчерпан этим предметом — пробуем следующий (он может быть мельче).
    }
  }
  return ids;
}


// ─── Измерительный стенд ──────────────────────────────────────────────────────

interface Stats {
  avg: number;
  p50: number;
  p99: number;
  min: number;
  max: number;
}

function bench(iterations: number, fn: (i: number) => unknown): Stats {
  // Прогрев: первые итерации компилируются JIT, и мерить их — значит мерить компилятор.
  const warm = Math.min(200, Math.max(10, Math.floor(iterations / 10)));
  for (let i = 0; i < warm; i += 1) fn(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    fn(i);
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const sum = samples.reduce((acc, value) => acc + value, 0);
  return {
    avg: sum / samples.length,
    p50: samples[Math.floor(samples.length * 0.5)] as number,
    p99: samples[Math.floor(samples.length * 0.99)] as number,
    min: samples[0] as number,
    max: samples[samples.length - 1] as number
  };
}

/** Печатает строку и возвращает статистику: сводка в конце обязана собираться из тех же замеров, а не из новых. */
function report(label: string, stats: Stats, iterations: number): Stats {
  const rps = stats.avg > 0 ? 1000 / stats.avg : Number.POSITIVE_INFINITY;
  console.log(
    `  ${label.padEnd(34)} avg ${stats.avg.toFixed(3).padStart(8)} мс   p50 ${stats.p50.toFixed(3).padStart(8)}   ` +
      `p99 ${stats.p99.toFixed(3).padStart(8)}   max ${stats.max.toFixed(2).padStart(7)}   ~${Math.round(rps)} ops/s` +
      `   (n=${iterations})`
  );
  return stats;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} КБ`;
}

/** Счётчик обращений к стору: read/write amplification видно только в цифрах. */
class CountingStore extends MemoryUserStore {
  reads = 0;
  writes = 0;

  override async findById(id: string): Promise<UserAccount | null> {
    this.reads += 1;
    return super.findById(id);
  }

  override async transact(id: string, reducer: (current: UserAccount) => UserAccount): Promise<UserAccount> {
    this.reads += 1;
    return super.transact(id, (current) => {
      const next = reducer(current);
      // Счётчик обязан мерить то, что уехало бы в Mongo. Холостой редуктор драйвер
      // отбрасывает целиком — и запись, и рост revision (см. sameState в doc.diff.ts).
      if (!sameState(current, next)) this.writes += 1;
      return next;
    });
  }
}

function lagProbe(intervalMs: number): { stop: () => { maxDriftMs: number; meanDriftMs: number } } {
  let last = performance.now();
  let max = 0;
  let sum = 0;
  let count = 0;
  const timer = setInterval(() => {
    const current = performance.now();
    const drift = current - last - intervalMs;
    last = current;
    count += 1;
    if (drift > max) max = drift;
    sum += Math.max(0, drift);
  }, intervalMs);
  return {
    stop: () => {
      clearInterval(timer);
      return { maxDriftMs: max, meanDriftMs: sum / Math.max(1, count) };
    }
  };
}

// ─── Основной прогон ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n=== Бенчмарк горячего пути TDS (NODE_ENV=test, один поток) ===\n');

  const defender = buildPlayer(config, 'bench-defender', { towers: 24, drones: 24, shield: false });
  const attacker = buildPlayer(config, 'bench-attacker', { towers: 24, drones: 24, shield: true });
  const droneIds = pickArmy(attacker);

  const baseReport = describeBase(defender);
  console.log(`База защитника: стен ${baseReport.walls}, башен ${baseReport.units}, ready=${baseReport.ready}`);
  console.log(`  нарушения ${JSON.stringify(baseReport.analysis.violations)}, предупреждения ${JSON.stringify(baseReport.analysis.warnings)}, путь от худших ворот ${baseReport.analysis.pathTiles} кл.`);
  if (!baseReport.ready) {
    console.error('\nБЕНЧМАРК НЕКОРРЕКТЕН: фиксированная база непроходима — правьте buildMaze().\n');
    process.exitCode = 1;
    return;
  }

  console.log('\n1. Вес документа игрока (уходит по сети на каждой записи)');
  const payload = toSetPayload(attacker);
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, 'utf8');
  console.log(`  toSetPayload → ${kb(bytes)}; инвентарь ${attacker.inventory.length}, стены ${attacker.base.walls.length}, ордера ${attacker.orders.length}`);
  // Разбивка по полям: дельта-запись оправдана ровно настолько, насколько поле тяжёлое
  // и насколько часто его трогает редуктор. Без этой таблицы оптимизация — догадка.
  const weights = (Object.keys(payload) as Array<keyof typeof payload>)
    .map((field) => ({ field: String(field), bytes: Buffer.byteLength(JSON.stringify(payload[field]), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes);
  console.log(`  тяжёлые поля: ${weights.slice(0, 6).map((w) => `${w.field} ${kb(w.bytes)}`).join(', ')}`);
  const untouchedByEconomy = weights
    .filter((w) => !['resources', 'storages', 'miningRates', 'structures', 'energyUpdatedAt', 'lastLootTime', 'junk', 'metals'].includes(w.field))
    .reduce((sum, w) => sum + w.bytes, 0);
  console.log(`  ≈ ${kb(untouchedByEconomy)} из ${kb(bytes)} экономический догон НЕ трогает — это и есть перерасход полного $set`);

  console.log('\n2. Оборот документа вокруг редуктора (клон → редуктор → $set)');
  const statClone = report('cloneAccount', bench(2000, () => cloneAccount(attacker)), 2000);
  const statPayload = report('toSetPayload', bench(2000, () => toSetPayload(attacker)), 2000);
  const statStringify = report('JSON.stringify($set)', bench(1000, () => JSON.stringify(toSetPayload(attacker))), 1000);
  const rawDoc = JSON.parse(json) as Record<string, unknown>;
  rawDoc['_id'] = attacker.id;
  const statToAccount = report('toAccount (десериализация)', bench(1000, () => toAccount(rawDoc as never)), 1000);

  console.log('\n3. Догон экономики (на каждом запросе, включая GET)');
  const now = new Date(T0.getTime() + 5 * 60_000);
  report('applyEconomyTick (5 мин)', bench(2000, () => applyEconomyTick(attacker, now, config.economy)), 2000);
  report('settleBuilds', bench(2000, () => settleBuilds(attacker, now, nextId)), 2000);
  report('voidExpiredOrders', bench(2000, () => voidExpiredOrders(attacker, now)), 2000);
  const statSync = report('syncState = весь догон', bench(1000, () => syncState(attacker, now, config.economy, nextId)), 1000);

  // Дельта-запись (modules/user/doc.diff.ts → MongoUserStore.transact): наружу уходит
  // только изменившееся поле, а не весь документ. Замер ставит вопрос ребром — сколько
  // байт и сколько CPU стоил перерасход, измеренный в разделе 1.
  const prevPayload = toSetPayload(attacker);
  const fieldCount = Object.keys(prevPayload).length;
  const tickedPayload = toSetPayload(syncState(attacker, now, config.economy, nextId).account);
  const economyDelta = diffSetPayload(prevPayload, tickedPayload);
  const deltaBytes = Buffer.byteLength(JSON.stringify(economyDelta), 'utf8');
  console.log(
    `  дельта догона: ${kb(deltaBytes)} вместо ${kb(bytes)} — ` +
      `${Object.keys(economyDelta).length} изменённых поля из ${fieldCount}, ` +
      `${(100 - (deltaBytes / bytes) * 100).toFixed(0)}% байта экономии`
  );
  // Меряем ТОЛЬКО сравнение и сериализацию дельты: `syncState` уже вынесен из замыкания,
  // иначе в цифгу попадал бы редуктор, и «стало» выглядело бы хуже, чем есть.
  const statDelta = report('diffSetPayload + stringify', bench(1000, () => JSON.stringify(diffSetPayload(prevPayload, tickedPayload))), 1000);

  console.log('\n4. Бой (синхронный CPU внутри HTTP-запроса)');
  report('describeBase (BFS от 8 ворот)', bench(2000, () => describeBase(defender)), 2000);
  const army = resolveArmy(attacker, droneIds);
  report(`resolveArmy (${army.robots} дронов)`, bench(1000, () => resolveArmy(attacker, droneIds)), 1000);
  const statBattle = report(`simulateBattle (${army.robots} дронов)`, bench(200, () => simulateBattle({ defender, army })), 200);
  const battle = simulateBattle({ defender, army });
  console.log(`  итог боя: ${battle.ticks} тиков / ${battle.durationMs} мс, исход ${battle.outcome}, разрушено ${battle.destroyed}, событий ${battle.timeline.length}`);
  const raidNow = new Date(T0.getTime() + 60_000);
  const raidInput = (nonce: string) => ({
    attackerId: attacker.id,
    defender,
    armyItemIds: droneIds,
    raidId: makeRaidId(attacker.id, defender.id, nonce),
    now: raidNow,
    config: config.economy
  });
  const oneRaid = resolveRaid(attacker, raidInput('probe'));
  console.log(`  черновиков журнала за один рейд: ${oneRaid.drafts.length}`);
  // Сколько байт реально уедет на запись рейда: дельта по каждому из двух документов.
  const raidAttackerBytes = Buffer.byteLength(JSON.stringify(diffSetPayload(toSetPayload(attacker), toSetPayload(oneRaid.attacker))), 'utf8');
  const raidDefenderBytes = Buffer.byteLength(JSON.stringify(diffSetPayload(toSetPayload(defender), toSetPayload(oneRaid.defender))), 'utf8');
  console.log(`  дельта записей боя: атакующий ${kb(raidAttackerBytes)}, защитник ${kb(raidDefenderBytes)}`);
  const statRaid = report('resolveRaid (полный резолв)', bench(200, (i) => resolveRaid(attacker, raidInput(`bench-${i}`))), 200);

  console.log('\n5. Обращений к стору на один HTTP-запрос (memory-драйвер: сеть исключена, остаток — наш код)');
  const store = new CountingStore();
  await store.save(attacker);
  await store.save(defender);
  const ledger = new MemoryLedgerStore();
  await ledger.connect();

  store.reads = 0;
  store.writes = 0;
  await store.transact(attacker.id, (current) => syncState(current, now, config.economy, nextId).account);
  const getWrites = store.writes;
  console.log(`  GET  /v1/economy      reads ${store.reads}  writes ${store.writes}   ← «чтение витрины» пишет документ`);
  console.log(`  байт на GET: было ${kb(bytes)} (полный $set) → стало ${kb(deltaBytes * getWrites)} (дельта)`);

  store.reads = 0;
  store.writes = 0;
  // Ровно та последовательность, что собрана в http/routes/pvpRoutes.ts:
  // accountAction(атакующий) → findById(защитник) → догон защитника в памяти → commitRaid.
  await store.transact(attacker.id, (current) => syncState(current, now, config.economy, nextId).account);
  const storedDefender = await store.findById(defender.id);
  if (!storedDefender) throw new Error('бенчмарк: защитник исчез');
  const freshDefender = syncState(storedDefender, now, config.economy, nextId).account;
  const committed = await commitRaid(
    { ...raidInput(`store-${Date.now()}`), defender: freshDefender },
    { store, ledger, idFactory: nextId }
  );
  console.log(`  POST /v1/pvp/raid     reads ${store.reads}  writes ${store.writes}   ← один бой (defenderCommitted=${committed.defenderCommitted})`);
  const raidWire = raidAttackerBytes + raidDefenderBytes;
  console.log(
    `  байт на бой: было ${kb(bytes * 4)} (4 полных $set) → стало ${kb(raidWire)} ` +
      `(атакующий ${kb(raidAttackerBytes)} + защитник ${kb(raidDefenderBytes)}; холостой догон не пишет ` +
      `ничего, изменённый — ещё ${kb(deltaBytes)})`
  );
  console.log(
    `  чтения по-прежнему тянут весь документ: ${store.reads} × ${kb(bytes)} = ${kb(bytes * store.reads)} вниз — ` +
      `дельта-запись их не касается (нужна проекция, отдельная работа)`
  );

  console.log('\n6. Lag event loop: что ловят соседи, пока один игрок дерётся');
  const probe = lagProbe(5);
  const raids = 20;
  for (let i = 0; i < raids; i += 1) {
    resolveRaid(attacker, raidInput(`lag-${i}`));
    // Отдаём таймерам шанс отработать — как между запросами в реальном сервере.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const lag = probe.stop();
  console.log(`  ${raids} рейдов подряд: максимальная задержка таймера ${lag.maxDriftMs.toFixed(1)} мс, средняя ${lag.meanDriftMs.toFixed(1)} мс`);
  console.log('  (при 5-мс интервале нормой считается < 5 мс; всё, что выше, — задержка ВСЕХ соединений процесса)');

  console.log('\n7. Сводка: из чего складывается CPU одного запроса (avg, мс)');
  // Два оборота документа: полный `$set` (как было до дельта-записи) и дельта (doc.diff.ts).
  const writeTurn = statClone.avg + statPayload.avg + statStringify.avg;
  const deltaTurn = statClone.avg + statPayload.avg * 2 + statDelta.avg;
  const readTurn = statToAccount.avg;
  const getBefore = statSync.avg + writeTurn + readTurn;
  const getAfter = statSync.avg + deltaTurn + readTurn;
  // Модель рейда. До: 2 пре-фрайт-транза + findById + commitRaid (2 транза) = 5 чтений,
  // 4 полных записи. После: 1 пре-фрайт + findById + commitRaid = счётчики из раздела 5,
  // каждый оборот — дельта. Догон защитника считается по-прежнему (его снимок обязан быть
  // свежим для лута), не пишется только — экономия на обороте, а не на редукторе.
  const raidBefore = statSync.avg * 2 + statRaid.avg + writeTurn * 4 + readTurn * 5;
  const raidAfter = statSync.avg * 2 + statRaid.avg + deltaTurn * store.writes + readTurn * store.reads;
  const line = (label: string, before: number, after: number): string =>
    `  ${label.padEnd(24)} ${before.toFixed(3).padStart(7)} → ${after.toFixed(3).padStart(7)} мс   −${(((before - after) / before) * 100).toFixed(0)}%`;
  console.log(line('оборот записью', writeTurn, deltaTurn));
  console.log(line('GET /v1/economy', getBefore, getAfter));
  console.log(line('POST /v1/pvp/raid', raidBefore, raidAfter));
  console.log(
    `  после: в рейде бой ${((statRaid.avg / raidAfter) * 100).toFixed(1)}%, ` +
      `догон ${((statSync.avg * 2 / raidAfter) * 100).toFixed(1)}%, ` +
      `обороты ${((deltaTurn * store.writes / raidAfter) * 100).toFixed(1)}%`
  );
  console.log(
    `  Один поток держит ≈ ${Math.round(1000 / raidAfter)} рейдов/сек (было ${Math.round(1000 / raidBefore)}), ` +
      `один рейд съедает ${((raidAfter / 16.67) * 100).toFixed(0)}% кадра 60 Гц event loop`
  );

  console.log('\n=== Итог: запрос = догон + оборот документа + (для боя) симуляция ===\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

