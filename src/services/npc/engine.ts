/**
 * NPC davranış motoru — tek scheduler, kontrollü batch, kalıcı durum.
 *
 * Döngü (her NPC için):
 *   READ       → yeni gönderileri/boardları oku
 *   UNDERSTAND → yerel bağlam analizi (analyze.ts)
 *   DECIDE     → 7 soruya cevap ver, eylem seç (ya da hiçbir şey yapma)
 *   ACT        → yorum / cevap / oy / konu aç
 *   OBSERVE    → sonucu ölç (etkileşim, oy, cevap)
 *   UPDATE MEMORY       → hafızayı güncelle (memory.ts)
 *   UPDATE RELATIONSHIP → ilişkiyi güncelle (relationships.ts)
 *   UPDATE BEHAVIOR     → davranış ağırlıklarını güncelle (learning.ts)
 *
 * PERFORMANS: 50 NPC için 50 process YOKTUR. Tek bir `runNpcTick` döngüsü
 * vardır; NPC'ler ağırlıklı seçilir ve kontrollü batch'lerde sırayla
 * çalıştırılır. Sorgular hazır indeksleri kullanır; her turda sınırlı sayıda
 * gönderi okunur.
 *
 * GÜVENLİK: Motor insan kullanıcılar için yazılmış MEVCUT servisleri çağırır
 * (createTextPost, createComment, castVote, joinCommunity). Rate limit, spam
 * koruması, yetki ve arşiv kontrolleri NPC için de istisnasız çalışır;
 * hiçbir koruma atlanmaz. Bir hata o NPC'yi durdurur, diğerlerini etkilemez.
 */
import type { Ctx } from '../../context'
import type { AiAgentRow, AiAgentWithUser, CommunityRow, PostRow, UserRow } from '../../types'
import { createTextPost } from '../posts'
import { createComment } from '../comments'
import { castVote } from '../votes'
import { joinCommunity } from '../communities'
import { getMembership } from '../access'
import { AppError } from '../errors'
import { newId } from '../../lib/ids'
import { makeRng, weightedPick } from './rng'
import { analyzeContext, type ContextAnalysis } from './analyze'
import { composeComment, composePost } from './compose'
import { findAnswer } from './knowledge'
import { rememberThread, resolveOpenQuestion, shiftOpinion, saveTrace } from './state'
import {
  adjustReputation,
  bumpNpcCounters,
  bumpPresence,
  eligibleCommunities,
  npcEligibleVisibilities,
  parseList,
  parseRecord,
  personaFor,
} from './agents'
import type { NpcPersona } from './personas'
import { noteInteraction, noteQualityReply, relationshipOf } from './relationships'
import {
  hasCommentedOn,
  hasSeenConcept,
  memoryWeight,
  recordEpisode,
  rememberBoard,
  rememberConcept,
  rememberPerson,
} from './memory'
import { behaviorOf, pendingOutcomes, recordOutcome, settleOutcome } from './learning'
import type { NpcRelationshipRow } from '../../types'

/** Bir turda tek NPC'nin en fazla açabileceği gönderi sayısı. */
const MAX_POSTS_PER_TICK = 2

/**
 * Bir turda NPC başına sayılan eylemler.
 *
 * `ai_agents.posts_created` ÖMÜRLÜK sayacıdır; onu tur limitiyle
 * karşılaştırmak kalıcı kilit yaratıyordu: karakter 2 gönderi açtıktan
 * sonra bir daha asla gönderi açamıyordu. Bu yüzden tur sayacı ayrı
 * tutulur.
 */
interface TickCounters {
  postsByAgent: Map<string, number>
}

function newTickCounters(): TickCounters {
  return { postsByAgent: new Map() }
}

export interface TickResult {
  actions: number
  posts: number
  comments: number
  votes: number
  /** Paylaşılabilir board sayısı (0 ise motor sessiz kalır). */
  boards: number
}

/** Bir NPC'nin o turda okuduğu bir gönderi ve anladığı bağlam. */
interface ReadItem {
  post: PostRow
  analysis: ContextAnalysis
  /** Bağlı olduğu boardun adı (tercih kararı için). */
  community_name: string
  /** Gönderiyi bir NPC mi açmış (soğuk gönderi önceliği için). */
  author_is_ai: boolean
}

/** Bir NPC'nin bir turda vereceği karar. */
interface Decision {
  action: 'post' | 'comment' | 'vote' | 'skip'
  reason: string
  /**
   * Kararın verildiği gönderi.
   *
   * ÖNEMLİ: karar aşamasında seçilen gönderi ile eylemin hedefi AYNI olmak
   * zorundadır. `decide()` cevapsız yeni konuları (coldStart) öne çıkararak
   * seçiyor; eylem katmanı bunun yerine `read` listesinden RASTGELE bir
   * gönderi alırsa bu öncelik tamamen kaybolur ve NPC kullanıcının açtığı
   * konulara yanıt vermeyi bırakır.
   */
  target: ReadItem | null
}

/**
 * Bir "tur" çalıştırır.
 *
 * @param now Zaman (testlerde sahte saat verilebilir).
 */
export function runNpcTick(ctx: Ctx, now: number = ctx.now(), options: { force?: boolean } = {}): TickResult {
  const result: TickResult = { actions: 0, posts: 0, comments: 0, votes: 0, boards: 0 }
  const npcs = listEnabled(ctx)
  if (npcs.length === 0) return result

  result.boards = eligibleCount(ctx)
  if (result.boards === 0) return result

  const rng = makeRng(now)

  // Bekleme süresi dolmamış NPC'ler havuzdan ÖNCE çıkarılır. Aksi halde
  // tur kapasitesi (varsayılan 12 işlem) bekleme süresinde olan NPC'lere
  // harcanır ve o turda gerçekte hiçbir işlem yapılmaz — yeni açılan
  // konuların etkileşim almamasının başlıca nedeni buydu.
  //
  // `force` yalnızca yönetim panelindeki "Şimdi bir tur çalıştır" düğmesi
  // için vardır: yönetici bekleme süresini bilmez ve düğmeye bastığında
  // beklenen şey motorun HİÇ ÇALIŞMAMASI değil, çalıştığını görmektir.
  // Zamanlayıcı bu bayrağı kullanmaz — bekleme süresi orada korunur.
  const ready = options.force
    ? npcs
    : npcs.filter((n) => n.last_active_at === null || now - n.last_active_at >= cooldownMs(n.activity))
  if (ready.length === 0) return result

  // Ağırlıklı seçim: aktivite seviyesi yüksek NPC daha sık döngüye girer,
  // "çok seyrek" NPC neredeyse hiç seçilmez.
  const chosen = pickWeightedNpcs(rng, ready, ctx.config.npcMaxActionsPerTick)
  const tick = newTickCounters()

  for (const npc of chosen) {
    try {
      if (runOneNpc(ctx, npc, rng, now, options.force === true, tick)) result.actions += 1
    } catch (err) {
      // Rate limit / yetki hatası bu NPC'yi durdurur, diğerlerini etkilemez.
      // Korumalar kasıtlı olarak bypass EDİLMEZ.
      if (!(err instanceof AppError)) throw err
    }
  }

  // Gözlenen sonuçları ölç ve davranış ağırlıklarını güncelle (OBSERVE → UPDATE).
  measurePendingOutcomes(ctx, chosen.map((n) => n.user_id), now)

  const row = ctx.db
    .prepare(
      `SELECT COALESCE(SUM(posts_created), 0)     AS posts,
              COALESCE(SUM(comments_created), 0) AS comments,
              COALESCE(SUM(votes_cast), 0)       AS votes
         FROM ai_agents`,
    )
    .get() as { posts: number; comments: number; votes: number }
  result.posts = row.posts
  result.comments = row.comments
  result.votes = row.votes
  return result
}

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function listEnabled(ctx: Ctx): AiAgentWithUser[] {
  return ctx.db
    .prepare(
      `SELECT a.*, u.username, u.display_name, u.avatar_key, u.suspended_indefinitely, u.deleted
         FROM ai_agents a JOIN users u ON u.id = a.user_id
        WHERE a.enabled = 1 AND u.deleted = 0
        ORDER BY a.activity DESC`,
    )
    .all() as unknown as AiAgentWithUser[]
}

function eligibleCount(ctx: Ctx): number {
  // Yönetim panelinde gösterilen sayıyla aynı olmalı: yalnızca NPC erişimi
  // olan, arşivlenmemiş boardlar sayılır.
  return eligibleCommunities(ctx).length
}

/** Aktivite seviyesine göre ağırlıklı NPC seçimi. */
function pickWeightedNpcs(
  rng: () => number,
  npcs: AiAgentWithUser[],
  count: number,
): AiAgentWithUser[] {
  return weightedPickMany(rng, npcs, count, (n) => Math.max(0.01, n.activity))
}

function weightedPickMany<T>(rng: () => number, items: T[], count: number, weight: (item: T) => number): T[] {
  const picked: T[] = []
  const pool = [...items]
  for (let i = 0; i < count && pool.length > 0; i++) {
    const weights = pool.map(weight)
    const total = weights.reduce((sum, w) => sum + Math.max(0.01, w), 0)
    let roll = rng() * total
    let index = pool.length - 1
    for (let j = 0; j < pool.length; j++) {
      roll -= Math.max(0.01, weights[j]!)
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

/** Etkin NPC'ler (dışarıdan test edilebilir). */
export function listActiveNpcs(ctx: Ctx): AiAgentWithUser[] {
  return listEnabled(ctx)
}

// ---------------------------------------------------------------------------
// Tek NPC döngüsü
// ---------------------------------------------------------------------------

function runOneNpc(
  ctx: Ctx,
  row: AiAgentWithUser,
  rng: () => number,
  now: number,
  force = false,
  tick: TickCounters = newTickCounters(),
): boolean {
  // Aynı NPC kısa sürede tekrar tetiklenmez (aktivite seviyesi düşükse
  // bekleme süresi daha uzundur). Yönetici panelinden elle tetiklenen tur
  // bu kurala uymaz — aksi halde düğmeye ikinci kez basmak hiçbir şey
  // yapmaz ve motor çalışmıyor sanılır.
  const cooldown = cooldownMs(row.activity)
  if (!force && row.last_active_at !== null && now - row.last_active_at < cooldown) {
    logSkip(ctx, row.user_id, 'bekleme süresi', now)
    return false
  }

  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id) as
    | UserRow
    | undefined
  if (!user || user.deleted === 1 || user.suspended_indefinitely === 1) return false

  const agent = ctx.db.prepare('SELECT * FROM ai_agents WHERE user_id = ?').get(row.user_id) as
    | AiAgentRow
    | undefined
  if (!agent) return false

  const persona = personaFor(row.username)
  if (!persona) return false

  // --- READ ---
  ensureMemberships(ctx, agent, user, rng)
  const read = readPosts(ctx, agent, persona)

  // --- DECIDE ---
  const decision = decide(ctx, agent, persona, read, rng, tick)
  if (decision.action === 'skip') {
    logSkip(ctx, agent.user_id, decision.reason, now)
    touch(ctx, agent.user_id, now)
    return false
  }

  // --- ACT ---
  // Eylem, kararın verildiği gönderiye uygulanır (`decision.target`).
  // Yorum/oy katmanı eskiden `read` listesinden rastgele bir gönderi seçiyordu;
  // bu, karar aşamasındaki "cevapsız yeni konuya öncelik" kuralını işe
  // yaramaz hale getiriyordu.
  const target = decision.target
  let acted = false
  if (decision.action === 'comment') acted = actComment(ctx, agent, persona, user, target, rng, now)
  else if (decision.action === 'vote') acted = actVote(ctx, agent, persona, user, target, rng)
  else if (decision.action === 'post') acted = actPost(ctx, agent, persona, user, rng, now, tick)

  // --- UPDATE MEMORY ---
  rememberBoard(ctx, agent.user_id, decision.action, 0.02, now)
  pruneMemoryIfNeeded(ctx, agent.user_id)
  touch(ctx, agent.user_id, now)
  return acted
}

/** Aktivite seviyesine göre bekleme süresi (ms). Çok aktif: 30 sn, çok seyrek: 30 dk. */
function cooldownMs(activity: number): number {
  return Math.round(30_000 + (1 - Math.min(1, activity)) * 1_770_000)
}

function touch(ctx: Ctx, agentId: string, now: number): void {
  ctx.db.prepare('UPDATE ai_agents SET last_active_at = ?, updated_at = ? WHERE user_id = ?').run(now, now, agentId)
}

function pruneMemoryIfNeeded(ctx: Ctx, agentId: string): void {
  // Her turda budama yerine seyrek çalıştır (maliyet).
  const count = ctx.db.prepare('SELECT COUNT(*) AS n FROM npc_memory WHERE agent_id = ?').get(agentId) as {
    n: number
  }
  if (count.n > 140) {
    ctx.db
      .prepare(
        `DELETE FROM npc_memory
          WHERE agent_id = ? AND id IN (
            SELECT id FROM npc_memory WHERE agent_id = ?
             ORDER BY weight ASC, hits ASC LIMIT ?)`,
      )
      .run(agentId, agentId, count.n - 120)
  }
}

// ---------------------------------------------------------------------------
// READ
// ---------------------------------------------------------------------------

/**
 * NPC'nin okuyabileceği gönderileri alır ve BAĞLAM ANALİZİNİ uygular.
 *
 * Filtreler: silinmemiş, arşivlenmemiş, yasaklı olmayan boardlarda,
 * NPC'nin kendi gönderisi olmayanlar.
 */
function readPosts(ctx: Ctx, agent: AiAgentRow, persona: NpcPersona): ReadItem[] {
  const communities = npcBoardList(ctx, agent.user_id)
  if (communities.length === 0) return []
  const byId = new Map(communities.map((c) => [c.id, c.name]))
  const placeholders = communities.map(() => '?').join(', ')
  const rows = ctx.db
    .prepare(
      `SELECT p.*, c.name AS community_name FROM posts p JOIN communities c ON c.id = p.community_id
        WHERE p.deleted = 0 AND p.removed = 0 AND p.auto_hidden = 0
          AND c.archived = 0 AND c.deleted_at IS NULL
          AND p.community_id IN (${placeholders})
          AND p.author_id != ?
        ORDER BY p.created_at DESC LIMIT ?`,
    )
    .all(
      ...communities.map((c) => c.id),
      agent.user_id,
      ctx.config.npcPostsScannedPerTick,
    ) as unknown as Array<PostRow & { community_name: string }>

  // UNDERSTAND: her gönderi bağlamına çevrilir.
  //
  // Bir gönderinin kendi kelimeleri bir kavram ailesine oturmuyorsa
  // ("Yardım İstiyorum") gönderinin YERİ de bağlamdır: boardun adı, başlığı
  // ve açıklaması konuyu verir. Komşu gönderiler bilinçli olarak KULLANILMAZ —
  // boardda yan yana duran iki konu birbirine bulaşmamalıdır.
  const boardMeta = new Map(
    communities.map((c) => [c.id, `${c.name} ${c.title} ${c.description ?? ''}`]),
  )

  // NPC yazarlarının kimlikleri: bir gönderiyi NPC mi açmış, yoksa gerçek
  // bir kullanıcı mı? “Henüz cevapsız gönderi” önceliği buna bakar.
  const aiAuthors = new Set(
    (
      ctx.db.prepare('SELECT user_id FROM ai_agents').all() as unknown as Array<{ user_id: string }>
    ).map((r) => r.user_id),
  )

  return rows.map((row) => {
    const text = `${row.title} ${row.body ?? ''}`
    const base = {
      postType: row.type,
      mediaKind: row.media_kind,
    }
    let analysis = analyzeContext(text, base)
    if (analysis.concepts.length === 0 && !analysis.isTrivial) {
      const boardText = boardMeta.get(row.community_id) ?? ''
      if (boardText.trim() !== '') {
        const withContext = analyzeContext(
          `${text} ${boardText}`.slice(0, 800),
          base,
        )
        if (withContext.concepts.length > 0) analysis = withContext
      }
    }
    return {
      post: row,
      community_name: row.community_name ?? byId.get(row.community_id) ?? '',
      analysis,
      author_is_ai: aiAuthors.has(row.author_id),
    }
  })
}

/** NPC'nin paylaşabileceği boardlar (yasaklar düşülmüş). */
function npcBoardList(ctx: Ctx, agentId: string): CommunityRow[] {
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
  const vis = npcVisibilities(ctx)
  const placeholders = vis.map(() => '?').join(', ')
  return (
    ctx.db
      .prepare(
        `SELECT * FROM communities
          WHERE archived = 0 AND deleted_at IS NULL AND visibility IN (${placeholders})
          ORDER BY name`,
      )
      .all(...vis) as unknown as CommunityRow[]
  ).filter((c) => !banned.has(c.id))
}

function npcVisibilities(ctx: Ctx): string[] {
  return npcEligibleVisibilities(ctx)
}

// ---------------------------------------------------------------------------
// DECIDE — yedi soru
// ---------------------------------------------------------------------------

/**
 * NPC bir gönderiye nasıl tepki verir?
 *
 *   1. Bu konu benim ilgi alanım mı?
 *   2. Bu konu tercih ettiğim boardlardan mı?
 *   3. Daha önce bu konuyu gördüm mü?
 *   4. Bu kullanıcıyla daha önce etkileşimim oldu mu?
 *   5. Bu konu önceki deneyimlerimle ilişkili mi?
 *   6. Buna cevap vermek karakterime uygun mu?
 *   7. Yeni bir konu açmak için yeterli bağlam var mı?
 *
 * Yedi sorudan altısı "hayır" ise NPC hiçbir şey YAPMAZ. Bu, davranışın
 * en önemli kuralıdır: her gördüğü gönderiye cevap vermez.
 */
function decide(
  ctx: Ctx,
  agent: AiAgentRow,
  persona: NpcPersona,
  read: ReadItem[],
  rng: () => number,
  tick: TickCounters,
): Decision {
  if (read.length === 0) return { action: 'skip', reason: 'okunacak gönderi yok', target: null }

  const interests = new Set(parseList(agent.interests).map((i) => i.toLowerCase()))
  const dislikes = parseList(agent.dislikes).map((d) => d.toLowerCase())
  const boardPrefs = parseRecord<number>(agent.board_prefs)

  // Aday gönderiler: ilgi alanı eşleşen VE sevmediği konu olmayanlar önce.
  const relevant: ReadItem[] = []
  const neutral: ReadItem[] = []
  for (const item of read) {
    const haystack = `${item.post.title} ${item.post.body ?? ''}`.toLowerCase()
    if (dislikes.some((d) => haystack.includes(d))) continue
    const interestMatch =
      item.analysis.topic === 'gündelik' ||
      interests.has(item.analysis.topic) ||
      [...interests].some((i) => haystack.includes(i))
    const boardBonus = boardPrefs[item.community_name] ?? 0
    if (interestMatch || boardBonus > 0.4) relevant.push(item)
    else neutral.push(item)
  }

  const pool = relevant.length > 0 ? relevant : neutral

  // CEVAPSIZ GÖNDERİ ÖNCELİĞİ.
  //
  // Kullanıcı yeni bir konu açtığında beklenen şey, birkaç dakika içinde
  // yorum/oy gelmesidir. NPC'ler gönderileri rastgele seçtiği için kendi
  // açtıkları gönderilere takılıp yeni konulara hiç uğramıyordu. Henüz
  // yorumalmamış, gerçek bir kullanıcının açtığı gönderiler bu yüzden
  // havuzdan öne çıkar (yine de herkes her gönderiye cevap vermez:
  // sonraki kilitler aynen geçerlidir).
  // Cevapsız gönderi havuzu. Kısa/kahkaha içerikler (“hhh”, “HAHAHA”)
  // cevaplanmaya değmez; havuzda dursalardı NPC'nin turunu tek başına
  // harcamalarına yol açarlardı. Önce anlamlı olanlar denenir.
  const cold = pool.filter((i) => !i.author_is_ai && i.post.comment_count === 0)
  const coldSolid = cold.filter((i) => !i.analysis.isTrivial)
  const solid = pool.filter((i) => !i.analysis.isTrivial)
  const candidates =
    coldSolid.length > 0 && rng() < 0.85
      ? coldSolid
      : cold.length > 0 && rng() < 0.85
        ? cold
        : solid.length > 0
          ? solid
          : pool
  const chosen = candidates[Math.floor(rng() * candidates.length) % candidates.length]
  if (!chosen) return { action: 'skip', reason: 'uygun gönderi yok', target: null }

  const { post, analysis } = chosen
  const seenBefore = hasSeenConcept(ctx, agent.user_id, analysis.topic)
  const alreadyCommented = hasCommentedOn(ctx, agent.user_id, post.id)
  const memory = memoryWeight(ctx, agent.user_id, analysis.topic)

  // Soru 3 + 4: Daha önce gördü mü, bu yazarla etkileşimi var mı?
  const relation: NpcRelationshipRow = relationshipOf(ctx, agent.user_id, post.author_id)
  const friend = relation.friendship > 0.15 || relation.respect > 0.15

  // Soru 6: Anlamsız içerik (kahkaha, boş) çoğu zaman yanıtlanmaz.
  if (analysis.isTrivial && !friend && rng() < 0.9) {
    return { action: 'skip', reason: 'anlamsız içerik', target: chosen }
  }

  // Zaten yorum yaptıysa tekrar yorum yapmaz.
  if (alreadyCommented && rng() < 0.8) {
    return { action: 'skip', reason: 'zaten yorum yapmış', target: chosen }
  }

  // Görüşü yeniden söylemeyi önle (daha önce aynı konuda olumsuz sonuç).
  if (seenBefore && memory > 0.4 && rng() < 0.5) {
    // Konu ilgi çekiyor ama tekrarı riskli → oy ver ya da geç.
    if (rng() < agent.vote_rate) return { action: 'vote', reason: 'konu hatırlı, oy tercih edildi', target: chosen }
    return { action: 'skip', reason: 'konu tekrarı riski', target: chosen }
  }

  // Eylem ağırlıkları — öğrenilmiş politika ile çarpılır.
  // Hiçbir gönderi ilgi alanıyla örtüşmüyorsa NPC yorum ve konu açmaz;
  // yalnızca oy kullanır ya da sessiz kalır. "Her gönderiye cevap verme"
  // kuralının motor içindeki karşılığı budur.
  const onTopic = relevant.length > 0 && !analysis.isTrivial
  // Yeni ve cevapsız bir gönderi: “sessiz kalma” eğilimi kırılır. Kullanıcı
  // konu açtı ve kimse cevap vermedi; NPC'nin burada susmaması gerekir.
  const coldStart = !chosen.author_is_ai && post.comment_count === 0
  const policy = behaviorOf(ctx, agent.user_id, analysis.topic)
  const commentWeight = onTopic
    ? agent.comment_rate * policy.engage_w *
      (analysis.isTrivial ? 0.1 : 1) *
      (alreadyCommented ? 0.2 : 1) *
      (friend ? 1.3 : 1) *
      (coldStart ? 2.5 : 1)
    : 0
  const voteWeight =
    agent.vote_rate * (analysis.isTrivial ? 0.2 : 1) * 0.7 * (coldStart ? 1.6 : 1)
  const postsThisTick = tick.postsByAgent.get(agent.user_id) ?? 0
  const postWeight = onTopic
    ? agent.post_rate * policy.post_w *
      (postsThisTick >= MAX_POSTS_PER_TICK ? 0 : 1) *
      (coldStart ? 0.2 : 1)
    : 0
  // Sessizlik ağırlığı: yeni konu varsa düşer, yoksa yüksektir.
  const skipWeight = 0.8 + (analysis.isTrivial ? 1.5 : 0) - (coldStart ? 0.55 : 0)

  // Ağırlığı 0 olan eylemler seçilemez. `weightedPick` 0'ı 0.01'e çektiği
  // için sıfır ağırlık doğrudan listeden çıkarılır: ilgi alanı dışı bir
  // gönderiye yorum yazılması böyle engellenir (aksi halde 50 karakter ×
  // onlarca turda bir kere bile "olası" kalıyordu).
  const options = [
    ['comment', commentWeight],
    ['vote', voteWeight],
    ['post', postWeight],
    ['skip', Math.max(0.15, skipWeight)], // "hiçbir şey yapma" geçerli bir davranıştır
  ] as Array<[Decision['action'], number]>
  const usable = options.filter(([, w]) => w > 0)
  const action = weightedPick(rng, usable.length > 0 ? usable : ([['skip', 1]] as Array<[Decision['action'], number]>))

  return { action, reason: `konu=${analysis.topic} ilgi=${relevant.length}`, target: chosen }
}

// ---------------------------------------------------------------------------
// ACT
// ---------------------------------------------------------------------------

/** Yorum yazar (gönderiye veya mevcut bir yoruma cevap). */
function actComment(
  ctx: Ctx,
  agent: AiAgentRow,
  persona: NpcPersona,
  user: UserRow,
  target: ReadItem | null,
  rng: () => number,
  now: number,
): boolean {
  if (!target) return false
  const { post } = target

  // Bazen mevcut bir yoruma cevap verir (tartışma zinciri) — ama yalnızca
  // gönderiyi GERÇEK bir kullanıcı açmışsa. NPC'lerin birbirine cevap
  // vermesi, kalıp cümlenin kalıp cümleye cevap vermesi demekti: ortaya
  // konu dışı, anlamsız zincirler çıkıyordu.
  let parentId: string | null = null
  let content = `${post.title} ${post.body ?? ''}`
  if (post.comment_count > 0 && rng() < 0.4) {
    const parent = ctx.db
      .prepare(
        `SELECT c.id, c.body FROM comments c JOIN users u ON u.id = c.author_id
          WHERE c.post_id = ? AND c.deleted = 0 AND c.removed = 0 AND c.auto_hidden = 0
            AND c.author_id != ? AND u.is_ai = 0
          ORDER BY c.created_at DESC LIMIT 1`,
      )
      .get(post.id, agent.user_id) as { id: string; body: string } | undefined
    if (parent) {
      // Yorum zincirine cevap vermek, gönderiyi okumamak demektir: başka
      // bir NPC'nin kalıp cümlesine verilen kalıp cevap, ortaya yeni bir
      // alakasız metin çıkarır. Asıl soru gönderide durduğu için, gönderi
      // yanıtlanabilir bir soruysa cevap doğrudan gönderiye yazılır.
      const postText = `${post.title} ${post.body ?? ''}`
      const base = { postType: post.type, mediaKind: post.media_kind }
      const parentAnswer = findAnswer(parent.body, analyzeContext(parent.body, base))
      if (!parentAnswer && findAnswer(postText, analyzeContext(postText, base))) {
        content = postText
      } else {
        parentId = parent.id
        content = parent.body
      }
    }
  }

  // Cevaplanan içeriğin bağlamı (gönderi ya da yorum).
  const replyAnalysis = analyzeContext(content, { postType: post.type, mediaKind: post.media_kind })

  // Thread awareness: bir kullanıcı bize cevap verdiyse açık sorumuz kapanır.
  if (parentId !== null) resolveOpenQuestion(ctx, agent.user_id, post.id, now)

  const relation = relationshipOf(ctx, agent.user_id, post.author_id)
  const composed = composeComment(ctx, {
    agentId: agent.user_id,
    persona,
    analysis: replyAnalysis,
    content,
    relationship: relation,
    memoryWeight: memoryWeight(ctx, agent.user_id, replyAnalysis.topic),
    postId: post.id,
    seed: Math.floor(rng() * 2 ** 31),
  })

  if (!composed) {
    ctx.db
      .prepare(
        `INSERT INTO ai_activity_log (id, agent_id, action, target_type, target_id, community_id, detail, created_at)
         VALUES (?, ?, 'comment_skipped', 'post', ?, ?, ?, ?)`,
      )
      .run(
        newId(),
        agent.user_id,
        post.id,
        post.community_id,
        'kalite kapısından geçemedi',
        now,
      )
    return false
  }

  try {
    const comment = createComment(ctx, user, post.id, { body: composed.body, parentId })
    bumpNpcCounters(ctx, agent.user_id, 'comment')
    bumpPresence(ctx, agent.user_id, post.community_id, 'comment')
    adjustReputation(ctx, agent.user_id, 0.5)
    noteInteraction(ctx, agent.user_id, post.author_id, composed.stance, composed.score.total, now)
    if (parentId === null) {
      noteQualityReply(ctx, agent.user_id, post.author_id, composed.score.total, now)
    }
    // Hafıza: bu konuyu ve bu kişiyi hatırla.
    rememberConcept(ctx, agent.user_id, replyAnalysis.topic, 0.05, now)
    rememberPerson(ctx, agent.user_id, post.author_id, 0.03, now)
    recordEpisode(
      ctx,
      agent.user_id,
      {
        concept: replyAnalysis.topic,
        summary: `${replyAnalysis.topicLabel} konusunda yorum: ${composed.body.slice(0, 120)}`,
        sentiment: replyAnalysis.sentiment,
        score: composed.score.total,
        postId: post.id,
        commentId: comment.id,
        peerId: post.author_id,
      },
      now,
    )
    // Davranış öğrenmesi: deneme kaydı (sonucu sonradan ölçülür).
    recordOutcome(
      ctx,
      agent.user_id,
      'comment',
      comment.id,
      replyAnalysis.topic,
      composed.style,
      composed.score.total,
      0,
      now,
    )
    logNpc(ctx, agent.user_id, 'comment', 'comment', comment.id, post.community_id, composed.stance, now)

    // --- YAŞAM KATMANLARI: konuşma devamlılığı, görüş, iz ---
    // Cevabı yazdıktan SONRA güncellenir: bir sonraki cevap bunlardan türer.
    const openQuestion = /\?/u.test(composed.body)
      ? (composed.body.match(/[^.!?…]*\?/u)?.[0] ?? '').trim().slice(0, 120)
      : ''
    rememberThread(
      ctx,
      agent.user_id,
      post.id,
      {
        subject: replyAnalysis.focus !== '' ? replyAnalysis.focus : replyAnalysis.topic,
        stance: composed.stance,
        statement: composed.body,
        openQuestion,
        disagreementDelta: composed.stance === 'disagree' ? 0.15 : composed.stance === 'agree' ? -0.1 : 0,
      },
      now,
    )
    // Görüş: yazdığı cevabın yönü küçük bir adım kaydırır.
    const evidence =
      composed.stance === 'agree' ? 0.5 : composed.stance === 'disagree' ? -0.5 : replyAnalysis.sentiment === 'negative' ? -0.2 : 0.15
    shiftOpinion(ctx, agent.user_id, replyAnalysis.topic, evidence, composed.score.total, now)
    // Denetim izi: "neden bu cevabı verdi?"
    saveTrace(
      ctx,
      agent.user_id,
      'comment',
      comment.id,
      {
        plan: composed.trace.plan,
        thought: composed.trace.thought,
        memory: composed.trace.memory,
        relationship: composed.trace.relationship,
        mood: composed.trace.mood,
        score: composed.score.total,
        rejected: composed.trace.rejected,
        body: composed.body,
      },
      now,
    )
    return true
  } catch (err) {
    if (err instanceof AppError) return false
    throw err
  }
}

/** Oy ver. Rastgele DEĞİLDİR: konu ilgisi + kişilik + duygu + ilişki + içerik kalitesi belirler. */
function actVote(
  ctx: Ctx,
  agent: AiAgentRow,
  persona: NpcPersona,
  user: UserRow,
  target: ReadItem | null,
  rng: () => number,
): boolean {
  if (!target) return false
  const { post, analysis } = target

  // İlgi uyumu: NPC'nin ilgi alanı bu gönderiyle örtüşüyor mu?
  const interests = parseList(agent.interests).map((i) => i.toLowerCase())
  let relevance = 0
  if (interests.includes(analysis.topic)) relevance += 1
  for (const interest of interests) {
    if (`${post.title} ${post.body ?? ''}`.toLowerCase().includes(interest)) relevance += 0.5
  }
  // Duygu uyumu: olumlu içeriğe olumlu, olumsuza olumsuz eğilim (ama ölçülü).
  if (analysis.sentiment === 'positive') relevance += 0.3
  if (analysis.sentiment === 'negative') relevance -= 0.2 * (1 - persona.talkativeness)
  // Şüpheci karakter olumsuz iddialara daha sert oy verir.
  if (analysis.isArgument && persona.skepticism > 0.6) relevance -= 0.3
  // Yazar ilişkisi: yakın dost → yukarı oy, rakip → aşağı eğilim.
  const relation = relationshipOf(ctx, agent.user_id, post.author_id)
  relevance += relation.friendship * 0.3 - relation.dislike * 0.3

  // Karar: kontrollü rastgelelik + faktörler.
  const upProb = Math.min(0.95, Math.max(0.05, agent.upvote_bias * 0.5 + 0.25 + relevance * 0.15))
  const downProb = Math.min(0.6, Math.max(0.02, agent.downvote_bias * 0.5 + Math.max(0, -relevance) * 0.15))
  const roll = rng()
  const value = roll < upProb ? 1 : roll < upProb + downProb ? -1 : 0
  if (value === 0) return false // oy vermemek de bir davranıştır

  // Zaten aynı değeri oyladıysa `castVote` sessizce hiçbir şey yapmaz ama
  // motor bunu "işlem" sayar: kullanıcı panelde oyun değişmediğini görür.
  // Aynı oyun tekrarı işlem sayılmaz; gerekirse karar değişecekse yeni
  // gönderi beklenir.
  const existing = ctx.db
    .prepare("SELECT value FROM votes WHERE user_id = ? AND target_type = 'post' AND target_id = ?")
    .get(user.id, post.id) as { value: number } | undefined
  if (existing && existing.value === value) return false

  try {
    castVote(ctx, user, 'post', post.id, value)
    bumpNpcCounters(ctx, agent.user_id, 'vote')
    bumpPresence(ctx, agent.user_id, post.community_id, 'vote')
    logNpc(ctx, agent.user_id, 'vote', 'post', post.id, post.community_id, value > 0 ? 'up' : 'down', ctx.now())
    return true
  } catch (err) {
    if (err instanceof AppError) return false
    throw err
  }
}

/** Yeni konu açar. Konu, NPC'nin ilgi alanlarından VE board bağlamından türetilir. */
function actPost(
  ctx: Ctx,
  agent: AiAgentRow,
  persona: NpcPersona,
  user: UserRow,
  rng: () => number,
  now: number,
  tick: TickCounters,
): boolean {
  // Tur başına limit (ömürlük sayaç DEĞİL): aksi halde karakter 2 gönderi
  // açtıktan sonra kalıcı olarak konu açamaz hale geliyordu.
  if ((tick.postsByAgent.get(agent.user_id) ?? 0) >= MAX_POSTS_PER_TICK) return false
  const communities = npcBoardList(ctx, agent.user_id)
  if (communities.length === 0) return false

  // Board seçimi: tercihler + ilgi alanı eşleşmesi.
  const prefs = parseRecord<number>(agent.board_prefs)
  const presence = new Map(
    (ctx.db
      .prepare('SELECT community_id, posts, comments FROM ai_board_presence WHERE agent_id = ?')
      .all(agent.user_id) as unknown as Array<{ community_id: string; posts: number; comments: number }>
    ).map((p) => [p.community_id, p]),
  )
  const weighted = communities.map((c) => {
    let w = 1
    w += (prefs[c.name] ?? 0) * 5
    const p = presence.get(c.id)
    if (p) w += Math.min(2, (p.posts + p.comments) * 0.2)
    const lower = `${c.name} ${c.title} ${c.description}`.toLowerCase()
    for (const interest of parseList(agent.interests)) {
      if (lower.includes(interest.toLowerCase())) w += 2
    }
    return [c, w] as [CommunityRow, number]
  })
  const community = weightedPick(rng, weighted)
  if (!community) return false

  // Konu: NPC'nin ilgi alanlarından seçilir; ancak konu yalnızca board'daki
  // son konuşmalarla birlikte BAĞLAM bulunursa üretilir. Tek başına "oyun"
  // kelimesi hangi aileyi kastettiğini kanıtlamaz.
  const interests = parseList(agent.interests)
  const recentRows = ctx.db
    .prepare(
      `SELECT title, body FROM posts
        WHERE community_id = ? AND deleted = 0 AND removed = 0
        ORDER BY created_at DESC LIMIT 3`,
    )
    .all(community.id) as unknown as Array<{ title: string; body: string | null }>
  const boardContext = recentRows.map((r) => `${r.title} ${r.body ?? ''}`).join(' ')

  let topicAnalysis: ContextAnalysis | null = null
  for (let i = 0; i < interests.length && topicAnalysis === null; i++) {
    const candidate = interests[(i + Math.floor(rng() * interests.length)) % interests.length]
    if (!candidate) continue
    const analysis = analyzeContext(
      `${candidate} ${community.title} ${boardContext || community.description}`.slice(0, 600),
    )
    if (analysis.topic !== 'gündelik') topicAnalysis = analysis
  }
  if (!topicAnalysis) {
    logNpc(ctx, agent.user_id, 'post_skipped', 'community', community.id, community.id, 'bağlam yok', now)
    return false
  }

  const composed = composePost(ctx, {
    agentId: agent.user_id,
    persona,
    analysis: topicAnalysis,
    content: community.title,
    seed: Math.floor(rng() * 2 ** 31),
    kind: 'post',
    boardName: community.name,
    board: { name: community.name, title: community.title, description: community.description ?? '' },
    agenda: recentRows.map((r) => r.title),
  })

  if (!composed) {
    logNpc(ctx, agent.user_id, 'post_skipped', 'community', community.id, community.id, 'kalite kapısı', now)
    return false
  }

  try {
    const post = createTextPost(ctx, user, community, { title: composed.title, body: composed.body })
    tick.postsByAgent.set(agent.user_id, (tick.postsByAgent.get(agent.user_id) ?? 0) + 1)
    bumpNpcCounters(ctx, agent.user_id, 'post')
    bumpPresence(ctx, agent.user_id, community.id, 'post')
    adjustReputation(ctx, agent.user_id, 1)
    rememberConcept(ctx, agent.user_id, composed.topic, 0.05, now)
    recordEpisode(
      ctx,
      agent.user_id,
      {
        concept: composed.topic,
        summary: `${composed.topic} konusunda gönderi açtı: ${composed.title}`,
        score: composed.score.total,
        postId: post.id,
      },
      now,
    )
    recordOutcome(
      ctx,
      agent.user_id,
      'post',
      post.id,
      composed.topic,
      'post',
      composed.score.total,
      0,
      now,
    )
    logNpc(ctx, agent.user_id, 'post', 'post', post.id, community.id, composed.title.slice(0, 80), now)
    return true
  } catch (err) {
    if (err instanceof AppError) return false
    throw err
  }
}

function logNpc(
  ctx: Ctx,
  agentId: string,
  action: string,
  targetType: string,
  targetId: string,
  communityId: string,
  detail: string,
  now: number,
): void {
  ctx.db
    .prepare(
      `INSERT INTO ai_activity_log (id, agent_id, action, target_type, target_id, community_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), agentId, action, targetType, targetId, communityId, detail, now)
}

/**
 * "NPC bir şey yapmadı" durumunu denetim izine yazar.
 *
 * Sessizlik kasıtlıdır ama yönetici için görünmezse hata sanılır. Bu kayıt
 * “neden yazmadı?” sorusunu panelden yanıtlar. Gürültüyü önlemek için aynı
 * NPC başına saatte en fazla bir kayıt yazılır.
 */
function logSkip(ctx: Ctx, agentId: string, reason: string, now: number): void {
  const recent = ctx.db
    .prepare(
      `SELECT 1 FROM ai_activity_log
        WHERE agent_id = ? AND action = 'skip' AND created_at > ? LIMIT 1`,
    )
    .get(agentId, now - 3_600_000)
  if (recent) return
  ctx.db
    .prepare(
      `INSERT INTO ai_activity_log (id, agent_id, action, target_type, target_id, community_id, detail, created_at)
       VALUES (?, ?, 'skip', 'tick', NULL, NULL, ?, ?)`,
    )
    .run(newId(), agentId, reason, now)
}

// ---------------------------------------------------------------------------
// OBSERVE — sonucu ölç, davranış ağırlıklarını güncelle
// ---------------------------------------------------------------------------

/**
 * Bekleyen denemelerin sonucunu ölçer:
 *   - Yazıya cevap geldi mi? (yorum / upvote sayısı)
 *   - Etkileşim oranı ne?
 *
 * Sonuç davranış ağırlıklarını kademeli günceller (learning.ts).
 */
export function measurePendingOutcomes(ctx: Ctx, agentIds: string[], now: number): void {
  for (const agentId of agentIds) {
    // Yalnızca önceki turlarda yazılmış denemeler ölçülür; aynı turda
    // yazılan yorum kendi etkileşimini henüz alamamıştı.
    for (const outcome of pendingOutcomes(ctx, agentId, 10, now)) {
      let reward = 0
      if (outcome.kind === 'comment') {
        // Yorumun aldığı oy + aldığı cevap sayısı.
        const stats = ctx.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM votes WHERE target_type = 'comment' AND target_id = ? AND value = 1) AS up,
                    (SELECT COUNT(*) FROM comments WHERE parent_id = ? AND deleted = 0) AS replies`,
          )
          .get(outcome.target_id, outcome.target_id) as { up: number; replies: number }
        reward = Math.min(1, stats.up * 0.3 + stats.replies * 0.4) - (1 - outcome.quality) * 0.2
      } else {
        // Gönderinin aldığı oy + yorum.
        const stats = ctx.db
          .prepare(
            `SELECT (SELECT COUNT(*) FROM votes WHERE target_type = 'post' AND target_id = ? AND value = 1) AS up,
                    (SELECT COUNT(*) FROM comments WHERE post_id = ? AND deleted = 0) AS replies`,
          )
          .get(outcome.target_id, outcome.target_id) as { up: number; replies: number }
        reward = Math.min(1, stats.up * 0.2 + stats.replies * 0.3) - (1 - outcome.quality) * 0.2
      }
      settleOutcome(ctx, agentId, outcome.id, Math.max(-1, Math.min(1, reward)), now)
    }
  }
}

// ---------------------------------------------------------------------------
// Üyelik (board yerleştirme)
// ---------------------------------------------------------------------------

/**
 * NPC'leri boardlara yerleştirir.
 *
 * Kısıtlı/gizli boardlarda yazmak için onaylı üye olmak gerekir. Yönetici
 * bu boardlarda NPC'lere izin verdiği için üyelik burada onaylanır; izin
 * verilmemişse (varsayılan `public`) bu boardlar zaten aday listesinde yok.
 */
function ensureMemberships(ctx: Ctx, agent: AiAgentRow, user: UserRow, rng: () => number): number {
  const prefs = parseRecord<number>(agent.board_prefs)
  let joined = 0
  for (const community of npcBoardList(ctx, agent.user_id)) {
    const membership = getMembership(ctx, user.id, community.id)
    if (membership?.status === 'approved') continue
    const pref = prefs[community.name]
    if (pref === undefined && rng() > 0.3) continue
    try {
      joinCommunity(ctx, user, community)
      if (community.visibility !== 'public') {
        ctx.db
          .prepare(`UPDATE memberships SET status = 'approved' WHERE user_id = ? AND community_id = ? AND status = 'pending'`)
          .run(user.id, community.id)
      }
      joined += 1
    } catch (err) {
      if (!(err instanceof AppError)) throw err
    }
  }
  return joined
}
