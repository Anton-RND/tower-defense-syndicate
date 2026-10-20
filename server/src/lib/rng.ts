/**
 * Детерминированный ГСЧ.
 *
 * Нужен там, где случайный результат обязан воспроизводиться по идентификатору
 * события: бой выдал лут, игрок спорит в тикете «мне не пришло», и поддержка должна
 * пересчитать тот же самый бросок, а не гадать. Для этого.seed выводится из raidId,
 * а не из часов — повторный запрос того же боя даёт те же числа.
 *
 * Здесь сознательно нет Math.random: единственное место, где допустима настоящая
 * случайность, — выбор соперника (matchmaking), и туда ГСЧ передаётся параметром,
 * чтобы тесты могли его подменить.
 */

/** FNV-1a 32-bit: быстрый, без аллокаций, достаточный для вывода сида из строки. */
export function hashSeed(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * mulberry32 — 32-битный генератор с полным набором бит в выходе.
 * Не криптография: для дропа лута и выбора соперника важна воспроизводимость и
 * равномерность, а не стойкость к подбору.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** ГСЧ, полностью определённый строкой (raidId, orderId, ...). */
export function rngFromKey(key: string): () => number {
  return mulberry32(hashSeed(key));
}

/** Целое в диапазоне [min, max] включительно — ровно то, что нужно таблицам дропа. */
export function randInt(rng: () => number, min: number, max: number): number {
  if (max < min) return min;
  return min + Math.floor(rng() * (max - min + 1));
}

/**
 * Выбор индекса из `length` равновероятно. Отдельная функция потому, что
 * `Math.floor(rng() * length)` на length=0 даёт NaN, и каждый вызывающий слой
 * должен был бы проверять это заново.
 */
export function pickIndex(rng: () => number, length: number): number {
  if (!Number.isFinite(length) || length <= 0) return -1;
  const index = Math.floor(rng() * length);
  return index >= length ? length - 1 : index;
}

/** Перемешивание Фишера–Йетса на копии массива: входной массив не трогаем. */
export function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = pickIndex(rng, index + 1);
    if (swap < 0) continue;
    const a = result[index] as T;
    const b = result[swap] as T;
    result[index] = b;
    result[swap] = a;
  }
  return result;
}
