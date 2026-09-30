/**
 * Board etiketleri (flair).
 *
 * Her board kendi etiketlerini yönetir; moderatörler etiket oluşturur/siler,
 * üyeler gönderilerini etiketler. Gönderi kartlarında renkli rozet olarak
 * görünür ve akış etikete göre filtrelenebilir.
 */
import type { Ctx } from '../context'
import type { FlairRow, UserRow } from '../types'
import { newId } from '../lib/ids'
import { badRequest, conflict, notFound } from './errors'
import { isModerator } from './access'

export const FLAIR_NAME_MAX = 24
const COLOR_RE = /^#[0-9a-fA-F]{6}$/

export function listFlairs(ctx: Ctx, communityId: string): FlairRow[] {
  return ctx.db
    .prepare('SELECT * FROM board_flairs WHERE community_id = ? ORDER BY position ASC, name ASC')
    .all(communityId) as unknown as FlairRow[]
}

/** Birden çok board için etiket haritası (feed kartlarında N+1 sorgu önler). */
export function flairMap(ctx: Ctx, communityIds: string[]): Map<string, FlairRow> {
  const unique = [...new Set(communityIds.filter(Boolean))]
  if (unique.length === 0) return new Map()
  const placeholders = unique.map(() => '?').join(',')
  const rows = ctx.db
    .prepare(`SELECT * FROM board_flairs WHERE community_id IN (${placeholders})`)
    .all(...unique) as unknown as FlairRow[]
  return new Map(rows.map((r) => [r.id, r]))
}

export function getFlair(ctx: Ctx, communityId: string, flairId: string): FlairRow | null {
  const row = ctx.db
    .prepare('SELECT * FROM board_flairs WHERE id = ? AND community_id = ?')
    .get(flairId, communityId) as FlairRow | undefined
  return row ?? null
}

function validateName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw badRequest('name', 'Etiket adı boş olamaz.')
  if (trimmed.length > FLAIR_NAME_MAX) {
    throw badRequest('name', `Etiket adı en fazla ${FLAIR_NAME_MAX} karakter olabilir.`)
  }
  return trimmed
}

function validateColor(color: string): string {
  const trimmed = color.trim()
  if (!trimmed) return ''
  if (!COLOR_RE.test(trimmed)) throw badRequest('color', 'Renk #RRGGBB biçiminde olmalıdır.')
  return trimmed.toLowerCase()
}

/** Yeni etiket oluşturur. Yalnızca board moderatörleri/yöneticileri. */
export function createFlair(
  ctx: Ctx,
  communityId: string,
  actor: UserRow,
  input: { name: string; color?: string },
): FlairRow {
  if (!isModerator(ctx, actor, communityId)) throw notFound()
  const name = validateName(input.name)
  const color = validateColor(input.color ?? '')
  // Aynı ad farklı büyük/küçük harfle ikinci kez kullanılamaz.
  const taken = ctx.db
    .prepare('SELECT 1 FROM board_flairs WHERE community_id = ? AND name = ? COLLATE NOCASE')
    .get(communityId, name)
  if (taken) throw conflict('flair_taken', 'Bu etiket zaten var.')
  const id = newId()
  const position =
    (ctx.db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM board_flairs WHERE community_id = ?').get(communityId) as {
      n: number
    }).n ?? 0
  ctx.db
    .prepare('INSERT INTO board_flairs (id, community_id, name, color, position, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, communityId, name, color, position, ctx.now())
  return getFlair(ctx, communityId, id) as FlairRow
}

export function deleteFlair(ctx: Ctx, communityId: string, actor: UserRow, flairId: string): void {
  if (!isModerator(ctx, actor, communityId)) throw notFound()
  const row = ctx.db.prepare('SELECT id FROM board_flairs WHERE id = ? AND community_id = ?').get(flairId, communityId)
  if (!row) throw notFound('Etiket bulunamadı.')
  // Gönderiler etiketsiz kalır, silinmez.
  ctx.db.prepare('UPDATE posts SET flair_id = NULL WHERE flair_id = ?').run(flairId)
  ctx.db.prepare('DELETE FROM board_flairs WHERE id = ?').run(flairId)
}

/** Bir board için etiket sayısı sınırı (çok etiketliğe karşı). */
export const FLAIRS_PER_BOARD_MAX = 12

export function assertFlairCount(ctx: Ctx, communityId: string): void {
  const n = (ctx.db.prepare('SELECT COUNT(*) AS n FROM board_flairs WHERE community_id = ?').get(communityId) as {
    n: number
  }).n
  if (n >= FLAIRS_PER_BOARD_MAX) {
    throw badRequest('limit', `Bir boardda en fazla ${FLAIRS_PER_BOARD_MAX} etiket olabilir.`)
  }
}
