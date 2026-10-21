import type { EconomyConfig, Platform } from '../../config/env.js';
import { emptyStorage, STORAGE_IDS, type StorageId } from '../../config/storage.js';
import { emptyStructures, STRUCTURE_IDS, type StructureId } from '../../config/structures.js';
import { DEFAULT_HQ, type Cell } from '../../config/base.js';
import {
  emptyAsterium,
  emptyTech,
  type AsteriumWallet,
  type AsteriumWalletName,
  type TechWallet
} from '../../config/materials.js';
import { PVP_RATING_START } from '../../config/pvp.js';
import { emptyJunk, emptyMetals, type BuildKind, type ItemKind, type JunkInventory, type MetalsInventory } from '../../config/workshop.js';
import type { SocialIdentity } from '../auth/vk.adapter.js';

/**
 * Кошелёк игрока (уже собранные ресурсы + энергия).
 *
 * `sec` стоит рядом с рудами сознательно, хотя природа у него другая: руды попадают
 * сюда РУКОЙ игрока (`collectWarehouse`), а SEC — ПРОМЫШЛЕННЫМ ТИКОМ, минуя цистерны
 * (см. `COIN_IDS` в config/storage.ts). Тем не менее это деньги, а не запас: их видно
 * в витрине, их тратят сооружения (`secCost` ASIC-стоек, списание — `spendSec`), и
 * журнал по ним обязан вести тот же учёт, что по остальным валютам.
 *
 * ВАРИАНТ «SEC ТРАТЯТ ЧЕРТЕЖИ» БЫЛ НАПИСАН ЗДЕСЬ РАНЬШЕ — И БЫЛ НЕПРАВДКОЙ, которая
 * стоила проекту месяца: монета не входит в `MaterialId` (config/workshop.ts), поэтому
 * ни один чертёж её требовать не мог, а `materialEntries` молча выбрасывает незнакомый
 * ключ — то есть даже опечатка в конфиге не обнаружила бы этого. Читателю комментария
 * оставалось только поверить, что у монеты есть применение, и не искать его. Правило
 * здесь теперь такое же, как про «SEC не называют криптой без отрицания рядом»
 * (VK_CATALOG.md): комментарий о том, куда уходит ценность, обязан проверяться тестом,
 * иначе это маркетинг, а не документация.
 *
 * Отдельный блок означал бы вторую копию `credit`/`debit`, второй `balanceLabel` и
 * второй путь в `walletSchema` — ровно ту разметку ценностей, из-за которой «откуда у
 * игрока 10 000» перестаёт отвечаться одним запросом.
 */
export interface ResourceWallet {
  energy: number;
  ferrum: number;
  silicium: number;
  uranium: number;
  plasma: number;
  /** Криптообеспечение ASIC (`COIN_IDS.sec`): капает в кошелёк напрямую, без склада. */
  sec: number;
}

export type ResourceId = keyof ResourceWallet;

/**
 * Астерий («донорно-премиальный материал») — наследник прежнего «критания».
 * Два кошелька — принципиально разные деньги:
 *  - purchased: куплены за реальные рубли. Не участвуют в рейдовом луте, не «отмываются»,
 *    из них вычитается рефанд платежа (вплоть до ухода в долг — см. wallet.refundAsterium).
 *  - earned:    заработаны (реклама, ассисты, события, бои). Тратятся ПЕРВЫМИ.
 *
 * Хрониум, вольфрам и станиум — плоские счётчики: они не продаются за рубли как
 * валюта и потому не нуждаются в раздельном учёте при возврате платежа.
 */
export type { AsteriumWallet, AsteriumWalletName, TechWallet };

/**
 * Состояние четырёх высокотехнологичных материалов (config/materials.ts).
 *
 * Держим их одним блоком, а не четырьмя полями верхнего уровня: документ игрока и
 * так содержит десятки секций, а здесь связка «астерий + сырьё + срок модуля»
 * меняется целиком одним балансным решением и читается как единое целое.
 */
export interface MaterialsState extends TechWallet {
  asterium: AsteriumWallet;
  /**
   * До какого момента на базе активен станиумный модуль (null — выключен).
   * Храним срок, а не булев флаг: игрок обязан видеть в витрине «осталось 12 минут»,
   * а рейд-резолвер — однозначно отвечать на вопрос «было ли поле активно в момент боя».
   */
  staniumFieldUntil: Date | null;
}

export function emptyMaterials(): MaterialsState {
  return { asterium: emptyAsterium(), ...emptyTech(), staniumFieldUntil: null };
}

/**
 * Накопители базы: руды экстракторов + промышленные газы и хладагенты.
 *
 * Когда-то это был `MinedWarehouse = Record<MiningResource, number>` — четыре ящика
 * под руду. Дейтерий и азот устроены физически точно так же (дробный остаток, ёмкость,
 * поточный приход и автоматический расход), и держать их вторым реестром означало бы
 * завести вторую копию тика, второго сборщика мусора по переполнению и вторую витрину
 * с другим набором edge-case'ов. Объединение здесь — не экономия на строчках, а
 * признание, что разница между «рудой» и «газом» теперь только в ИСТОЧНИКЕ прихода,
 * а не в природе запаса. Источник описан в `config/structures.ts`, запас — здесь.
 */
export type StoragePools = Record<StorageId, number>;

/** Строительный мусор прошлого реестра: имя сохранено как алиас для старой записи. */
export type MinedWarehouse = StoragePools;

/** Сооружения базы: счётчики экземпляров по видам из `config/structures.ts`. */
export type StructureCounts = Record<StructureId, number>;

/** Откуда предмет оказался у игрока: влияет на возможность отзыва при рефанде. */
export type ItemSource = 'build' | 'purchase' | 'event' | 'admin';

/**
 * Готовый предмет инвентаря (башня, дрон, оружие).
 *
 * Храним как сущности с собственным id, а не как `{ code: count }`, потому что
 * конкретную башню нужно (а) поставить на координату, (б) улучшать, (в) разобрать
 * именно её. Там, где единицы взаимозаменяемы (хлам, металлы), — наоборот, счётчики.
 */
export interface InventoryItem {
  id: string;
  kind: ItemKind;
  /** Код чертежа — стабилен: имена и баланс меняются, код нет. */
  code: string;
  level: number;
  acquiredAt: Date;
  source: ItemSource;
  /** Заказ/событие-источник — для тикетов поддержки и отзыва при рефанде. */
  orderId: string | null;
}

/** Стройка в работе: занимает ровно одного робота-строителя до `endsAt`. */
export interface BuildJob {
  id: string;
  code: string;
  /** `'structure'` — сооружение-счётчик; остальные виды — штучный предмет инвентаря. */
  kind: BuildKind;
  level: number;
  startedAt: Date;
  endsAt: Date;
}

/**
 * Учёт боевого лута. `lastRaidId` — грубая, но бесплатная защита от повторного
 * отчёта того же боя до того, как Шаг 4 заведёт полноценные записи рейдов.
 */
export interface LootState {
  /** Ключ суток UTC (YYYY-MM-DD) — как в assist. */
  day: string;
  /** Сколько боёв с лутом засчитано сегодня. */
  events: number;
  /** Сколько единиц хлама принесён сегодня (для антифрод-аналитики). */
  totalUnits: number;
  lastRaidId: string | null;
}

/**
 * PvP-профиль игрока (Шаг 4).
 *
 * Счётчики боев держим здесь же, а не в отдельной коллекции: они читаются на каждом
 * матче и на лестнице, и ни одно из них не участвует в чужой транзакции. Единственная
 * PvP-сущность вне документа игрока — сам бой, он в `pvp/battle.ts` и не хранится
 * вовсе (воспроизводится по входу).
 */
export interface PvpProfile {
  /** Эло-рейтинг. Индекс `platform + rating` — по нему работает матчмейкинг. */
  rating: number;
  /** Ключ суток UTC (YYYY-MM-DD) счётчика атак: суточный лимит — антифрод против бота. */
  day: string;
  attacksToday: number;
  battles: number;
  wins: number;
  draws: number;
  losses: number;
  /** Лучший рейтинг за время игры: сезонные награды и «я был алмазом» в профиле. */
  bestRating: number;
  /** Серия побед подряд (обнуляется на ничьей и поражении). */
  streak: number;
  /** Последний засчитанный бой — дедупликация отчёта резолвера (аналог loot.lastRaidId). */
  lastRaidId: string | null;
  lastBattleAt: Date | null;
}

/**
 * Реферальная связка (п.2.3, «пригласи друга»).
 *
 * Награда пригласившему выдаётся ровно один раз на приглашённого и только при
 * регистрации нового аккаунта: `invitedBy` ставится один раз и больше не меняется,
 * поэтому пересоздание аккаунта тем же `ref` не даёт вторую награду — счётчик
 * держится на стороне пригласившего, а не на словах клиента.
 */
export interface ReferralState {
  /** Кого пригласили меня (id аккаунта пригласившего). Ставится один раз. */
  invitedBy: string | null;
  /** Когда награда пригласившему выдана; null — ещё не выдавалась. */
  creditedAt: Date | null;
  /** Ключ суток UTC (YYYY-MM-DD) счётчика собственных приглашений. */
  day: string;
  /** Сколько приглашений засчитано сегодня (суточный потолок — антифрод). */
  count: number;
  /** Кого уже пригласил (анти-чит: один приглашённый — одна награда). */
  invited: string[];
}

/**
 * Заказ на покупку (Часть 1, монетизация). Живёт в документе игрока: идемпотентность
 * выдачи товара держится на состоянии аккаунта, а не на журнале, — иначе повторный
 * вебхук площадки выдал бы пак второй раз. Подробно — в modules/payment/orders.ts.
 */
export type OrderStatus = 'pending' | 'paid' | 'fulfilled' | 'void' | 'refunded';

export interface PurchaseOrder {
  /** `order:<userId>:<nonce>` — из id читается владелец: постбэк приходит без сессии. */
  id: string;
  sku: string;
  amount: number;
  priceRub: number;
  status: OrderStatus;
  createdAt: Date;
  expiresAt: Date;
  paidAt: Date | null;
  fulfilledAt: Date | null;
  refundedAt: Date | null;
  /** order_id площадки — внешний ключ сверки с агентом выплат и тикетов поддержки. */
  providerOrderId: string | null;
  note: string | null;
}

/** Что именно даёт купленная/выигранная привилегия (п. «Монетизация»: дефицит → закрытие). */
export type EntitlementKind =
  /** +N роботов-строителей (слоты очереди стройки, п.3.1). */
  | 'builder_slot'
  /** Множитель вместимости складов — закрывает «склады забились, пока я спал». */
  | 'warehouse_boost'
  /** Множитель скорости добычи. */
  | 'mine_boost'
  /** Множитель скорости регена энергии. */
  | 'energy_boost'
  /** База неуязвима для рейдов до expiresAt («Щит покоя»). */
  | 'shield';

export type EntitlementSource = 'purchase' | 'ad_reward' | 'event' | 'admin';

/**
 * Активная привилегия игрока. Храним как список фактов, а не как булевы флаги:
 * откат/revoke при возврате платежа = удалить одну запись, а не «додумывать» состояние.
 */
export interface Entitlement {
  id: string;
  /** Артикул каталога (SKU), например `robot_slot_3`, `warehouse_x2_7d`. */
  sku: string;
  kind: EntitlementKind;
  /** Слоты — целое; множители — 2 = x2; щит — игнорируется (важен expiresAt). */
  value: number;
  /** true => бессрочно (expiresAt = null). */
  permanent: boolean;
  expiresAt: Date | null;
  source: EntitlementSource;
  grantedAt: Date;
  /** Заказ-источник (идемпотентность выдачи и рефанд). */
  orderId: string | null;
}

/**
 * Исполненный постбэк рекламы: один `reward_id` площадки выдаёт награду ровно
 * один раз, сколько бы раз площадка его ни доставила.
 *
 * Храним именно ПЛОЩАДСКОЙ id, а не наш id сессии: наш `pending.id` после выдачи
 * стирается вместе со слотом, и сравнивать с ним повторный постбэк было бы нечем.
 */
export interface AdUsedReward {
  /** `reward_id` из подписанного постбэка (идентификатор площадки, не `pending.id`). */
  id: string;
  /** Момент выдачи награды по этому id; старше `ADS_REPLAY_WINDOW_SEC` — не помним. */
  at: Date;
}

/** Состояние rewarded-рекламы: суточный счётчик + одна «висящая» сессия показа. */
export interface AdState {
  /** Ключ суток UTC (YYYY-MM-DD) — как в assist. */
  day: string;
  /** Сколько наград за рекламу получено сегодня. */
  claimed: number;
  lastClaimAt: Date | null;
  /** Открытый показ: клиент обязан подтвердить его серверным postback'ом провайдера. */
  pending: {
    id: string;
    /** Что обещано за просмотр (SKU награды из каталога рекламных бустов). */
    sku: string;
    createdAt: Date;
    expiresAt: Date;
  } | null;
  /**
   * Уже исполненные `reward_id` площадки, от старых к новым (анти-реплей постбэка).
   *
   * Повторная доставка того же постбэка — штатное поведение рекламных сетей, а
   * слот показа после выдачи пуст, поэтому без этой памяти повтор попадал бы в
   * СЛЕДУЮЩИЙ показ игрока и оплачивал его (см. modules/ads/postback.ts).
   *
   * Честное ограничение: если площадка `reward_id` не шлёт вовсе, помнить нечего
   * и реплей отбивается только лимитами. Поле тогда остаётся пустым — это
   * наблюдаемое свойство живого кабинета, а не опция.
   */
  used: AdUsedReward[];
}

/**
 * Планировка обороны (Шаг 3). Живёт ВНУТРИ документа игрока, а не в отдельной
 * коллекции `PvpDefense` — и это не экономия на индексах.
 *
 * Расстановка ссылается на `itemId` предметов из `inventory`. Отдельная коллекция
 * означала бы два документа, обновляемых одним игровым действием, при том что стор
 * атомарен только в пределах одного (CAS по `revision`). Последствия конкретны:
 * предмет разобрали — башня осталась на карте; башню сняли с карты — предмет остался
 * «занятым»; рефанд отозвал предмет — чужой бой идёт по несуществующей турели.
 * Здесь же планировка и инвентарь меняются в одном редукторе, и «всё или ничего»
 * распространяется на оба.
 *
 * Отдельно: признак «карта проходим» здесь НЕ хранится. Он производен от сетки и от
 * того, какие предметы ещё живы, — и любой хранимый флаг неминуемо устаревает
 * (см. `buildersBusy` в workshop/craft). Проходимость считается `analyzeLayout`
 * на чтении.
 */

/** Занятая башней/орудием клетка. Код и тир единицы не дублируются: они в инвентаре. */
export interface DeployedUnit {
  itemId: string;
  x: number;
  y: number;
}

/** Состояние базы защитника. */
export interface BaseState {
  /** Штаб — обязательно одна из площадок `HQ_PADS` (проверяет modules/pvp/defense). */
  hq: Cell;
  /** Стены: расходуемый материал, поэтому только координаты, без id и без кодов. */
  walls: Cell[];
  /** Выставленные единицы инвентаря. Их наличие делает предмет «занятым» (dismantle откажет). */
  units: DeployedUnit[];
  /**
   * Счётчик эффективных изменений. Не версия записи (`revision`) и не блокировка:
   * это защита редактора от отправки устаревшего снапшота — клиент, продержавший
   * открытым 20 минут и нажавший «сохранить», должен получить конфликт, а не тихо
   * откатить свою же новую планировку.
   */
  version: number;
  updatedAt: Date;
}

/**
 * Единственная доменная модель игрока. Поле за полем совпадает с ТЗ (п.1 «User Schema»),
 * плюс склад `mined` — то, что ещё не собрано вручную и что можно потерять при атаке (п.4.1).
 */
export interface UserAccount {
  id: string;
  /** 'vk' | 'tg' */
  platform: Platform;
  /** Социальный id (VK viewer_id). */
  socialId: string;
  appId: string | null;
  groupId: string | null;

  createdAt: Date;
  lastLoginAt: Date;

  resources: ResourceWallet;
  /**
   * Содержимое накопителей (п.2.2 для руд; дейтерий и азот — новые цистерны).
   * Хранится дробным, отдаётся целым. Расходуется промышленностью автоматически.
   */
  storages: StoragePools;
  /** Вместимость склада (ед.) — базовая, на каждый ресурс отдельно. Поверх неё — ёмкости построек. */
  storageCapacity: number;
  /** Ставки добычи руды, ед./час. */
  miningRates: StoragePools;
  /**
   * Сооружения базы (реакторы, кулеры, цехи, ASIC, цистерны) — счётчики экземпляров.
   * Не инвентарь: у сооружения нет id, координаты и возможности «снять с карты», а его
   * вклад в экономику аддитивен. Подробно — в шапке `config/structures.ts`.
   */
  structures: StructureCounts;

  /** Момент последнего расчёта офлайн-майнинга / сбора (п.1 модели). */
  lastLootTime: Date;
  /** Момент последнего расчёта регена энергии. */
  energyUpdatedAt: Date;

  /** Состояние виральной механики «Помощь друга» (п.2.3). */
  assist: {
    /** Ключ суток UTC (YYYY-MM-DD), для сброса лимита. */
    day: string;
    /** Сколько восстановлений принято за сутки. */
    count: number;
    /** Кто уже помогал (анти-чит: один друг — один раз). */
    helpers: string[];
  };

  /**
   * БАЗОВОЕ число роботов-строителей (п.3.1), по умолчанию 2.
   * Купленные в магазине слоты сюда НЕ пишутся: они живут перманентными
   * entitlement'ами `builder_slot` и решаются лениво (effectiveBuildRobots).
   * Поэтому рефанд платежа откатывает слот одной операцией удаления записи.
   */
  buildRobots: number;

  /** Готовые предметы: башни, дроны, оружие. Единицы НЕ взаимозаменяемы → сущности. */
  inventory: InventoryItem[];
  /** Очередь стройки. `buildersBusy` выводится отсюда, а не хранится (см. workshop/craft). */
  builds: BuildJob[];
  /** Планировка обороны: сетка, штаб, выставленные единицы (см. modules/pvp). */
  base: BaseState;
  /** Хлам (взаимозаменяемые единицы) → счётчики: 6 чисел вместо массива на тысячи строк. */
  junk: JunkInventory;
  /** Переработанные металлы — сырьё чертежей 2–3 тира. */
  metals: MetalsInventory;
  /** Состояние боевого лута (суточный лимит событий + дедупликация отчётов). */
  loot: LootState;
  /** PvP: рейтинг, статистика боёв, суточный счётчик атак (Шаг 4). */
  pvp: PvpProfile;
  /** Социальная связка «пригласи друга» (п.2.3). */
  referral: ReferralState;

  /** Четыре материала: астерий (два кошелька), хрониум, вольфрам, станиум + срок станиумного модуля. */
  materials: MaterialsState;
  /** Активные привилегии (купленные бусты, доп. слоты, щиты). Протухшие вычищает тик. */
  entitlements: Entitlement[];
  /** Состояние rewarded-рекламы. */
  ads: AdState;

  /** Заказы на покупку (Часть 1): история + идемпотентность выдачи товара. */
  orders: PurchaseOrder[];
  /**
   * Клан (Часть 2). Строковый id, а не ObjectId: стор абстрактный (memory/mongo).
   * Членство хранится и в клане (`members`), и здесь — как в любых связанных
   * документах без транзакций; источником истины при расхождении считается клан,
   * а `clanId` игрока — его кэш для быстрого «в каком я клане» (см. modules/clan).
   */
  clanId: string | null;

  /** Версия записи — CAS-блокировка для Mongo-стора. */
  revision: number;
}

export function emptyStorages(): StoragePools {
  return emptyStorage();
}

/** Нулевой набор сооружений. Отдельная функция, а не literal: перечень видов живёт в конфиге. */
export function emptyStructureCounts(): StructureCounts {
  return emptyStructures();
}

export function emptyLoot(day: string): LootState {
  return { day, events: 0, totalUnits: 0, lastRaidId: null };
}

/**
 * Новый PvP-профиль: стартовый рейтинг и нули.
 * `bestRating` стартует с rating — иначе «лучший рейтинг» новичка был бы 0 и витрина
 * достижений врала бы с первого экрана.
 */
export function emptyPvp(day: string): PvpProfile {
  return {
    rating: PVP_RATING_START,
    day,
    attacksToday: 0,
    battles: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    bestRating: PVP_RATING_START,
    streak: 0,
    lastRaidId: null,
    lastBattleAt: null
  };
}

export function emptyReferral(day: string): ReferralState {
  return { invitedBy: null, creditedAt: null, day, count: 0, invited: [] };
}

/**
 * Пустая база: штаб на площадке по умолчанию, ни стены, ни башен.
 *
 * Существенно, что это состояние валидно само по себе — игрок может быть подобран в
 * PvP до первого своего действия. Просроченные документы (до Шага 3) маппятся именно
 * сюда, а не в null: `null` означал бы ветку «базы нет» в каждом бойце-резолвере.
 */
export function emptyBase(now: Date): BaseState {
  return { hq: { ...DEFAULT_HQ }, walls: [], units: [], version: 0, updatedAt: now };
}

export function cloneBase(base: BaseState): BaseState {
  return {
    hq: { ...base.hq },
    walls: base.walls.map((cell) => ({ ...cell })),
    units: base.units.map((unit) => ({ ...unit })),
    version: base.version,
    updatedAt: new Date(base.updatedAt)
  };
}

/**
 * Сколько выставленных на карту единиц каждого кода.
 *
 * Живёт в домене, а не в витрине, потому что его потребляют и `economy/industry.ts`
 * (тик), и `economy/view.ts` (DTO). Тик, импортирующий DTO-модуль, — перевёрнутая
 * зависимость: слой, знающий про формат ответа, оказывается ниже слоя физики.
 *
 * Ссылка `itemId` → код через инвентарь: «призрак» (предмет отозван, а клетка занята)
 * даёт код, которого в чертежах нет, и `unitPowerProfile` на него вернёт null — такая
 * единица сеть не нагружает, что совпадает с поведением `defenseSnapshot` в бою.
 */
export function deployedUnitCodes(account: UserAccount): Record<string, number> {
  const codeOf = new Map(account.inventory.map((item) => [item.id, item.code]));
  const counts: Record<string, number> = {};
  for (const unit of account.base?.units ?? []) {
    const code = codeOf.get(unit.itemId);
    if (!code) continue;
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

export function storageRatesOf(rates: Partial<Record<StorageId, number>> | undefined): StoragePools {
  const result = emptyStorages();
  for (const resource of STORAGE_IDS) {
    result[resource] = Number(rates?.[resource] ?? 0);
  }
  return result;
}

/**
 * Нормализация накопителей при чтении чужих/старых данных.
 *
 * Документы старше промышленного контура содержат четыре ключа вместо шести, а
 * документы до объединения полей — вообще под именем `mined`. Приведение сделано
 * здесь, а не в вызывающих кодах: читатель тика не должен каждый раз вспоминать,
 * какая из трёх исторических форм у документа в руках (тот же приём, что для `base`).
 */
export function normalizeStorages(raw: unknown): StoragePools {
  const result = emptyStorages();
  if (!raw || typeof raw !== 'object') return result;
  const source = raw as Record<string, unknown>;
  for (const resource of STORAGE_IDS) {
    const value = Number(source[resource]);
    result[resource] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return result;
}

/** Нормализация счётчиков сооружений: Недостающие виды → 0, мусор → отброшен. */
export function normalizeStructures(raw: unknown): StructureCounts {
  const result = emptyStructureCounts();
  if (!raw || typeof raw !== 'object') return result;
  const source = raw as Record<string, unknown>;
  for (const id of STRUCTURE_IDS) {
    const value = Math.trunc(Number(source[id]));
    result[id] = Number.isFinite(value) && value > 0 ? value : 0;
  }
  return result;
}

export function cloneAccount(account: UserAccount): UserAccount {
  return {
    ...account,
    createdAt: new Date(account.createdAt),
    lastLoginAt: new Date(account.lastLoginAt),
    lastLootTime: new Date(account.lastLootTime),
    energyUpdatedAt: new Date(account.energyUpdatedAt),
    resources: { ...account.resources },
    // Документы до промышленного контура полей `storages`/`structures` не имеют:
    // фолбэк здесь, а не в вызывающих кодах (тот же приём, что для `base` ниже).
    storages: account.storages ? { ...account.storages } : emptyStorages(),
    miningRates: account.miningRates ? { ...account.miningRates } : emptyStorages(),
    structures: account.structures ? { ...account.structures } : emptyStructureCounts(),
    assist: { ...account.assist, helpers: [...account.assist.helpers] },
    inventory: account.inventory.map((item) => ({ ...item, acquiredAt: new Date(item.acquiredAt) })),
    builds: account.builds.map((job) => ({
      ...job,
      startedAt: new Date(job.startedAt),
      endsAt: new Date(job.endsAt)
    })),
    // Документы до Шага 3 поля `base` не имеют — фолбэк здесь, а не в вызывающих кодах,
    // чтобы читателям не приходилось каждый раз вспоминать про миграцию по чтению.
    base: account.base ? cloneBase(account.base) : emptyBase(account.createdAt),
    junk: { ...account.junk },
    metals: { ...account.metals },
    loot: { ...account.loot },
    // PvP-профиль и рефералы появились в Шаге 4: документы старше него полей не имеют,
    // и фолбэк здесь (а не в вызывающих кодах) — тот же приём, что и для `base` выше.
    pvp: account.pvp ? { ...account.pvp } : emptyPvp(account.createdAt.toISOString().slice(0, 10)),
    referral: account.referral
      ? { ...account.referral, invited: [...account.referral.invited] }
      : emptyReferral(account.createdAt.toISOString().slice(0, 10)),
    materials: {
      ...account.materials,
      asterium: { ...account.materials.asterium },
      // Дата копируется как Date: cloneAccount вызывается на каждом transact, и
      // «строка вместо Date» в редукторе сломала бы сравнение staniumFieldUntil.getTime().
      staniumFieldUntil: account.materials.staniumFieldUntil
        ? new Date(account.materials.staniumFieldUntil)
        : null
    },
    entitlements: account.entitlements.map((ent) => ({
      ...ent,
      grantedAt: new Date(ent.grantedAt),
      expiresAt: ent.expiresAt ? new Date(ent.expiresAt) : null
    })),
    ads: {
      ...account.ads,
      lastClaimAt: account.ads.lastClaimAt ? new Date(account.ads.lastClaimAt) : null,
      pending: account.ads.pending ? { ...account.ads.pending } : null,
      // Копия массива с датами-копиями: cloneAccount вызывают на каждом transact, и
      // общий ссылочный массив позволил бы одному редуктору испортить чужой.
      used: account.ads.used.map((used) => ({ id: used.id, at: new Date(used.at) }))
    },
    // Даты заказов копируются как Date: cloneAccount вызывается на каждом transact,
    // и «строка вместо Date» в редукторе сломала бы сравнения expiresAt.getTime().
    orders: (account.orders ?? []).map((order) => ({
      ...order,
      createdAt: new Date(order.createdAt),
      expiresAt: new Date(order.expiresAt),
      paidAt: order.paidAt ? new Date(order.paidAt) : null,
      fulfilledAt: order.fulfilledAt ? new Date(order.fulfilledAt) : null,
      refundedAt: order.refundedAt ? new Date(order.refundedAt) : null
    })),
    clanId: account.clanId ?? null
  };
}

/** Создаёт новую запись игрока с «нулевой» базой стартовых значений. */
export function createAccount(
  identity: Pick<SocialIdentity, 'platform' | 'socialId' | 'appId' | 'groupId'>,
  now: Date,
  config: EconomyConfig,
  idFactory: () => string
): UserAccount {
  const iso = now.toISOString();
  return {
    id: idFactory(),
    platform: identity.platform,
    socialId: identity.socialId,
    appId: identity.appId,
    groupId: identity.groupId,
    createdAt: now,
    lastLoginAt: now,
    // Энергию даём полную — игрок сразу может сходить в PvP (п.2.3).
    resources: { energy: config.energyCap, ferrum: 0, silicium: 0, uranium: 0, plasma: 0, sec: 0 },
    storages: emptyStorages(),
    storageCapacity: config.storageCapacity,
    miningRates: storageRatesOf(config.miningRates),
    structures: emptyStructureCounts(),
    lastLootTime: now,
    energyUpdatedAt: now,
    // Отметки стартуют с «сегодняшнего» дня, чтобы суточный лимит ассистов считался верно.
    assist: { day: iso.slice(0, 10), count: 0, helpers: [] },
    buildRobots: config.buildRobotsDefault,
    // Инвентарь новичка пуст: первый предмет он соберёт сам, из ресурсов майнинга.
    inventory: [],
    builds: [],
    // База новичка не пуста в смысле «не готова к бою»: штаб на площадке по умолчанию,
    // путь от ворот свободен — игрока можно подобрать в PvP сразу, до первой постройки.
    base: emptyBase(now),
    junk: emptyJunk(),
    metals: emptyMetals(),
    loot: emptyLoot(iso.slice(0, 10)),
    // Рейтинг новичка — стартовый, а не нулевой: матчмейкинг ищет по коридору вокруг
    // значения, и с нуля новичок никогда бы не нашёл соперника того же уровня.
    pvp: emptyPvp(iso.slice(0, 10)),
    referral: emptyReferral(iso.slice(0, 10)),
    // Новичок без материалов: платный астерий появляется только из заказа, заработанный —
    // из рекламы/событий, сырьё (хрониум, вольфрам, станиум) — из цеха переработки и магазина.
    materials: emptyMaterials(),
    entitlements: [],
    ads: { day: iso.slice(0, 10), claimed: 0, lastClaimAt: null, pending: null, used: [] },
    orders: [],
    // Новичок без клана: основание клана — платющее действие, а не состояние по умолчанию.
    clanId: null,
    revision: 0
  };
}
