import { STORAGE_IDS, type StorageId } from '../../config/storage.js';
import type { EconomyConfig } from '../../config/env.js';
import { resolveEntitlements, storageCapacities } from './entitlements.js';
import { HOUR_MS } from './mining.js';
import { computeGrid, type PowerGrid } from './power.js';
import { credit, resource } from './wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import { deployedUnitCodes, emptyStorages, type StoragePools, type UserAccount } from '../user/user.types.js';

/**
 * Промышленный тик: реакторы жгут топливо, цехи наливают газы, кулеры сжигают азот.
 *
 * ЗАЧЕМ СТАДИИ, А НЕ ОДНО УМНОЖЕНИЕ НА Δt
 * ───────────────────────────────────────
 * Наивный офлайн-расчёт «8 часов × ставки» врёт, и вранье это одностороннее:
 *
 *   1. Плазма кончилась на 3-м часу. Умножение на 8 напечатало бы мощность, которой
 *      не было, и азот, который некому было производить.
 *   2. Крио-цистерна наполнилась на 5-м часу. Азотная станция после этого обязана
 *      встать (лить продукцию некуда), освободив мощность реакторам. Умножение на 8
 *      сожгло бы плазму впустую — игрок потерял бы топливо без результата.
 *
 * Поэтому горизонт режется на стадии по ближайшему СОБЫТИЮ, а внутри стадии ставки
 * постоянны и считаются замкнутой формулой. Событий ровно столько, сколько ресурсов
 * способны упереться в 0 или в ёмкость, — то есть конечное число, и цикл сходится.
 *
 * ПОРЯДОК ТИКОВ В `applyEconomyTick`
 * ──────────────────────────────────
 *   привилегии → майнинг → промышленность → энергия
 * Майнинг перед промышленностью не случайно: руда (плазма, уран) — топливо цехов, и
 * ночная добыча должна стать доступна реактору в том же такте. Обратный порядок
 * заставил бы игрока ждать один тик между «накопалось» и «сгорело».
 */

/** Потолок стадий за один тик. Больше — значит в конфиге кольцо, а не монотонный расход. */
const MAX_STAGES = 24;

/** Меньше этого шага — уже шум round6, и дальше он только плодил бы пустые итерации. */
const MIN_STAGE_MS = 1;

/**
 * Какие накопители переполнены прямо сейчас.
 *
 * Проверяется `>=`, а не `===`: дробные остатки после стадии могут оказаться на
 * единицу ulp ниже ёмкости, и сравнение на равенство тогда «разморозит» цех на один
 * такт, потом снова заморозит — дёрганье, которое игрок прочитает как поломку.
 */
function blockedOutputs(storages: StoragePools, capacities: Record<StorageId, number>): StorageId[] {
  const blocked: StorageId[] = [];
  for (const resource of STORAGE_IDS) {
    const capacity = capacities[resource] ?? 0;
    if (capacity > 0 && (storages[resource] ?? 0) >= capacity) blocked.push(resource);
  }
  return blocked;
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

export interface IndustryTickResult {
  /** Новое содержимое накопителей. */
  storages: StoragePools;
  /** Что сгорело за тик (топливо + азот охлаждения), ед. */
  burned: StoragePools;
  /** Что выработано и влезло в цистерны, ед. */
  produced: StoragePools;
  /** Что утекло при переполнении. Нормальное значение — 0; нет — цистерны узкие. */
  vented: StoragePools;
  /**
   * SEC, накапавший с ASIC за тик. Дробное намеренно: ставка 25/ч × 0.4 ч = 10, и
   * округлять на середине тика — значит печатать или терять монеты в зависимости от
   * длины стадии, то есть от того, когда именно кончилась плазма. Точное число
   * живёт в кошельке, а «сколько денег» витрина считает как `Math.floor(sec)` —
   * ровно тот же приём, что `stored`/`storedExact` в WarehouseView: запас дробный,
   * рука игрока целая.
   */
  secGained: number;
  /** Сетка на МОМЕНТ ОКОНЧАНИЯ тика: витрина показывает актуальное состояние, а не начало ночи. */
  grid: PowerGrid;
  /** Число стадий: 1 — событий не было, 2–4 — обычная ночь, больше — узкие цистерны. */
  stages: number;
  /** Упёрлось в потолок стадий: признак конфигурационного кольца, а не игровой ситуации. */
  truncated: boolean;
}

/**
 * Прогон промышленности до `now` без записи результата — для витрины и для `peek`.
 * Идемпотентна: повторный вызов с тем же `now` даёт дословно тот же ответ.
 */
export function computeIndustryTick(account: UserAccount, now: Date, config: EconomyConfig): IndustryTickResult {
  const effects = resolveEntitlements(account, now);
  const capacities = storageCapacities(account, now, effects);
  const structures = account.structures;
  const units = deployedUnitCodes(account);

  // Горизонт — тот же, что у майнинга: лимит офлайна режет и промышленность. Иначе за
  // неделю отсутствия игрок получил бы сожжённую плазму за 168 часов при добыче,
  // учтённой только за `maxOfflineHours`.
  const elapsedMs = Math.max(0, now.getTime() - account.lastLootTime.getTime());
  const horizonMs = Math.min(elapsedMs, config.maxOfflineHours * HOUR_MS);

  const storages: StoragePools = { ...account.storages };
  const burned = emptyStorages();
  const produced = emptyStorages();
  const vented = emptyStorages();
  let secGained = 0;

  let cursorMs = 0;
  let stages = 0;
  let truncated = false;
  let grid = computeGrid({ structures, units, storages, blockedOutput: blockedOutputs(storages, capacities) });

  while (cursorMs < horizonMs) {
    stages += 1;
    if (stages > MAX_STAGES) {
      truncated = true;
      break;
    }

    grid = computeGrid({ structures, units, storages, blockedOutput: blockedOutputs(storages, capacities) });
    const remainingHours = (horizonMs - cursorMs) / HOUR_MS;

    // Событие №1: топливо или азот кончаются.
    let boundaryHours = remainingHours;
    for (const resource of STORAGE_IDS) {
      const drain = (grid.fuelRate[resource] ?? 0) + (resource === 'nitrogen' ? grid.nitrogenPerHour : 0);
      if (drain <= 0) continue;
      const hours = (storages[resource] ?? 0) / drain;
      if (hours < boundaryHours) boundaryHours = hours;
    }

    // Событие №2: ёмкость наполняется — цех, которому некуда лить, встаёт.
    for (const resource of STORAGE_IDS) {
      const inflow = grid.outputRate[resource] ?? 0;
      if (inflow <= 0) continue;
      const room = (capacities[resource] ?? 0) - (storages[resource] ?? 0);
      if (room <= 0) continue;
      const hours = room / inflow;
      if (hours < boundaryHours) boundaryHours = hours;
    }

    if (!(boundaryHours > 0)) break;
    const stepMs = boundaryHours * HOUR_MS;
    if (stepMs < MIN_STAGE_MS) break;

    for (const resource of STORAGE_IDS) {
      const drain = (grid.fuelRate[resource] ?? 0) + (resource === 'nitrogen' ? grid.nitrogenPerHour : 0);
      const inflow = grid.outputRate[resource] ?? 0;

      // Сначала слив, потом приход. Обратный порядок позволял бы цистерне принять
      // азот, который в эту же стадию сгорел в кулере, — и показать игроку запас,
      // которого физически не было.
      if (drain > 0) {
        const before = storages[resource] ?? 0;
        const spent = Math.min(before, drain * boundaryHours);
        storages[resource] = round6(before - spent);
        burned[resource] = round6((burned[resource] ?? 0) + spent);
      }
      if (inflow > 0) {
        const current = storages[resource] ?? 0;
        const raw = current + inflow * boundaryHours;
        const clamped = Math.min(raw, capacities[resource] ?? 0);
        storages[resource] = round6(clamped);
        produced[resource] = round6((produced[resource] ?? 0) + (clamped - current));
        vented[resource] = round6((vented[resource] ?? 0) + (raw - clamped));
      }
    }

    // Монета капаёт по той же стадии и по той же ставке, что и газ в цистерны:
    // `coinRate.sec` уже итог веера (гасились ли ASIC топливом, мощностью или
    // теплоотводом), поэтому отдельной границы события не требует — у монеты нет
    // ёмкости, ей некуда переполняться и нечего вырабатывать впустую.
    secGained += grid.coinRate.sec * boundaryHours;

    cursorMs += stepMs;
  }

  return {
    storages,
    burned,
    produced,
    vented,
    secGained: round6(secGained),
    grid,
    stages: Math.max(1, stages),
    truncated
  };
}

/** Догоняет накопители промышленностью и возвращает новое состояние. */
export interface IndustryApplyResult {
  account: UserAccount;
  /**
   * Черновик журнала на накапавший SEC. Пустой, если монеты не было: писать нулевое
   * движение на каждом запросе значит заставить журнал расти темпом heartbeat'а
   * игрока, ничего при этом не объясняя.
   */
  drafts: LedgerDraft[];
  /** Что набежало за тик (для лога и для `peek`). */
  secGained: number;
}

/**
 * Догоняет накопители промышленностью и начисляет SEC в кошелёк.
 *
 * Начисление идёт через `credit`, а не прямой правкой `resources.sec`, и причина не в
 * аккуратности: только `credit` ставит `balanceAfter`, по которому журнал
 * восстанавливается без пересчёта, и только он даёт ключ идемпотентности. Без второго
 * повторный ретрай запроса удвоил бы деньги; без первого «откуда 600 SEC» снова стало
 * бы вопросом к поддержке.
 */
export function applyIndustryTick(
  account: UserAccount,
  now: Date,
  config: EconomyConfig
): IndustryApplyResult {
  const tick = computeIndustryTick(account, now, config);
  const gained = tick.secGained;

  if (gained <= 0) {
    return { account: { ...account, storages: tick.storages }, drafts: [], secGained: 0 };
  }

  const movement = credit(account, resource('sec'), gained, {
    ts: now,
    reason: 'industry',
    // Ни структуры, ни рейда: начислено не «объект X», а состояние сети за интервал.
    // Ставка менялась от стадии к стадии (плазма кончилась — половина стоек встала),
    // поэтому приписать сумму конкретному коду было бы правдой только для одного
    // витка, а врать в аудит-логе хуже, чем оставить поле пустым.
    refType: null,
    refId: null,
    // Валюта в ключе есть по инварианту №1 (см. ledger.types), хотя сегодня их одна:
    // завтрашняя вторая монета не должна переписывать историю сегодняшней.
    idempotencyKey: makeIdempotencyKey('industry', `${account.id}:${now.getTime()}:sec`),
    meta: {
      // Итоговая ставка на МОМЕНТ окончания тика — по ней поддержка отвечает на вопрос
      // «почему за ночь пришло меньше, чем 25 × 8 × число стоек».
      secPerHour: Math.round(tick.grid.coinRate.sec * 100) / 100,
      stages: tick.stages,
      truncated: tick.truncated
    }
  });

  return {
    account: { ...movement.account, storages: tick.storages },
    drafts: [movement.draft],
    secGained: gained
  };
}

