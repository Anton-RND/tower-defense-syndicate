import { type CraftTechId } from './materials.js';

/**
 * Каталог платящих SKU (Часть 1: монетизация через окно оплаты ВК).
 *
 * ЗДЕСЬ ЖИВЁТ ИСТИНА О ТОМ, ЧТО ПРОДАЁТСЯ. Клиент не присылает ни цену, ни состав
 * награды — он присылает только `sku`, а сервер сам знает, сколько астерия (или
 * сырья) за него выдать. Любая другая схема («клиент сказал, что купил pack_100
 * за 10 рублей») — дыра, через которую материалы печатают нулевой стоимостью.
 *
 * ДВА РЕЖИМА ОКНА ОПЛАТЫ ВК — оба поддержаны явно, потому что это разные продукты
 * площадки и разные payload подтверждения:
 *
 *  1. `type: 'item'` — товар, заведённый в панели разработчика («Витрина» / VK Pay).
 *     Подтверждение приносит `order_id` + имя товара. Это рекомендуемый путь для
 *     новых Mini Apps: товар виден в витрине, его цена управляется с площадки.
 *  2. `type: 'votes'` — Голоса, внутренняя валюта площадки. Подтверждение приносит
 *     количество голосов, а не наш SKU, поэтому связь «голоса → материал» обязана
 *     быть зафиксирована здесь (`votes` у SKU) и проверяться при выдаче.
 *
 * ТРИ ВИДА НАГРАДЫ: `asterium` (донатная валюта, два кошелька), `material` (сырьё:
 * хрониум/вольфрам/станиум, плоский счётчик) и `entitlement` (привилегия со сроком).
 *
 * ЧЕГО ЗДЕСЬ НЕТ: «бонусных» единиц отдельным кошельком. Весь выданный за деньги
 * астерий падает в `materials.asterium.purchased` и потому полностью отрабатывается
 * при refund (`wallet.refundAsterium`): иначе chargeback оставлял бы игроку бонус,
 * то есть превращался бы в способ получить валюту бесплатно. Сырьё при refund
 * уходит в минус (`wallet.refundTech`) и блокирует трату до отработки долга.
 */

/** То, что отдаёт `VKWebAppShowOrderBox` для конкретного SKU. */
export interface OrderBoxParams {
  type: 'votes' | 'item';
  /** Имя товара в панели разработчика. Обязательно при type='item', null при 'votes'. */
  item: string | null;
}

/** Вид награды. Структурно совпадает с EntitlementKind из домена игрока. */
export type SkuEntitlementKind = 'builder_slot' | 'warehouse_boost' | 'mine_boost' | 'energy_boost' | 'shield';

interface SkuBase {
  /** Артикул каталога — единственное, что клиент имеет право прислать. */
  sku: string;
  label: string;
  /**
   * Цена для витрины, рубли. СПРАВОЧНАЯ: списывает её площадка, и именно её вернёт
   * сверка с агентом выплат. Расхождение с подтверждением — повод не выдавать товар.
   */
  priceRub: number;
  box: OrderBoxParams;
  /** Сколько Голосов списывается при type='votes' (для сверки подтверждения). */
  votes: number | null;
  /** true — позиция снята с продажи, но старые заказы продолжают исполняться. */
  retired?: boolean;
}

/** Пакет донатной валюты («Астерий»): два кошелька, купленный и заработанный. */
export interface AsteriumSku extends SkuBase {
  kind: 'asterium';
  amount: number;
}

/**
 * Пакет сырья (хрониум / вольфрам / станиум).
 *
 * В отличие от астерия это плоский счётчик: единицы не различаются по
 * происхождению, и рефанд платежа снимает начисленное «в минус» (wallet.refundTech) —
 * долг по сырью блокирует трату сам собой, потому что списывать нечего.
 */
export interface MaterialSku extends SkuBase {
  kind: 'material';
  material: CraftTechId;
  amount: number;
}

/** Прямая покупка привилегии: щит, буст, слот — без промежуточной валюты. */
export interface EntitlementSku extends SkuBase {
  kind: 'entitlement';
  entitlement: {
    kind: SkuEntitlementKind;
    /** Слоты — целое >= 1; множители — > 1; щит — 0 (важен только срок). */
    value: number;
    /** null — бессрочно (осторожно: такие вещи не продаются дважды «в одни руки»). */
    durationMs: number | null;
  };
}

export type ShopSku = AsteriumSku | MaterialSku | EntitlementSku;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/**
 * Пакеты астерия: цена за единицу падает с размером пака — стандартная практика,
 * игроку выгодно взять большой, площадке — понятен ARPPU.
 */
export const SHOP_SKUS: readonly ShopSku[] = [
  {
    kind: 'asterium',
    sku: 'asterium_pack_500',
    label: '500 астерия',
    amount: 500,
    priceRub: 49,
    votes: 5,
    box: { type: 'item', item: 'asterium_pack_500' }
  },
  {
    kind: 'asterium',
    sku: 'asterium_pack_1500',
    label: '1 500 астерия',
    amount: 1500,
    priceRub: 129,
    votes: 13,
    box: { type: 'item', item: 'asterium_pack_1500' }
  },
  {
    kind: 'asterium',
    sku: 'asterium_pack_4000',
    label: '4 000 астерия',
    amount: 4000,
    priceRub: 299,
    votes: 29,
    box: { type: 'item', item: 'asterium_pack_4000' }
  },
  {
    kind: 'asterium',
    sku: 'asterium_pack_12000',
    label: '12 000 астерия',
    amount: 12_000,
    priceRub: 749,
    votes: 69,
    box: { type: 'item', item: 'asterium_pack_12000' }
  },
  // ─── Сырьё: хрониум, вольфрам, станиум ────────────────────────────────────────
  //
  // Продаются отдельными паками, а не «универсальной валютой»: у каждой воронки
  // своя цена, и игрок платит ровно за то, что нужно ему сейчас — ускориться,
  // собрать рельсотрон либо закрыть базу полем замедления перед сезоном PvP.
  {
    kind: 'material',
    material: 'chronium',
    sku: 'chronium_pack_15',
    label: '15 хрониума (15 минут ускорений)',
    amount: 15,
    priceRub: 29,
    votes: 3,
    box: { type: 'item', item: 'chronium_pack_15' }
  },
  {
    kind: 'material',
    material: 'chronium',
    sku: 'chronium_pack_60',
    label: '60 хрониума (1 час ускорений)',
    amount: 60,
    priceRub: 99,
    votes: 9,
    box: { type: 'item', item: 'chronium_pack_60' }
  },
  {
    kind: 'material',
    material: 'wolfram',
    sku: 'wolfram_pack_50',
    label: '50 вольфрама',
    amount: 50,
    priceRub: 79,
    votes: 7,
    box: { type: 'item', item: 'wolfram_pack_50' }
  },
  {
    kind: 'material',
    material: 'stanium',
    sku: 'stanium_pack_20',
    label: '20 станиума (5 часов поля замедления)',
    amount: 20,
    priceRub: 69,
    votes: 6,
    box: { type: 'item', item: 'stanium_pack_20' }
  },
  {
    kind: 'entitlement',
    sku: 'rest_shield_24h',
    label: 'Щит покоя, 24 часа',
    priceRub: 79,
    votes: null,
    box: { type: 'item', item: 'rest_shield_24h' },
    entitlement: { kind: 'shield', value: 0, durationMs: DAY_MS }
  },
  {
    kind: 'entitlement',
    sku: 'warehouse_x2_3d',
    label: 'Склады ×2 на 3 дня',
    priceRub: 119,
    votes: null,
    box: { type: 'item', item: 'warehouse_x2_3d' },
    entitlement: { kind: 'warehouse_boost', value: 2, durationMs: 3 * DAY_MS }
  },
  {
    kind: 'entitlement',
    sku: 'mine_x2_24h',
    label: 'Добыча ×2 на 24 часа',
    priceRub: 99,
    votes: null,
    box: { type: 'item', item: 'mine_x2_24h' },
    entitlement: { kind: 'mine_boost', value: 2, durationMs: DAY_MS }
  },
  {
    kind: 'entitlement',
    sku: 'energy_x2_7d',
    label: 'Реген энергии ×2 на 7 дней',
    priceRub: 149,
    votes: null,
    box: { type: 'item', item: 'energy_x2_7d' },
    entitlement: { kind: 'energy_boost', value: 2, durationMs: 7 * DAY_MS }
  }
];

const bySku = new Map<string, ShopSku>(SHOP_SKUS.map((item) => [item.sku, item]));
const byBoxItem = new Map<string, ShopSku>(
  SHOP_SKUS.filter((item) => item.box.item !== null).map((item) => [item.box.item as string, item])
);

/** SKU по артикулу. undefined — позиция не продаётся. */
export function getSku(sku: string): ShopSku | undefined {
  return bySku.get(sku);
}

/** SKU по имени товара в панели ВК: подтверждение `type:'item'` приносит именно его. */
export function getSkuByBoxItem(item: string): ShopSku | undefined {
  return byBoxItem.get(item);
}

/** Витрина для клиента: без внутренних полей, только то, что можно показать. */
export interface CatalogEntryView {
  sku: string;
  label: string;
  kind: ShopSku['kind'];
  priceRub: number;
  /** Сколько единиц астерия/сырья даёт пак (null — для привилегий). */
  amount: number | null;
  /** Какой именно материал (только для kind='material'). */
  material: CraftTechId | null;
  box: OrderBoxParams;
}

export function describeCatalog(): CatalogEntryView[] {
  return SHOP_SKUS.filter((item) => !item.retired).map((item) => ({
    sku: item.sku,
    label: item.label,
    kind: item.kind,
    priceRub: item.priceRub,
    amount: item.kind === 'asterium' || item.kind === 'material' ? item.amount : null,
    material: item.kind === 'material' ? item.material : null,
    box: { ...item.box }
  }));
}
