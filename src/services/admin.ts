import { mkdirSync } from 'node:fs'
import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../context'
import type { CommunityRow, UserRow, Viewer } from '../types'
import { newId, newSecret } from '../lib/ids'
import { badRequest, notFound } from './errors'
import { requireAdmin } from './access'
import { invalidateAllSessions } from './auth'
import { logAction } from './modlog'
import { syncCommunityFts } from './communities'
import { transaction } from '../db'

const DAY_MS = 24 * 60 * 60 * 1000

/** US-036: site-wide suspension; sessions die immediately, login is blocked. */
export function suspendUser(
  ctx: Ctx,
  viewer: Viewer,
  userId: string,
  input: { days: number | null; reason?: string | null },
): void {
  const admin = requireAdmin(viewer)
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ? AND deleted = 0').get(userId) as UserRow | undefined
  if (!user) throw notFound('User not found.')
  if (user.is_admin) throw badRequest('admin', 'Site admins cannot be suspended.')
  const until = input.days === null ? null : ctx.now() + input.days * DAY_MS
  transaction(ctx.db, () => {
    ctx.db
      .prepare('UPDATE users SET suspended_until = ?, suspended_indefinitely = ?, suspension_reason = ? WHERE id = ?')
      .run(until, input.days === null ? 1 : 0, input.reason ?? null, userId)
    invalidateAllSessions(ctx, userId)
    logAction(ctx, {
      communityId: null,
      actorId: admin.id,
      action: 'suspend_user',
      targetType: 'user',
      targetId: userId,
      reason: input.reason ?? null,
      detail: input.days === null ? 'indefinite' : `${input.days} days`,
    })
  })
}

export function unsuspendUser(ctx: Ctx, viewer: Viewer, userId: string): void {
  const admin = requireAdmin(viewer)
  transaction(ctx.db, () => {
    ctx.db
      .prepare('UPDATE users SET suspended_until = NULL, suspended_indefinitely = 0, suspension_reason = NULL WHERE id = ?')
      .run(userId)
    logAction(ctx, { communityId: null, actorId: admin.id, action: 'unsuspend_user', targetType: 'user', targetId: userId })
  })
}

/** US-037: archive = read-only, reversible. */
export function setCommunityArchived(ctx: Ctx, viewer: Viewer, community: CommunityRow, archived: boolean): void {
  const admin = requireAdmin(viewer)
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE communities SET archived = ? WHERE id = ?').run(archived ? 1 : 0, community.id)
    logAction(ctx, {
      communityId: null,
      actorId: admin.id,
      action: archived ? 'archive_community' : 'unarchive_community',
      targetType: 'community',
      targetId: community.id,
    })
  })
}

/** US-037: soft delete with typed-name confirmation; recoverable for 30 days. */
export function deleteCommunity(ctx: Ctx, viewer: Viewer, community: CommunityRow, typedName: string): void {
  const admin = requireAdmin(viewer)
  if (typedName.trim().toLowerCase() !== community.name) {
    throw badRequest('confirm', 'Type the community name exactly to confirm deletion.')
  }
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE communities SET deleted_at = ? WHERE id = ?').run(ctx.now(), community.id)
    syncCommunityFts(ctx, community.id)
    ctx.db.prepare('DELETE FROM posts_fts WHERE post_id IN (SELECT id FROM posts WHERE community_id = ?)').run(community.id)
    logAction(ctx, {
      communityId: null,
      actorId: admin.id,
      action: 'delete_community',
      targetType: 'community',
      targetId: community.id,
      detail: community.name,
    })
  })
}

export function restoreCommunity(ctx: Ctx, viewer: Viewer, community: CommunityRow): void {
  const admin = requireAdmin(viewer)
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE communities SET deleted_at = NULL WHERE id = ?').run(community.id)
    syncCommunityFts(ctx, community.id)
    const posts = ctx.db.prepare('SELECT id, title, body FROM posts WHERE community_id = ? AND deleted = 0 AND removed = 0 AND auto_hidden = 0').all(community.id) as Array<{ id: string; title: string; body: string | null }>
    const insert = ctx.db.prepare('INSERT INTO posts_fts (title, body, post_id) VALUES (?, ?, ?)')
    for (const p of posts) insert.run(p.title, p.body ?? '', p.id)
    logAction(ctx, {
      communityId: null,
      actorId: admin.id,
      action: 'restore_community',
      targetType: 'community',
      targetId: community.id,
    })
  })
}

/** Purge sweep: hard-delete community content 30 days after soft deletion. */
export function purgeExpiredCommunities(ctx: Ctx): number {
  const cutoff = ctx.now() - ctx.config.communityPurgeAfterMs
  const expired = ctx.db
    .prepare('SELECT id FROM communities WHERE deleted_at IS NOT NULL AND deleted_at <= ?')
    .all(cutoff) as Array<{ id: string }>
  for (const { id } of expired) {
    transaction(ctx.db, () => {
      const postIds = (ctx.db.prepare('SELECT id FROM posts WHERE community_id = ?').all(id) as Array<{ id: string }>).map((r) => r.id)
      for (const postId of postIds) {
        ctx.db.prepare("DELETE FROM votes WHERE target_type = 'comment' AND target_id IN (SELECT id FROM comments WHERE post_id = ?)").run(postId)
        ctx.db.prepare('DELETE FROM comments WHERE post_id = ?').run(postId)
        ctx.db.prepare("DELETE FROM votes WHERE target_type = 'post' AND target_id = ?").run(postId)
        ctx.db.prepare("DELETE FROM reports WHERE target_type = 'post' AND target_id = ?").run(postId)
      }
      ctx.db.prepare('DELETE FROM reports WHERE community_id = ?').run(id)
      ctx.db.prepare('DELETE FROM posts WHERE community_id = ?').run(id)
      ctx.db.prepare('DELETE FROM community_rules WHERE community_id = ?').run(id)
      ctx.db.prepare('DELETE FROM memberships WHERE community_id = ?').run(id)
      ctx.db.prepare('DELETE FROM bans WHERE community_id = ?').run(id)
      ctx.db.prepare('DELETE FROM exports WHERE community_id = ?').run(id)
      ctx.db.prepare('DELETE FROM mod_actions WHERE community_id = ?').run(id)
      ctx.db.prepare('DELETE FROM communities WHERE id = ?').run(id)
    })
  }
  return expired.length
}

export interface AdminUserEntry {
  id: string
  username: string
  email_lower: string | null
  is_admin: number
  deleted: number
  suspended_until: number | null
  suspended_indefinitely: number
  created_at: number
}

export function listUsers(ctx: Ctx, viewer: Viewer, query?: string): AdminUserEntry[] {
  requireAdmin(viewer)
  if (query?.trim()) {
    return ctx.db
      .prepare(
        `SELECT id, username, email_lower, is_admin, deleted, suspended_until, suspended_indefinitely, created_at
         FROM users WHERE username_lower LIKE ? ORDER BY created_at DESC LIMIT 200`,
      )
      .all(`%${query.trim().toLowerCase().replaceAll('%', '')}%`) as unknown as AdminUserEntry[]
  }
  return ctx.db
    .prepare(
      `SELECT id, username, email_lower, is_admin, deleted, suspended_until, suspended_indefinitely, created_at
       FROM users ORDER BY created_at DESC LIMIT 200`,
    )
    .all() as unknown as AdminUserEntry[]
}

export function listAllCommunities(ctx: Ctx, viewer: Viewer): Array<CommunityRow & { member_count: number; post_count: number }> {
  requireAdmin(viewer)
  return ctx.db
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id AND m.status = 'approved') AS member_count,
        (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.deleted = 0) AS post_count
       FROM communities c ORDER BY c.created_at DESC`,
    )
    .all() as unknown as Array<CommunityRow & { member_count: number; post_count: number }>
}

/** US-038: invite links with expiry and use limits. */
export function createInvite(ctx: Ctx, viewer: Viewer, input: { expiresInDays: number; maxUses: number }): { code: string } {
  const admin = requireAdmin(viewer)
  const code = newSecret().slice(0, 20)
  const expiresInDays = Math.max(1, Math.min(365, Math.trunc(input.expiresInDays)))
  const maxUses = Math.max(1, Math.min(1000, Math.trunc(input.maxUses)))
  ctx.db
    .prepare('INSERT INTO invites (code, created_by, expires_at, max_uses, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, admin.id, ctx.now() + expiresInDays * DAY_MS, maxUses, ctx.now())
  logAction(ctx, { communityId: null, actorId: admin.id, action: 'create_invite', detail: `expires ${expiresInDays}d, max ${maxUses}` })
  return { code }
}

export function listInvites(ctx: Ctx, viewer: Viewer): Array<{ code: string; expires_at: number; max_uses: number; uses: number }> {
  requireAdmin(viewer)
  return ctx.db
    .prepare('SELECT code, expires_at, max_uses, uses FROM invites ORDER BY created_at DESC LIMIT 100')
    .all() as unknown as Array<{ code: string; expires_at: number; max_uses: number; uses: number }>
}

/**
 * US-039: JSON export of a community's posts/comments. Includes scores,
 * timestamps, author usernames; excludes emails, hashes, vote rows, IPs.
 * Download link is valid for 24 hours.
 */
export async function exportCommunity(ctx: Ctx, viewer: Viewer, community: CommunityRow): Promise<{ token: string; expiresAt: number }> {
  const admin = requireAdmin(viewer)
  const posts = ctx.db
    .prepare(
      `SELECT p.id, p.type, p.title, p.body, p.url, p.image_key, p.score, p.upvotes, p.downvotes,
              p.comment_count, p.created_at, p.edited_at, p.deleted, p.removed,
              CASE WHEN u.deleted = 1 THEN '[deleted]' ELSE u.username END AS author
       FROM posts p JOIN users u ON u.id = p.author_id WHERE p.community_id = ? ORDER BY p.created_at ASC`,
    )
    .all(community.id)
  const comments = ctx.db
    .prepare(
      `SELECT c.id, c.post_id, c.parent_id, c.depth, c.body, c.score, c.upvotes, c.downvotes,
              c.created_at, c.edited_at, c.deleted, c.removed,
              CASE WHEN u.deleted = 1 THEN '[deleted]' ELSE u.username END AS author
       FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.post_id IN (SELECT id FROM posts WHERE community_id = ?) ORDER BY c.created_at ASC`,
    )
    .all(community.id)

  const payload = {
    community: { name: community.name, title: community.title, description: community.description, visibility: community.visibility },
    exportedAt: new Date(ctx.now()).toISOString(),
    posts,
    comments,
  }
  mkdirSync(ctx.config.exportDir, { recursive: true })
  const token = newSecret()
  const filePath = join(ctx.config.exportDir, `${community.name}-${newId()}.json`)
  await writeFile(filePath, JSON.stringify(payload, null, 2))
  const expiresAt = ctx.now() + ctx.config.exportLinkTtlMs
  ctx.db
    .prepare('INSERT INTO exports (token, community_id, file_path, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(token, community.id, filePath, expiresAt, ctx.now())
  logAction(ctx, {
    communityId: null,
    actorId: admin.id,
    action: 'export_community',
    targetType: 'community',
    targetId: community.id,
  })
  return { token, expiresAt }
}

export async function getExport(ctx: Ctx, token: string): Promise<string | null> {
  const row = ctx.db.prepare('SELECT * FROM exports WHERE token = ?').get(token) as
    | { token: string; file_path: string; expires_at: number }
    | undefined
  if (!row) return null
  if (row.expires_at <= ctx.now()) {
    await rm(row.file_path, { force: true })
    ctx.db.prepare('DELETE FROM exports WHERE token = ?').run(token)
    return null
  }
  return row.file_path
}
