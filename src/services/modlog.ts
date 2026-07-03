import type { Ctx } from '../context'
import type { ModActionRow } from '../types'
import { newId } from '../lib/ids'

/** Append-only moderation/admin log (US-035). No update or delete paths exist. */
export function logAction(
  ctx: Ctx,
  entry: {
    communityId: string | null // null = site-level admin action
    actorId: string
    action: string
    targetType?: string
    targetId?: string
    reason?: string | null
    detail?: string | null
  },
): void {
  ctx.db
    .prepare(
      `INSERT INTO mod_actions (id, community_id, actor_id, action, target_type, target_id, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      entry.communityId,
      entry.actorId,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.reason ?? null,
      entry.detail ?? null,
      ctx.now(),
    )
}

export function communityModLog(ctx: Ctx, communityId: string, limit = 200): ModActionRow[] {
  return ctx.db
    .prepare('SELECT * FROM mod_actions WHERE community_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(communityId, limit) as unknown as ModActionRow[]
}

export function siteAdminLog(ctx: Ctx, limit = 200): ModActionRow[] {
  return ctx.db
    .prepare('SELECT * FROM mod_actions WHERE community_id IS NULL ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as unknown as ModActionRow[]
}
