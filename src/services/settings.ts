import type { Ctx } from '../context'

/** Runtime-editable site policies (FR-14, US-038, US-042). */
export interface SiteSettings {
  registrationMode: 'open' | 'invite' | 'closed'
  communityCreation: 'member' | 'admin'
  hotDecaySeconds: number
  postsPer10Min: number
  commentsPer10Min: number
  votesPerMinute: number
  reportsPerHour: number
}

export const DEFAULT_SETTINGS: SiteSettings = {
  registrationMode: 'open',
  communityCreation: 'member',
  hotDecaySeconds: 90000,
  postsPer10Min: 5,
  commentsPer10Min: 20,
  votesPerMinute: 60,
  reportsPerHour: 10,
}

export function getSettings(ctx: Ctx): SiteSettings {
  const rows = ctx.db.prepare('SELECT key, value FROM site_settings').all() as Array<{
    key: string
    value: string
  }>
  const stored = Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value)]))
  return { ...DEFAULT_SETTINGS, ...stored }
}

export function updateSettings(ctx: Ctx, patch: Partial<SiteSettings>): SiteSettings {
  const upsert = ctx.db.prepare(
    'INSERT INTO site_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  )
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULT_SETTINGS) || value === undefined) continue
    upsert.run(key, JSON.stringify(value))
  }
  return getSettings(ctx)
}
