import type { AdOffer } from '../modules/ads/rewarded.js';

/**
 * Каталог rewarded-наград (Часть 1.5, п. «Монетизация: реклама»).
 *
 * То же правило, что и у shop.ts: истину о том, что даёт просмотр ролика, знает
 * только сервер. Клиент присылает исключительно `sku` — состав и размер награды
 * берутся отсюда. Любая другая схема («клиент сказал, что ролик даёт 100 станиума»)
 * — это принтер сырья за бесплатно.
 *
 * Тип награды ИМПОРТИРУЕТСЯ из домена рекламы, а не дублируется здесь: rewarded.ts
 * определяет разброс наград (энергия / астерий / сырьё / привилегия), и второй
 * экземпляр этого union'а гарантированно разъехался бы с первым — каталог начал бы
 * предлагать то, что резолвер не умеет выдавать. Импорт только типов: `import type`
 * стирается компилятором, рантайм-ребра config → modules здесь нет.
 *
 * Баланс: рекламный кран намеренно мельче покупного (см. шапку rewarded.ts) —
 * 1-2 единицы сырья за показ. Щедрый кран превратил бы «посмотри ролик» в замену
 * магазину и обнулил ARPPU на материалах.
 */

const HOUR_MS = 60 * 60_000;

export const AD_OFFERS: readonly AdOffer[] = [
  {
    sku: 'ad_energy_25',
    label: '25 энергии',
    reward: { kind: 'energy', units: 25 }
  },
  {
    sku: 'ad_asterium_10',
    label: '10 заработанного астерия',
    reward: { kind: 'asterium', amount: 10 }
  },
  {
    sku: 'ad_chronium_2',
    label: '2 хрониума (2 минуты ускорений)',
    reward: { kind: 'material', material: 'chronium', amount: 2 }
  },
  {
    sku: 'ad_wolfram_1',
    label: '1 вольфрам',
    reward: { kind: 'material', material: 'wolfram', amount: 1 }
  },
  {
    sku: 'ad_stanium_1',
    label: '1 станиум (15 минут поля замедления)',
    reward: { kind: 'material', material: 'stanium', amount: 1 }
  },
  /**
   * Хлам за рекламу. Три позиции, а не шесть: `chips`/`batteries`/`boards` запирают
   * тир-1 и тир-2 (первый дрон, первая турель, вторая башня), то есть именно ту
   * ступень, на которой игрок зависает навсегда. `engines`, `transmissions` и
   * `ammo_casings` остаются боевыми — отдавать их здесь значило бы заменить PvP
   * тапаньем по роликам (см. шапку файла).
   *
   * По 2 единицы за показ = один предмет за одну награду: дрон стоит 2 батареи,
   * турель — 2 чипа. Игрок, потерявший флот, восстанавливает боеспособность за
   * несколько просмотров, а не ждёт, пока ему кто-нибудь выгорит базу.
   */
  {
    sku: 'ad_chips_2',
    label: '2 чипа (первая лазерная турель)',
    reward: { kind: 'junk', junk: 'chips', amount: 2 }
  },
  {
    sku: 'ad_batteries_2',
    label: '2 батареи (первый грузовой дрон)',
    reward: { kind: 'junk', junk: 'batteries', amount: 2 }
  },
  {
    sku: 'ad_boards_2',
    label: '2 платы (узлы тир-2)',
    reward: { kind: 'junk', junk: 'boards', amount: 2 }
  },
  {
    sku: 'ad_shield_1h',
    label: 'Щит покоя на 1 час',
    reward: {
      kind: 'entitlement',
      entitlement: { sku: 'ad_shield_1h', kind: 'shield', value: 0, durationMs: HOUR_MS }
    }
  }
];

const bySku = new Map<string, AdOffer>(AD_OFFERS.map((offer) => [offer.sku, offer]));

/** Offer по артикулу. undefined — такая награда не выдаётся (клиент ошибся sku). */
export function getAdOffer(sku: string): AdOffer | undefined {
  return bySku.get(sku);
}

/** Витрина рекламных наград. Каталог неизменяем, поэтому копий не делаем. */
export function describeAdOffers(): readonly AdOffer[] {
  return AD_OFFERS;
}
