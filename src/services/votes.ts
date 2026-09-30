import type { Ctx } from '../context'
import type { CommentRow, PostRow, UserRow, Viewer } from '../types'
import { getSettings } from './settings'
import { badRequest, forbidden, notFound, rateLimited, unauthorized } from './errors'
import { activeBan, getCommunityById, isSuspended } from './access'
import { AFFINITY_STEP, bumpAffinity } from './feeds'
import { isAdminPower } from './ranks'
import { transaction } from '../db'

export type VoteTarget = 'post' | 'comment'

export interface VoteResult {
  score: number
  upvotes: number
  downvotes: number
  myVote: number
}

/**
 * US-022: one vote per user per item (DB unique constraint), idempotent,
 * changeable and removable (value 0). Self-votes are rejected server-side.
 */
export function castVote(
  ctx: Ctx,
  viewer: Viewer,
  targetType: VoteTarget,
  targetId: string,
  value: number,
): VoteResult {
  if (!viewer) throw unauthorized('Oy vermek için giriş yapın.')
  if (isSuspended(ctx, viewer)) throw forbidden('Hesabınız askıya alınmış.')
  if (![1, -1, 0].includes(value)) throw badRequest('value', 'Oy değeri 1, -1 veya 0 olmalıdır.')

  const settings = getSettings(ctx)
  const limit = ctx.rateLimiter.check(`vote:${viewer.id}`, settings.votesPerMinute, 60 * 1000)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)

  const target = loadTarget(ctx, targetType, targetId)
  if (!target || target.deleted || target.removed || target.auto_hidden) {
    throw notFound('Bu içerik artık mevcut değil.')
  }
  if (target.author_id === viewer.id) {
    throw forbidden('Kendi içeriğinize oy veremezsiniz.')
  }
  const communityId = targetType === 'post' ? (target as PostRow).community_id : postCommunityId(ctx, (target as CommentRow).post_id)
  const community = getCommunityById(ctx, communityId)
  if (!community || community.deleted_at !== null) throw notFound('Bu içerik artık mevcut değil.')
  if (community.archived) throw badRequest('archived', 'Bu topluluk arşivlenmiş ve salt okunur durumdadır.')
  if (activeBan(ctx, viewer.id, community.id)) {
    throw forbidden('Bu topluluktan yasaklandınız.')
  }    if (community.visibility === 'private' && !isAdminPower(viewer)) {
    const member = ctx.db
      .prepare("SELECT 1 FROM memberships WHERE user_id = ? AND community_id = ? AND status = 'approved'")
      .get(viewer.id, community.id)
    if (!member) throw forbidden('Bu topluluk gizli.')
  }

  return transaction(ctx.db, () => {
    const existing = ctx.db
      .prepare('SELECT value FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
      .get(viewer.id, targetType, targetId) as { value: number } | undefined
    const previous = existing?.value ?? 0

    if (previous !== value) {
      if (value === 0) {
        ctx.db
          .prepare('DELETE FROM votes WHERE user_id = ? AND target_type = ? AND target_id = ?')
          .run(viewer.id, targetType, targetId)
      } else {
        ctx.db
          .prepare(
            `INSERT INTO votes (user_id, target_type, target_id, value, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id, target_type, target_id) DO UPDATE SET value = excluded.value`,
          )
          .run(viewer.id, targetType, targetId, value, ctx.now())
      }
      const upDelta = (value === 1 ? 1 : 0) - (previous === 1 ? 1 : 0)
      const downDelta = (value === -1 ? 1 : 0) - (previous === -1 ? 1 : 0)
      const table = targetType === 'post' ? 'posts' : 'comments'
      ctx.db
        .prepare(
          `UPDATE ${table} SET upvotes = upvotes + ?, downvotes = downvotes + ?, score = score + ? WHERE id = ?`,
        )
        .run(upDelta, downDelta, upDelta - downDelta, targetId)

      // Kişiselleştirilmiş akış: oy vermek boarda ilgiyi de değiştirir
      // (beğeni artırır, karşı oy azaltır).
      const interestDelta = value === 1 ? AFFINITY_STEP.vote : value === -1 ? -AFFINITY_STEP.downVote : 0
      if (interestDelta !== 0) bumpAffinity(ctx, viewer.id, community.id, interestDelta)
    }

    const table = targetType === 'post' ? 'posts' : 'comments'
    const updated = ctx.db.prepare(`SELECT score, upvotes, downvotes FROM ${table} WHERE id = ?`).get(targetId) as {
      score: number
      upvotes: number
      downvotes: number
    }
    return { ...updated, myVote: value }
  })
}

function loadTarget(ctx: Ctx, targetType: VoteTarget, targetId: string): (PostRow | CommentRow) | null {
  const table = targetType === 'post' ? 'posts' : 'comments'
  return (ctx.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(targetId) as PostRow | CommentRow | undefined) ?? null
}

function postCommunityId(ctx: Ctx, postId: string): string {
  const row = ctx.db.prepare('SELECT community_id FROM posts WHERE id = ?').get(postId) as
    | { community_id: string }
    | undefined
  return row?.community_id ?? ''
}

/** Viewer's votes on a set of targets, for rendering vote state (US-022). */
export function getMyVotes(
  ctx: Ctx,
  viewer: UserRow | null,
  targetType: VoteTarget,
  targetIds: string[],
): Map<string, number> {
  if (!viewer || targetIds.length === 0) return new Map()
  const placeholders = targetIds.map(() => '?').join(', ')
  const rows = ctx.db
    .prepare(
      `SELECT target_id, value FROM votes WHERE user_id = ? AND target_type = ? AND target_id IN (${placeholders})`,
    )
    .all(viewer.id, targetType, ...targetIds) as Array<{ target_id: string; value: number }>
  return new Map(rows.map((r) => [r.target_id, r.value]))
}
