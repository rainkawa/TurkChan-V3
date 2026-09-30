/**
 * Imageboard tarzı gönderi referansları (`>>12345`).
 *
 * - Numaralar topluluk içinde 1'den başlar ve atlanmaz.
 * - Referans yalnızca AYNI topluluktaki gönderilere çözülür; başka topluluğun
 *   gönderi numarası sızıntı anlamı taşımaz.
 * - Çözülemeyen referans düz metin olarak kalır (`>>9999` kalır); bağlantı
 *   üretilmez, dolayısıyla uydurma bağlantı/numara sızıntısı olmaz.
 */
import type { Ctx } from '../context'

/** Bir gövdedeki tüm `>>123` referans numaraları (benzersiz, sıralı). */
export function parseReferenceNumbers(text: string | null | undefined): number[] {
  if (!text) return []
  const found = new Set<number>()
  // Tüm rakamlar alınır: `>>12a` veya `>>1.5` bir referans DEĞİLDİR.
  for (const match of text.matchAll(/>>(\d+)/g)) {
    const digits = match[1] as string
    // Aşırı uzun sayılar (ör. 10^15+) kabul edilmez; makul bir üst sınır var.
    if (digits.length > 10) continue
    const value = Number(digits)
    if (Number.isSafeInteger(value) && value > 0) found.add(value)
  }
  return [...found].sort((a, b) => a - b)
}

/** Topluluk içinde sıradaki post numarası. Çağıran transaction içinde olmalıdır. */
export function nextPostNumber(ctx: Ctx, communityId: string): number {
  const row = ctx.db
    .prepare('SELECT COALESCE(MAX(number), 0) AS maxNumber FROM posts WHERE community_id = ?')
    .get(communityId) as { maxNumber: number }
  return (row.maxNumber ?? 0) + 1
}

/**
 * Gövdedeki referansları aynı topluluktaki gerçek gönderilere bağlar.
 *
 * Kayıt edilen bağlantılar "Bu gönderi şunlara cevap veriyor" (backlink)
 * görünümü için `post_references` tablosunda saklanır.
 */
export function syncReferences(
  ctx: Ctx,
  sourcePostId: string,
  communityId: string,
  text: string | null | undefined,
): Map<number, string> {
  const numbers = parseReferenceNumbers(text)
  ctx.db.prepare('DELETE FROM post_references WHERE source_post_id = ?').run(sourcePostId)
  const resolved = new Map<number, string>()
  if (numbers.length === 0) return resolved
  const placeholders = numbers.map(() => '?').join(', ')
  const rows = ctx.db
    .prepare(
      `SELECT id, number FROM posts
        WHERE community_id = ? AND number IN (${placeholders})
          AND deleted = 0 AND removed = 0`,
    )
    .all(communityId, ...numbers) as unknown as Array<{ id: string; number: number }>
  const now = ctx.now()
  for (const row of rows) {
    resolved.set(row.number, row.id)
    ctx.db
      .prepare(
        `INSERT OR IGNORE INTO post_references (source_post_id, target_post_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(sourcePostId, row.id, now)
  }
  return resolved
}

/** Bir gönderiye verilen referanslar ("yanıtlayanlar"). */
export function repliesTo(ctx: Ctx, postId: string): Array<{
  id: string
  number: number | null
  title: string
  author_username: string | null
  anon_name: string | null
  created_at: number
}> {
  return ctx.db
    .prepare(
      `SELECT p.id, p.number, p.title, p.created_at,
              CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.username END AS author_username,
              p.anon_name
         FROM post_references r
         JOIN posts p ON p.id = r.source_post_id
         JOIN users u ON u.id = p.author_id
        WHERE r.target_post_id = ?
          AND p.deleted = 0 AND p.removed = 0
          AND u.deleted = 0
        ORDER BY p.created_at ASC
        LIMIT 20`,
    )
    .all(postId) as unknown as Array<{
    id: string
    number: number | null
    title: string
    author_username: string | null
    anon_name: string | null
    created_at: number
  }>
}

/** Bir gönderinin referans verdiği gönderiler (ileri bağlantılar). */
export function referencesOut(ctx: Ctx, postId: string): Array<{
  id: string
  number: number | null
  title: string
}> {
  return ctx.db
    .prepare(
      `SELECT p.id, p.number, p.title
         FROM post_references r JOIN posts p ON p.id = r.target_post_id
        WHERE r.source_post_id = ? AND p.deleted = 0
        ORDER BY p.number IS NULL, p.number
        LIMIT 20`,
    )
    .all(postId) as unknown as Array<{ id: string; number: number | null; title: string }>
}
/**
 * Akış sayfası için toplu referans çözümü (N+1 olmadan).
 *
 * Verilen gönderilerin gövdelerindeki TÜM numaralar tek sorguda çözülür ve
 * gönderi kimliği → (numara → hedef gönderi kimliği) eşlemesi döner.
 *
 * @param communityId Yalnızca bu topluluğun gönderileri çözülür.
 */
export function referenceMapsForFeed(
  ctx: Ctx,
  communityId: string,
  posts: Array<{ id: string; body: string | null }>,
): Map<string, Map<number, string>> {
  const result = new Map<string, Map<number, string>>()
  const allNumbers = new Set<number>()
  const perPost = new Map<string, number[]>()
  for (const post of posts) {
    const numbers = parseReferenceNumbers(post.body)
    if (numbers.length === 0) continue
    perPost.set(post.id, numbers)
    for (const n of numbers) allNumbers.add(n)
  }
  if (allNumbers.size === 0) return result

  const numbers = [...allNumbers]
  // SQLite parametre sınırına takılmamak için gruplar hâlinde sorgulanır.
  const resolved = new Map<number, string>()
  const CHUNK = 400
  for (let i = 0; i < numbers.length; i += CHUNK) {
    const slice = numbers.slice(i, i + CHUNK)
    const placeholders = slice.map(() => '?').join(', ')
    const rows = ctx.db
      .prepare(
        `SELECT id, number FROM posts
          WHERE community_id = ? AND number IN (${placeholders})
            AND deleted = 0 AND removed = 0`,
      )
      .all(communityId, ...slice) as unknown as Array<{ id: string; number: number }>
    for (const row of rows) resolved.set(row.number, row.id)
  }

  for (const [postId, referenced] of perPost) {
    const map = new Map<number, string>()
    for (const n of referenced) {
      const target = resolved.get(n)
      if (target) map.set(n, target)
    }
    result.set(postId, map)
  }
  return result
}
