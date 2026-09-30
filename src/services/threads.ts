/**
 * Thread modu.
 *
 * Bir gönderi "thread" olarak işaretlendiğinde yorumlar sıralı bir zincir
 * hâline gelir: her yanıt bir numara alır ve kendisinden önceki yanıtı alıntılar.
 *
 * - **Bump**: her yeni yanıt thread'i yukarı taşır (`bumped_at`).
 * - **Bump limiti**: `threadBumpLimit` aşıldığında thread artık yukarı
 *   taşınmaz; `threadReplyLimit` aşıldığında otomatik kilitlenir.
 * - **Sticky**: moderatör thread'i listenin en üstünde sabitler.
 * - **Locked**: görünür ama yanıtlanamaz.
 * - **Archived**: yalnızca yönetici/moderatör görebilir.
 */
import type { Ctx } from '../context'
import type { PostRow, UserRow, Viewer } from '../types'
import { getSettings } from './settings'
import { isModerator } from './access'
import { forbidden, notFound } from './errors'

/** Bump penceresi: bu süre içindeki yanıtlar thread'i taşır. */
const BUMP_WINDOW_MS = 48 * 60 * 60 * 1000

export interface ThreadState {
  isThread: boolean
  locked: boolean
  archived: boolean
  sticky: boolean
  /** Yeni yanıt kabul edilir mi? */
  canReply: boolean
  /** Yanıt thread'i yukarı taşır mı? */
  canBump: boolean
  replies: number
  bumps: number
}

export function threadState(ctx: Ctx, post: PostRow): ThreadState {
  if (!post.is_thread) {
    return { isThread: false, locked: false, archived: false, sticky: false, canReply: true, canBump: false, replies: post.reply_count, bumps: 0 }
  }
  const settings = getSettings(ctx)
  const age = ctx.now() - post.created_at
  const limitReached = post.reply_count >= settings.threadReplyLimit
  return {
    isThread: true,
    locked: post.thread_locked === 1 || limitReached,
    archived: post.thread_archived === 1,
    sticky: post.thread_sticky === 1,
    canReply: post.thread_locked !== 1 && !limitReached,
    // Bump yalnızca pencere içinde ve limit aşılmadıysa.
    canBump: post.bump_count < settings.threadBumpLimit && age <= BUMP_WINDOW_MS,
    replies: post.reply_count,
    bumps: post.bump_count,
  }
}

/** Arşivlenmiş thread yalnızca moderatörlere/yöneticilere görünür. */
export function canSeeThread(ctx: Ctx, viewer: Viewer, post: PostRow): boolean {
  if (post.thread_archived !== 1) return true
  return isModerator(ctx, viewer, post.community_id)
}

/**
 * Yeni thread yanıtı kaydeder. Sıra numarası ve alıntılanan yorum burada
 * belirlenir; bump limiti aşılıyorsa thread kilitlenir.
 */
export function registerThreadReply(ctx: Ctx, post: PostRow, commentId: string): void {
  if (!post.is_thread) return
  const state = threadState(ctx, post)
  if (!state.canReply) throw forbidden('Bu thread kilitli.')
  const nextNo = post.reply_count + 1
  const previous = ctx.db
    .prepare('SELECT id FROM comments WHERE post_id = ? AND thread_no = ? ORDER BY thread_no DESC LIMIT 1')
    .get(post.id, post.reply_count) as { id: string } | undefined
  ctx.db
    .prepare('UPDATE comments SET thread_no = ?, reply_to_comment_id = ? WHERE id = ?')
    .run(nextNo, previous?.id ?? null, commentId)
  ctx.db.prepare('UPDATE posts SET reply_count = ? WHERE id = ?').run(nextNo, post.id)
  if (state.canBump) {
    ctx.db
      .prepare('UPDATE posts SET bumped_at = ?, bump_count = bump_count + 1 WHERE id = ?')
      .run(ctx.now(), post.id)
  }
}

/** Thread durumunu değiştirir (yalnızca moderatörler). */
export function setThreadFlag(
  ctx: Ctx,
  viewer: Viewer,
  postId: string,
  flag: 'thread_sticky' | 'thread_locked' | 'thread_archived',
  value: boolean,
): PostRow {
  const post = ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as PostRow | undefined
  if (!post || post.deleted) throw notFound('Gönderi bulunamadı.')
  if (!post.is_thread) throw notFound('Bu bir thread değil.')
  if (!isModerator(ctx, viewer, post.community_id)) throw forbidden()
  // Arşivleme yalnızca site yöneticilerine açık.
  if (flag === 'thread_archived' && !isModerator(ctx, viewer as UserRow, post.community_id)) throw forbidden()
  ctx.db.prepare(`UPDATE posts SET ${flag} = ? WHERE id = ?`).run(value ? 1 : 0, postId)
  return ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get(postId) as unknown as PostRow
}

/** Süresi dolan thread'leri arşivler (zamanlanmış görev). */
export function autoArchiveThreads(ctx: Ctx): number {
  const settings = getSettings(ctx)
  const cutoff = ctx.now() - settings.threadArchiveAfterDays * 24 * 60 * 60 * 1000
  const res = ctx.db
    .prepare(
      `UPDATE posts SET thread_archived = 1
        WHERE is_thread = 1 AND thread_archived = 0 AND created_at < ?`,
    )
    .run(cutoff)
  return Number(res.changes ?? 0)
}
