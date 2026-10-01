/**
 * NPC veri katmanı.
 *
 * TASARIM: NPC hesapları `users` tablosunda normal birer satırdır
 * (`is_ai = 1`). Bu, kasıtlı bir seçimdir:
 *
 *   - Gönderi/yorum/oy yazan TÜM mevcut servisler (createTextPost,
 *     createComment, castVote) NPC'ler için de ÇALIŞIR. Böylece rate
 *     limit, spam koruması, yetki kontrolleri ve feed indekslemesi
 *     istisnasız uygulanır — hiçbir koruma bypass EDİLMEZ.
 *   - Yeni içerik türü eklendiğinde NPC'ler otomatik kapsam dahil olur.
 *
 * Güvenlik: NPC hesapları parola ile GİRİŞ YAPAMAZ. `password_hash` boş
 * bırakılır ve `login()` bunu reddeder (bkz. services/auth.ts).
 */
import type { Ctx } from '../../context'
import type {
  AiActivityRow,
  AiAgentRow,
  AiAgentWithUser,
  CommunityRow,
  UserRow,
} from '../../types'
import { newId } from '../../lib/ids'
import { transaction } from '../../db'
import { logAction } from '../modlog'
import { NPC_PERSONAS, type NpcPersona } from './personas'

// ---------------------------------------------------------------------------
// Oluşturma
// ---------------------------------------------------------------------------

/**
 * 50 NPC hesabını oluşturur.
 *
 * Idempotent: kullanıcı adı varsa atlanır. Gerçek kullanıcı tablosuna
 * dokunulmaz.
 *
 * @returns Oluşturulan NPC sayısı.
 */
export function createNpcAgents(ctx: Ctx): number {
  let created = 0
  transaction(ctx.db, () => {
    for (const persona of NPC_PERSONAS) {
      if (npcByUsername(ctx, persona.username)) continue
      const userId = newId()
      const now = ctx.now()
      ctx.db
        .prepare(
          `INSERT INTO users (id, username, username_lower, password_hash, display_name, bio,
                              is_admin, is_ai, created_at)
           VALUES (?, ?, ?, '', ?, ?, 0, 1, ?)`,
        )
        .run(userId, persona.username, persona.username.toLowerCase(), persona.displayName, persona.bio, now)
      insertNpcRow(ctx, userId, persona, now)
      created += 1
    }
  })
  return created
}

function insertNpcRow(ctx: Ctx, userId: string, persona: NpcPersona, now: number): void {
  ctx.db
    .prepare(
      `INSERT INTO ai_agents (
         user_id, archetype, bio,
         verbosity, humor, assertiveness, politeness, activity, profanity, emoji_rate,
         comment_rate, post_rate, upvote_bias, downvote_bias,
         curiosity, seriousness, talkativeness, patience, empathy, skepticism,
         confidence, slang_rate, vote_rate,
         interests, likes, dislikes, board_prefs, peers, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .run(
      userId,
      persona.archetype,
      persona.bio,
      persona.verbosity,
      persona.humor,
      persona.assertiveness,
      persona.politeness,
      persona.activity,
      persona.profanity,
      persona.emoji_rate,
      persona.comment_rate,
      persona.post_rate,
      persona.upvote_bias,
      persona.downvote_bias,
      persona.curiosity,
      persona.seriousness,
      persona.talkativeness,
      persona.patience,
      persona.empathy,
      persona.skepticism,
      persona.confidence,
      persona.slang_rate,
      persona.vote_rate,
      JSON.stringify(persona.interests),
      JSON.stringify(persona.likes),
      JSON.stringify(persona.dislikes),
      JSON.stringify(persona.boardPrefs),
      JSON.stringify(persona.peers),
      now,
      now,
    )
}

/** Persona kataloğundan canlı profil üretir (üretim motoru bunu kullanır). */
export function personaFor(username: string): NpcPersona | undefined {
  return NPC_PERSONAS.find((p) => p.username === username)
}

// ---------------------------------------------------------------------------
// Sorgular
// ---------------------------------------------------------------------------

function npcByUsername(ctx: Ctx, username: string): AiAgentRow | null {
  return (
    (ctx.db
      .prepare(
        `SELECT a.* FROM ai_agents a JOIN users u ON u.id = a.user_id
          WHERE u.username_lower = ?`,
      )
      .get(username.toLowerCase()) as AiAgentRow | undefined) ?? null
  )
}

export function getNpcAgent(ctx: Ctx, userId: string): AiAgentRow | null {
  return (
    (ctx.db.prepare('SELECT * FROM ai_agents WHERE user_id = ?').get(userId) as AiAgentRow | undefined) ??
    null
  )
}

/** Yönetim listesi: NPC + kullanıcı satırı birlikte. */
export function listNpcAgents(ctx: Ctx, opts: { onlyEnabled?: boolean } = {}): AiAgentWithUser[] {
  const where = opts.onlyEnabled ? 'WHERE a.enabled = 1' : ''
  return ctx.db
    .prepare(
      `SELECT a.*, u.username, u.display_name, u.avatar_key, u.suspended_indefinitely, u.deleted
         FROM ai_agents a JOIN users u ON u.id = a.user_id
         ${where}
         ORDER BY a.activity DESC, u.username ASC`,
    )
    .all() as unknown as AiAgentWithUser[]
}

export function listEnabledNpcs(ctx: Ctx): AiAgentWithUser[] {
  return listNpcAgents(ctx, { onlyEnabled: true })
}

/** Bir hesabın NPC olup olmadığı (backend seviyesinde ayırt). */
export function isNpcUser(ctx: Ctx, userId: string): boolean {
  const row = ctx.db.prepare('SELECT is_ai FROM users WHERE id = ?').get(userId) as
    | { is_ai: number }
    | undefined
  return row?.is_ai === 1
}

// ---------------------------------------------------------------------------
// Profil güncelleme (admin)
// ---------------------------------------------------------------------------

/** Yönetim panelinden değiştirilebilen davranış alanları. */
export interface NpcUpdate {
  bio?: string
  verbosity?: number
  humor?: number
  assertiveness?: number
  politeness?: number
  activity?: number
  profanity?: number
  emoji_rate?: number
  upvote_bias?: number
  downvote_bias?: number
  comment_rate?: number
  post_rate?: number
  curiosity?: number
  seriousness?: number
  talkativeness?: number
  patience?: number
  empathy?: number
  skepticism?: number
  confidence?: number
  slang_rate?: number
  vote_rate?: number
  interests?: string[]
  likes?: string[]
  dislikes?: string[]
  boardPrefs?: Record<string, number>
  enabled?: boolean
}

/** Tüm sayısal davranış sütunları (yönetim formu tek listeden üretir). */
export const NPC_SLIDER_FIELDS = [
  'verbosity',
  'humor',
  'assertiveness',
  'politeness',
  'activity',
  'profanity',
  'emoji_rate',
  'upvote_bias',
  'downvote_bias',
  'comment_rate',
  'post_rate',
  'curiosity',
  'seriousness',
  'talkativeness',
  'patience',
  'empathy',
  'skepticism',
  'confidence',
  'slang_rate',
  'vote_rate',
] as const

export type NpcSliderField = (typeof NPC_SLIDER_FIELDS)[number]

/** Ölçek değerini 0–1 aralığına kıstlar. */
function clamp01(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/** Profili günceller ve değişikliği denetim günlüğüne yazar. */
export function updateNpcAgent(
  ctx: Ctx,
  adminId: string,
  userId: string,
  update: NpcUpdate,
): AiAgentRow {
  const current = getNpcAgent(ctx, userId)
  if (!current) throw new Error('NPC bulunamadı')

  const sets: string[] = []
  const values: unknown[] = []
  const push = (col: string, value: unknown): void => {
    sets.push(`${col} = ?`)
    values.push(value)
  }

  for (const field of NPC_SLIDER_FIELDS) {
    const raw = update[field]
    if (raw === undefined) continue
    push(field, clamp01(raw, current[field]))
  }
  if (update.bio !== undefined) push('bio', String(update.bio).slice(0, 500))
  if (update.interests !== undefined) push('interests', JSON.stringify(update.interests.slice(0, 20)))
  if (update.likes !== undefined) push('likes', JSON.stringify(update.likes.slice(0, 20)))
  if (update.dislikes !== undefined) push('dislikes', JSON.stringify(update.dislikes.slice(0, 20)))
  if (update.boardPrefs !== undefined) {
    const safe: Record<string, number> = {}
    for (const [board, weight] of Object.entries(update.boardPrefs).slice(0, 30)) {
      safe[board] = clamp01(weight, 0.5)
    }
    push('board_prefs', JSON.stringify(safe))
  }
  if (update.enabled !== undefined) push('enabled', update.enabled ? 1 : 0)

  if (sets.length === 0) return current
  sets.push('updated_at = ?')
  values.push(ctx.now())
  values.push(userId)

  ctx.db.prepare(`UPDATE ai_agents SET ${sets.join(', ')} WHERE user_id = ?`).run(...(values as never[]))

  logAction(ctx, {
    communityId: null,
    actorId: adminId,
    action: 'ai_agent_update',
    targetType: 'npc',
    targetId: userId,
    detail: sets.map((s) => s.split(' = ')[0]).join(','),
  })
  return getNpcAgent(ctx, userId) as AiAgentRow
}

export function setNpcEnabled(ctx: Ctx, adminId: string, userId: string, enabled: boolean): void {
  updateNpcAgent(ctx, adminId, userId, { enabled })
}

/**
 * NPC'yi sıfırlar: sayaçlar, itibar, ilişkiler, hafıza ve öğrenme
 * temizlenir. Profil ayarları KORUNUR. Yazdığı gönderi/yorumlar SİLİNMEZ
 * (bunlar gerçer içeriktir).
 */
export function resetNpcAgent(ctx: Ctx, adminId: string, userId: string): void {
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE ai_agents
            SET posts_created = 0, comments_created = 0, votes_cast = 0, reputation = 0,
                last_active_at = NULL, updated_at = ?
          WHERE user_id = ?`,
      )
      .run(ctx.now(), userId)
    ctx.db.prepare('DELETE FROM ai_relationships WHERE agent_id = ?').run(userId)
    ctx.db.prepare('DELETE FROM npc_relationships WHERE agent_id = ? OR peer_id = ?').run(userId, userId)
    ctx.db.prepare('DELETE FROM ai_board_presence WHERE agent_id = ?').run(userId)
  })
  logAction(ctx, {
    communityId: null,
    actorId: adminId,
    action: 'ai_agent_reset',
    targetType: 'npc',
    targetId: userId,
  })
}

/** NPC'nin oluşturduğu içerikler (yönetim paneli). */
export function npcContent(
  ctx: Ctx,
  userId: string,
  limit = 50,
): {
  posts: Array<{ id: string; title: string; community: string; created_at: number }>
  comments: Array<{ id: string; body: string; post_title: string; created_at: number }>
} {
  const posts = ctx.db
    .prepare(
      `SELECT p.id, p.title, c.name AS community, p.created_at
         FROM posts p JOIN communities c ON c.id = p.community_id
        WHERE p.author_id = ? AND p.deleted = 0
        ORDER BY p.created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as unknown as Array<{ id: string; title: string; community: string; created_at: number }>
  const comments = ctx.db
    .prepare(
      `SELECT cm.id, cm.body, p.title AS post_title, cm.created_at
         FROM comments cm JOIN posts p ON p.id = cm.post_id
        WHERE cm.author_id = ? AND cm.deleted = 0
        ORDER BY cm.created_at DESC LIMIT ?`,
    )
    .all(userId, limit) as unknown as Array<{ id: string; body: string; post_title: string; created_at: number }>
  return { posts, comments }
}

// ---------------------------------------------------------------------------
// İtibar ve board hakimiyeti
// ---------------------------------------------------------------------------

export function adjustReputation(ctx: Ctx, userId: string, delta: number): void {
  ctx.db
    .prepare(
      `UPDATE ai_agents
          SET reputation = MAX(-100, MIN(100, reputation + ?)), updated_at = ?
        WHERE user_id = ?`,
    )
    .run(delta, ctx.now(), userId)
}

export function bumpPresence(
  ctx: Ctx,
  userId: string,
  communityId: string,
  kind: 'post' | 'comment' | 'vote',
): void {
  const column = kind === 'post' ? 'posts' : kind === 'comment' ? 'comments' : 'votes'
  ctx.db
    .prepare(
      `INSERT INTO ai_board_presence (agent_id, community_id, ${column}, updated_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(agent_id, community_id)
       DO UPDATE SET ${column} = ${column} + 1, updated_at = excluded.updated_at`,
    )
    .run(userId, communityId, ctx.now())
}

/** NPC'nin boardlara göre hakimiyeti. */
export function boardPresence(
  ctx: Ctx,
  userId: string,
): Array<{ community_id: string; community: string; posts: number; comments: number; votes: number }> {
  return ctx.db
    .prepare(
      `SELECT p.community_id, c.name AS community, p.posts, p.comments, p.votes
         FROM ai_board_presence p JOIN communities c ON c.id = p.community_id
        WHERE p.agent_id = ?
        ORDER BY (p.posts * 3 + p.comments) DESC`,
    )
    .all(userId) as unknown as Array<{
    community_id: string
    community: string
    posts: number
    comments: number
    votes: number
  }>
}

// ---------------------------------------------------------------------------
// Sayaçlar ve denetim izi
// ---------------------------------------------------------------------------

export function bumpNpcCounters(
  ctx: Ctx,
  userId: string,
  kind: 'post' | 'comment' | 'vote',
): void {
  const column = kind === 'post' ? 'posts_created' : kind === 'comment' ? 'comments_created' : 'votes_cast'
  ctx.db
    .prepare(
      `UPDATE ai_agents SET ${column} = ${column} + 1, last_active_at = ?, updated_at = ? WHERE user_id = ?`,
    )
    .run(ctx.now(), ctx.now(), userId)
}

/** NPC işlemlerinin append-only denetim izi. */
export function logNpcAction(
  ctx: Ctx,
  entry: {
    agentId: string
    action:
      | 'post'
      | 'comment'
      | 'vote'
      | 'join'
      | 'post_skipped'
      | 'comment_skipped'
      | 'read'
      | 'memory'
    targetType?: string | null
    targetId?: string | null
    communityId?: string | null
    detail?: string | null
  },
): void {
  ctx.db
    .prepare(
      `INSERT INTO ai_activity_log (id, agent_id, action, target_type, target_id, community_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      entry.agentId,
      entry.action,
      entry.targetType ?? null,
      entry.targetId ?? null,
      entry.communityId ?? null,
      entry.detail ?? null,
      ctx.now(),
    )
}

export function npcActivityLog(ctx: Ctx, opts: { agentId?: string; limit?: number } = {}): AiActivityRow[] {
  const limit = opts.limit ?? 200
  if (opts.agentId) {
    return ctx.db
      .prepare('SELECT * FROM ai_activity_log WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(opts.agentId, limit) as unknown as AiActivityRow[]
  }
  return ctx.db
    .prepare('SELECT * FROM ai_activity_log ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as AiActivityRow[]
}

export function npcActivityLogWithNames(
  ctx: Ctx,
  limit = 100,
): Array<AiActivityRow & { username: string }> {
  return ctx.db
    .prepare(
      `SELECT l.*, u.username FROM ai_activity_log l JOIN users u ON u.id = l.agent_id
        ORDER BY l.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<AiActivityRow & { username: string }>
}

// ---------------------------------------------------------------------------
// Board erişimi
// ---------------------------------------------------------------------------

/** NPC'lerin paylaşabileceği board görünürlükleri. */
export type NpcBoardAccess = 'public' | 'restricted' | 'private' | 'all'

/** Görünürlük → izin verilen görünürlükler. */
export function npcEligibleVisibilities(ctx: Ctx): string[] {
  const access = (getSettingsValue(ctx) ?? 'public') as NpcBoardAccess
  if (access === 'all') return ['public', 'restricted', 'private']
  return [access]
}

function getSettingsValue(ctx: Ctx): string | undefined {
  const row = ctx.db
    .prepare("SELECT value FROM site_settings WHERE key = 'aiVisibility'")
    .get() as { value: string } | undefined
  return row?.value
}

/** NPC'lerin kullanabileceği boardlar. */
export function eligibleCommunities(ctx: Ctx): CommunityRow[] {
  const vis = npcEligibleVisibilities(ctx)
  const placeholders = vis.map(() => '?').join(', ')
  return ctx.db
    .prepare(
      `SELECT * FROM communities
        WHERE archived = 0 AND deleted_at IS NULL AND visibility IN (${placeholders})
        ORDER BY name`,
    )
    .all(...vis) as unknown as CommunityRow[]
}

/**
 * NPC'nin paylaşabileceği boardlar (yasaklı olanlar çıkarılır).
 *
 * Moderatör bir NPC hesabını bir boarddan yasaklarsa motor oraya bir daha
 * giremez — yasak kalkmadan da.
 */
export function npcCommunities(ctx: Ctx, agentId: string): CommunityRow[] {
  const banned = new Set(
    (
      ctx.db
        .prepare(
          `SELECT community_id FROM bans
            WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)`,
        )
        .all(agentId, ctx.now()) as unknown as Array<{ community_id: string }>
    ).map((r) => r.community_id),
  )
  return eligibleCommunities(ctx).filter((c) => !banned.has(c.id))
}

/** Yönetim arayüzü için board kapsamı özeti. */
export function npcBoardCoverage(ctx: Ctx): {
  access: NpcBoardAccess
  total: number
  eligible: number
  byVisibility: Record<string, number>
} {
  const rows = ctx.db
    .prepare(
      'SELECT visibility, COUNT(*) AS n FROM communities WHERE archived = 0 AND deleted_at IS NULL GROUP BY visibility',
    )
    .all() as unknown as Array<{ visibility: string; n: number }>
  const byVisibility: Record<string, number> = { public: 0, restricted: 0, private: 0 }
  let total = 0
  for (const row of rows) {
    byVisibility[row.visibility] = row.n
    total += row.n
  }
  return {
    access: (getSettingsValue(ctx) ?? 'public') as NpcBoardAccess,
    total,
    eligible: eligibleCommunities(ctx).length,
    byVisibility,
  }
}

// ---------------------------------------------------------------------------
// JSON yardımcıları
// ---------------------------------------------------------------------------

export function parseList(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function parseRecord<T>(json: string): Record<string, T> {
  try {
    const parsed = JSON.parse(json)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, T>)
      : {}
  } catch {
    return {}
  }
}

export function npcUserRow(ctx: Ctx, userId: string): UserRow | null {
  return (
    (ctx.db.prepare('SELECT * FROM users WHERE id = ? AND is_ai = 1').get(userId) as UserRow | undefined) ??
    null
  )
}

export function anyUserRow(ctx: Ctx, userId: string): UserRow | null {
  return (ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined) ?? null
}
