import type { Ctx } from '../context'
import type { CommunityRow, MembershipRow, UserRow, Viewer } from '../types'
import { forbidden, notFound, unauthorized, badRequest } from './errors'

/**
 * Authorisation core (US-044). Every read/write goes through these checks
 * server-side; client-side hiding is never the only control.
 */

export function getCommunityByName(ctx: Ctx, name: string): CommunityRow | null {
  const row = ctx.db.prepare('SELECT * FROM communities WHERE name = ?').get(name.toLowerCase()) as
    | CommunityRow
    | undefined
  return row ?? null
}

export function getCommunityById(ctx: Ctx, id: string): CommunityRow | null {
  const row = ctx.db.prepare('SELECT * FROM communities WHERE id = ?').get(id) as CommunityRow | undefined
  return row ?? null
}

export function getMembership(ctx: Ctx, userId: string, communityId: string): MembershipRow | null {
  const row = ctx.db
    .prepare('SELECT * FROM memberships WHERE user_id = ? AND community_id = ?')
    .get(userId, communityId) as MembershipRow | undefined
  return row ?? null
}

export function isApprovedMember(ctx: Ctx, viewer: Viewer, communityId: string): boolean {
  if (!viewer) return false
  const m = getMembership(ctx, viewer.id, communityId)
  return m?.status === 'approved'
}

export function isModerator(ctx: Ctx, viewer: Viewer, communityId: string): boolean {
  if (!viewer) return false
  if (viewer.is_admin) return true
  const m = getMembership(ctx, viewer.id, communityId)
  return m?.status === 'approved' && m.role === 'moderator'
}

export function activeBan(ctx: Ctx, userId: string, communityId: string): { expires_at: number | null; reason: string | null } | null {
  const row = ctx.db
    .prepare('SELECT expires_at, reason FROM bans WHERE community_id = ? AND user_id = ?')
    .get(communityId, userId) as { expires_at: number | null; reason: string | null } | undefined
  if (!row) return null
  if (row.expires_at !== null && row.expires_at <= ctx.now()) return null // timed ban lifted
  return row
}

export function isSuspended(ctx: Ctx, user: UserRow): boolean {
  if (user.suspended_indefinitely) return true
  return user.suspended_until !== null && user.suspended_until > ctx.now()
}

/** Community exists for this viewer (soft-deleted communities are admin-only). */
export function requireVisibleCommunity(ctx: Ctx, viewer: Viewer, name: string): CommunityRow {
  const community = getCommunityByName(ctx, name)
  if (!community) throw notFound('Topluluk bulunamadı.')
  if (community.deleted_at !== null && !viewer?.is_admin) throw notFound('Topluluk bulunamadı.')
  return community
}

/** Can the viewer read content in this community? Zero leakage for private. */
export function canReadCommunity(ctx: Ctx, viewer: Viewer, community: CommunityRow): boolean {
  if (community.deleted_at !== null && !viewer?.is_admin) return false
  if (community.visibility === 'private') {
    return Boolean(viewer?.is_admin) || isApprovedMember(ctx, viewer, community.id)
  }
  return true // public and restricted are world-readable
}

export function requireReadAccess(ctx: Ctx, viewer: Viewer, community: CommunityRow): void {
  if (!canReadCommunity(ctx, viewer, community)) {
    // Access-required, never leaking content — 403 with no detail beyond the name being valid.
    throw forbidden('Bu topluluk gizli. Görüntülemek için onaylı üye olmalısınız.')
  }
}

/** Common gate for creating posts/comments/votes in a community. */
export function requireParticipant(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  opts: { requireMembership: boolean },
): UserRow {
  if (!viewer) throw unauthorized()
  if (viewer.deleted) throw unauthorized()
  if (isSuspended(ctx, viewer)) throw forbidden('Hesabınız askıya alınmış.')
  if (community.deleted_at !== null) throw notFound('Topluluk bulunamadı.')
  if (community.archived) throw badRequest('archived', 'Bu topluluk arşivlenmiş ve salt okunur durumdadır.')
  const ban = activeBan(ctx, viewer.id, community.id)
  if (ban) throw forbidden('Bu topluluktan yasaklandınız.')
  if (opts.requireMembership && !viewer.is_admin && !isApprovedMember(ctx, viewer, community.id)) {
    throw forbidden('Bunu yapmak için bu topluluğun üyesi olmalısınız.')
  }
  return viewer
}

export function requireModerator(ctx: Ctx, viewer: Viewer, community: CommunityRow): UserRow {
  if (!viewer) throw unauthorized()
  if (isSuspended(ctx, viewer)) throw forbidden('Hesabınız askıya alınmış.')
  if (!isModerator(ctx, viewer, community.id)) throw forbidden('Moderatör yetkisi gerekiyor.')
  return viewer
}

export function requireAdmin(viewer: Viewer): UserRow {
  if (!viewer) throw unauthorized()
  if (!viewer.is_admin) throw forbidden('Site yöneticisi yetkisi gerekiyor.')
  return viewer
}

/** Ids of private communities this viewer may read (for feed/search/profile filters). */
export function readablePrivateCommunityIds(ctx: Ctx, viewer: Viewer): string[] {
  if (!viewer) return []
  if (viewer.is_admin) {
    return (
      ctx.db.prepare("SELECT id FROM communities WHERE visibility = 'private'").all() as Array<{ id: string }>
    ).map((r) => r.id)
  }
  return (
    ctx.db
      .prepare(
        `SELECT c.id FROM communities c
         JOIN memberships m ON m.community_id = c.id
         WHERE c.visibility = 'private' AND m.user_id = ? AND m.status = 'approved'`,
      )
      .all(viewer.id) as Array<{ id: string }>
  ).map((r) => r.id)
}

/**
 * SQL fragment filtering rows to communities the viewer can read.
 * `alias` is the communities table alias in the outer query.
 */
export function readableCommunitiesClause(ctx: Ctx, viewer: Viewer, alias: string): { clause: string; params: string[] } {
  const privateIds = readablePrivateCommunityIds(ctx, viewer)
  const placeholders = privateIds.map(() => '?').join(', ')
  const privatePart = privateIds.length > 0 ? ` OR ${alias}.id IN (${placeholders})` : ''
  const deletedPart = viewer?.is_admin ? '' : ` AND ${alias}.deleted_at IS NULL`
  return {
    clause: `((${alias}.visibility IN ('public','restricted')${privatePart})${deletedPart})`,
    params: privateIds,
  }
}
