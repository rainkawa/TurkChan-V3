import type { Ctx } from '../context'
import type { CommunityRow, CommunityRuleRow, MembershipRow, UserRow, Viewer } from '../types'
import { newId } from '../lib/ids'
import {
  validateCommunityName,
  ValidationError,
  LIMITS,
} from '../lib/validation'
import { getSettings } from './settings'
import { badRequest, conflict, forbidden, notFound, unauthorized } from './errors'
import {
  activeBan,
  getCommunityByName,
  getMembership,
  isSuspended,
  requireModerator,
} from './access'
import { logAction } from './modlog'
import { transaction } from '../db'
import { notify } from './notifications'

export function createCommunity(
  ctx: Ctx,
  viewer: Viewer,
  input: { name: string; title: string; description: string; visibility: string },
): CommunityRow {
  if (!viewer) throw unauthorized()
  if (isSuspended(ctx, viewer)) throw forbidden('Hesabınız askıya alınmış.')
  const settings = getSettings(ctx)
  if (settings.communityCreation === 'admin' && !viewer.is_admin) {
    throw forbidden('Şu anda yalnızca site yöneticileri topluluk oluşturabilir.')
  }

  const name = validateCommunityName(input.name)
  const title = input.title.trim() || name
  if (title.length > LIMITS.communityTitleMax) {
    throw new ValidationError('title', `Başlık en fazla ${LIMITS.communityTitleMax} karakter olabilir.`)
  }
  const description = input.description.trim().slice(0, LIMITS.communityDescriptionMax)
  if (!['public', 'restricted', 'private'].includes(input.visibility)) {
    throw badRequest('visibility', 'Görünürlük herkese açık, kısıtlı veya gizli olmalıdır.')
  }
  if (getCommunityByName(ctx, name)) throw conflict('name_taken', 'Bu topluluk adı zaten alınmış.')

  const id = newId()
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO communities (id, name, title, description, visibility, creator_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, title, description, input.visibility, viewer.id, ctx.now())
    // Creator becomes first moderator and a member (US-008).
    ctx.db
      .prepare(
        `INSERT INTO memberships (user_id, community_id, role, status, mod_since, created_at)
         VALUES (?, ?, 'moderator', 'approved', ?, ?)`,
      )
      .run(viewer.id, id, ctx.now(), ctx.now())
    syncCommunityFts(ctx, id)
  })
  return getCommunityByName(ctx, name) as CommunityRow
}

export function syncCommunityFts(ctx: Ctx, communityId: string): void {
  ctx.db.prepare('DELETE FROM communities_fts WHERE community_id = ?').run(communityId)
  const community = ctx.db.prepare('SELECT * FROM communities WHERE id = ?').get(communityId) as
    | CommunityRow
    | undefined
  if (!community || community.deleted_at !== null) return
  ctx.db
    .prepare('INSERT INTO communities_fts (name, title, description, community_id) VALUES (?, ?, ?, ?)')
    .run(community.name, community.title, community.description, community.id)
}

export interface DirectoryEntry extends CommunityRow {
  member_count: number
}

/** US-009: public + restricted communities; private excluded for non-members. */
export function listDirectory(ctx: Ctx, viewer: Viewer): DirectoryEntry[] {
  const rows = ctx.db
    .prepare(
      `SELECT c.*, (
         SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id AND m.status = 'approved'
       ) AS member_count
       FROM communities c
       WHERE c.deleted_at IS NULL
       ORDER BY member_count DESC, c.created_at ASC`,
    )
    .all() as unknown as DirectoryEntry[]
  return rows.filter((c) => {
    if (c.visibility !== 'private') return true
    if (!viewer) return false
    if (viewer.is_admin) return true
    const m = getMembership(ctx, viewer.id, c.id)
    return m?.status === 'approved'
  })
}

export function memberCount(ctx: Ctx, communityId: string): number {
  return (
    ctx.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE community_id = ? AND status = 'approved'")
      .get(communityId) as { n: number }
  ).n
}

export function listRules(ctx: Ctx, communityId: string): CommunityRuleRow[] {
  return ctx.db
    .prepare('SELECT * FROM community_rules WHERE community_id = ? ORDER BY position ASC')
    .all(communityId) as unknown as CommunityRuleRow[]
}

export function updateCommunitySettings(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  input: {
    title?: string
    description?: string
    visibility?: string
    autoHideReports?: number
    hideCommentScoresMinutes?: number
  },
): CommunityRow {
  const actor = requireModerator(ctx, viewer, community)
  const title = (input.title ?? community.title).trim().slice(0, LIMITS.communityTitleMax) || community.title
  const description = (input.description ?? community.description).trim().slice(0, LIMITS.communityDescriptionMax)
  const visibility = input.visibility ?? community.visibility
  if (!['public', 'restricted', 'private'].includes(visibility)) {
    throw badRequest('visibility', 'Görünürlük herkese açık, kısıtlı veya gizli olmalıdır.')
  }
  const autoHide = Math.max(0, Math.min(100, Math.trunc(input.autoHideReports ?? community.auto_hide_reports)))
  const hideScores = Math.max(0, Math.min(1440, Math.trunc(input.hideCommentScoresMinutes ?? community.hide_comment_scores_minutes)))

  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE communities SET title = ?, description = ?, visibility = ?, auto_hide_reports = ?, hide_comment_scores_minutes = ?
         WHERE id = ?`,
      )
      .run(title, description, visibility, autoHide, hideScores, community.id)
    syncCommunityFts(ctx, community.id)
    logAction(ctx, {
      communityId: community.id,
      actorId: actor.id,
      action: 'settings_update',
      detail: JSON.stringify({ title, visibility, autoHideReports: autoHide, hideCommentScoresMinutes: hideScores }),
    })
  })
  return ctx.db.prepare('SELECT * FROM communities WHERE id = ?').get(community.id) as unknown as CommunityRow
}

export function replaceRules(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  rules: Array<{ title: string; detail?: string }>,
): CommunityRuleRow[] {
  const actor = requireModerator(ctx, viewer, community)
  if (rules.length > LIMITS.ruleMax) {
    throw badRequest('rules', `Bir toplulukta en fazla ${LIMITS.ruleMax} kural olabilir.`)
  }
  const cleaned = rules
    .map((r) => ({
      title: r.title.trim().slice(0, LIMITS.ruleTitleMax),
      detail: (r.detail ?? '').trim().slice(0, LIMITS.ruleDetailMax) || null,
    }))
    .filter((r) => r.title.length > 0)
  transaction(ctx.db, () => {
    ctx.db.prepare('DELETE FROM community_rules WHERE community_id = ?').run(community.id)
    const insert = ctx.db.prepare(
      'INSERT INTO community_rules (id, community_id, position, title, detail) VALUES (?, ?, ?, ?, ?)',
    )
    cleaned.forEach((rule, index) => insert.run(newId(), community.id, index + 1, rule.title, rule.detail))
    logAction(ctx, {
      communityId: community.id,
      actorId: actor.id,
      action: 'rules_update',
      detail: JSON.stringify(cleaned.map((r) => r.title)),
    })
  })
  return listRules(ctx, community.id)
}

/** US-010: join (instant for public; pending request for restricted/private). */
export function joinCommunity(ctx: Ctx, viewer: Viewer, community: CommunityRow): MembershipRow {
  if (!viewer) throw unauthorized()
  if (isSuspended(ctx, viewer)) throw forbidden('Hesabınız askıya alınmış.')
  if (community.archived) throw badRequest('archived', 'Bu topluluk arşivlenmiş durumdadır.')
  if (community.deleted_at !== null) throw notFound('Topluluk bulunamadı.')
  if (activeBan(ctx, viewer.id, community.id)) {
    throw forbidden('Bu topluluktan yasaklandınız ve yeniden katılamazsınız.')
  }
  const existing = getMembership(ctx, viewer.id, community.id)
  if (existing?.status === 'approved') return existing
  const status = community.visibility === 'public' ? 'approved' : 'pending'
  ctx.db
    .prepare(
      `INSERT INTO memberships (user_id, community_id, role, status, created_at)
       VALUES (?, ?, 'member', ?, ?)
       ON CONFLICT(user_id, community_id) DO UPDATE SET status = excluded.status, created_at = excluded.created_at`,
    )
    .run(viewer.id, community.id, status, ctx.now())
  return getMembership(ctx, viewer.id, community.id) as MembershipRow
}

export function leaveCommunity(ctx: Ctx, viewer: Viewer, community: CommunityRow): void {
  if (!viewer) throw unauthorized()
  const membership = getMembership(ctx, viewer.id, community.id)
  if (!membership) return
  if (membership.role === 'moderator' && lastModeratorId(ctx, community.id) === viewer.id) {
    throw badRequest('last_moderator', 'Son moderatörsünüz. Ayrılmadan önce başka bir moderatör atayın.')
  }
  ctx.db.prepare('DELETE FROM memberships WHERE user_id = ? AND community_id = ?').run(viewer.id, community.id)
}

function lastModeratorId(ctx: Ctx, communityId: string): string | null {
  const mods = ctx.db
    .prepare(
      "SELECT user_id FROM memberships WHERE community_id = ? AND role = 'moderator' AND status = 'approved'",
    )
    .all(communityId) as Array<{ user_id: string }>
  return mods.length === 1 ? (mods[0] as { user_id: string }).user_id : null
}

export interface PendingRequest extends MembershipRow {
  username: string
}

export function pendingRequests(ctx: Ctx, viewer: Viewer, community: CommunityRow): PendingRequest[] {
  requireModerator(ctx, viewer, community)
  return ctx.db
    .prepare(
      `SELECT m.*, u.username FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.status = 'pending' ORDER BY m.created_at ASC`,
    )
    .all(community.id) as unknown as PendingRequest[]
}

/** US-011: approve or reject a join request; both mod-logged. */
export function resolveJoinRequest(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  userId: string,
  decision: 'approve' | 'reject',
): void {
  const actor = requireModerator(ctx, viewer, community)
  const membership = getMembership(ctx, userId, community.id)
  if (!membership || membership.status !== 'pending') throw notFound('Bu kullanıcı için bekleyen istek yok.')
  transaction(ctx.db, () => {
    ctx.db
      .prepare('UPDATE memberships SET status = ? WHERE user_id = ? AND community_id = ?')
      .run(decision === 'approve' ? 'approved' : 'rejected', userId, community.id)
    logAction(ctx, {
      communityId: community.id,
      actorId: actor.id,
      action: decision === 'approve' ? 'membership_approve' : 'membership_reject',
      targetType: 'user',
      targetId: userId,
    })
    notify(ctx, {
      userId,
      type: 'membership',
      title:
        decision === 'approve'
          ? `Your request to join c/${community.name} was approved.`
          : `Your request to join c/${community.name} was declined.`,
      link: `/c/${community.name}`,
    })
  })
}

export function listModerators(ctx: Ctx, communityId: string): Array<{ user_id: string; username: string; mod_since: number | null }> {
  return ctx.db
    .prepare(
      `SELECT m.user_id, u.username, m.mod_since FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.community_id = ? AND m.role = 'moderator' AND m.status = 'approved'
       ORDER BY m.mod_since ASC`,
    )
    .all(communityId) as unknown as Array<{ user_id: string; username: string; mod_since: number | null }>
}

export function getUserForModeration(ctx: Ctx, username: string): UserRow | null {
  return (
    (ctx.db
      .prepare('SELECT * FROM users WHERE username_lower = ? AND deleted = 0')
      .get(username.toLowerCase()) as UserRow | undefined) ?? null
  )
}
