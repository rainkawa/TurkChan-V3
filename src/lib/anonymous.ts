/**
 * Anonim paylaşım.
 *
 * Kullanıcı "anonim" seçeneğini açtığında sistem gerçek hesabı gizleyen
 * rastgele bir kullanıcı adı üretir: 5 karakter, büyük/küçük harf ve rakam
 * karışık. Gerçek yazar `posts.author_id` içinde saklanır ve yalnızca
 * yönetim ekranında görünür.
 */
import { randomInt } from 'node:crypto'

const LOWER = 'abcdefghijkmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGITS = '23456789'

/** Karışık büyük/küçük harf ve rakamdan 5 haneli bir ad üretir. */
export function generateAnonName(): string {
  const pools = [LOWER, UPPER, DIGITS]
  // Her gruptan en az bir karakter garanti eder → ad her zaman karışık.
  const chars = pools.map((pool) => pool[randomInt(pool.length)] as string)
  while (chars.length < 5) {
    const pool = pools[randomInt(pools.length)] as string
    chars.push(pool[randomInt(pool.length)] as string)
  }
  // Fisher-Yates karıştırma (kriptografik rastgelelik kaynağı ile).
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[chars[i], chars[j]] = [chars[j] as string, chars[i] as string]
  }
  return chars.join('')
}
