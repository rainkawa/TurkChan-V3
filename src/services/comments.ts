import type { Ctx } from '../context'
import type { CommentRow, PostRow, Viewer } from '../types'
import { newId } from '../lib/ids'
import { validateCommentBody } from '../lib/validation'
import { wilsonLowerBound } from '../lib/ranking'
import { getSettings } from './settings'
import { badRequest, forbidden, notFound, rateLimited } from './errors'
import { getCommunityById, requireParticipant } from './access'
import { getPost, getPostForViewer } from './posts'
import { notify, withdrawForComment } from './notifications'
import { transaction } from '../db'

/** Visual nesting cap (FR-6): depth is 1-based; replies beyond 8 flatten to 8. */
export const MAX_COMMENT_DEPTH = 8
const TEN_MINUTES_MS = 10 * 60 * 1000

export function getComment(ctx: Ctx, id: string): CommentRow | null {
  return (ctx.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow | undefined) ?? null
}

export function createComment(
  ctx: Ctx,
  viewer: Viewer,
  postId: string,
  input: { body: string; parentId?: string | null },
): CommentRow {
  const post = getPost(ctx, postId)
  if (!post || post.deleted) throw notFound('Gönderi bulunamadı.')

  if (post.removed || post.auto_hidden) {
    throw forbidden('Kaldırılan içeriklere yorum yapılamaz.')
  }
  const community = getCommunityById(ctx, post.community_id)
  if (!community) throw notFound('Gönderi bulunamadı.')
  const user = requireParticipant(ctx, viewer, community, {
    requireMembership: community.visibility !== 'public',
  })

  const settings = getSettings(ctx)
  const limit = ctx.rateLimiter.check(`comment:${user.id}`, settings.commentsPer10Min, TEN_MINUTES_MS)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)

  const body = validateCommentBody(input.body)

  let parent: CommentRow | null = null
  if (input.parentId) {
    parent = getComment(ctx, input.parentId)
    if (!parent || parent.post_id !== postId) throw notFound('Üst yorum bulunamadı.')
    if (parent.deleted && !hasVisibleContent(parent)) {
      // Replying to a [deleted] placeholder is allowed (thread structure is preserved).
    }
  }

  const id = newId()
  const depth = parent ? Math.min(parent.depth + 1, MAX_COMMENT_DEPTH) : 1
  const path = parent ? `${parent.path}/${id}` : id

  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO comments (id, post_id, parent_id, path, depth, author_id, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, postId, parent?.id ?? null, path, depth, user.id, body, ctx.now())
    ctx.db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(postId)

    // Direct-reply notification (US-040): parent comment author, or post author
    // for top-level comments. Never for self-replies.
    const recipientId = parent ? parent.author_id : post.author_id
    const recipientVisible = parent ? !parent.deleted && !parent.removed : !post.deleted && !post.removed
    if (recipientId !== user.id && recipientVisible) {
      notify(ctx, {
        userId: recipientId,
        type: 'reply',
        title: `/tc/${user.username}, c/${community.name} topluluğundaki ${parent ? 'yorumunuza' : 'gönderinize'} yanıt verdi`,
        link: `/c/${community.name}/comments/${postId}/comment/${id}`,
        sourceCommentId: id,
      })
    }
  })
  return getComment(ctx, id) as CommentRow
}

function hasVisibleContent(comment: CommentRow): boolean {
  return !comment.deleted && !comment.removed
}

export function editComment(ctx: Ctx, viewer: Viewer, commentId: string, body: string): CommentRow {
  const comment = getComment(ctx, commentId)
  if (!comment || comment.deleted) throw notFound('Yorum bulunamadı.')
  if (!viewer || viewer.id !== comment.author_id) throw forbidden('Bu yorumu yalnızca yazarı düzenleyebilir.')
  if (comment.removed) throw forbidden('Bu yorum bir moderatör tarafından kaldırıldı ve düzenlenemez.')
  const community = getCommunityById(ctx, (getPost(ctx, comment.post_id) as PostRow).community_id)
  if (!community || community.archived || community.deleted_at !== null) {
    throw badRequest('archived', 'Bu topluluk arşivlenmiş ve salt okunur durumdadır.')
  }
  const validBody = validateCommentBody(body)
  ctx.db.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(validBody, ctx.now(), commentId)
  return getComment(ctx, commentId) as CommentRow
}

/**
 * US-020: deleting a leaf removes the row and decrements the count; deleting a
 * comment with replies leaves a "[deleted]" placeholder preserving structure.
 */
export function deleteComment(ctx: Ctx, viewer: Viewer, commentId: string): { placeholder: boolean } {
  const comment = getComment(ctx, commentId)
  if (!comment || comment.deleted) throw notFound('Yorum bulunamadı.')
  if (!viewer || viewer.id !== comment.author_id) throw forbidden('Bu yorumu yalnızca yazarı silebilir.')

  const childCount = (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE parent_id = ?').get(commentId) as { n: number }
  ).n

  return transaction(ctx.db, () => {
    withdrawForComment(ctx, commentId)
    if (childCount > 0) {
      ctx.db.prepare("UPDATE comments SET deleted = 1, body = '' WHERE id = ?").run(commentId)
      return { placeholder: true }
    }
    ctx.db.prepare('DELETE FROM votes WHERE target_type = ? AND target_id = ?').run('comment', commentId)
    ctx.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId)
    ctx.db.prepare('UPDATE posts SET comment_count = comment_count - 1 WHERE id = ?').run(comment.post_id)
    return { placeholder: false }
  })
}

export type CommentSort = 'best' | 'new' | 'top'

export interface CommentNode {
  comment: CommentRow
  authorUsername: string | null
  children: CommentNode[]
  hidden: 'deleted' | 'removed' | 'pending_review' | null
}

/**
 * Full comment tree for a post, siblings ordered by the chosen sort at every
 * level. Placeholders preserve structure for deleted/removed comments.
 */
export function getCommentTree(ctx: Ctx, viewer: Viewer, postId: string, sort: CommentSort): CommentNode[] {
  // Access is enforced by the same gate the post page uses.
  getPostForViewer(ctx, viewer, postId)

  const rows = ctx.db
    .prepare(
      `SELECT c.*, u.username AS author_username, u.deleted AS author_deleted
       FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.post_id = ?`,
    )
    .all(postId) as unknown as Array<CommentRow & { author_username: string; author_deleted: number }>

  const nodes = new Map<string, CommentNode>()
  for (const row of rows) {
    const hidden = row.deleted
      ? 'deleted'
      : row.removed
        ? 'removed'
        : row.auto_hidden
          ? 'pending_review'
          : null
    nodes.set(row.id, {
      comment: row,
      authorUsername: hidden || row.author_deleted ? null : row.author_username,
      children: [],
      hidden,
    })
  }

  const roots: CommentNode[] = []
  for (const row of rows) {
    const node = nodes.get(row.id) as CommentNode
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const compare = comparatorFor(sort)
  const sortTree = (list: CommentNode[]) => {
    list.sort(compare)
    for (const node of list) sortTree(node.children)
  }
  sortTree(roots)
  return roots
}

function comparatorFor(sort: CommentSort): (a: CommentNode, b: CommentNode) => number {
  if (sort === 'new') {
    return (a, b) => b.comment.created_at - a.comment.created_at || (a.comment.id < b.comment.id ? 1 : -1)
  }
  if (sort === 'top') {
    return (a, b) => b.comment.score - a.comment.score || b.comment.created_at - a.comment.created_at
  }
  // Best: Wilson lower bound of upvote ratio (US-027).
  return (a, b) => {
    const wa = wilsonLowerBound(a.comment.upvotes, a.comment.downvotes)
    const wb = wilsonLowerBound(b.comment.upvotes, b.comment.downvotes)
    return wb - wa || b.comment.created_at - a.comment.created_at
  }
}

/** Ancestor chain for a permalinked comment (US-019). */
export function getCommentAncestors(ctx: Ctx, comment: CommentRow): CommentRow[] {
  const ids = comment.path.split('/').slice(0, -1)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = ctx.db
    .prepare(`SELECT * FROM comments WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as CommentRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is CommentRow => Boolean(r))
}
