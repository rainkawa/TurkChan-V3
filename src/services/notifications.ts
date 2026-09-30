import type { Ctx } from '../context'
import type { NotificationRow } from '../types'
import { newId } from '../lib/ids'

export function notify(
  ctx: Ctx,
  input: {
    userId: string
    type: NotificationRow['type']
    title: string
    link: string
    sourceCommentId?: string
    /** Bildirimi tetikleyen kullanıcı (rozet gösterimi için). */
    actorId?: string | null
  },
): void {
  ctx.db
    .prepare(
      `INSERT INTO notifications (id, user_id, actor_id, type, title, link, source_comment_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      input.userId,
      input.actorId ?? null,
      input.type,
      input.title,
      input.link,
      input.sourceCommentId ?? null,
      ctx.now(),
    )
}

export function listNotifications(ctx: Ctx, userId: string, limit = 50): NotificationRow[] {
  return ctx.db
    .prepare(
      `SELECT * FROM notifications WHERE user_id = ? AND withdrawn = 0
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(userId, limit) as unknown as NotificationRow[]
}

export function unreadCount(ctx: Ctx, userId: string): number {
  return (
    ctx.db
      .prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0 AND withdrawn = 0')
      .get(userId) as { n: number }
  ).n
}

export function markRead(ctx: Ctx, userId: string, notificationId: string): void {
  ctx.db
    .prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?')
    .run(notificationId, userId)
}

/**
 * Bildirim ekranı açıldığında gösterilen bildirimleri okundu işaretler.
 *
 * `read = 0` koşulu yalnızca gerçekten okunmamış satırlara dokunur; hem tek
 * bir UPDATE ifadesi kullanıldığı için eşzamanlı isteklerde yarış durumu
 * oluşmaz, hem de `updated_at` benzeri bir alan gerekmez. Çağıran, rozet
 * sayısını bundan SONRA hesaplamalıdır.
 */
export function markListedRead(ctx: Ctx, userId: string, ids: string[]): number {
  if (ids.length === 0) return 0
  const placeholders = ids.map(() => '?').join(',')
  const result = ctx.db
    .prepare(`UPDATE notifications SET read = 1 WHERE user_id = ? AND withdrawn = 0 AND read = 0 AND id IN (${placeholders})`)
    .run(userId, ...ids)
  return Number(result.changes)
}

export function markAllRead(ctx: Ctx, userId: string): void {
  ctx.db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId)
}

/**
 * US-040: withdraw unread reply notifications when their source comment is
 * removed/deleted before the recipient opens them.
 */
export function withdrawForComment(ctx: Ctx, commentId: string): void {
  ctx.db
    .prepare('UPDATE notifications SET withdrawn = 1 WHERE source_comment_id = ? AND read = 0')
    .run(commentId)
}
