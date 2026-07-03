import type { Ctx } from '../context'
import type { CommentRow, CommunityRow, PostRow, ReportRow, Viewer } from '../types'
import { newId } from '../lib/ids'
import { LIMITS } from '../lib/validation'
import { getSettings } from './settings'
import { badRequest, forbidden, notFound, rateLimited, unauthorized } from './errors'
import { canReadCommunity, getCommunityById, isSuspended, requireModerator } from './access'
import { syncPostFts, getPost } from './posts'
import { getComment } from './comments'

const HOUR_MS = 60 * 60 * 1000

export interface ReportInput {
  targetType: 'post' | 'comment'
  targetId: string
  reasonType: 'rule' | 'spam' | 'harassment' | 'other'
  ruleId?: string | null
  detail?: string
}

/** US-029: report content; duplicates absorbed silently; reporters anonymous. */
export function createReport(ctx: Ctx, viewer: Viewer, input: ReportInput): void {
  if (!viewer) throw unauthorized('Log in to report content.')
  if (isSuspended(ctx, viewer)) throw forbidden('Your account is suspended.')

  const settings = getSettings(ctx)
  const limit = ctx.rateLimiter.check(`report:${viewer.id}`, settings.reportsPerHour, HOUR_MS)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)

  const target =
    input.targetType === 'post' ? getPost(ctx, input.targetId) : getComment(ctx, input.targetId)
  if (!target || target.deleted) throw notFound('This content is no longer available.')

  const communityId =
    input.targetType === 'post'
      ? (target as PostRow).community_id
      : (getPost(ctx, (target as CommentRow).post_id) as PostRow).community_id
  const community = getCommunityById(ctx, communityId)
  if (!community || community.deleted_at !== null) throw notFound('This content is no longer available.')
  if (!canReadCommunity(ctx, viewer, community)) throw forbidden('This community is private.')

  const detail = (input.detail ?? '').trim().slice(0, LIMITS.reportDetailMax)
  if (input.reasonType === 'other' && !detail) {
    throw badRequest('detail_required', 'Describe the problem when choosing "other".')
  }
  let ruleId: string | null = null
  if (input.reasonType === 'rule') {
    const rule = ctx.db
      .prepare('SELECT id FROM community_rules WHERE id = ? AND community_id = ?')
      .get(input.ruleId ?? '', community.id)
    if (!rule) throw badRequest('rule', 'Select one of this community’s rules.')
    ruleId = input.ruleId as string
  }

  // Duplicate reports from the same user are absorbed silently (US-029).
  ctx.db
    .prepare(
      `INSERT INTO reports (id, target_type, target_id, community_id, reporter_id, reason_type, rule_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(reporter_id, target_type, target_id) DO NOTHING`,
    )
    .run(newId(), input.targetType, input.targetId, community.id, viewer.id, input.reasonType, ruleId, detail || null, ctx.now())

  applyAutoHide(ctx, community, input.targetType, input.targetId)
}

/** US-030: optional auto-hide once open reports reach the community threshold. */
function applyAutoHide(ctx: Ctx, community: CommunityRow, targetType: 'post' | 'comment', targetId: string): void {
  if (community.auto_hide_reports <= 0) return
  const openCount = (
    ctx.db
      .prepare("SELECT COUNT(*) AS n FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open'")
      .get(targetType, targetId) as { n: number }
  ).n
  if (openCount < community.auto_hide_reports) return
  if (targetType === 'post') {
    ctx.db.prepare('UPDATE posts SET auto_hidden = 1 WHERE id = ? AND removed = 0').run(targetId)
    const post = getPost(ctx, targetId)
    if (post) syncPostFts(ctx, post)
  } else {
    ctx.db.prepare('UPDATE comments SET auto_hidden = 1 WHERE id = ? AND removed = 0').run(targetId)
  }
}

export interface QueueEntry {
  target_type: 'post' | 'comment'
  target_id: string
  community_id: string
  community_name: string
  report_count: number
  oldest_report_at: number
  reasons: string
  auto_hidden: number
  title: string | null
  body_preview: string | null
  author_username: string | null
}

/** US-030: open reports grouped per target, oldest-unresolved first. */
export function reportQueue(ctx: Ctx, viewer: Viewer, community: CommunityRow | null): QueueEntry[] {
  if (community) requireModerator(ctx, viewer, community)
  else if (!viewer?.is_admin) throw forbidden('Site admin access required.')

  const rows = ctx.db
    .prepare(
      `SELECT r.target_type, r.target_id, r.community_id, c.name AS community_name,
              COUNT(*) AS report_count, MIN(r.created_at) AS oldest_report_at,
              GROUP_CONCAT(DISTINCT r.reason_type) AS reasons
       FROM reports r JOIN communities c ON c.id = r.community_id
       WHERE r.status = 'open' ${community ? 'AND r.community_id = ?' : ''}
       GROUP BY r.target_type, r.target_id
       ORDER BY oldest_report_at ASC`,
    )
    .all(...(community ? [community.id] : [])) as unknown as Array<
    Omit<QueueEntry, 'auto_hidden' | 'title' | 'body_preview' | 'author_username'>
  >

  return rows.map((row) => {
    if (row.target_type === 'post') {
      const post = getPost(ctx, row.target_id)
      const author = post
        ? (ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(post.author_id) as { username: string } | undefined)
        : undefined
      return {
        ...row,
        auto_hidden: post?.auto_hidden ?? 0,
        title: post?.title ?? null,
        body_preview: post?.body?.slice(0, 200) ?? null,
        author_username: author?.username ?? null,
      }
    }
    const comment = getComment(ctx, row.target_id)
    const author = comment
      ? (ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(comment.author_id) as { username: string } | undefined)
      : undefined
    return {
      ...row,
      auto_hidden: comment?.auto_hidden ?? 0,
      title: null,
      body_preview: comment?.body.slice(0, 200) ?? null,
      author_username: author?.username ?? null,
    }
  })
}

/** Dismiss all open reports on a target (mod action from the queue). */
export function dismissReports(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  targetType: 'post' | 'comment',
  targetId: string,
): void {
  const actor = requireModerator(ctx, viewer, community)
  ctx.db
    .prepare(
      `UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = ?
       WHERE target_type = ? AND target_id = ? AND community_id = ? AND status = 'open'`,
    )
    .run(actor.id, ctx.now(), targetType, targetId, community.id)
  // Auto-hidden content returns to visibility when reports are dismissed.
  if (targetType === 'post') {
    ctx.db.prepare('UPDATE posts SET auto_hidden = 0 WHERE id = ?').run(targetId)
    const post = getPost(ctx, targetId)
    if (post) syncPostFts(ctx, post)
  } else {
    ctx.db.prepare('UPDATE comments SET auto_hidden = 0 WHERE id = ?').run(targetId)
  }
}

export function resolveReportsForTarget(ctx: Ctx, resolverId: string, targetType: string, targetId: string): void {
  ctx.db
    .prepare(
      `UPDATE reports SET status = 'resolved', resolved_by = ?, resolved_at = ?
       WHERE target_type = ? AND target_id = ? AND status = 'open'`,
    )
    .run(resolverId, ctx.now(), targetType, targetId)
}

/** Reporter-facing state: confirmation + resolved indicator, never the action taken. */
export function myReports(ctx: Ctx, viewer: Viewer): Array<Pick<ReportRow, 'id' | 'target_type' | 'target_id' | 'status' | 'created_at'>> {
  if (!viewer) throw unauthorized()
  return ctx.db
    .prepare(
      'SELECT id, target_type, target_id, status, created_at FROM reports WHERE reporter_id = ? ORDER BY created_at DESC LIMIT 100',
    )
    .all(viewer.id) as unknown as Array<Pick<ReportRow, 'id' | 'target_type' | 'target_id' | 'status' | 'created_at'>>
}
