import type { Ctx } from '../context'
import type { CommentRow, CommunityRow, PostRow, Viewer } from '../types'
import { badRequest, forbidden, notFound } from './errors'
import { getCommunityById, getMembership, requireAdmin, requireModerator } from './access'
import { getPost, syncPostFts } from './posts'
import { getComment } from './comments'
import { notify, withdrawForComment } from './notifications'
import { logAction } from './modlog'
import { resolveReportsForTarget } from './reports'
import { listModerators } from './communities'
import { isAdminPower } from './ranks'
import { transaction } from '../db'

const DAY_MS = 24 * 60 * 60 * 1000
export const BAN_DURATIONS_DAYS = [3, 7, 30] as const

function targetCommunity(ctx: Ctx, targetType: 'post' | 'comment', target: PostRow | CommentRow): CommunityRow {
  const communityId =
    targetType === 'post'
      ? (target as PostRow).community_id
      : (getPost(ctx, (target as CommentRow).post_id) as PostRow).community_id
  const community = getCommunityById(ctx, communityId)
  if (!community) throw notFound('Topluluk bulunamadı.')
  return community
}

/**
 * US-031: remove content. Karma reversal is automatic (karma sums exclude
 * removed rows); reply notifications from a removed comment are withdrawn.
 */
export function removeContent(
  ctx: Ctx,
  viewer: Viewer,
  targetType: 'post' | 'comment',
  targetId: string,
  citedRule?: string | null,
): void {
  const target = targetType === 'post' ? getPost(ctx, targetId) : getComment(ctx, targetId)
  if (!target || target.deleted) throw notFound('Bu içerik artık mevcut değil.')
  const community = targetCommunity(ctx, targetType, target)
  const actor = requireModerator(ctx, viewer, community)

  transaction(ctx.db, () => {
    if (targetType === 'post') {
      ctx.db.prepare('UPDATE posts SET removed = 1, auto_hidden = 0, pinned_at = NULL WHERE id = ?').run(targetId)
      syncPostFts(ctx, getPost(ctx, targetId) as PostRow)
    } else {
      ctx.db.prepare('UPDATE comments SET removed = 1, auto_hidden = 0 WHERE id = ?').run(targetId)
      withdrawForComment(ctx, targetId)
    }
    resolveReportsForTarget(ctx, actor.id, targetType, targetId)
    logAction(ctx, {
      communityId: community.id,
      actorId: actor.id,
      action: `remove_${targetType}`,
      targetType,
      targetId,
      reason: citedRule ?? null,
    })
    // US-041: author notified; acting moderator and reporters never identified.
    notify(ctx, {
      userId: target.author_id,
      type: 'mod_removal',
      title: `c/${community.name} topluluğundaki ${targetType === 'post' ? 'gönderiniz' : 'yorumunuz'} moderatörler tarafından kaldırıldı${citedRule ? ` — atıf yapılan kural: ${citedRule}` : ''}.`,
      link: `/c/${community.name}`,
    })
  })
}

/** Site admin can view and reverse any removal (US-031). */
export function restoreContent(ctx: Ctx, viewer: Viewer, targetType: 'post' | 'comment', targetId: string): void {
  const target = targetType === 'post' ? getPost(ctx, targetId) : getComment(ctx, targetId)
  if (!target) throw notFound('Bu içerik artık mevcut değil.')
  const community = targetCommunity(ctx, targetType, target)
  const admin = requireAdmin(viewer)

  transaction(ctx.db, () => {
    if (targetType === 'post') {
      ctx.db.prepare('UPDATE posts SET removed = 0, auto_hidden = 0 WHERE id = ?').run(targetId)
      syncPostFts(ctx, getPost(ctx, targetId) as PostRow)
    } else {
      ctx.db.prepare('UPDATE comments SET removed = 0, auto_hidden = 0 WHERE id = ?').run(targetId)
    }
    logAction(ctx, {
      communityId: community.id,
      actorId: admin.id,
      action: `restore_${targetType}`,
      targetType,
      targetId,
    })
  })
}

/** US-032: community-scoped ban, timed or permanent. */
export function banUser(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  userId: string,
  durationDays: number | null,
  reason?: string | null,
): void {
  const actor = requireModerator(ctx, viewer, community)
  if (durationDays !== null && !BAN_DURATIONS_DAYS.includes(durationDays as (typeof BAN_DURATIONS_DAYS)[number])) {
    throw badRequest('duration', 'Yasaklama süresi 3, 7 veya 30 gün ya da süresiz olmalıdır.')
  }
  const target = ctx.db.prepare('SELECT id, is_admin, staff_role FROM users WHERE id = ? AND deleted = 0').get(userId) as
    | { id: string; is_admin: number; staff_role: string }
    | undefined
  if (!target) throw notFound('Kullanıcı bulunamadı.')
  if (isAdminPower(target)) throw forbidden('Site yöneticileri topluluklardan yasaklanamaz.')
  if (target.id === actor.id) throw badRequest('self', 'Kendinizi yasaklayamazsınız.')

  const expiresAt = durationDays === null ? null : ctx.now() + durationDays * DAY_MS
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO bans (community_id, user_id, expires_at, reason, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(community_id, user_id) DO UPDATE SET expires_at = excluded.expires_at,
           reason = excluded.reason, created_by = excluded.created_by, created_at = excluded.created_at`,
      )
      .run(community.id, userId, expiresAt, reason ?? null, actor.id, ctx.now())
    // Banned members lose membership (cannot rejoin while banned, US-010).
    ctx.db.prepare('DELETE FROM memberships WHERE user_id = ? AND community_id = ?').run(userId, community.id)
    logAction(ctx, {
      communityId: community.id,
      actorId: actor.id,
      action: 'ban_user',
      targetType: 'user',
      targetId: userId,
      reason: reason ?? null,
      detail: durationDays === null ? 'süresiz' : `${durationDays} gün`,
    })
    notify(ctx, {
      userId,
      type: 'mod_ban',
      title: `c/${community.name} topluluğundan ${durationDays === null ? 'süresiz olarak' : `${durationDays} gün süreyle`} yasaklandınız${reason ? ` — sebep: ${reason}` : ''}.`,
      link: `/c/${community.name}`,
    })
  })
}

export function unbanUser(ctx: Ctx, viewer: Viewer, community: CommunityRow, userId: string): void {
  const actor = requireModerator(ctx, viewer, community)
  ctx.db.prepare('DELETE FROM bans WHERE community_id = ? AND user_id = ?').run(community.id, userId)
  logAction(ctx, {
    communityId: community.id,
    actorId: actor.id,
    action: 'unban_user',
    targetType: 'user',
    targetId: userId,
  })
}

/** US-033: pin up to 2 posts; pinning a third requires unpinning first. */
export function pinPost(ctx: Ctx, viewer: Viewer, postId: string): void {
  const post = getPost(ctx, postId)
  if (!post || post.deleted || post.removed) throw notFound('Gönderi bulunamadı.')
  const community = getCommunityById(ctx, post.community_id) as CommunityRow
  const actor = requireModerator(ctx, viewer, community)
  if (post.pinned_at !== null) return
  const pinnedCount = (
    ctx.db
      .prepare('SELECT COUNT(*) AS n FROM posts WHERE community_id = ? AND pinned_at IS NOT NULL AND deleted = 0 AND removed = 0')
      .get(community.id) as { n: number }
  ).n
  if (pinnedCount >= 2) {
    throw badRequest('pin_limit', 'Bir topluluk en fazla 2 gönderi sabitleyebilir. Önce bir gönderinin sabitlemesini kaldırın.')
  }
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE posts SET pinned_at = ? WHERE id = ?').run(ctx.now(), postId)
    logAction(ctx, { communityId: community.id, actorId: actor.id, action: 'pin_post', targetType: 'post', targetId: postId })
  })
}

export function unpinPost(ctx: Ctx, viewer: Viewer, postId: string): void {
  const post = getPost(ctx, postId)
  if (!post) throw notFound('Gönderi bulunamadı.')
  const community = getCommunityById(ctx, post.community_id) as CommunityRow
  const actor = requireModerator(ctx, viewer, community)
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE posts SET pinned_at = NULL WHERE id = ?').run(postId)
    logAction(ctx, { communityId: community.id, actorId: actor.id, action: 'unpin_post', targetType: 'post', targetId: postId })
  })
}

/** US-034: any moderator may appoint; only the oldest-standing moderator or admin removes. */
export function appointModerator(ctx: Ctx, viewer: Viewer, community: CommunityRow, userId: string): void {
  const actor = requireModerator(ctx, viewer, community)
  const membership = getMembership(ctx, userId, community.id)
  if (!membership || membership.status !== 'approved') {
    throw badRequest('not_member', 'Yalnızca onaylı üyeler moderatör olarak atanabilir.')
  }
  if (membership.role === 'moderator') return
  transaction(ctx.db, () => {
    ctx.db
      .prepare("UPDATE memberships SET role = 'moderator', mod_since = ? WHERE user_id = ? AND community_id = ?")
      .run(ctx.now(), userId, community.id)
    logAction(ctx, {
      communityId: community.id,
      actorId: actor.id,
      action: 'moderator_appoint',
      targetType: 'user',
      targetId: userId,
    })
  })
}

export function removeModerator(ctx: Ctx, viewer: Viewer, community: CommunityRow, userId: string): void {
  const actor = requireModerator(ctx, viewer, community)
  const membership = getMembership(ctx, userId, community.id)
  if (!membership || membership.role !== 'moderator') throw notFound('Bu kullanıcı moderatör değil.')

  const moderators = listModerators(ctx, community.id)
  if (moderators.length <= 1) {
    throw badRequest('last_moderator', 'Son moderatör kaldırılamaz. Yerine başka bir moderatör atayın ya da site yöneticisine danışın.')
  }
  const oldest = moderators[0]
  const isSelfStepDown = actor.id === userId
  if (!isSelfStepDown && !isAdminPower(actor) && actor.id !== oldest?.user_id) {
    throw forbidden('Yalnızca en eski moderatör ya da site yöneticisi diğer moderatörleri kaldırabilir.')
  }
  transaction(ctx.db, () => {
    ctx.db
      .prepare("UPDATE memberships SET role = 'member', mod_since = NULL WHERE user_id = ? AND community_id = ?")
      .run(userId, community.id)
    logAction(ctx, {
      communityId: community.id,
      actorId: actor.id,
      action: 'moderator_remove',
      targetType: 'user',
      targetId: userId,
    })
  })
}

export interface BanEntry {
  user_id: string
  username: string
  expires_at: number | null
  reason: string | null
  created_at: number
}

export function listBans(ctx: Ctx, viewer: Viewer, community: CommunityRow): BanEntry[] {
  requireModerator(ctx, viewer, community)
  return ctx.db
    .prepare(
      `SELECT b.user_id, u.username, b.expires_at, b.reason, b.created_at
       FROM bans b JOIN users u ON u.id = b.user_id
       WHERE b.community_id = ? AND (b.expires_at IS NULL OR b.expires_at > ?)
       ORDER BY b.created_at DESC`,
    )
    .all(community.id, ctx.now()) as unknown as BanEntry[]
}
