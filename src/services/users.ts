import type { Ctx } from '../context'
import type { CommentRow, PostRow, UserRow, Viewer } from '../types'
import { validateBio, validateDisplayName, validateUsername, validatePassword } from '../lib/validation'
import { conflict, forbidden, unauthorized } from './errors'
import { hashPassword, verifyPassword } from '../lib/passwords'
import { attachUpload } from './uploads'
import { rankInfoFor, type UserRank } from './ranks'
import { readableCommunitiesClause } from './access'
import { transaction } from '../db'
import { sha256 } from '../lib/ids'

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
  user: Pick<
    UserRow,
    | 'id'
    | 'username'
    | 'display_name'
    | 'bio'
    | 'created_at'
    | 'is_admin'
    | 'avatar_key'
    | 'cover_key'
    | 'rank_mode'
    | 'rank_override'
    | 'staff_role'
  >
  karma: Karma
  posts: Array<PostRow & { community_name: string }>
  comments: Array<CommentRow & { community_name: string; post_title: string; post_id: string }>
}

/** Moderator of at least one visible community — drives the profile role badge. */
export function moderatesAnyCommunity(ctx: Ctx, userId: string): boolean {
  const row = ctx.db
    .prepare(
      "SELECT 1 AS n FROM memberships WHERE user_id = ? AND role = 'moderator' AND status = 'approved' LIMIT 1",
    )
    .get(userId) as { n: number } | undefined
  return row !== undefined
}

/** Toplu kullanıcı getirme: rütbe/rozet çözümü için (N+1 sorgu önlenir). */
export function usersByIds(ctx: Ctx, ids: string[]): UserRow[] {
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return []
  const marks = unique.map(() => '?').join(', ')
  return ctx.db
    .prepare(`SELECT * FROM users WHERE id IN (${marks})`)
    .all(...unique) as unknown as UserRow[]
}

/** Tek kullanıcı (yoksa null). */
export function getUserById(ctx: Ctx, id: string): UserRow | null {
  const row = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  return row ?? null
}

/**
 * Görüntülenen gönderi/yorum yazarlarının rütbe ve yetki bilgisi.
 * Tek toplu sorguda çözülür; kart başına ayrı sorgu yapılmaz.
 */
export function authorRanksFor(ctx: Ctx, authorIds: Array<string | null | undefined>): Map<string, UserRank> {
  return rankInfoFor(ctx, usersByIds(ctx, authorIds.filter((id): id is string => Boolean(id))))
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
      is_admin: user.is_admin,
      avatar_key: user.avatar_key,
      cover_key: user.cover_key,
      rank_mode: user.rank_mode,
      rank_override: user.rank_override,
      staff_role: user.staff_role,
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

/**
 * Username change. Reuses the registration validator and the same uniqueness
 * rule, so a name that could not be registered cannot be taken here either.
 * Sessions keep working because they key on the user id, not the username.
 */
export function changeUsername(ctx: Ctx, viewer: Viewer, rawUsername: string): UserRow {
  if (!viewer) throw unauthorized()
  const username = validateUsername(rawUsername)
  if (username.toLowerCase() === viewer.username_lower) return viewer
  const taken = ctx.db
    .prepare('SELECT 1 FROM users WHERE username_lower = ? AND id != ?')
    .get(username.toLowerCase(), viewer.id)
  if (taken) throw conflict('username_taken', 'Bu kullanıcı adı zaten alınmış.')
  ctx.db
    .prepare('UPDATE users SET username = ?, username_lower = ? WHERE id = ?')
    .run(username, username.toLowerCase(), viewer.id)
  return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id) as unknown as UserRow
}

/**
 * Password change. Requires the current password, so a stolen session alone
 * cannot lock the owner out. Other sessions are dropped on success.
 */
export async function changePassword(
  ctx: Ctx,
  viewer: Viewer,
  currentPassword: string,
  newPassword: string,
  keepSessionToken?: string,
): Promise<void> {
  if (!viewer) throw unauthorized()
  const valid = await verifyPassword(viewer.password_hash, currentPassword)
  if (!valid) throw forbidden('Mevcut parola hatalı.')
  const next = validatePassword(newPassword)
  if (next === currentPassword) throw forbidden('Yeni parola eskisiyle aynı olamaz.')
  const hash = await hashPassword(next)
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, viewer.id)
    // Keep the session the user is acting from; drop any other device.
    if (keepSessionToken) {
      ctx.db
        .prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
        .run(viewer.id, sha256(keepSessionToken))
    } else {
      ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(viewer.id)
    }
  })
}

/** Set or clear the profile picture / cover. `key` must be an owned, uploaded image. */
export function setProfileImage(
  ctx: Ctx,
  viewer: Viewer,
  field: 'avatar' | 'cover',
  key: string | null,
): UserRow {
  if (!viewer) throw unauthorized()
  const column = field === 'avatar' ? 'avatar_key' : 'cover_key'
  if (key === null) {
    ctx.db.prepare(`UPDATE users SET ${column} = NULL WHERE id = ?`).run(viewer.id)
    return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id) as unknown as UserRow
  }
  // Reuses the post-image pipeline: ownership, single-use, type and size checks.
  attachUpload(ctx, viewer, key)
  ctx.db.prepare(`UPDATE users SET ${column} = ? WHERE id = ?`).run(key, viewer.id)
  return ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(viewer.id) as unknown as UserRow
}
