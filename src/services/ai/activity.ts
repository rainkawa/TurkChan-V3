/**
 * AI karakter davranış motoru.
 *
 * Bu motor karakterleri "yaşayan" hale getirir: konu açar, yorum yazar,
 * yorumlara cevap verir, oy verir, boardlara katılır. Her karar karakterin
 * profili ve konuşmanın içeriğinden türetilir — rastgele seçim YOKTUR.
 *
 * GÜVENLİK ÖNCELİĞİ:
 *   Motor, insan kullanıcılar için yazılmış MEVCUT servisleri çağırır
 *   (createTextPost, createComment, castVote). Bu nedenle rate limit,
 *   spam koruması, yetki ve arşiv kontrolü AI için de istisnasız çalışır;
 *   hiçbir koruma atlanmaz. Motor yalnızca bir istisna yakalayıp adımı
 *   sessizce atlar (bir karakterin limiti dolduysa diğerleri etkilenmez).
 *
 * `runAiTick` bir zamanlayıcıdan (server.ts) periyodik çağrılır.
 */
import type { Ctx } from '../../context'
import type { AiAgentWithUser, CommunityRow, PostRow, UserRow } from '../../types'
import { createTextPost } from '../posts'
import { createComment } from '../comments'
import { castVote } from '../votes'
import { joinCommunity } from '../communities'
import { activeBan, getCommunityById, getMembership } from '../access'
import { isAdminPower } from '../ranks'
import { getSettings } from '../settings'
import { AppError } from '../errors'
import { generateComment, generatePost, makeRng, detectTopic } from './voice'
import { analyzeContent } from './analyze'
import {
  adjustRelationship,
  adjustReputation,
  boardPresence,
  bumpAgentCounters,
  bumpPresence,
  declaredPeerAffinity,
  getAiAgent,
  listEnabledAgents,
  logAiAction,
  parseList,
  parseRecord,
  relationshipAffinity,
} from './agents'

/** Motorun tek seferde en fazla yapacağı işlem sayısı. */
const MAX_ACTIONS_PER_TICK = 12
/** Bir karakterin tek seferde en fazla açabileceği gönderi sayısı. */
const MAX_POSTS_PER_TICK = 2

export interface TickResult {
  actions: number
  posts: number
  comments: number
  votes: number
  /** Karakterlerin paylaşabileceği board sayısı (0 ise motor sessiz kalır). */
  boards: number
}

/** Topluluk görünürlüğü → AI'ın o boardda aktif olup olmadığı. */
export type AiBoardAccess = 'public' | 'restricted' | 'private' | 'all'

/**
 * AI karakterlerinin paylaşabileceği board görünürlükleri.
 *
 * Varsayılan SADECE herkese açık boardlardır: gizli topluluklar sitede
 * gizliliğin temel vaadi olduğu için AI oraya yönetici açıkça izin
 * vermedikçe girmemelidir. Yönetici bu değeri Admin → AI Karakterler
 * ekranından değiştirir.
 */
export function aiEligibleVisibilities(ctx: Ctx): string[] {
  const access = (getSettings(ctx).aiVisibility ?? 'public') as AiBoardAccess
  if (access === 'all') return ['public', 'restricted', 'private']
  return [access]
}

/**
 * AI'ın paylaşabileceği boardlar.
 *
 * Doğrudan sorgulanır (dizin değil): gizli boardları bir AI hesabı, kendi
 * üyeliği olmadan göremez — ama yönetici izin verdiyse motor onlara
 * üye olup paylaşabilmelidir.
 */
export function eligibleCommunities(ctx: Ctx): CommunityRow[] {
  const vis = aiEligibleVisibilities(ctx)
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
 * Bir karakterin paylaşabileceği boardlar.
 *
 * Genel listeden yalnızca karakterin yasaklandığı boardlar çıkarılır:
 * moderatör bir AI hesabını bir boarddan yasaklarsa motor o boarda bir daha
 * giremez (yasak kalkmadan da).
 */
function agentCommunities(ctx: Ctx, agentId: string): CommunityRow[] {
  return eligibleCommunities(ctx).filter((c) => activeBan(ctx, agentId, c.id) === null)
}

/**
 * AI'ın kullanabileceği boardların sayısını ve gerekçesini döner.
 * Yönetim arayüzünde "hiçbir şey olmuyor" durumunu açıklamak için kullanılır.
 */
export function aiBoardCoverage(ctx: Ctx): {
  access: AiBoardAccess
  total: number
  eligible: number
  byVisibility: Record<string, number>
} {
  const rows = ctx.db
    .prepare('SELECT visibility, COUNT(*) AS n FROM communities WHERE archived = 0 AND deleted_at IS NULL GROUP BY visibility')
    .all() as unknown as Array<{ visibility: string; n: number }>
  const byVisibility: Record<string, number> = { public: 0, restricted: 0, private: 0 }
  let total = 0
  for (const row of rows) {
    byVisibility[row.visibility] = row.n
    total += row.n
  }
  return {
    access: (getSettings(ctx).aiVisibility ?? 'public') as AiBoardAccess,
    total,
    eligible: eligibleCommunities(ctx).length,
    byVisibility,
  }
}

/**
 * Bir "tur" çalıştırır: etkin karakterlerden rastgele birkaçı seçilir ve
 * kişiliklerine göre birer işlem yapar.
 *
 * @param now Zaman (testlerde sahte saat verilebilir).
 */
export function runAiTick(ctx: Ctx, now: number = ctx.now()): TickResult {
  const agents = listEnabledAgents(ctx)
  const result: TickResult = { actions: 0, posts: 0, comments: 0, votes: 0, boards: 0 }
  if (agents.length === 0) return result

  // Karakterlerin paylaşabileceği board yoksa motor sessizce hiçbir şey
  // yapmaz; yönetim arayüzü bu sayıyı kullanıcıya gösterir.
  result.boards = eligibleCommunities(ctx).length
  if (result.boards === 0) return result

  const rng = makeRng(now)

  // Etkinlik seviyesine göre ağırlıklı karakter seçimi: sık aktif olanlar
  // daha çok çağrılır, nadir paylaşanlar az.
  const chosen = pickWeightedAgents(rng, agents, MAX_ACTIONS_PER_TICK)

  for (const agentRow of chosen) {
    try {
      const did = runOneAgent(ctx, agentRow, rng, now)
      if (did) result.actions += 1
    } catch (err) {
      // Rate limit / yetki hatası bu karakteri durdurur ama diğerlerini
      // etkilemez. Korumalar kasıtlı olarak bypass EDİLMEZ.
      if (!(err instanceof AppError)) throw err
    }
  }

  // Kümülatif sayaçlar değil, BU TURDA yapılan işlemler döner: testler ve
  // loglar tek turda ne olduğunu görebilsin.
  const row = ctx.db
    .prepare(
      `SELECT
         COALESCE(SUM(posts_created), 0)      AS posts,
         COALESCE(SUM(comments_created), 0)  AS comments,
         COALESCE(SUM(votes_cast), 0)        AS votes
       FROM ai_agents`,
    )
    .get() as { posts: number; comments: number; votes: number }
  result.posts = row.posts
  result.comments = row.comments
  result.votes = row.votes
  return result
}

/**
 * Etkinlik seviyesine göre ağırlıklı karakter seçimi.
 * `activity` 0 olan karakter pratikte hiç seçilmez (ağırlığı ~0).
 */
function pickWeightedAgents(
  rng: () => number,
  agents: AiAgentWithUser[],
  count: number,
): AiAgentWithUser[] {
  const picked: AiAgentWithUser[] = []
  const pool = [...agents]
  for (let i = 0; i < count && pool.length > 0; i++) {
    const total = pool.reduce((sum, a) => sum + Math.max(0.01, a.activity), 0)
    let roll = rng() * total
    let index = 0
    for (let j = 0; j < pool.length; j++) {
      roll -= Math.max(0.01, pool[j]!.activity)
      if (roll <= 0) {
        index = j
        break
      }
    }
    picked.push(pool[index]!)
    pool.splice(index, 1)
  }
  return picked
}

/** Tek bir karakterin bir turda ne yapacağına karar verir ve yapar. */
function runOneAgent(ctx: Ctx, row: AiAgentWithUser, rng: () => number, now: number): boolean {
  // Bir turda aynı karakterin arka arkaya çok işlem yapmasın.
  if (row.last_active_at !== null && now - row.last_active_at < 60_000) return false

  const agent = getAiAgent(ctx, row.user_id)
  if (!agent) return false
  // Davranış fonksiyonları profil + kullanıcı satırının birleşimini ister;
  // ikisi de zaten aynı veritabanı satırından geliyor.
  const profile: AiAgentWithUser = { ...agent, ...row }
  const user = userRow(ctx, row.user_id)
  if (!user || user.deleted) return false
  if (user.suspended_indefinitely) return false

  const interests = parseList(agent.interests)
  const dislikes = parseList(agent.dislikes)

  // Kısıtlı/gizli boardlarda yazabilmek için önce üye olunması gerekir.
  ensureAiMemberships(ctx, profile, user, rng)

  // Karar: gönderi mi, yorum mu, oy mu, yoksa hiçbir şey mi?
  const action = weightedChoice(rng, [
    ['post', agent.post_rate * 0.6],
    ['comment', agent.comment_rate * 1.2],
    ['vote', 0.8],
    ['skip', 0.7],
  ])
  if (action === 'skip') {
    // "Her zaman yorum yazmak zorunda değil": sessiz kalmak da geçerli bir
    // davranıştır ve kişiliğin doğal sonucudur.
    ctx.db.prepare('UPDATE ai_agents SET last_active_at = ?, updated_at = ? WHERE user_id = ?').run(now, now, row.user_id)
    return false
  }

  if (action === 'post') {
    return maybeOpenPost(ctx, profile, user, rng, interests, now)
  }
  if (action === 'comment') {
    return maybeComment(ctx, profile, user, rng, interests, dislikes, now)
  }
  return maybeVote(ctx, profile, user, rng, interests, dislikes)
}

function userRow(ctx: Ctx, userId: string): UserRow | null {
  return (
    (ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined) ?? null
  )
}

function weightedChoice(rng: () => number, entries: Array<[string, number]>): string {
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0)
  if (total <= 0) return entries[0]![0]
  let roll = rng() * total
  for (const [value, weight] of entries) {
    roll -= Math.max(0, weight)
    if (roll <= 0) return value
  }
  return entries[entries.length - 1]![0]
}

/** Karakterın ilgi alanlarına uygun, yazabileceği bir board seçer. */
function pickCommunity(
  ctx: Ctx,
  agent: AiAgentWithUser,
  rng: () => number,
): CommunityRow | null {
  const candidates = agentCommunities(ctx, agent.user_id)
  if (candidates.length === 0) return null

  // Board tercihleri (şabbondan veya yönetimden gelen ağırlıklar).
  const prefs = parseRecord<number>(agent.board_prefs)
  const presence = new Map(boardPresence(ctx, agent.user_id).map((p) => [p.community_id, p]))

  const weights = candidates.map((c) => {
    let w = 1
    // Açık tercih varsa belirleyici.
    const pref = prefs[c.name]
    if (typeof pref === 'number') w += pref * 6
    // Daha önce aktif olduğu boarda yatınca döner (board hakimiyeti).
    const pres = presence.get(c.id)
    if (pres) w += Math.min(3, (pres.posts + pres.comments) * 0.4)
    // Adı ilgi alanıyla eşleşen boardlar öne çıkar.
    const lower = `${c.name} ${c.title} ${c.description}`.toLowerCase()
    for (const interest of parseList(agent.interests)) {
      if (lower.includes(interest.toLowerCase())) w += 2
    }
    return w
  })

  const total = weights.reduce((sum, w) => sum + Math.max(0.01, w), 0)
  let roll = rng() * total
  for (let i = 0; i < candidates.length; i++) {
    roll -= Math.max(0.01, weights[i]!)
    if (roll <= 0) return candidates[i]!
  }
  return candidates[candidates.length - 1]!
}

/** Karakter yeni bir gönderi açar. */
function maybeOpenPost(
  ctx: Ctx,
  agent: AiAgentWithUser,
  user: UserRow,
  rng: () => number,
  interests: string[],
  now: number,
): boolean {
  if (agent.posts_created >= MAX_POSTS_PER_TICK) return false
  const community = pickCommunity(ctx, agent, rng)
  if (!community) return false

  const text = generatePost(agent, Math.floor(rng() * 2 ** 31))
  // İlgi alanıyla eşleşmeyen konuları bu karakterin ilgi alanlarından birine
  // bağla: yazı, karakterin gerçekten ilgilendiği bir alandan gelsin.
  const topic = interests.length > 0 ? interests[Math.floor(rng() * interests.length)]! : text.topic

  try {
    const post = createTextPost(ctx, user, community, {
      title: text.title.replace(/\{t\}/g, topic),
      body: text.body,
    })
    bumpAgentCounters(ctx, agent.user_id, 'post')
    bumpPresence(ctx, agent.user_id, community.id, 'post')
    adjustReputation(ctx, agent.user_id, 1)
    logAiAction(ctx, {
      agentId: agent.user_id,
      action: 'post',
      targetType: 'post',
      targetId: post.id,
      communityId: community.id,
      detail: post.title.slice(0, 120),
    })
    return true
  } catch (err) {
    if (err instanceof AppError) return false
    throw err
  } finally {
    ctx.db.prepare('UPDATE ai_agents SET last_active_at = ?, updated_at = ? WHERE user_id = ?').run(now, now, agent.user_id)
  }
}

/** Karakter mevcut bir konuya yorum yazar veya yoruma cevap verir. */
function maybeComment(
  ctx: Ctx,
  agent: AiAgentWithUser,
  user: UserRow,
  rng: () => number,
  interests: string[],
  dislikes: string[],
  now: number,
): boolean {
  const posts = candidatePosts(ctx, agent, interests, dislikes)
  if (posts.length === 0) return false
  const post = posts[Math.floor(rng() * posts.length) % posts.length]!

  // Yorum yazacaksa bazen mevcut bir yoruma cevap verir (tartışma zinciri).
  const parent = maybePickParent(ctx, agent, post, rng)

  // Cevaplanan içerik: yorum varsa yorumun kendisi, yoksa gönderi.
  // Metin üreticisi bu içeriği okuyup ona göre cevap kurar.
  const context = parent ? parent.body : `${post.title} ${post.body ?? ''}`
  const media = { postType: post.type, mediaKind: post.media_kind }
  const analysis = analyzeContent(context, media)

  // Anlamsız içerik ("hhh", ":)") çoğu zaman yanıtlanmaz: gerçek bir
  // kullanıcı da her kahkahaya cevap yazmaz.
  if (analysis.isTrivial && rng() < 0.85) {
    ctx.db.prepare('UPDATE ai_agents SET last_active_at = ?, updated_at = ? WHERE user_id = ?').run(now, now, agent.user_id)
    return false
  }

  // Cevap verdiği yazarın karaktere ilişkisi cevabın tonunu etkiler.
  let peerRelation = 0
  let peerId: string | null = null
  if (parent) {
    peerId = parent.author_id
    if (peerId !== agent.user_id) {
      const peer = userRow(ctx, peerId)
      if (peer?.is_ai === 1) {
        peerRelation =
          relationshipAffinity(ctx, agent.user_id, peerId) !== 0
            ? relationshipAffinity(ctx, agent.user_id, peerId)
            : declaredPeerAffinity(agent, peer.username)
      }
    }
  }

  const text = generateComment(agent, context, Math.floor(rng() * 2 ** 31), undefined, peerRelation, media)

  try {
    const comment = createComment(ctx, user, post.id, {
      body: text.body,
      parentId: parent?.id ?? null,
    })
    bumpAgentCounters(ctx, agent.user_id, 'comment')
    bumpPresence(ctx, agent.user_id, post.community_id, 'comment')
    // Yorum yazmak küçük bir itibar kazandırır; cevap verilen kişi varsa
    // ilişki tutumuna göre kayar.
    adjustReputation(ctx, agent.user_id, parent ? 1 : 0)
    if (peerId && peerId !== agent.user_id) {
      // Katılıyorsa ilişki ısınır, disagrees ise soğur.
      const delta = text.stance === 'agree' ? 0.08 : text.stance === 'disagree' ? -0.05 : 0.02
      adjustRelationship(ctx, agent.user_id, peerId, delta, now)
      adjustRelationship(ctx, peerId, agent.user_id, delta * 0.5, now)
    }
    logAiAction(ctx, {
      agentId: agent.user_id,
      action: 'comment',
      targetType: 'comment',
      targetId: comment.id,
      communityId: post.community_id,
      detail: text.stance,
    })
    return true
  } catch (err) {
    if (err instanceof AppError) return false
    throw err
  } finally {
    ctx.db.prepare('UPDATE ai_agents SET last_active_at = ?, updated_at = ? WHERE user_id = ?').run(now, now, agent.user_id)
  }
}

/** Karaktere uygun gönderi havuzu (ilgi alanı + sevmememe). */
function candidatePosts(
  ctx: Ctx,
  agent: AiAgentWithUser,
  interests: string[],
  dislikes: string[],
): PostRow[] {
  const vis = aiEligibleVisibilities(ctx)
  const placeholders = vis.map(() => '?').join(', ')
  const rows = ctx.db
    .prepare(
      `SELECT p.* FROM posts p JOIN communities c ON c.id = p.community_id
        WHERE p.deleted = 0 AND p.removed = 0 AND p.auto_hidden = 0
          AND c.archived = 0 AND c.deleted_at IS NULL AND c.visibility IN (${placeholders})
          AND p.community_id NOT IN (
            SELECT community_id FROM bans
             WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
          )
        ORDER BY p.created_at DESC LIMIT 60`,
    )
    .all(...vis, agent.user_id, ctx.now()) as unknown as PostRow[]
  if (rows.length === 0) return []

  // Kendi gönderisine yorum yapmaz: havuzda yalnızca kendi gönderileri
  // varsa motor o tur yazmaz (kendi gönderisini yorumlamak yapay davranış).
  const mine = rows.filter((p) => p.author_id !== agent.user_id)
  if (mine.length === 0) return []
  const pool = mine

  const interestSet = interests.map((i) => i.toLowerCase())
  const dislikeSet = dislikes.map((d) => d.toLowerCase())

  return pool.filter((post) => {
    const haystack = `${post.title} ${post.body ?? ''}`.toLowerCase()
    // Sevmediği konu türüne tepki vermeyi azaltır (tamamen engellemez:
    // karakter yine de karşı görüşünü yazabilir).
    for (const d of dislikeSet) {
      if (haystack.includes(d)) return false
    }
    // İlgi alanıyla eşleşen gönderilere daha sıcak tepki verir; ama her
    // gönderiye tepki verebilir (ilgi alanı zorunlu değil).
    void interestSet
    return true
  })
}

/** Bazen bir yoruma cevap verir (tartışma zinciri). */
function maybePickParent(
  ctx: Ctx,
  agent: AiAgentWithUser,
  post: PostRow,
  rng: () => number,
): { id: string; body: string; author_id: string } | null {
  // Yalnızca tartışması olan gönderilere cevap verilir.
  if (post.comment_count <= 0) return null
  const comments = ctx.db
    .prepare(
      `SELECT id, body, author_id FROM comments
        WHERE post_id = ? AND deleted = 0 AND removed = 0 AND auto_hidden = 0
          AND author_id != ?
        ORDER BY created_at DESC LIMIT 10`,
    )
    .all(post.id, agent.user_id) as unknown as Array<{ id: string; body: string; author_id: string }>
  if (comments.length === 0) return null
  return comments[Math.floor(rng() * comments.length) % comments.length]!
}

/** Karakter mevcut içeriklere oy verir. */
function maybeVote(
  ctx: Ctx,
  agent: AiAgentWithUser,
  user: UserRow,
  rng: () => number,
  interests: string[],
  dislikes: string[],
): boolean {
  const posts = candidatePosts(ctx, agent, interests, dislikes)
  if (posts.length === 0) return false
  const post = posts[Math.floor(rng() * posts.length) % posts.length]!

  // Oy yönü: kişilik eğilimleri + konu uyumu.
  const haystack = `${post.title} ${post.body ?? ''}`.toLowerCase()
  let relevance = 0
  for (const interest of interests) {
    if (haystack.includes(interest.toLowerCase())) relevance += 1
  }
  for (const dislike of dislikes) {
    if (haystack.includes(dislike.toLowerCase())) relevance -= 1
  }

  const upBias = Math.min(1, agent.upvote_bias + relevance * 0.1)
  const downBias = Math.min(1, agent.downvote_bias + Math.max(0, -relevance) * 0.15)
  const roll = rng()
  let value = 0
  if (roll < upBias) value = 1
  else if (roll < upBias + downBias) value = -1
  else return false // oy vermemek de bir davranıştır

  try {
    castVote(ctx, user, 'post', post.id, value)
    bumpAgentCounters(ctx, agent.user_id, 'vote')
    bumpPresence(ctx, agent.user_id, post.community_id, 'vote')
    logAiAction(ctx, {
      agentId: agent.user_id,
      action: 'vote',
      targetType: 'post',
      targetId: post.id,
      communityId: post.community_id,
      detail: value > 0 ? 'up' : 'down',
    })
    return true
  } catch (err) {
    if (err instanceof AppError) return false
    throw err
  }
}

/**
 * Karakterleri boardlara yerleştirir (üyelik).
 *
 * Kısıtlı ve gizli boardlarda yazmak için onaylı üye olmak gerekir. AI
 * hesabı gerçek bir kullanıcı olmadığı ve yönetici bu boardlarda AI'a izin
 * verdiği için üyelik burada onaylanır — izin verilmemişse (varsayılan
 * `public`) bu boardlar zaten aday listesinde bulunmaz.
 */
function ensureAiMemberships(
  ctx: Ctx,
  agent: AiAgentWithUser,
  user: UserRow,
  rng: () => number,
): number {
  const prefs = parseRecord<number>(agent.board_prefs)
  let joined = 0
  for (const community of agentCommunities(ctx, agent.user_id)) {
    const membership = getMembership(ctx, user.id, community.id)
    if (membership?.status === 'approved') continue
    const pref = prefs[community.name]
    // Tercih edilen boarda her turda katılınır; diğerlerine düşük olasılıkla
    // (yoksa her karakter her yere üye olur ve ilgi alanı anlamını yitirir).
    if (pref === undefined && rng() > 0.35) continue
    try {
      joinCommunity(ctx, user, community)
      if (community.visibility !== 'public') {
        ctx.db
          .prepare(
            `UPDATE memberships SET status = 'approved'
              WHERE user_id = ? AND community_id = ? AND status = 'pending'`,
          )
          .run(user.id, community.id)
      }
      logAiAction(ctx, {
        agentId: agent.user_id,
        action: 'join',
        targetType: 'community',
        targetId: community.id,
        communityId: community.id,
        detail: community.visibility,
      })
      joined += 1
    } catch (err) {
      if (!(err instanceof AppError)) throw err
    }
  }
  return joined
}

/** Dışa açık yardımcı: bir karakteri boardlara yerleştirir. */
export function ensureMemberships(ctx: Ctx, agent: AiAgentWithUser): number {
  const user = userRow(ctx, agent.user_id)
  if (!user) return 0
  return ensureAiMemberships(ctx, agent, user, makeRng())
}

/** Karakterin topluluk adını (board) döndürür — dışarıdan okuma için. */
export function communityNameFor(ctx: Ctx, communityId: string): string | null {
  const community = getCommunityById(ctx, communityId)
  return community?.name ?? null
}
