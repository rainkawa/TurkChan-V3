import type { Ctx } from '../context'
import type { CommentRow, PostRow, UserRow, Viewer } from '../types'
import { validateBio, validateDisplayName } from '../lib/validation'
import { unauthorized } from './errors'
import { readableCommunitiesClause } from './access'

export interface Karma {
  postKarma: number
  commentKarma: number
}

/**
 * US-007: karma = sum of scores on non-deleted, non-removed content. Computed
 * on read — always consistent, and removal/deletion reversal is automatic.
 */
export function getKarma(ctx: Ctx, userId: string): Karma {
  const postKarma = (
    ctx.db
      .prepare('SELECT COALESCE(SUM(score), 0) AS k FROM posts WHERE author_id = ? AND deleted = 0 AND removed = 0')
      .get(userId) as { k: number }
  ).k
  const commentKarma = (
    ctx.db
      .prepare('SELECT COALESCE(SUM(score), 0) AS k FROM comments WHERE author_id = ? AND deleted = 0 AND removed = 0')
      .get(userId) as { k: number }
  ).k
  return { postKarma, commentKarma }
}

export interface ProfileView {
  user: Pick<UserRow, 'id' | 'username' | 'display_name' | 'bio' | 'created_at'>
  karma: Karma
  posts: Array<PostRow & { community_name: string }>
  comments: Array<CommentRow & { community_name: string; post_title: string; post_id: string }>
}

/**
 * US-005: public profile. Content in communities the viewer cannot read is
 * excluded from the visible history (karma still counts it, US-007).
 */
export function getProfile(ctx: Ctx, viewer: Viewer, username: string): ProfileView | null {
  const user = ctx.db
    .prepare('SELECT * FROM users WHERE username_lower = ? AND deleted = 0')
    .get(username.toLowerCase()) as UserRow | undefined
  if (!user) return null

  const readable = readableCommunitiesClause(ctx, viewer, 'c')
  const posts = ctx.db
    .prepare(
      `SELECT p.*, c.name AS community_name FROM posts p JOIN communities c ON c.id = p.community_id
       WHERE p.author_id = ? AND p.deleted = 0 AND p.removed = 0 AND p.auto_hidden = 0 AND ${readable.clause}
       ORDER BY p.created_at DESC LIMIT 50`,
    )
    .all(user.id, ...readable.params) as unknown as Array<PostRow & { community_name: string }>
  const comments = ctx.db
    .prepare(
      `SELECT cm.*, c.name AS community_name, p.title AS post_title
       FROM comments cm JOIN posts p ON p.id = cm.post_id JOIN communities c ON c.id = p.community_id
       WHERE cm.author_id = ? AND cm.deleted = 0 AND cm.removed = 0 AND cm.auto_hidden = 0
         AND p.deleted = 0 AND p.removed = 0 AND ${readable.clause}
       ORDER BY cm.created_at DESC LIMIT 50`,
    )
    .all(user.id, ...readable.params) as unknown as Array<
    CommentRow & { community_name: string; post_title: string }
  >

  return {
    user: {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      bio: user.bio,
      created_at: user.created_at,
    },
    karma: getKarma(ctx, user.id),
    posts,
    comments,
  }
}

/** US-006: display name and bio; bio renders as plain text (escaped at render). */
export function updateProfile(ctx: Ctx, viewer: Viewer, input: { displayName: string; bio: string }): UserRow {
  if (!viewer) throw unauthorized()
  const displayName = validateDisplayName(input.displayName)
  const bio = validateBio(input.bio)
  ctx.db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName, bio, viewer.id)
  return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id) as unknown as UserRow
}
