/**
 * AI karakterlerinin veri katmanı.
 *
 * TASARIM: AI hesapları `users` tablosunda normal birer satırdır
 * (`is_ai = 1`). Bu, kasıtlı bir seçimdir:
 *
 *   - Gönderi/yorum/oy yazan tüm mevcut servisler (createTextPost,
 *     createComment, castVote) AI hesapları için de ÇALIŞIR. Böylece
 *     rate limit, spam koruması, yetki kontrolleri ve arama/feed
 *     indekslemesi AI için de istisnasız uygulanır — hiçbir koruma
 *     bypass EDİLMEZ.
 *   - Yeni içerik türü eklenirse AI karakterleri de otomatik kapsam
 *     dahil olur; davranış ayrı bir kod yoluna sapmaz.
 *
 * Bu dosya yalnızca karaktere ÖZEL ek nitelikleri yönetir: profil,
 * davranış ölçekleri, ilişkiler, itibar ve denetim izi.
 *
 * Güvenlik: AI hesapları parola ile GİRİŞ YAPAMAZ (bkz. services/auth.ts).
 * Şifre hash'i üretilmez; `password_hash` boş bırakılır ve login bu
 * durumu reddeder.
 */
import type { Ctx } from '../../context'
import type { AiActivityRow, AiAgentRow, AiAgentWithUser, AiRelationshipRow, UserRow } from '../../types'
import { newId } from '../../lib/ids'
import { transaction } from '../../db'
import { logAction } from '../modlog'
import { PERSONAS, type Persona } from './personas'

// ---------------------------------------------------------------------------
// Karakter oluşturma
// ---------------------------------------------------------------------------

/**
 * 50 AI karakter hesabını oluşturur.
 *
 * idempotent: kullanıcı adı zaten varsa o karakter atlanır; böylece
 * betik tekrar tekrar çalıştırılabilir. Mevcut gerçek kullanıcı
 * tablolarına dokunulmaz.
 *
 * @returns Oluşturulan karakter sayısı.
 */
export function createAiAgents(ctx: Ctx): number {
  let created = 0
  transaction(ctx.db, () => {
    for (const persona of PERSONAS) {
      if (aiAgentByUsername(ctx, persona.username)) continue
      const userId = newId()
      const now = ctx.now()
      // AI hesabı oturum açamaz: parola hash'i BOŞ bırakılır. login()
      // boş hash'i reddeder, ayrıca is_ai kontrolü ikinci savunmadır.
      ctx.db
        .prepare(
          `INSERT INTO users (id, username, username_lower, password_hash, display_name, bio,
                              is_admin, is_ai, created_at)
           VALUES (?, ?, ?, '', ?, ?, 0, 1, ?)`,
        )
        .run(userId, persona.username, persona.username.toLowerCase(), persona.displayName, persona.bio, now)
      insertAgentRow(ctx, userId, persona, now)
      created += 1
    }
  })
  return created
}

function insertAgentRow(ctx: Ctx, userId: string, persona: Persona, now: number): void {
  ctx.db
    .prepare(
      `INSERT INTO ai_agents (
         user_id, archetype, bio, verbosity, humor, assertiveness, politeness, activity,
         profanity, emoji_rate, upvote_bias, downvote_bias, comment_rate, post_rate,
         interests, likes, dislikes, board_prefs, peers, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
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
      persona.upvote_bias,
      persona.downvote_bias,
      persona.comment_rate,
      persona.post_rate,
      JSON.stringify(persona.interests),
      JSON.stringify(persona.likes),
      JSON.stringify(persona.dislikes),
      JSON.stringify(persona.boardPrefs),
      JSON.stringify(persona.peers),
      now,
      now,
    )
}

// ---------------------------------------------------------------------------
// Sorgular
// ---------------------------------------------------------------------------

function aiAgentByUsername(ctx: Ctx, username: string): AiAgentRow | null {
  return (
    (ctx.db
      .prepare(
        `SELECT a.* FROM ai_agents a JOIN users u ON u.id = a.user_id
         WHERE u.username_lower = ?`,
      )
      .get(username.toLowerCase()) as AiAgentRow | undefined) ?? null
  )
}

export function getAiAgent(ctx: Ctx, userId: string): AiAgentRow | null {
  return (
    (ctx.db.prepare('SELECT * FROM ai_agents WHERE user_id = ?').get(userId) as AiAgentRow | undefined) ?? null
  )
}

/** Yönetim listesi: karakter + kullanıcı satırı birlikte. */
export function listAiAgents(ctx: Ctx, opts: { onlyEnabled?: boolean } = {}): AiAgentWithUser[] {
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

export function listEnabledAgents(ctx: Ctx): AiAgentWithUser[] {
  return listAiAgents(ctx, { onlyEnabled: true })
}

/** Bir kullanıcının AI olup olmadığı (backend seviyesinde ayırt). */
export function isAiUser(ctx: Ctx, userId: string): boolean {
  const row = ctx.db.prepare('SELECT is_ai FROM users WHERE id = ?').get(userId) as
    | { is_ai: number }
    | undefined
  return row?.is_ai === 1
}

// ---------------------------------------------------------------------------
// Profil güncelleme (admin)
// ---------------------------------------------------------------------------

/** Yönetim panelinden değiştirilebilen davranış alanları. */
export interface AiAgentUpdate {
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
  interests?: string[]
  likes?: string[]
  dislikes?: string[]
  boardPrefs?: Record<string, number>
  enabled?: boolean
}

const NUMERIC_FIELDS = [
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
] as const

/** Ölçek değerini 0–1 aralığına kıstlar (yönetim formundan gelen girdi). */
function clamp01(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(1, Math.max(0, n))
}

/**
 * Karakter profilini günceller ve değişikliği denetim günlüğüne yazar.
 * Tüm ölçekler 0–1 aralığına kıstlanır; JSON sütunları güvenli parse edilir.
 */
export function updateAiAgent(
  ctx: Ctx,
  adminId: string,
  userId: string,
  update: AiAgentUpdate,
): AiAgentRow {
  const current = getAiAgent(ctx, userId)
  if (!current) throw new Error('AI karakter bulunamadı')

  const sets: string[] = []
  const values: unknown[] = []
  const push = (col: string, value: unknown): void => {
    sets.push(`${col} = ?`)
    values.push(value)
  }

  for (const field of NUMERIC_FIELDS) {
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
    targetType: 'ai_agent',
    targetId: userId,
    detail: sets.map((s) => s.split(' = ')[0]).join(','),
  })
  return getAiAgent(ctx, userId) as AiAgentRow
}

/** Karakteri aktif/pasif yapar. */
export function setAiAgentEnabled(ctx: Ctx, adminId: string, userId: string, enabled: boolean): void {
  updateAiAgent(ctx, adminId, userId, { enabled })
}

/**
 * Karakterin davranışını sıfırlar: sayaçlar, itibar, ilişkiler ve
 * board hakimiyeti temizlenir; profil ayarları KORUNUR (karakter aynı
 * kişilik olarak devam eder). Kullanıcının yazdığı gönderi/yorumlar
 * silinmez — bunlar gerçek içeriktir ve moderasyonun konusudur.
 */
export function resetAiAgent(ctx: Ctx, adminId: string, userId: string): void {
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE ai_agents
            SET posts_created = 0, comments_created = 0, votes_cast = 0, reputation = 0,
                last_active_at = NULL, updated_at = ?
          WHERE user_id = ?`,
      )
      .run(ctx.now(), userId)
    // İlişkiler ve board hakimiyeti bu karaktere aittir; temizlenir.
    ctx.db.prepare('DELETE FROM ai_relationships WHERE agent_id = ?').run(userId)
    ctx.db.prepare('DELETE FROM ai_relationships WHERE peer_id = ?').run(userId)
    ctx.db.prepare('DELETE FROM ai_board_presence WHERE agent_id = ?').run(userId)
  })
  logAction(ctx, {
    communityId: null,
    actorId: adminId,
    action: 'ai_agent_reset',
    targetType: 'ai_agent',
    targetId: userId,
  })
}

/** Karakterin oluşturduğu içerikler (yönetim paneli). */
export function aiAgentContent(
  ctx: Ctx,
  userId: string,
  limit = 50,
): { posts: Array<{ id: string; title: string; community: string; created_at: number }>; comments: Array<{ id: string; body: string; post_title: string; created_at: number }> } {
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
// İlişkiler (arkadaşlık / düşmanlık)
// ---------------------------------------------------------------------------

/**
 * İki karakter arasındaki ilişkiyi günceller.
 *
 * `affinity` -1 (düşman) ile +1 (dost) arasındadır. Etkileşim sonrası
 * kademeli olarak yaklaşır; her adım küçüktür, böylece ilişkiler ani
 * sıçramalar yerine yavaş yavaş değişir.
 */
export function adjustRelationship(
  ctx: Ctx,
  agentId: string,
  peerId: string,
  delta: number,
  now: number,
): void {
  if (agentId === peerId) return
  const existing = ctx.db
    .prepare('SELECT affinity, interactions FROM ai_relationships WHERE agent_id = ? AND peer_id = ?')
    .get(agentId, peerId) as { affinity: number; interactions: number } | undefined
  const previous = existing?.affinity ?? 0
  const next = Math.min(1, Math.max(-1, previous + delta))
  if (existing) {
    ctx.db
      .prepare(
        `UPDATE ai_relationships
            SET affinity = ?, interactions = interactions + 1, last_interaction_at = ?
          WHERE agent_id = ? AND peer_id = ?`,
      )
      .run(next, now, agentId, peerId)
  } else {
    ctx.db
      .prepare(
        `INSERT INTO ai_relationships (agent_id, peer_id, affinity, interactions, last_interaction_at)
         VALUES (?, ?, ?, 1, ?)`,
      )
      .run(agentId, peerId, next, now)
  }
}

/** Karakterin bir başka karaktere karşı ilişki kuvveti (-1..1). */
export function relationshipAffinity(ctx: Ctx, agentId: string, peerId: string): number {
  const row = ctx.db
    .prepare('SELECT affinity FROM ai_relationships WHERE agent_id = ? AND peer_id = ?')
    .get(agentId, peerId) as { affinity: number } | undefined
  return row?.affinity ?? 0
}

/** Şablon tanımından gelen başlangıç uyumu (henüz etkileşim yoksa). */
export function declaredPeerAffinity(agent: AiAgentRow, peerUsername: string): number {
  const peers = parseRecord<number>(agent.peers)
  return peers[peerUsername] ?? 0
}

// ---------------------------------------------------------------------------
// İtibar ve board hakimiyeti
// ---------------------------------------------------------------------------

/**
 * İtibarı günceller. Yorum/beğeni kazanmak artırır, olumsuz oy ve
 * kaldırılan içerik azaltır. Değer -100..+100 aralığında tutulur ve
 * sosyal statü rozetlerini besler.
 */
export function adjustReputation(ctx: Ctx, userId: string, delta: number): void {
  ctx.db
    .prepare(
      `UPDATE ai_agents
          SET reputation = MAX(-100, MIN(100, reputation + ?)), updated_at = ?
        WHERE user_id = ?`,
    )
    .run(delta, ctx.now(), userId)
}

/** Board hakimiyeti sayacını artırır. */
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

/** Bir karakterin boardlara göre hakimiyeti (yönetim ve davranış için). */
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

export function bumpAgentCounters(
  ctx: Ctx,
  userId: string,
  kind: 'post' | 'comment' | 'vote',
): void {
  const column = kind === 'post' ? 'posts_created' : kind === 'comment' ? 'comments_created' : 'votes_cast'
  ctx.db
    .prepare(`UPDATE ai_agents SET ${column} = ${column} + 1, last_active_at = ?, updated_at = ? WHERE user_id = ?`)
    .run(ctx.now(), ctx.now(), userId)
}

/**
 * AI karakterinin yaptığı HER işlemi append-only olarak kaydeder.
 * Yönetim panelindeki denetim görünümü ve "oluşturduğu içerikler" listesi
 * buradan beslenir.
 */
export function logAiAction(
  ctx: Ctx,
  entry: {
    agentId: string
    action: 'post' | 'comment' | 'vote' | 'join' | 'post_skipped' | 'comment_skipped'
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

export function aiActivityLog(ctx: Ctx, opts: { agentId?: string; limit?: number } = {}): AiActivityRow[] {
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

/** Denetim izinde görüntülenecek kişi adı. */
export function aiActivityLogWithNames(
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

/** Topluluk adı → id eşlemesi (board tercihi çözümleme için). */
export function communityIdByName(ctx: Ctx, name: string): string | null {
  const row = ctx.db.prepare('SELECT id FROM communities WHERE name = ?').get(name) as
    | { id: string }
    | undefined
  return row?.id ?? null
}

/** Karakterin kullanıcı satırını döndürür (davranış motoru için). */
export function aiUserRow(ctx: Ctx, userId: string): UserRow | null {
  return (
    (ctx.db.prepare('SELECT * FROM users WHERE id = ? AND is_ai = 1').get(userId) as UserRow | undefined) ??
    null
  )
}
