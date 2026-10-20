import {
  CHRONIUM_BUNDLE_DISCOUNT,
  CHRONIUM_MAX_BATCH,
  CHRONIUM_MIN_COST,
  CHRONIUM_MS_PER_UNIT,
  TECH_LABEL
} from '../../config/materials.js';
import {
  MAX_BUILD_QUEUE,
  MAX_INVENTORY_ITEMS,
  getBlueprint,
  type Blueprint,
  type ItemKind
} from '../../config/workshop.js';
import {
  MAX_STRUCTURE_TOTAL,
  getStructure,
  isStructureId,
  structureSecCost,
  structuresTotal,
  type StructureDef,
  type StructureId
} from '../../config/structures.js';
import { AppError, ErrorCodes } from '../../lib/errors.js';
import { effectiveBuildRobots } from '../economy/entitlements.js';
import { payMaterials, spendSec, spendTech } from '../economy/wallet.js';
import { makeIdempotencyKey, type LedgerDraft } from '../ledger/ledger.types.js';
import type { BuildJob, InventoryItem, StructureCounts, UserAccount } from '../user/user.types.js';

/**
 * Крафт и очередь стройки (п.3.1).
 *
 * `buildersBusy` намеренно НЕ хранится в документе: он выводится изlive-очереди
 * `builds`. Хранимый счётчик обязательно разойдётся с реальностью — упавший
 * запрос «начал стройку» оставил бы робота занятым навсегда, а игрок в такой
 * ситуации видит только одно: «купил слот, робот сломался». Здесь же состояние
 * всегда производно от данных, и восстановление тривиально.
 */

/** Ещё не завершённые на данный момент работы. */
export function activeBuilds(account: UserAccount, now: Date): BuildJob[] {
  return account.builds.filter((job) => job.endsAt.getTime() > now.getTime());
}

/** Сколько роботов сейчас занято (производно от очереди, не хранится). */
export function buildersBusy(account: UserAccount, now: Date): number {
  return activeBuilds(account, now).length;
}

/** Сколько роботов у игрока всего: база + купленные слоты + временные бусты. */
export function buildersMax(account: UserAccount, now: Date): number {
  return effectiveBuildRobots(account, now);
}

export function buildersFree(account: UserAccount, now: Date): number {
  return Math.max(0, buildersMax(account, now) - buildersBusy(account, now));
}

/** Когда освободится ближайший робот (null — есть свободные либо очередь пуста). */
export function nextBuilderFreeAt(account: UserAccount, now: Date): Date | null {
  const active = activeBuilds(account, now);
  if (active.length === 0) return null;
  return new Date(Math.min(...active.map((job) => job.endsAt.getTime())));
}

export interface SettleResult {
  account: UserAccount;
  /** Предметы, которые только что встали в инвентарь. */
  items: InventoryItem[];
  /** Сколько завершённых работ-ПРЕДМЕТОВ не поместилось в инвентарь и осталось «наготове». */
  overflow: number;
  /** Прирост сооружений за этот догон (код → сколько единиц прибыло). */
  gained: Partial<Record<StructureId, number>>;
}

/**
 * Догоняет очередь: всё, у чего `endsAt <= now`, переезжает в инвентарь (или в
 * счётчики сооружений). Идемпотентна — повторный вызов не найдёт завершённых работ.
 * Движений журнала не создаёт: материалы списались в момент старта стройки.
 *
 * Переполнение инвентаря обрабатывается ТОЛЕРАНТНО: лишние работы остаются в
 * очереди с прошедшим сроком. Жёсткий бросок здесь создал бы взаимоблокировку —
 * игрок с забитым инвентарем не смог бы вызвать и dismantle (он тоже догоняет
 * очередь) и не смог бы освободить место.
 *
 * СООРУЖЕНИЯ ВСТАЮТ ПЕРВЫМИ И БЕЗ УСЛОВИЙ. У них нет слота инвентаря, поэтому
 * держать достроенный реактор «наготове» только потому, что у игрока 400 башен в
 * рюкзаке, — значит наказать его чужой механикой. Порядок «сначала здания, потом
 * предметы» также бесплатен: здания не конкурируют за место, которого им не нужно.
 */
export function settleBuilds(account: UserAccount, now: Date, idFactory: () => string): SettleResult {
  const done = account.builds.filter((job) => job.endsAt.getTime() <= now.getTime());
  if (done.length === 0) return { account, items: [], overflow: 0, gained: {} };

  const structureJobs = done.filter((job) => job.kind === 'structure');
  const itemJobs = done.filter((job) => job.kind !== 'structure');

  const gained: Partial<Record<StructureId, number>> = {};
  for (const job of structureJobs) {
    // Код исчез из конфига (откат патча) — работа просто сгорает, не роняя каждый
    // последующий тик экономики. Молчаливый ноль здесь честнее 500 на входе в игру.
    if (!isStructureId(job.code)) continue;
    gained[job.code] = (gained[job.code] ?? 0) + 1;
  }

  const room = Math.max(0, MAX_INVENTORY_ITEMS - account.inventory.length);
  const settling = itemJobs.slice(0, room);

  const items: InventoryItem[] = settling.map((job) => ({
    id: idFactory(),
    kind: job.kind as ItemKind,
    code: job.code,
    level: job.level,
    acquiredAt: now,
    source: 'build',
    orderId: null
  }));

  const settledIds = new Set<string>([...structureJobs.map((job) => job.id), ...settling.map((job) => job.id)]);
  if (settledIds.size === 0) return { account, items: [], overflow: itemJobs.length, gained: {} };

  const next: UserAccount = {
    ...account,
    inventory: items.length > 0 ? [...account.inventory, ...items] : account.inventory,
    structures:
      Object.keys(gained).length > 0
        ? Object.fromEntries(
            Object.entries(account.structures).map(([id, count]) => [id, count + (gained[id as StructureId] ?? 0)])
          ) as StructureCounts
        : account.structures,
    builds: account.builds.filter((job) => !settledIds.has(job.id))
  };

  return { account: next, items, overflow: itemJobs.length - settling.length, gained };
}

export interface StartBuildResult {
  account: UserAccount;
  /** Расход материалов по чертежу — по одному движению на каждый материал. */
  drafts: LedgerDraft[];
  job: BuildJob;
  /** Непусто ровно для одного из `blueprint`/`structure`: предмет или здание. */
  blueprint: Blueprint | null;
  structure: StructureDef | null;
  /**
   * Сколько SEC списано этой стройкой (0 — денег не взяли). Отдельное поле, а не
   * графа в `drafts`: фронт обязан показать «за стройку ушло 350 SEC» ответом на
   * запрос, а не пересчётом журнала.
   */
  secCost: number;
  busyAfter: number;
  freeAfter: number;
}

/**
 * Запуск стройки: списывает материалы (и монету, если у сооружения есть `secCost`),
 * занимает свободного робота.
 * Всё или ничего: не хватило любого материала — INSUFFICIENT_FUNDS из редуктора,
 * транзакция не записывается, очередь не трогается. Порядок проверок тоже «всё или
 * ничего»: лимиты сооружения (`assertStructureSlot`) смотрятся ДО первой оплаты,
 * иначе игрок заплатил бы вольфрамом и получил отказ по лимиту.
 */
/**
 * Можно ли поставить ещё один экземпляр сооружения.
 *
 * Проверка ДО списания материалов — тот же принцип «всё или ничего», что и в остальной
 * стройке: иначе игрок заплатил бы вольфрамом и получил бы отказ по лимиту.
 *
 * Три границы, и каждая отвечает на свой вопрос:
 *  - `maxPerBase` — баланс вида («реакторов не больше 12», иначе генерация обесценит
 *    весь контур охлаждения и веер станет бессмысленным);
 *  - `MAX_STRUCTURE_TOTAL` — размер документа (16 МБ на аккаунт — не бесконечность);
 *  - `requires` — связность технологий: без крио-цистерны лить азот некуда, и честнее
 *    отказать на входе, чем выдать станцию, которая встанет по переполнению через час.
 */
function assertStructureSlot(account: UserAccount, structure: StructureDef): void {
  const owned = account.structures[structure.id] ?? 0;
  if (structure.maxPerBase > 0 && owned >= structure.maxPerBase) {
    throw new AppError(ErrorCodes.STRUCTURE_LIMIT, 409, `${structure.name}: достигнут предел на базе`, {
      code: structure.id,
      owned,
      limit: structure.maxPerBase
    });
  }
  if (structuresTotal(account.structures) >= MAX_STRUCTURE_TOTAL) {
    throw new AppError(ErrorCodes.STRUCTURE_LIMIT, 409, 'Достигнут общий предел сооружений на базе', {
      limit: MAX_STRUCTURE_TOTAL
    });
  }
  for (const [need, count] of Object.entries(structure.requires ?? {})) {
    const have = account.structures[need as StructureId] ?? 0;
    if (have < (count ?? 0)) {
      throw new AppError(ErrorCodes.STRUCTURE_REQUIRES, 409, `Сначала постройте: ${getStructure(need)?.name ?? need} × ${count}`, {
        code: structure.id,
        requires: structure.requires,
        owned: have
      });
    }
  }
}

export function startBuild(
  account: UserAccount,
  code: string,
  now: Date,
  idFactory: () => string
): StartBuildResult {
  const blueprint = getBlueprint(code) ?? null;
  const structure = blueprint ? null : getStructure(code) ?? null;
  if (!blueprint && !structure) {
    throw new AppError(ErrorCodes.UNKNOWN_BLUEPRINT, 404, `Неизвестный чертёж: ${code}`, { code });
  }

  // Сначала догоняем очередь: иначе робот, освободившийся минуту назад, считался бы занятым.
  const settled = settleBuilds(account, now, idFactory);
  const base = settled.account;

  // Инвентарь волнует только предметы. Отказать в постройке реактора из-за забитого
  // рюкзака — значит наказать игрока чужой механикой.
  if (!structure && base.inventory.length >= MAX_INVENTORY_ITEMS) {
    throw new AppError(ErrorCodes.INVENTORY_FULL, 409, 'Инвентарь переполнен — разберите что-нибудь в мастерской', {
      inventory: base.inventory.length,
      limit: MAX_INVENTORY_ITEMS
    });
  }

  if (structure) assertStructureSlot(base, structure);

  if (base.builds.length >= MAX_BUILD_QUEUE) {
    throw new AppError(ErrorCodes.BUILD_QUEUE_FULL, 409, 'Очередь стройки переполнена', {
      queue: base.builds.length,
      limit: MAX_BUILD_QUEUE
    });
  }

  const free = buildersFree(base, now);
  if (free <= 0) {
    throw new AppError(ErrorCodes.NO_FREE_BUILDER, 409, 'Все роботы-строители заняты', {
      max: buildersMax(base, now),
      busy: buildersBusy(base, now),
      readyAt: nextBuilderFreeAt(base, now)
    });
  }

  const def = blueprint ?? structure!;
  const jobId = idFactory();
  const paid = payMaterials(base, def.cost, {
    ts: now,
    reason: 'craft',
    refType: blueprint ? 'blueprint' : 'structure',
    refId: code,
    meta: { job: jobId, tier: def.tier },
    idempotencyKeyFor: (id) => makeIdempotencyKey('build', `${jobId}:${id}`)
  });

  // Второй платёж — монетой. Цена считается по числу стоек, уже стоящих на базе
  // (`base`, а не `paid.account`: сырьё количество экземпляров не меняет, оно
  // прирастает в `settleBuilds` по окончании стройки).
  //
  // Ключ обязан содержать валюту — инвариант №1 (modules/ledger/ledger.types.ts):
  // без `:sec` второе движение этой же оплаты попало бы под уникальный индекс
  // первого и монеты ушли бы с баланса без аудиторского следа.
  let accountAfterPay = paid.account;
  const drafts = [...paid.drafts];
  let secPrice = 0;
  if (structure) {
    const owned = base.structures[structure.id] ?? 0;
    secPrice = structureSecCost(structure, owned);
    if (secPrice > 0) {
      const coin = spendSec(accountAfterPay, secPrice, {
        ts: now,
        reason: 'craft',
        refType: 'structure',
        refId: code,
        meta: { job: jobId, tier: def.tier, owned },
        idempotencyKey: makeIdempotencyKey('build', `${jobId}:sec`)
      });
      accountAfterPay = coin.account;
      drafts.push(coin.draft);
    }
  }

  const job: BuildJob = {
    id: jobId,
    code,
    kind: blueprint ? blueprint.kind : 'structure',
    level: 1,
    startedAt: now,
    endsAt: new Date(now.getTime() + def.buildMs)
  };

  const next: UserAccount = { ...accountAfterPay, builds: [...accountAfterPay.builds, job] };

  return {
    account: next,
    drafts,
    job,
    blueprint,
    structure,
    secCost: secPrice,
    busyAfter: buildersBusy(next, now),
    freeAfter: buildersFree(next, now)
  };
}


// ─── Мгновенное ускорение стройки (хрониум) ────────────────────────────────────

/**
 * Ускорение оплачивается ХРОНИУМОМ, а не донатной валютой.
 *
 * Это разделение принципиально. Пока скип таймера и покупка робота-строителя стоили
 * одних и тех же единиц, игрок каждый раз решал одну и ту же дилемму «ускориться
 * сейчас или купить слот надолго», а продукт терял управление темпом: в пике
 * активности все сжигали баланс на ускорения и слоты не покупались вовсе. Хрониум
 * тратится ровно в одну воронку — время, — и его цена («1 минута за 1 единицу»)
 * остаётся читаемой независимо от цен на остальные материалы.
 *
 * Клиент никогда не передаёт ни цену, ни остаток таймера: сервер пересчитывает их
 * в момент списания. Иначе «ускорение за 1 хрониум» стало бы эксплойтом за пять минут.
 */

/** Сколько секунд таймера срезает одна единица хрониума — для сообщений и витрины. */
export const CHRONIUM_SECONDS_PER_UNIT = CHRONIUM_MS_PER_UNIT / 1000;

/** Цена ускорения одной работы: сколько хрониума стоит срезанный таймер. */
export function chroniumPrice(remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  return Math.max(CHRONIUM_MIN_COST, Math.ceil(remainingMs / CHRONIUM_MS_PER_UNIT));
}

/** Цена «ускорить всё»: сумма индивидуальных чеков минус скидка на пачку. */
export function chroniumBundlePrice(jobs: readonly BuildJob[], now: Date): number {
  const total = jobs.reduce((sum, job) => sum + chroniumPrice(job.endsAt.getTime() - now.getTime()), 0);
  if (total <= 0) return 0;
  return Math.max(1, Math.ceil(total * CHRONIUM_BUNDLE_DISCOUNT));
}

/** Сколько миллисекунд таймера даёт `units` хрониума. */
export function chroniumToMs(units: number): number {
  return units * CHRONIUM_MS_PER_UNIT;
}

/** Работы, срок которых уже прошёл, но места в инвентаре им не досталось. */
/** Работы-ПРЕДМЕТЫ, срок которых уже прошёл, но места в инвентаре им не досталось. */
function readyOverflow(account: UserAccount, now: Date): number {
  return account.builds.filter((job) => job.kind !== 'structure' && job.endsAt.getTime() <= now.getTime()).length;
}

/**
 * Хватает ли места, чтобы результат ускорения ТОЧНО приехал в инвентарь.
 *
 * Проверка обязательна до списания: без неё игрок с полным складом заплатил бы
 * хрониум, работа завершилась бы, а предмет остался бы висеть в очереди «готово,
 * но не выдан». Время куплено, товара нет — наихудший из возможных миров для
 * доверия к экономике. `extra` — сколько предметов планируется выдать этим же
 * действием.
 */
function hasGuaranteedRoom(account: UserAccount, now: Date, extra = 1): boolean {
  return account.inventory.length + readyOverflow(account, now) + extra <= MAX_INVENTORY_ITEMS;
}

/** Валидация количества хрониума из запроса: целое, > 0, в пределах разума. */
function assertChroniumAmount(amount: number, jobId: string): void {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new AppError(ErrorCodes.SPEEDUP_AMOUNT_INVALID, 400, 'Количество хрониума должно быть целым и > 0', {
      jobId,
      amount
    });
  }
  if (amount > CHRONIUM_MAX_BATCH) {
    throw new AppError(ErrorCodes.SPEEDUP_AMOUNT_INVALID, 400, 'Слишком крупная порция хрониума за один запрос', {
      jobId,
      amount,
      limit: CHRONIUM_MAX_BATCH
    });
  }
}

export type SpeedupReason = 'ok' | 'not_found' | 'done' | 'inventory_full' | 'funds' | 'empty';

export interface SpeedupQuote {
  jobId: string;
  code: string | null;
  /** Остаток таймера, мс. */
  remainingMs: number;
  /** Цена полного завершения работы в хрониуме. */
  cost: number;
  /** Сколько таймера срежет одна единица хрониума — витрина рисует по ней «+N сек». */
  msPerUnit: number;
  canSpeedup: boolean;
  /** Причина отказа для UI — без бросания исключений на каждый отрисованный ряд. */
  reason: SpeedupReason;
}

/** Пресет кнопки «Ускорить»: состояние проверяется на месте, ошибки не будет. */
export function describeSpeedup(account: UserAccount, jobId: string, now: Date): SpeedupQuote {
  const job = account.builds.find((candidate) => candidate.id === jobId);
  const quote = (remainingMs: number, cost: number, reason: SpeedupReason): SpeedupQuote => ({
    jobId,
    code: job?.code ?? null,
    remainingMs,
    cost,
    msPerUnit: CHRONIUM_MS_PER_UNIT,
    canSpeedup: reason === 'ok',
    reason
  });

  if (!job) return quote(0, 0, 'not_found');

  const remainingMs = job.endsAt.getTime() - now.getTime();
  // Просроченная работа бесплатна: её выдаст любой settle. Продавать её нельзя —
  // игрок видел бы нулевой таймер и платил за уже случившееся событие.
  // Замечание для читающего код: витрина смотрит ещё не догнанную очередь и потому
  // отвечает 'done', а applyChroniumSpeedup первым делом делает settle и той же работы
  // уже не найдёт (BUILD_NOT_FOUND). Это две формулировки одного отказа — ни одна не списывает.
  if (remainingMs <= 0) return quote(0, 0, 'done');

  const cost = chroniumPrice(remainingMs);
  // Сооружению слот инвентаря не нужен: отказывать в ускорении реактора из-за полного
  // рюкзака — значит брать хрониум за решение проблемы, которой не существует.
  if (job.kind !== 'structure' && !hasGuaranteedRoom(account, now)) return quote(remainingMs, cost, 'inventory_full');
  if (account.materials.chronium < cost) return quote(remainingMs, cost, 'funds');
  return quote(remainingMs, cost, 'ok');
}

/** Внутренний результат применения хрониума к одной работе. */
interface AppliedSpeedup {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Сколько хрониума реально списано (может быть меньше влитого — см. speedupCraft). */
  charged: number;
  /** На сколько реально сдвинут таймер (не больше остатка). */
  cutMs: number;
  job: BuildJob;
  done: boolean;
  items: InventoryItem[];
}

/**
 * Ядро ускорения: списывает `units` хрониума и сдвигает `endsAt`.
 *
 * Порядок шагов здесь принципиален: списание — последнее, что может упасть
 * (INSUFFICIENT_FUNDS из кошелька), поэтому состояния «время куплено, таймер не
 * сдвинут» в этом коде невыразимо. Всё, что идёт после списания, — чистые
 * редукторы над уже провалидированными данными.
 */
function applyChroniumToJob(
  base: UserAccount,
  job: BuildJob,
  units: number,
  now: Date,
  idFactory: () => string
): AppliedSpeedup {
  const remainingMs = job.endsAt.getTime() - now.getTime();
  const cutMs = Math.min(chroniumToMs(units), remainingMs);
  const done = remainingMs - cutMs <= 0;

  const spent = spendTech(base, 'chronium', units, {
    ts: now,
    reason: 'upgrade',
    refType: 'build_job',
    refId: job.id,
    // Ключ включает количество: ретрай того же запроса — тот же ключ, а вот
    // «ускорить на 5» и «ускорить на 20» — два разных действия с разными ключами.
    idempotencyKey: makeIdempotencyKey('rush', `${job.id}:${units}`),
    meta: { units, cut_ms: cutMs, code: job.code, ms_per_unit: CHRONIUM_MS_PER_UNIT }
  });

  const endsAt = new Date(job.endsAt.getTime() - cutMs);
  const shifted: UserAccount = {
    ...spent.account,
    builds: spent.account.builds.map((candidate) => (candidate.id === job.id ? { ...candidate, endsAt } : candidate))
  };

  // Догоняем очередь только если работа дошла до нуля: иначе settle ничего не вернёт,
  // а лишний обход очереди на каждом частичном ускорении — пустая работа.
  const settled = done
    ? settleBuilds(shifted, now, idFactory)
    : { account: shifted, items: [] as InventoryItem[], overflow: 0 };

  if (done && settled.items.length !== 1) {
    // Бросок внутри редуктора = транзакция не записана, хрониум не списан. Хуже всего
    // здесь «проглотить» молча: игрок увидел бы списание без предмета.
    throw new AppError(ErrorCodes.INTERNAL, 500, 'Хрониум списан, а предмет в инвентарь не приехал', {
      jobId: job.id,
      units,
      issued: settled.items.length,
      overflow: settled.overflow
    });
  }

  return {
    account: settled.account,
    drafts: [spent.draft],
    charged: units,
    cutMs,
    job: { ...job, endsAt },
    done,
    items: settled.items
  };
}

/** Работа, к которой применяется ускорение, ещё не догнана очередью. */
function requireActiveJob(account: UserAccount, jobId: string, now: Date): BuildJob {
  const job = account.builds.find((candidate) => candidate.id === jobId);
  if (!job) {
    throw new AppError(ErrorCodes.BUILD_NOT_FOUND, 404, 'Стройка не найдена в очереди', { jobId });
  }
  if (job.endsAt.getTime() <= now.getTime()) {
    throw new AppError(ErrorCodes.BUILD_ALREADY_DONE, 409, 'Эта стройка уже завершена', {
      jobId,
      code: job.code,
      endsAt: job.endsAt
    });
  }
  return job;
}


export interface SpeedupResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  /** Сколько хрониума списано. */
  cost: number;
  /** Срезанное время, мс. */
  savedMs: number;
  /** Ускоренная работа (с новым endsAt). */
  job: BuildJob;
  items: InventoryItem[];
  busyAfter: number;
  freeAfter: number;
}

/**
 * Мгновенное завершение одной работы: «сколько бы ни осталось — забирай сейчас».
 *
 * Списывается ровно `chroniumPrice(остаток)`, не больше. Остаток округляется ВВЕРХ:
 * 61 секунда стоит 2 хрониума. Округление вниз подарило бы игроку минуту за
 * половину единицы и сделало бы цену непонятной («заплатил 1, а ускорилось на 61с»).
 */
export function applyChroniumSpeedup(
  account: UserAccount,
  jobId: string,
  now: Date,
  idFactory: () => string
): SpeedupResult {
  // Сначала догоняем очередь: завершившаяся работа не должна продаваться (см. describeSpeedup).
  const base = settleBuilds(account, now, idFactory).account;
  const job = requireActiveJob(base, jobId, now);

  const remainingMs = job.endsAt.getTime() - now.getTime();
  const cost = chroniumPrice(remainingMs);

  if (!hasGuaranteedRoom(base, now)) {
    throw new AppError(ErrorCodes.INVENTORY_FULL, 409, 'Инвентарь не примет ускоренную работу — освободите место', {
      inventory: base.inventory.length,
      limit: MAX_INVENTORY_ITEMS,
      jobId
    });
  }

  const applied = applyChroniumToJob(base, job, cost, now, idFactory);

  return {
    account: applied.account,
    drafts: applied.drafts,
    cost,
    savedMs: applied.cutMs,
    job: applied.job,
    items: applied.items,
    busyAfter: buildersBusy(applied.account, now),
    freeAfter: buildersFree(applied.account, now)
  };
}

export interface PartialSpeedupResult extends SpeedupResult {
  /** Сколько хрониума игрок просил списать. */
  requested: number;
  /** true — работа дошла до нуля, предмет выдан в инвентарь. */
  done: boolean;
  /** Сколько запрошенного хрониума НЕ списано (излишек сверх полного завершения). */
  leftover: number;
}

/**
 * Частичное ускорение: игрок вливает `chroniumAmount` и срезает ровно столько
 * времени, сколько оно даёт (1 единица = 1 минута).
 *
 * Правило честности: если влитого количества хватило бы с избытком на полное
 * завершение, списывается ровно цена завершения, а излишек остаётся на балансе.
 * Молча снять 20 хрониума за 3 минуты остатка — значит получить тикет на каждом
 * втором ускорении.
 *
 * Место в инвентаре требуется только когда работа доходит до нуля: частичное
 * ускорение предмет не выдаёт, поэтому и блокировать его полным складом незачем.
 */
export function speedupCraft(
  account: UserAccount,
  jobId: string,
  chroniumAmount: number,
  now: Date,
  idFactory: () => string
): PartialSpeedupResult {
  const base = settleBuilds(account, now, idFactory).account;
  const job = requireActiveJob(base, jobId, now);
  assertChroniumAmount(chroniumAmount, jobId);

  const remainingMs = job.endsAt.getTime() - now.getTime();
  const fullCost = chroniumPrice(remainingMs);
  const charged = Math.min(chroniumAmount, fullCost);
  const willFinish = charged >= fullCost;

  if (willFinish && !hasGuaranteedRoom(base, now)) {
    throw new AppError(ErrorCodes.INVENTORY_FULL, 409, 'Инвентарь не примет ускоренную работу — освободите место', {
      inventory: base.inventory.length,
      limit: MAX_INVENTORY_ITEMS,
      jobId
    });
  }

  const applied = applyChroniumToJob(base, job, charged, now, idFactory);

  return {
    account: applied.account,
    drafts: applied.drafts,
    cost: applied.charged,
    requested: chroniumAmount,
    leftover: chroniumAmount - applied.charged,
    savedMs: applied.cutMs,
    done: applied.done,
    job: applied.job,
    items: applied.items,
    busyAfter: buildersBusy(applied.account, now),
    freeAfter: buildersFree(applied.account, now)
  };
}


// ─── Ускорение всей очереди (пачка) ────────────────────────────────────────────

export interface SpeedupAllQuote {
  /** Сколько активных работ попадёт под ускорение. */
  count: number;
  /** Суммарно срезанное время, мс. */
  savedMs: number;
  /** Цена пачки с учётом скидки. */
  cost: number;
  canSpeedup: boolean;
  reason: SpeedupReason;
}

/** Пресет кнопки «Ускорить всё»: состояние проверяется на месте, ошибки не будет. */
export function describeSpeedupAll(account: UserAccount, now: Date): SpeedupAllQuote {
  const active = activeBuilds(account, now);
  if (active.length === 0) return { count: 0, savedMs: 0, cost: 0, canSpeedup: false, reason: 'empty' };

  const sorted = active.slice().sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());
  const cost = chroniumBundlePrice(sorted, now);
  const savedMs = sorted.reduce((sum, job) => sum + Math.max(0, job.endsAt.getTime() - now.getTime()), 0);

  // Пачка выдаёт N предметов разом: места должно хватить на все, иначе часть
  // оплаченного результата застрянет в очереди «готово, но не выдан».
  if (!hasGuaranteedRoom(account, now, sorted.filter((job) => job.kind !== 'structure').length)) {
    return { count: sorted.length, savedMs, cost, canSpeedup: false, reason: 'inventory_full' };
  }
  if (account.materials.chronium < cost) {
    return { count: sorted.length, savedMs, cost, canSpeedup: false, reason: 'funds' };
  }
  return { count: sorted.length, savedMs, cost, canSpeedup: true, reason: 'ok' };
}

export interface SpeedupAllResult {
  account: UserAccount;
  drafts: LedgerDraft[];
  cost: number;
  savedMs: number;
  /** Ускоренные работы в порядке их завершения. */
  jobs: BuildJob[];
  items: InventoryItem[];
  busyAfter: number;
  freeAfter: number;
}

/**
 * Ускорить всю очередь разом.
 *
 * Один чек на пачку, а не N списаний: так скидка видна игроку одной цифрой, в
 * журнале остаётся одно действие (а не 20 строк, размывающих аналитику), и ключ
 * идемпотентности переживает ретрай того же состава очереди.
 */
export function speedupAllBuilds(account: UserAccount, now: Date, idFactory: () => string): SpeedupAllResult {
  const base = settleBuilds(account, now, idFactory).account;
  const active = activeBuilds(base, now)
    .slice()
    .sort((a, b) => a.endsAt.getTime() - b.endsAt.getTime());

  if (active.length === 0) {
    throw new AppError(ErrorCodes.NOTHING_TO_RUSH, 409, 'Нечего ускорять: очередь стройки пуста');
  }

  const quote = describeSpeedupAll(base, now);
  if (quote.reason === 'inventory_full') {
    throw new AppError(ErrorCodes.INVENTORY_FULL, 409, 'Инвентарь не примет все ускоренные работы — освободите место', {
      waiting: quote.count,
      limit: MAX_INVENTORY_ITEMS
    });
  }
  if (quote.reason !== 'ok') {
    throw new AppError(ErrorCodes.INSUFFICIENT_FUNDS, 409, `Недостаточно ${TECH_LABEL.chronium.label.toLowerCase()}: нужно ${quote.cost}`, {
      currency: 'chronium',
      required: quote.cost,
      available: base.materials.chronium,
      reason: 'upgrade'
    });
  }

  const cost = quote.cost;
  const savedMs = quote.savedMs;
  // Подпись состава очереди: повтор того же запроса тем же составом — тот же ключ,
  // изменённая очередь — новый ключ (старые работы уже оплачены и ушли в инвентарь).
  const signature = active.map((job) => job.id).join('+');

  const spent = spendTech(base, 'chronium', cost, {
    ts: now,
    reason: 'upgrade',
    refType: 'build_job',
    refId: null,
    idempotencyKey: makeIdempotencyKey('rush', `all:${signature}`),
    meta: { count: active.length, saved_ms: savedMs, cost, bundle_discount: CHRONIUM_BUNDLE_DISCOUNT }
  });

  const ids = new Set(active.map((job) => job.id));
  const queued: UserAccount = {
    ...spent.account,
    builds: spent.account.builds.map((candidate) =>
      ids.has(candidate.id) ? { ...candidate, endsAt: now } : candidate
    )
  };

  const after = settleBuilds(queued, now, idFactory);
  // Сверяем только предметы: сооружения приехали в счётчики, а не в `items`, и
  // сравнение с полной длиной очереди дало бы ложный INTERNAL на каждой ускоренной
  // постройке здания.
  const expectedItems = active.filter((job) => job.kind !== 'structure').length;
  if (after.items.length !== expectedItems) {
    throw new AppError(ErrorCodes.INTERNAL, 500, 'Ускорение очереди: список работ и выданных предметов разошлись', {
      expected: expectedItems,
      issued: after.items.length,
      cost
    });
  }

  return {
    account: after.account,
    drafts: [spent.draft],
    cost,
    savedMs,
    jobs: active.map((job) => ({ ...job, endsAt: now })),
    items: after.items,
    busyAfter: buildersBusy(after.account, now),
    freeAfter: buildersFree(after.account, now)
  };
}

