/**
 * Gönderi istatistikleri.
 *
 * Görüntülenme sayısı şişirilmesin diye aynı ziyaretçi bir gönderiyi
 * `VIEW_WINDOW_MS` içinde yalnızca bir kez sayar. Ziyaretçi kimliği:
 * giriş yapmış kullanıcı için user id, ziyaretçi için IP adresinin karması
 * (ham IP saklanmaz).
 */
import type { Ctx } from '../context'
import type { PostRow, Viewer } from '../types'
import { sha256 } from '../lib/ids'

/** Aynı ziyaretçi bu süreden sonra tekrar sayılır. */
export const VIEW_WINDOW_MS = 6 * 60 * 60 * 1000

export function viewerKey(viewer: Viewer, ip: string | null): string {
  if (viewer) return `u:${viewer.id}`
  if (!ip) return 'anon:none'
  return `ip:${sha256(ip).slice(0, 32)}`
}

/** Görüntülenmeyi kaydeder; yeni sayım yaptıysa true döner. */
export function recordView(ctx: Ctx, post: PostRow, viewer: Viewer, ip: string | null): boolean {
  if (post.deleted) return false
  // Yazar kendi gönderisini saymaz.
  if (viewer && viewer.id === post.author_id) return false
  const key = viewerKey(viewer, ip)
  const now = ctx.now()
  const existing = ctx.db
    .prepare('SELECT viewed_at FROM post_views WHERE post_id = ? AND viewer_key = ?')
    .get(post.id, key) as { viewed_at: number } | undefined
  if (existing && now - existing.viewed_at < VIEW_WINDOW_MS) return false
  if (existing) {
    ctx.db.prepare('UPDATE post_views SET viewed_at = ? WHERE post_id = ? AND viewer_key = ?').run(now, post.id, key)
  } else {
    ctx.db.prepare('INSERT INTO post_views (post_id, viewer_key, viewed_at) VALUES (?, ?, ?)').run(post.id, key, now)
  }
  ctx.db.prepare('UPDATE posts SET view_count = view_count + 1 WHERE id = ?').run(post.id)
  return true
}

export interface PostStats {
  views: number
  score: number
  upvotes: number
  downvotes: number
  comments: number
  createdAt: number
  editedAt: number | null
  /** Görüntülenen benzersiz ziyaretçi (tüm zamanlar). */
  uniqueViewers: number
}

export function postStats(ctx: Ctx, post: PostRow): PostStats {
  const unique = (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM post_views WHERE post_id = ?').get(post.id) as { n: number }
  ).n
  return {
    views: post.view_count,
    score: post.score,
    upvotes: post.upvotes,
    downvotes: post.downvotes,
    comments: post.comment_count,
    createdAt: post.created_at,
    editedAt: post.edited_at,
    uniqueViewers: unique,
  }
}

/** Yönetim paneli: en çok görüntülenen gönderiler. */
export function topViewedPosts(ctx: Ctx, limit = 20): Array<{ id: string; title: string; community_name: string; view_count: number }> {
  return ctx.db
    .prepare(
      `SELECT p.id, p.title, p.view_count, c.name AS community_name
         FROM posts p JOIN communities c ON c.id = p.community_id
        WHERE p.deleted = 0 AND p.removed = 0
        ORDER BY p.view_count DESC, p.created_at DESC
        LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ id: string; title: string; community_name: string; view_count: number }>
}
