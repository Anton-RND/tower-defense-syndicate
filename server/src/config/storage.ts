/**
 * Накопители (bulk) и сырьё экстракторов — единый словарь физических запасов базы.
 *
 * Почему отдельный файл, а не расширение `env.MINING_RESOURCES`:
 *  - `MINING_RESOURCES` описывает то, что РОЖДЕТСЯ буром и ЖДЁТ РУКИ игрока (п.2.2);
 *  - `STORAGE_IDS` описывает то, что НАКАПЛИВАЕТСЯ в цистернах и расходуется
 *    промышленностью автоматически (дейтерий, азот).
 * Объединять их в один тип нужно потому, что и те и другие живут в одном поле
 * `account.storages` с одной моделью «дробное число + ёмкость + поточный приход».
 * Различаются они лишь источником прихода, и это различие — в конфиге сооружений,
 * а не в типе ресурса.
 *
 * Чего здесь сознательно НЕТ:
 *  - `energy` — это стамина (п.2.3), а не физический запас: у неё реген, кап, ассисты
 *    и реклама. Смешать её с сетью нельзя (см. modules/economy/power.ts).
 *  - `ferrum/silicium/...` из кошелька — это уже СОБРАННЫЕ ресурсы, отдельные числа.
 *  - драгметаллы и хлам — штучный учёт, `config/workshop.ts`.
 */

/** Руды, которые роют экстракторы (п.2.2). Совпадает с `env.MINING_RESOURCES`. */
export const ORE_IDS = ['ferrum', 'silicium', 'uranium', 'plasma'] as const;
export type OreId = (typeof ORE_IDS)[number];

/** Промышленные газы и хладагенты: наливаешь в цистерну, расходуется автоматически. */
export const FLUID_IDS = ['deuterium', 'nitrogen'] as const;
export type FluidId = (typeof FLUID_IDS)[number];

/** Всё, что хранится в `account.storages` дробными числами. */
export const STORAGE_IDS = [...ORE_IDS, ...FLUID_IDS] as const;
export type StorageId = (typeof STORAGE_IDS)[number];

/** Валюты, капающие напрямую в кошелёк, минуя цистерны (продукт ASIC). */
export const COIN_IDS = ['sec'] as const;
export type CoinId = (typeof COIN_IDS)[number];

const oreSet: ReadonlySet<string> = new Set<string>(ORE_IDS);
const fluidSet: ReadonlySet<string> = new Set<string>(FLUID_IDS);
const storageSet: ReadonlySet<string> = new Set<string>(STORAGE_IDS);
const coinSet: ReadonlySet<string> = new Set<string>(COIN_IDS);

export function isOreId(value: string): value is OreId {
  return oreSet.has(value);
}
export function isFluidId(value: string): value is FluidId {
  return fluidSet.has(value);
}
export function isStorageId(value: string): value is StorageId {
  return storageSet.has(value);
}
export function isCoinId(value: string): value is CoinId {
  return coinSet.has(value);
}

/** Пустой набор накопителей — стартовое состояние и база для миграций. */
export function emptyStorage(): Record<StorageId, number> {
  return { ferrum: 0, silicium: 0, uranium: 0, plasma: 0, deuterium: 0, nitrogen: 0 };
}

export const STORAGE_LABEL: Readonly<Record<StorageId, string>> = {
  ferrum: 'Железо',
  silicium: 'Кремний',
  uranium: 'Уран',
  plasma: 'Плазма',
  deuterium: 'Дейтерий',
  nitrogen: 'Жидкий азот'
};
