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
