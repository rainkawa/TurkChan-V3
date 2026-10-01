/**
 * Deterministik sözde rastgele sayı üreteci (mulberry32).
 *
 * Davranış motoru test edilebilir olmalıdır: aynı tohum → aynı karar
 * dizisi. Math.random() kullanılmaz çünkü hem testleri kırılganlaştırır
 * hem de "rastgele seçim" kaygısını körleştirir.
 */

/** mulberry32 — küçük, hızlı, iyi dağılımlı. */
export function makeRng(seed?: number): () => number {
  let state = (seed ?? Date.now()) >>> 0
  return function rng(): number {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Ağırlıklı rastgele seçim. Ağırlıklar negatif/NaN olabilir; bunlar 0.01'e
 * çekilir (seçimin tamamen engellenmemesi için).
 */
export function weightedPick<T>(rng: () => number, entries: Array<[T, number]>): T {
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0.01, w), 0)
  let roll = rng() * total
  for (const [value, weight] of entries) {
    roll -= Math.max(0.01, weight)
    if (roll <= 0) return value
  }
  return entries[entries.length - 1]![0]
}
