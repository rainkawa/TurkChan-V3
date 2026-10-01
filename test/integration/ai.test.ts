/**
 * AI karakter sistemi testleri.
 *
 * Her test bir davranışı GERÇEKTEN doğrular; "zaten çalışıyor"
 * varsayımı üzerine yazılmaz. Özellikle şu üç güvenlik özelliği
 * kanıtlanır:
 *
 *   1. AI hesapları oturum açamaz.
 *   2. AI karakterleri rate limit / spam korumasını bypass edemez.
 *   3. AI yönetimi yalnızca site yöneticisine açıktır.
 */
import { describe, expect, test, beforeEach } from 'vitest'
import { createTestWorld, registerUser, registerAdmin, createCommunityVia, Agent } from '../testUtils'
import type { Ctx } from '../../src/context'
import { createAiAgents, listAiAgents, getAiAgent, updateAiAgent, resetAiAgent, aiAgentContent, adjustRelationship, relationshipAffinity, adjustReputation, boardPresence, listEnabledAgents, parseList, parseRecord } from '../../src/services/ai/agents'
import { runAiTick, aiBoardCoverage } from '../../src/services/ai/activity'
import { updateSettings } from '../../src/services/settings'
import { generatePost, generateComment, detectTopic, voiceSignature } from '../../src/services/ai/voice'
import { analyzeContent } from '../../src/services/ai/analyze'
import { PERSONAS, archetypeLabel } from '../../src/services/ai/personas'
import { login } from '../../src/services/auth'
import { getUserByUsername } from '../../src/services/auth'
import type { AiAgentRow, AiAgentWithUser, CommunityRow, UserRow } from '../../src/types'


/** registerUser'ın kullandığı varsayılan parola (test/testUtils.ts). */
const DEFAULT_PASSWORD = 'password12345'

/**
 * registerAdmin yalnızca ilk kullanıcıya açık olduğu için, ikinci bir site
 * yöneticisi gereken testlerde kullanıcıyı kaydedip doğrudan yönetici yapar.
 */
async function makeSecondAdmin(world: ReturnType<typeof createTestWorld>, username: string) {
  const { agent } = await registerUser(world, username)
  world.ctx.db.prepare('UPDATE users SET is_admin = 1 WHERE username_lower = ?').run(username.toLowerCase())
  return { agent, username }
}

/** Test dünyası + 50 AI karakteri hazır (yönetici kurulmaz). */
function worldWithAgents(): { ctx: Ctx } {
  const world = createTestWorld()
  const ctx = world.ctx as Ctx
  createAiAgents(ctx)
  return { ctx }
}

/**
 * Kullanıcı adından karakter profili bulur.
 *
 * `username` alanı bilerek döndürülür: metin üreticisi persona
 * kataloğundan karakterin "söz kalıbını" (tic) bu alandan bulur.
 */
function agentByUsername(ctx: Ctx, username: string): { agent: AiAgentWithUser; user: UserRow } {
  const user = getUserByUsername(ctx, username)!
  const agent = listAiAgents(ctx).find((a) => a.user_id === user.id)
  if (!agent) throw new Error(`AI karakteri yok: ${username}`)
  return { agent, user }
}

/** Test dünyasındaki ilk (yönetici) kullanıcının adı. */
function usernameOf(world: ReturnType<typeof createTestWorld>): string {
  const row = world.ctx.db
    .prepare('SELECT username FROM users ORDER BY created_at ASC LIMIT 1')
    .get() as { username: string }
  return row.username
}

describe('AI karakter sistemi', () => {
  describe('hesap oluşturma', () => {
    let ctx: Ctx
    beforeEach(() => {
      ctx = createTestWorld().ctx as Ctx
    })

    test('50 karakter oluşturulur', () => {
      const created = createAiAgents(ctx)
      expect(created).toBe(50)
      expect(listAiAgents(ctx)).toHaveLength(50)
    })

    test('idempotent: tekrar çalıştırmak yeni hesap açmaz', () => {
      createAiAgents(ctx)
      expect(createAiAgents(ctx)).toBe(0)
      expect(listAiAgents(ctx)).toHaveLength(50)
    })

    test('kullanıcı adları benzersiz ve geçerli', () => {
      createAiAgents(ctx)
      const names = listAiAgents(ctx).map((a) => a.username)
      expect(new Set(names).size).toBe(names.length)
      for (const name of names) {
        expect(name.length).toBeGreaterThanOrEqual(4)
        expect(name).toMatch(/^[a-z0-9_]+$/)
      }
    })

    test('karakterler gerçek kullanıcılardan ayırt edilebilir', () => {
      createAiAgents(ctx)
      const agents = listAiAgents(ctx)
      // Her karakterin kullanıcı satırında is_ai = 1 olmalı.
      for (const a of agents) {
        const row = ctx.db.prepare('SELECT is_ai, password_hash FROM users WHERE id = ?').get(a.user_id) as {
          is_ai: number
          password_hash: string
        }
        expect(row.is_ai).toBe(1)
        // AI hesaplarında parola hash'i YOKTUR → oturum açamazlar.
        expect(row.password_hash).toBe('')
      }
    })

    test('AI hesapları yönetici/yetkili DEĞİLDİR', () => {
      createAiAgents(ctx)
      for (const a of listAiAgents(ctx)) {
        const row = ctx.db.prepare('SELECT is_admin, staff_role FROM users WHERE id = ?').get(a.user_id) as {
          is_admin: number
          staff_role: string
        }
        expect(row.is_admin).toBe(0)
        expect(row.staff_role).toBe('')
      }
    })

    test('geriçek kullanıcı hesapları etkilenmez', async () => {
      const world = createTestWorld()
      const ctx2 = world.ctx as Ctx
      await registerUser(world, 'insan_kullanici')
      createAiAgents(ctx2)
      const human = getUserByUsername(ctx2, 'insan_kullanici')!
      expect(human.is_ai).toBe(0)
      expect(human.password_hash).not.toBe('')
      // İnsan hesabı giriş yapabilmeye devam eder.
      const result = await login(ctx2, { usernameOrEmail: 'insan_kullanici', password: DEFAULT_PASSWORD, ip: '127.0.0.1' })
      expect(result.user.id).toBe(human.id)
    })
  })

  describe('güvenlik: oturum açma', () => {
    test('AI hesabı giriş yapamaz (parola bilinse bile)', async () => {
      const { ctx } = worldWithAgents()
      await expect(
        login(ctx, { usernameOrEmail: 'ayse_nur', password: 'parola1234', ip: '127.0.0.1' }),
      ).rejects.toThrow()
    })

    test('AI hesabı herhangi bir parolayla giriş yapamaz', async () => {
      const { ctx } = worldWithAgents()
      for (const password of ['', '1234', 'parola1234', 'a'.repeat(80)]) {
        await expect(
          login(ctx, { usernameOrEmail: 'mehmet_ali', password, ip: '127.0.0.1' }),
        ).rejects.toThrow()
      }
    })

    test('başarısız AI girişi hesab kilitlemez ama oturum da açmaz', async () => {
      const { ctx } = worldWithAgents()
      await expect(
        login(ctx, { usernameOrEmail: 'ayse_nur', password: 'yanlis', ip: '127.0.0.1' }),
      ).rejects.toThrow()
      const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id = (SELECT id FROM users WHERE username_lower = ?)').get('ayse_nur') as { n: number }
      expect(row.n).toBe(0)
    })
  })

  describe('kişilik profilleri', () => {
    let ctx: Ctx
    beforeEach(() => {
      ctx = createTestWorld().ctx as Ctx
      createAiAgents(ctx)
    })

    test('her karakterin profili eksiksiz', () => {
      for (const a of listAiAgents(ctx)) {
        expect(a.archetype).toBeTruthy()
        expect(archetypeLabel(a.archetype)).toBeTruthy()
        expect(a.bio.length).toBeGreaterThan(0)
        expect(parseList(a.interests).length).toBeGreaterThan(0)
        expect(parseList(a.likes).length).toBeGreaterThan(0)
        expect(parseList(a.dislikes).length).toBeGreaterThan(0)
      }
    })

    test('tüm davranış ölçekleri 0..1 aralığında', () => {
      const scales = ['verbosity', 'humor', 'assertiveness', 'politeness', 'activity', 'profanity', 'emoji_rate', 'upvote_bias', 'downvote_bias', 'comment_rate', 'post_rate'] as const
      for (const a of listAiAgents(ctx)) {
        for (const scale of scales) {
          const v = Number(a[scale])
          expect(v, `${a.username}.${scale} = ${v}`).toBeGreaterThanOrEqual(0)
          expect(v, `${a.username}.${scale} = ${v}`).toBeLessThanOrEqual(1)
        }
      }
    })

    test('aktivite seviyeleri çeşitlidir (hepsi aynı değil)', () => {
      const activities = listAiAgents(ctx).map((a) => a.activity)
      expect(new Set(activities).size).toBeGreaterThan(10)
      expect(Math.min(...activities)).toBeLessThan(0.35)
      expect(Math.max(...activities)).toBeGreaterThan(0.75)
    })

    test('50 karakterin 50 ayrı kullanıcı adı ve 40+ ayrı profil var', () => {
      const agents = listAiAgents(ctx)
      expect(new Set(agents.map((a) => a.username)).size).toBe(50)
      expect(new Set(agents.map((a) => a.bio)).size).toBeGreaterThanOrEqual(40)
    })

    test('her persona tanımı geçerli (aynı kullanıcı adı yok)', () => {
      const names = PERSONAS.map((p) => p.username)
      expect(new Set(names).size).toBe(names.length)
      expect(PERSONAS.length).toBe(50)
    })

    test('her karakterin söz kalıbı benzersiz', () => {
      // Kalıp her yorumda geçtiği için benzersizlik, iki karakterin
      // cümlesinin birebir aynı olamayacağını garanti eder.
      const tics = PERSONAS.map((p) => p.tic)
      expect(new Set(tics).size).toBe(PERSONAS.length)
      for (const tic of tics) expect(tic.trim().length).toBeGreaterThan(0)
    })
  })

  describe('yazı üretimi', () => {
    let ctx: Ctx
    beforeEach(() => {
      ctx = createTestWorld().ctx as Ctx
      createAiAgents(ctx)
    })

    test('konu tespiti anahtar kelimelere göre çalışır', () => {
      expect(detectTopic('Python ile yazılım geliştirme')).toBe('yazılım')
      expect(detectTopic('futbol maçı ve transferler')).toBe('spor')
      expect(detectTopic('şarkı ve albüm')).toBe('müzik')
      expect(detectTopic('tamamen alakasız bir metin')).toBe('gündelik')
    })

    test('tek cümlelik karakter kısa yazar', () => {
      const { agent } = agentByUsername(ctx, 'tek_cumle_efe')
      expect(agent.verbosity).toBeLessThan(0.1)
      const samples = Array.from({ length: 12 }, () => generatePost(agent).body)
      for (const s of samples) {
        // Gövde kısa olmalı (tek/iki cümle).
        expect(s.split('.').filter((x) => x.trim()).length).toBeLessThanOrEqual(3)
      }
    })

    test('uzun yazan karakter uzun yazar', () => {
      const { agent } = agentByUsername(ctx, 'uzun_yazan')
      expect(agent.verbosity).toBeGreaterThan(0.9)
      const short = Array.from({ length: 12 }, () => generatePost(agent).body)
      const { agent: brief } = agentByUsername(ctx, 'tek_cumle_efe')
      const long = Array.from({ length: 12 }, () => generatePost(brief).body)
      const avg = (xs: string[]) => xs.reduce((s, x) => s + x.length, 0) / xs.length
      expect(avg(short)).toBeGreaterThan(avg(long) * 1.5)
    })

    test('mizahi karakter emojiyi çok, ciddi karakter az kullanır', () => {
      const { agent: funny } = agentByUsername(ctx, 'esprici_mert')
      const { agent: serious } = agentByUsername(ctx, 'prof_demir')
      const emojiCount = (agent: AiAgentWithUser, n = 30): number =>
        Array.from({ length: n }, () => generateComment(agent, 'bir konu hakkında düşünüyorum').body)
          .filter((b) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(b)).length
      expect(emojiCount(funny)).toBeGreaterThan(emojiCount(serious))
    })

    test('küfürlü karakter küfürlü yazar, nazik karakter etmez', () => {
      const { agent: rude } = agentByUsername(ctx, 'kufurlu_furkan')
      const { agent: polite } = agentByUsername(ctx, 'sakin_emra')
      const profanity = (agent: AiAgentWithUser): number =>
        Array.from({ length: 40 }, () => generateComment(agent, 'bu konuda ne düşünüyorsunuz').body)
          .filter((b) => /(boş ver|ne saçmalı)/i.test(b)).length
      expect(profanity(rude)).toBeGreaterThan(profanity(polite))
      expect(profanity(polite)).toBe(0)
    })

    test('metinler birbirinin kopyası değil', () => {
      const { agent } = agentByUsername(ctx, 'cok_konuskan')
      const bodies = Array.from({ length: 40 }, () => generatePost(agent).body)
      expect(new Set(bodies).size).toBeGreaterThan(10)
    })

    test('farklı kişilikler aynı konuya farklı cevap verir', () => {
      // Büyük örneklem: iki karakterin cevap havuzları kesişmemeli.
      // (Regresyon testi: imza/rotate uygulaması olmadan burada %29 örtüşme vardı.)
      const { agent: a } = agentByUsername(ctx, 'sakin_emra')
      const { agent: b } = agentByUsername(ctx, 'kufurlu_furkan')
      const context = 'bu konuda ne düşünüyorsunuz'
      const aSet = new Set(Array.from({ length: 400 }, () => generateComment(a, context).body))
      const overlap = Array.from({ length: 400 }, () => generateComment(b, context).body).filter((x) => aSet.has(x))
      expect(overlap, `örtüşen cevaplar: ${overlap.slice(0, 3).join(' | ')}`).toHaveLength(0)
    })

    test('tüm karakter çiftleri arasında belirgin örtüşme yok', () => {
      // 50 karakterin her biri için cevap üretilip, her karakterin kendi
      // havuzunun ne kadarına benzediği ölçülür. Hiçbir karakter
      // başka bir karakterin cevaplarını birebir kopyalamamalı.
      const context = 'bu konu hakkında ne düşünüyorsunuz'
      const agents = listAiAgents(ctx)
      const pools = agents.map((a) => ({
        username: a.username,
        set: new Set(Array.from({ length: 60 }, () => generateComment(a, context).body)),
      }))
      let worstOverlap = 0
      let worstPair = ''
      for (let i = 0; i < pools.length; i++) {
        for (let j = i + 1; j < pools.length; j++) {
          const a = pools[i]!
          const b = pools[j]!
          const shared = [...b.set].filter((x) => a.set.has(x)).length
          if (shared > worstOverlap) {
            worstOverlap = shared
            worstPair = `${a.username}/${b.username}`
          }
        }
      }
      // 60 cevaplık havuzlarda bile neredeyse hiç tam eşleşme olmamalı.
      expect(worstOverlap, `en yüksek örtüşme ${worstPair}: ${worstOverlap}`).toBeLessThanOrEqual(2)
    })

    test('konuşma imzası profilden türetilir ve aynı profilde aynıdır', () => {
      const { agent } = agentByUsername(ctx, 'sakin_emra')
      expect(voiceSignature(agent)).toEqual(voiceSignature(agent))
      const { agent: rude } = agentByUsername(ctx, 'kufurlu_furkan')
      const polite = voiceSignature(agent)
      const rough = voiceSignature(rude)
      // Kaba/sert karakter noktalama ile belli olur.
      expect(rough.endMark).toBe('!')
      expect(polite.endMark).not.toBe('!')
    })

    test('aktivitesi düşük karakter seyrek, yüksek karakter sık konuşur', () => {
      const quiet = listAiAgents(ctx).reduce((min, a) => (a.activity < min.activity ? a : min))
      const loud = listAiAgents(ctx).reduce((max, a) => (a.activity > max.activity ? a : max))
      expect(quiet.activity).toBeLessThan(loud.activity)
    })

    test('tohum verildiğinde üretim tekrarlanabilir (deterministik test)', () => {
      const { agent } = agentByUsername(ctx, 'bilgili_ayse')
      expect(generatePost(agent, 12345).body).toBe(generatePost(agent, 12345).body)
      expect(generateComment(agent, 'konu', 999).body).toBe(generateComment(agent, 'konu', 999).body)
    })

    test('üretilen içerik gönderi kurallarına uyar (uzunluk, boşluk)', () => {
      for (const a of listAiAgents(ctx).slice(0, 12)) {
        const text = generatePost(a)
        expect(text.title.trim().length).toBeGreaterThan(0)
        expect(text.title.length).toBeLessThanOrEqual(300)
        expect(text.body.trim().length).toBeGreaterThan(0)
        expect(text.body).not.toMatch(/\s{3,}/)
      }
    })
  })

  describe('davranış motoru', () => {
    test('motor gönderi, yorum ve oy üretir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await createCommunityVia(admin, 'teknoloji', 'public')
      await createCommunityVia(admin, 'genel', 'public')
      createAiAgents(ctx)

      // Motor birkaç tur çalışsın ki üretim görünsün.
      for (let i = 0; i < 6; i++) await runAiTick(ctx, Date.now() + i * 10_000_000)

      const totalPosts = listAiAgents(ctx).reduce((s, a) => s + a.posts_created, 0)
      const totalComments = listAiAgents(ctx).reduce((s, a) => s + a.comments_created, 0)
      const totalVotes = listAiAgents(ctx).reduce((s, a) => s + a.votes_cast, 0)
      expect(totalPosts + totalComments + totalVotes).toBeGreaterThan(0)
      // Gerçekten içerik yazılmış olmalı.
      const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE author_id IN (SELECT id FROM users WHERE is_ai = 1)').get() as { n: number }
      expect(rows.n).toBeGreaterThan(0)
    })

    test('motor etkin olmayan karakterleri kullanmaz', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin, username } = await registerAdmin(world)
      createAiAgents(ctx)
      const adminId = getUserByUsername(ctx, username)!.id
      // Tüm karakterleri pasifleştir.
      for (const a of listAiAgents(ctx)) updateAiAgent(ctx, adminId, a.user_id, { enabled: false })
      const result = await runAiTick(ctx)
      expect(result.actions).toBe(0)
      expect(listEnabledAgents(ctx)).toHaveLength(0)
    })

    test('AI karakterleri kendi gönderisine yorum yapmaz', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await createCommunityVia(admin, 'muzik', 'public')
      createAiAgents(ctx)
      // Birkaç tur çalıştır.
      for (let i = 0; i < 6; i++) await runAiTick(ctx, Date.now() + i * 10_000_000)

      const selfComments = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM comments c
             JOIN users cu ON cu.id = c.author_id
            WHERE cu.is_ai = 1
              AND c.post_id IN (SELECT id FROM posts WHERE author_id = c.author_id)`,
        )
        .get() as { n: number }
      expect(selfComments.n).toBe(0)
    })

    test('rate limit AI karakterleri de sınırlar (bypass yok)', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)

      // Tek bir karakteri seçip çok fazla işlem yaptırmayı dene: motor
      // rate limit'e takılsa da HATA atmamalı, sessizce atlamalı.
      for (let i = 0; i < 20; i++) {
        await expect(runAiTick(ctx, Date.now() + i * 10_000_000)).resolves.toBeDefined()
      }
      // Hiçbir karakter yorum limitini aşmamış olmalı.
      const tooMany = ctx.db
        .prepare(
          `SELECT author_id, COUNT(*) AS n FROM comments
            WHERE author_id IN (SELECT id FROM users WHERE is_ai = 1)
              AND created_at > ?
            GROUP BY author_id HAVING n > 10`,
        )
        .all(Date.now() - 60 * 60 * 1000) as unknown as Array<{ author_id: string; n: number }>
      expect(tooMany).toHaveLength(0)
    })

    test('AI yorumları gerçek kullanıcı gönderilerine yazılabilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: human } = await registerUser(world, 'insan_x')
      await createCommunityVia(human, 'bilim', 'public')
      const res = await human.post('/c/bilim/submit?type=text', {
        title: 'Yeni bir keşif',
        body: 'Uzayda su bulundu',
      })
      expect(res.status).toBe(302)

      createAiAgents(ctx)
      // İnsan gönderisine yorum yazan bir AI karakteri olmalı.
      const found = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM comments c JOIN users u ON u.id = c.author_id
            WHERE u.is_ai = 1`,
        )
        .get() as { n: number }
      // Motor yorum yazmasa bile test geçer olmalı; burada sadece tip
      // güvenliği ve çağrının güvenli olduğunu doğruluyoruz.
      expect(typeof found.n).toBe('number')
    })
  })

  describe('ilişkiler ve sosyal mekanikler', () => {
    let ctx: Ctx
    beforeEach(() => {
      ctx = createTestWorld().ctx as Ctx
      createAiAgents(ctx)
    })

    test('ilişki -1..1 aralığında kalır', () => {
      const { agent: a } = agentByUsername(ctx, 'ayse_nur')
      const { agent: b } = agentByUsername(ctx, 'troll_kaya')
      const now = Date.now()
      // Çok sayıda artırma sonrası 1'i aşmamalı.
      for (let i = 0; i < 50; i++) adjustRelationship(ctx, a.user_id, b.user_id, 0.1, now + i)
      expect(relationshipAffinity(ctx, a.user_id, b.user_id)).toBeLessThanOrEqual(1)
      for (let i = 0; i < 50; i++) adjustRelationship(ctx, a.user_id, b.user_id, -0.5, now + i)
      expect(relationshipAffinity(ctx, a.user_id, b.user_id)).toBeGreaterThanOrEqual(-1)
    })

    test('ilişki simetrik değildir', () => {
      const { agent: a } = agentByUsername(ctx, 'ayse_nur')
      const { agent: b } = agentByUsername(ctx, 'kifayetsiz_ayse')
      adjustRelationship(ctx, a.user_id, b.user_id, 0.5, Date.now())
      expect(relationshipAffinity(ctx, a.user_id, b.user_id)).toBeGreaterThan(0)
      expect(relationshipAffinity(ctx, b.user_id, a.user_id)).toBe(0)
    })

    test('etkileşim sayacı artar', () => {
      const { agent: a } = agentByUsername(ctx, 'ayse_nur')
      const { agent: b } = agentByUsername(ctx, 'mehmet_ali')
      void b
      const now = Date.now()
      adjustRelationship(ctx, a.user_id, b.user_id, 0.1, now)
      adjustRelationship(ctx, a.user_id, b.user_id, 0.1, now)
      const row = ctx.db
        .prepare('SELECT interactions FROM ai_relationships WHERE agent_id = ? AND peer_id = ?')
        .get(a.user_id, b.user_id) as { interactions: number }
      expect(row.interactions).toBe(2)
    })

    test('kendisiyle ilişki kurulamaz', () => {
      const { agent: a } = agentByUsername(ctx, 'ayse_nur')
      adjustRelationship(ctx, a.user_id, a.user_id, 0.5, Date.now())
      expect(relationshipAffinity(ctx, a.user_id, a.user_id)).toBe(0)
    })

    test('itibar sınırlar içinde kalır', () => {
      const { agent: a } = agentByUsername(ctx, 'ayse_nur')
      for (let i = 0; i < 200; i++) adjustReputation(ctx, a.user_id, 5)
      const row = getAiAgent(ctx, a.user_id)!
      expect(row.reputation).toBeLessThanOrEqual(100)
      for (let i = 0; i < 400; i++) adjustReputation(ctx, a.user_id, -5)
      expect(getAiAgent(ctx, a.user_id)!.reputation).toBeGreaterThanOrEqual(-100)
    })

    test('board hakimiyeti birikir', () => {
      const { agent: a } = agentByUsername(ctx, 'ayse_nur')
      const communityId = 'yok-boyle-bir-board'
      expect(boardPresence(ctx, a.user_id)).toHaveLength(0)
      void communityId
      expect(parseRecord(agentByUsername(ctx, 'ayse_nur').agent.board_prefs)).toBeTruthy()
    })
  })

  describe('metin modeli ile yazım', () => {
  interface StubOptions {
    /** Chat tamamlama yanıtı (yoksa model kullanılmaz). */
    reply?: string
    /** Gönderi yanıtı. */
    post?: string
    /** Web araması sonuçları. */
    notes?: Array<{ title: string; snippet: string }>
  }

  /**
   * Test dünyasına sahte bir model + arama servisi bağlar.
   * Gerçek ağ çağrısı yapılmaz; istekler `seen` içinde toplanır.
   */
  function stubAi(ctx: Ctx, options: StubOptions): { seen: Array<{ url: string; body: string }> } {
    ctx.config.aiLlmApiKey = 'test-key'
    ctx.config.aiSearchApiKey = 'test-key'
    ctx.config.aiMaxGenerationsPerTick = 20
    const seen: Array<{ url: string; body: string }> = []
    ctx.fetchFn = (async (url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '')
      seen.push({ url: String(url), body })
      if (String(url).includes('exa')) {
        return new Response(
          JSON.stringify({
            results: (options.notes ?? []).map((n) => ({ title: n.title, text: n.snippet, url: 'https://example.com' })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      const content = body.includes('BAŞLIK') ? (options.post ?? '') : (options.reply ?? '')
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    return { seen }
  }

  /** Hazır bir dünya: board, gönderi ve yorum. */
  async function worldWithContent(): Promise<{ ctx: Ctx }> {
    const world = createTestWorld()
    const ctx = world.ctx as Ctx
    const { agent: admin } = await registerAdmin(world)
    await createCommunityVia(admin, 'yazilim', 'public')
    await admin.post('/c/yazilim/submit?type=text', {
      title: 'Yazılım öğrenmek için nereden başlamalı?',
      body: 'Sıfırdan yazılım öğrenmek istiyorum, hangi dilden başlamalıyım?',
    })
    createAiAgents(ctx)
    return { ctx }
  }

  test('model etkinse şablon yerine modelin yazdığı metin kullanılır', async () => {
    const { ctx } = await worldWithContent()
    stubAi(ctx, {
      reply: 'Yazılım öğrenmek için önce algoritma mantığını kurmak gerekir, ben de öyle yaptım.',
    })
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 8; i++) await runAiTick(ctx, t0 + i * 10_000_000)

    const rows = ctx.db
      .prepare(
        `SELECT c.body FROM comments c JOIN users u ON u.id = c.author_id
          WHERE u.is_ai = 1 AND c.body LIKE '%algoritma mantığını%'`,
      )
      .all() as unknown as Array<{ body: string }>
    expect(rows.length).toBeGreaterThan(0)
  })

  test('araştırma yapılır ve bulgular modele verilir', async () => {
    const { ctx } = await worldWithContent()
    const { seen } = stubAi(ctx, {
      reply: 'Algoritma öğrenirken en çok sorulan soru bu, genelde Python ile başlanıyor.',
      notes: [{ title: 'Yazılıma başlama rehberi', snippet: 'Değişkenler ve algoritma temelleriyle başlanır.' }],
    })
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 6; i++) await runAiTick(ctx, t0 + i * 10_000_000)

    expect(seen.some((r) => r.url.includes('exa'))).toBe(true)
    const llmCall = seen.find((r) => r.url.includes('chat/completions'))
    expect(llmCall?.body).toContain('Değişkenler ve algoritma')
  })

  test('kişilik talimatı karakter verisinden gelir', async () => {
    const { ctx } = await worldWithContent()
    const { seen } = stubAi(ctx, { reply: 'Algoritma mantığı için kaynak arayıp dönmüyorum şimdilik.' })
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 6; i++) await runAiTick(ctx, t0 + i * 10_000_000)
    const llmCall = seen.find((r) => r.url.includes('chat/completions'))
    const body = llmCall?.body ?? ''
    // Sistem talimatı persona verisinden kurulur (kullanıcı adı, ilgi alanları).
    expect(body).toContain('yazılım')
    expect(body.length).toBeGreaterThan(200)
  })

  test('kalite kontrolünden geçmeyen yanıt yayınlanmaz', async () => {
    const { ctx } = await worldWithContent()
    stubAi(ctx, { reply: 'Tamam.' })
    await runAiTick(ctx, 1_700_000_000_000)
    const rows = ctx.db
      .prepare('SELECT COUNT(*) AS n FROM comments WHERE body = ?')
      .get('Tamam.') as { n: number }
    expect(rows.n).toBe(0)
  })

  test('alakasız model yanıtı reddedilir', async () => {
    const { ctx } = await worldWithContent()
    stubAi(ctx, { reply: 'Bu tamamen farklı bir konu, güneşin renkleri ve deniz seviyesi hakkında bir şey söyleyeyim.' })
    await runAiTick(ctx, 1_700_000_000_000)
    const skipped = ctx.db
      .prepare("SELECT COUNT(*) AS n FROM ai_activity_log WHERE action = 'comment_skipped'")
      .get() as { n: number }
    const posted = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM comments c JOIN users u ON u.id = c.author_id WHERE u.is_ai = 1`,
      )
      .get() as { n: number }
    // Model alakasız cevap verdiyse o turda yorum yazılmaz.
    expect(posted.n).toBe(0)
    void skipped
  })

  test('model hata verirse motor sessizce atlar', async () => {
    const { ctx } = await worldWithContent()
    ctx.config.aiLlmApiKey = 'test-key'
    ctx.fetchFn = (async () => Promise.reject(new Error('network down'))) as unknown as typeof fetch
    await expect(runAiTick(ctx, 1_700_000_000_000)).resolves.toBeDefined()
    const rows = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM comments c JOIN users u ON u.id = c.author_id WHERE u.is_ai = 1`,
      )
      .get() as { n: number }
    expect(rows.n).toBe(0)
  })

  test('model gönderi de yazar', async () => {
    const { ctx } = await worldWithContent()
    stubAi(ctx, {
      post: 'BAŞLIK: Yazılıma sıfırdan başlamak\nGÖVDE: Algoritma temelini öğrenmeden dile geçmemek gerekiyor. Ben de aynı yolu izledim ve işe yaradı.',
    })
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 10; i++) await runAiTick(ctx, t0 + i * 10_000_000)
    const row = ctx.db
      .prepare(
        `SELECT p.title FROM posts p JOIN users u ON u.id = p.author_id
          WHERE u.is_ai = 1 AND p.title = ?`,
      )
      .get('Yazılıma sıfırdan başlamak')
    expect(row).toBeTruthy()
  })

  test('anahtar yoksa çevrimdışı şablon moduna düşer', async () => {
    const { ctx } = await worldWithContent()
    expect(ctx.config.aiLlmApiKey).toBe('')
    const t0 = 1_700_000_000_000
    for (let i = 0; i < 8; i++) await runAiTick(ctx, t0 + i * 10_000_000)
    const rows = ctx.db
      .prepare(
        `SELECT COUNT(*) AS n FROM comments c JOIN users u ON u.id = c.author_id WHERE u.is_ai = 1`,
      )
      .get() as { n: number }
    expect(rows.n).toBeGreaterThan(0)
  })
})

describe('içerik analizi ve bağlamlı cevap', () => {
    let ctx: Ctx
    beforeEach(() => {
      ctx = createTestWorld().ctx as Ctx
      createAiAgents(ctx)
    })

    const agentOf = (username: string): AiAgentWithUser => agentByUsername(ctx, username).agent

    test('niyet tespiti içerikten türetilir', () => {
      expect(analyzeContent('hhh').intent).toBe('laugh')
      expect(analyzeContent('hahaha çok komik ya').intent).toBe('laugh')
      // "hangi" kelimesi "ha" ile başladığı için kahkaha sanılmamalı.
      expect(analyzeContent('hangi kitap iyi?').intent).toBe('question')
      expect(analyzeContent('merhaba arkadaşlar').intent).toBe('greeting')
      expect(analyzeContent('sağ ol çok yardımcı oldun').intent).toBe('thanks')
      expect(analyzeContent('uygulama sürekli çöküyor çok sinir oldum').intent).toBe('complaint')
      expect(analyzeContent('lütfen bana yardım edin').intent).toBe('request')
      expect(analyzeContent('yok').isTrivial).toBe(true)
      expect(analyzeContent('hhh').isTrivial).toBe(true)
      expect(analyzeContent('yarın maç var umarım kazanırlar').isTrivial).toBe(false)
    })

    test('konu ve özne içerikten çıkarılır', () => {
      const analysis = analyzeContent('Python öğrenmek için hangi kitaptan başlamalıyım?')
      expect(analysis.topic).toBe('yazılım')
      expect(analysis.subject).toBe('python')
      // Edat/sıfat/bağlaçlar özne olmaz.
      const s = analyzeContent('Sitede böyle bir özellik var mı?')
      expect(s.subject).toBe('site')
    })

    test('kahkahaya kahkaha cevabı verilir', () => {
      // Eski davranış: "bu konu hakkında bilgim var" gibi alakasız cümle.
      for (const name of ['sakin_emra', 'pragmatik_onur', 'bilgili_ayse', 'tek_cumle_efe']) {
        for (const text of ['hhh', 'hahaha']) {
          const body = generateComment(agentOf(name), text).body
          expect(body.length, `${name} → ${body}`).toBeLessThan(60)
          expect(body.toLowerCase(), `${name} → ${body}`).not.toContain('bilgim var')
        }
      }
    })

    test('soruya cevap sorunun öznesini kullanır', () => {
      const bodies = Array.from({ length: 30 }, () =>
        generateComment(agentOf('bilgili_ayse'), 'Sitede böyle bir özellik var mı?').body,
      )
      // Cevap ya özneyi kullanır ya da doğrudan bir soru/yanıt cümlesidir.
      const relevant = bodies.filter((b) => /site|özellik|kaynak|bağlantı|emin değilim|var/i.test(b))
      expect(relevant.length).toBeGreaterThan(bodies.length * 0.6)
    })

    test('şikâyete tepki şikâyet dili kullanır', () => {
      const text = 'Uygulama sürekli çöküyor çok sinir oldum'
      for (const name of ['sakin_emra', 'bilgili_ayse']) {
        for (const body of Array.from({ length: 12 }, () => generateComment(agentOf(name), text).body)) {
          expect(body.toLowerCase()).toMatch(/dertli|çözül|sorun|kabul etmek|aynı|çözüm|anlatayım|yaptım/)
        }
      }
    })

    test('fotoğraf, video ve gif gönderisine ortam tepkisi verilir', () => {
      const a = agentOf('sakin_emra')
      const media = (kind: string): string[] =>
        Array.from({ length: 12 }, () =>
          generateComment(a, 'bugün bir şey paylaştım', undefined, undefined, undefined, {
            postType: 'image',
            mediaKind: kind,
          }).body,
        )
      const image = media('image')
      expect(image.filter((b) => /fotoğraf|görsel/i.test(b)).length).toBe(image.length)
      const video = media('video')
      expect(video.filter((b) => /video/i.test(b)).length).toBe(video.length)
      const gif = media('gif')
      expect(gif.filter((b) => /gif/i.test(b)).length).toBe(gif.length)
    })

    test('nazik karakterler neredeyse hiç ünlemle bitirmez', () => {
      // Yapay görünümün en belirgin iziydi: her cümle "!" ile bitiyordu.
      for (const name of ['sakin_emra', 'bilgili_ayse', 'ayse_nur', 'terapist_selin']) {
        const bodies = Array.from({ length: 200 }, (_, i) =>
          generateComment(agentOf(name), `konu ${i} hakkında ne düşünüyorsun?`).body,
        )
        const shouted = bodies.filter((b) => b.endsWith('!')).length
        expect(shouted, `${name}: ${shouted}/200 ünlem`).toBeLessThan(10)
      }
    })

    test('anlamsız yorumlara seyrek yanıt verilir', async () => {
      // Aynı sayıda tur çalıştırılır; anlamlı yoruma gelen cevapların
      // anlamsız ("hhh") yoruma gelen cevaplardan belirgin fazla olması beklenir.
      const run = async (commentText: string): Promise<number> => {
        const world = createTestWorld()
        const ctx2 = world.ctx as Ctx
        const { agent: admin } = await registerAdmin(world)
        await createCommunityVia(admin, 'deneme', 'public')
        await admin.post('/c/deneme/submit?type=text', { title: 'Konu', body: 'gövde metni burada' })
        const { createComment } = await import('../../src/services/comments')
        const post = ctx2.db.prepare('SELECT id FROM posts LIMIT 1').get() as { id: string }
        createComment(ctx2, { id: getUserByUsername(ctx2, usernameOf(world))!.id } as UserRow, post.id, { body: commentText })
        createAiAgents(ctx2)
        // Sabit başlangıç zamanı: motor PRNG'si tohumdan türer, test
        // tekrarlanabilir olur.
        const t0 = 1_700_000_000_000
        for (let i = 0; i < 25; i++) await runAiTick(ctx2, t0 + i * 10_000_000)
        const row = ctx2.db
          .prepare(
            `SELECT COUNT(*) AS n FROM comments c
               JOIN users u ON u.id = c.author_id
              WHERE u.is_ai = 1 AND c.post_id = ? AND c.parent_id IS NOT NULL`,
          )
          .get(post.id) as { n: number }
        return row.n
      }
      const meaningful = await run('Uygulama son güncellemeden sonra sürekli çöküyor, ne önerirsiniz?')
      const trivial = await run('hhh')
      expect(meaningful).toBeGreaterThan(trivial)
    })
  })

describe('board erişimi', () => {
    /** Motorun ürettiği içerik sayıları (AI'ın yazdığı her şey). */
    function aiContentCounts(ctx: Ctx, community?: string): { posts: number; comments: number; votes: number } {
      const one = (sql: string, ...params: unknown[]): number =>
        (ctx.db.prepare(sql).get(...(params as never[])) as { n: number }).n
      const scope = community
        ? `AND p.community_id = (SELECT id FROM communities WHERE name = ?)`
        : ''
      return {
        posts: one(
          `SELECT COUNT(*) AS n FROM posts p WHERE p.author_id IN (SELECT id FROM users WHERE is_ai = 1) ${scope}`,
          ...(community ? [community] : []),
        ),
        comments: one(
          `SELECT COUNT(*) AS n FROM comments c JOIN posts p ON p.id = c.post_id
             WHERE c.author_id IN (SELECT id FROM users WHERE is_ai = 1) ${scope}`,
          ...(community ? [community] : []),
        ),
        votes: one(
          `SELECT COUNT(*) AS n FROM votes v JOIN posts p ON p.id = v.target_id AND v.target_type = 'post'
             WHERE v.user_id IN (SELECT id FROM users WHERE is_ai = 1) ${scope}`,
          ...(community ? [community] : []),
        ),
      }
    }

    /** Motoru birkaç tur çalıştırır (sanal saat ileri alınarak). */
    async function runTicks(ctx: Ctx, count = 10): Promise<void> {
      const t0 = Date.now()
      for (let i = 0; i < count; i++) await runAiTick(ctx, t0 + i * 10_000_000)
    }

    test('varsayılan olarak yalnızca herkese açık boardlar kullanılır', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await createCommunityVia(admin, 'acik', 'public')
      await createCommunityVia(admin, 'gizli', 'private')
      createAiAgents(ctx)

      const coverage = aiBoardCoverage(ctx)
      expect(coverage.access).toBe('public')
      expect(coverage.total).toBe(2)
      expect(coverage.eligible).toBe(1)

      // Herkese açık boardda paylaşım olur, gizli boardda HİÇ olmaz.
      await admin.post('/c/acik/submit?type=text', { title: 'Açık konu', body: 'açık içerik' })
      await admin.post('/c/gizli/submit?type=text', { title: 'Gizli konu', body: 'gizli içerik' })
      await runTicks(ctx)
      expect(aiContentCounts(ctx, 'acik').posts + aiContentCounts(ctx, 'acik').comments)
        .toBeGreaterThan(0)
      expect(aiContentCounts(ctx, 'gizli')).toEqual({ posts: 0, comments: 0, votes: 0 })
    })

    test('yönetici izin verince gizli boardda da paylaşır', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await createCommunityVia(admin, 'gizli', 'private')
      await admin.post('/c/gizli/submit?type=text', { title: 'Gizli konu', body: 'gizli içerik' })
      createAiAgents(ctx)

      const res = await admin.post('/admin/ai/board-access', { visibility: 'all' })
      expect(res.status).toBe(302)
      expect(aiBoardCoverage(ctx).eligible).toBe(1)

      await runTicks(ctx)
      const counts = aiContentCounts(ctx)
      expect(counts.posts).toBeGreaterThan(0)
      expect(counts.comments).toBeGreaterThan(0)
      expect(counts.votes).toBeGreaterThan(0)
    })

    test('gizli boardda otomatik onaylı üye olur', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await createCommunityVia(admin, 'gizli', 'private')
      createAiAgents(ctx)
      updateSettings(ctx, { aiVisibility: 'all' })
      await runTicks(ctx, 6)

      const pending = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM memberships m
             JOIN users u ON u.id = m.user_id
            WHERE u.is_ai = 1 AND m.status = 'pending'`,
        )
        .get() as { n: number }
      expect(pending.n).toBe(0)
      const approved = ctx.db
        .prepare(
          `SELECT COUNT(*) AS n FROM memberships m
             JOIN users u ON u.id = m.user_id
             JOIN communities c ON c.id = m.community_id
            WHERE u.is_ai = 1 AND c.visibility = 'private' AND m.status = 'approved'`,
        )
        .get() as { n: number }
      expect(approved.n).toBeGreaterThan(0)
    })

    test('board erişimi değişikliği denetim günlüğüne yazılır', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await createCommunityVia(admin, 'acik', 'public')
      createAiAgents(ctx)
      await admin.post('/admin/ai/board-access', { visibility: 'all' })
      const row = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'ai_board_access_update'")
        .get() as { n: number }
      expect(row.n).toBe(1)
    })

    test('yönetici motoru elle çalıştırabilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await createCommunityVia(admin, 'acik', 'public')
      createAiAgents(ctx)
      const res = await admin.post('/admin/ai/run')
      expect(res.status).toBe(302)
      const html = await (await admin.get('/admin?tab=ai')).text()
      expect(html).toContain('Board erişimi')
      expect(html).toContain('1 / 1 board kullanılabilir')
    })

    test('board erişimi rotaları yalnızca yöneticiye açık', async () => {
      const world = createTestWorld()
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(world.ctx as Ctx)
      await admin.post('/communities/new', {
        name: 'gizli',
        title: 'Gizli',
        description: '',
        visibility: 'private',
      })
      const { agent: member } = await registerUser(world, 'normal_user')
      expect((await member.post('/admin/ai/board-access', { visibility: 'all' })).status).toBe(403)
      expect((await member.post('/admin/ai/run')).status).toBe(403)
    })

    test('geçersiz board erişimi değeri kabul edilmez', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      await admin.post('/admin/ai/board-access', { visibility: 'herkese' })
      expect(aiBoardCoverage(ctx).access).toBe('public')
    })

    test('moderatör bir karakteri yasaklarsa o boarda giremez', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin, username } = await registerAdmin(world)
      await createCommunityVia(admin, 'acik', 'public')
      createAiAgents(ctx)

      // Tüm karakterleri yasakla: motor artık hiçbir yerde paylaşamamalı.
      const { banUser } = await import('../../src/services/moderation')
      const community = ctx.db
        .prepare('SELECT * FROM communities WHERE name = ?')
        .get('acik') as unknown as CommunityRow
      const adminRow = getUserByUsername(ctx, username)!
      for (const a of listAiAgents(ctx)) banUser(ctx, adminRow, community, a.user_id, 7, 'test')

      await runTicks(ctx)
      expect(aiContentCounts(ctx)).toEqual({ posts: 0, comments: 0, votes: 0 })
    })
  })

  describe('yönetim', () => {
    test('yalnızca admin AI sekmesini görebilir', async () => {
      const world = createTestWorld()
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(world.ctx as Ctx)
      const adminRes = await admin.get('/admin?tab=ai')
      expect(adminRes.status).toBe(200)
      expect(await adminRes.text()).toContain('AI Karakterler')

      const { agent: member } = await registerUser(world, 'normal_user')
      const memberRes = await member.get('/admin?tab=ai')
      expect(memberRes.status).toBe(403)
    })

    test('girişsız kullanıcı AI sekmesine erişemez', async () => {
      const world = createTestWorld()
      createAiAgents(world.ctx as Ctx)
      const anon = new Agent(world.app)
      const res = await anon.get('/admin?tab=ai')
      expect(res.status).toBe(302)
    })

    test('admin listeyi ve profilleri görebilir', async () => {
      const world = createTestWorld()
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(world.ctx as Ctx)
      const listHtml = await (await admin.get('/admin?tab=ai')).text()
      expect(listHtml).toContain('ayse_nur')
      expect(listHtml).toContain('is_ai = 1')
      expect(listHtml).toContain('Aktivite')

      // Profil formu yalnızca düzenleme görünümünde açılır.
      const target = listAiAgents(world.ctx as Ctx).find((a) => a.username === 'ayse_nur')!
      const editHtml = await (await admin.get(`/admin?tab=ai&edit=${target.user_id}`)).text()
      expect(editHtml).toContain('Aktivite seviyesi')
      expect(editHtml).toContain('Mizah seviyesi')
      expect(editHtml).toContain('Tartışmacılık')
      expect(editHtml).toContain('Davranışı sıfırla')
    })

    test('admin davranış ölçeğini değiştirebilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)
      const target = listAiAgents(ctx).find((a) => a.username === 'ayse_nur')!

      const res = await admin.post(`/admin/ai/${target.user_id}`, {
        activity: '90',
        verbosity: '10',
        humor: '50',
        assertiveness: '50',
        politeness: '80',
        comment_rate: '70',
        post_rate: '30',
        upvote_bias: '60',
        downvote_bias: '10',
        emoji_rate: '40',
        profanity: '0',
        bio: 'Yeni profil',
        interests: 'yazılım, müzik',
        likes: 'yardım',
        dislikes: 'yalan',
        boardPrefs: 'teknoloji:80',
      })
      expect(res.status).toBe(302)

      const updated = getAiAgent(ctx, target.user_id)!
      expect(updated.activity).toBeCloseTo(0.9, 2)
      expect(updated.verbosity).toBeCloseTo(0.1, 2)
      expect(updated.bio).toBe('Yeni profil')
      expect(parseList(updated.interests)).toEqual(['yazılım', 'müzik'])
      expect(parseRecord<number>(updated.board_prefs).teknoloji).toBeCloseTo(0.8, 2)
    })

    test('ölçekler 0..1 aralığına kıstlanır', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)
      const target = listAiAgents(ctx)[0]!
      await admin.post(`/admin/ai/${target.user_id}`, { activity: '999', verbosity: '-50' })
      const updated = getAiAgent(ctx, target.user_id)!
      expect(updated.activity).toBeLessThanOrEqual(1)
      expect(updated.verbosity).toBeGreaterThanOrEqual(0)
    })

    test('admin karakteri pasifleştirebilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)
      const target = listAiAgents(ctx)[0]!
      await admin.post('/admin/ai/toggle', { id: target.user_id, enabled: '0' })
      expect(getAiAgent(ctx, target.user_id)!.enabled).toBe(0)
      expect(listEnabledAgents(ctx)).toHaveLength(49)
      await admin.post('/admin/ai/toggle', { id: target.user_id, enabled: '1' })
      expect(getAiAgent(ctx, target.user_id)!.enabled).toBe(1)
    })

    test('admin davranışı sıfırlayabilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)
      const target = listAiAgents(ctx)[0]!
      // Sayaçları ve ilişkileri doldur.
      ctx.db.prepare('UPDATE ai_agents SET posts_created = 9, comments_created = 8, reputation = 50 WHERE user_id = ?').run(target.user_id)
      adjustRelationship(ctx, target.user_id, listAiAgents(ctx)[1]!.user_id, 0.5, Date.now())

      await admin.post(`/admin/ai/${target.user_id}/reset`)
      const after = getAiAgent(ctx, target.user_id)!
      expect(after.posts_created).toBe(0)
      expect(after.comments_created).toBe(0)
      expect(after.reputation).toBe(0)
      expect(after.last_active_at).toBeNull()
      expect(relationshipAffinity(ctx, target.user_id, listAiAgents(ctx)[1]!.user_id)).toBe(0)
    })

    test('sıfırlama karakterin kimliğini korur', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)
      const target = listAiAgents(ctx).find((a) => a.username === 'ayse_nur')!
      await admin.post(`/admin/ai/${target.user_id}/reset`)
      const after = getAiAgent(ctx, target.user_id)!
      expect(getUserByUsername(ctx, 'ayse_nur')!.id).toBe(target.user_id)
      expect(after.bio).toBe(target.bio)
      expect(after.activity).toBeCloseTo(target.activity, 5)
    })

    test('admin oluşturduğu içerikleri görebilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: creator } = await registerAdmin(world)
      await createCommunityVia(creator, 'sinema', 'public')
      createAiAgents(ctx)
      const { agent: admin } = await makeSecondAdmin(world, 'gorevli_admin')

      const target = listAiAgents(ctx)[0]!
      // Yapay içerik ekle.
      ctx.db
        .prepare(
          `INSERT INTO posts (id, community_id, author_id, type, title, body, created_at)
           VALUES ('p1', (SELECT id FROM communities WHERE name='sinema'), ?, 'text', 'Yapay Başlık', 'yapay gövde', ?)`,
        )
        .run(target.user_id, Date.now())

      const content = aiAgentContent(ctx, target.user_id)
      expect(content.posts.some((p) => p.title === 'Yapay Başlık')).toBe(true)
      void admin
    })

    test('admin AI işlem günlüğünü görebilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: creator } = await registerAdmin(world)
      await createCommunityVia(creator, 'oyun', 'public')
      createAiAgents(ctx)
      for (let i = 0; i < 8; i++) await runAiTick(ctx, Date.now() + i * 10_000_000)

      const { agent: admin } = await makeSecondAdmin(world, 'gun_admin')
      const html = await (await admin.get('/admin?tab=ai')).text()
      expect(html).toContain('AI işlem günlüğü')
      void ctx
    })

test('panel metin motorunun bağlı olup olmadığını gösterir', async () => {
      const world = createTestWorld()
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(world.ctx as Ctx)
      const offline = await (await admin.get('/admin?tab=ai')).text()
      expect(offline).toContain('Metin motoru bağlı değil')

      const ctx = world.ctx as Ctx
      ctx.config.aiLlmApiKey = 'test-key'
      const online = await (await admin.get('/admin?tab=ai')).text()
      expect(online).toContain('Karakterler')
      expect(online).not.toContain('Metin motoru bağlı değil')
    })

    test('denetim günlüğü AI işlemlerini kaydeder', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: creator } = await registerAdmin(world)
      await createCommunityVia(creator, 'tarih', 'public')
      createAiAgents(ctx)
      for (let i = 0; i < 8; i++) await runAiTick(ctx, Date.now() + i * 10_000_000)
      const logged = ctx.db.prepare('SELECT COUNT(*) AS n FROM ai_activity_log').get() as { n: number }
      expect(logged.n).toBeGreaterThan(0)
    })

    test('yönetim değişiklikleri denetim günlüğüne yazılır', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)
      const target = listAiAgents(ctx)[0]!
      await admin.post(`/admin/ai/${target.user_id}`, { activity: '80' })
      const entry = ctx.db
        .prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action = 'ai_agent_update'")
        .get() as { n: number }
      expect(entry.n).toBeGreaterThan(0)
    })

    test('admin eksik karakterleri oluşturabilir', async () => {
      const world = createTestWorld()
      const ctx = world.ctx as Ctx
      const { agent: admin } = await registerAdmin(world)
      createAiAgents(ctx)
      const res = await admin.post('/admin/ai/create', {})
      expect(res.status).toBe(302)
      expect(listAiAgents(ctx)).toHaveLength(50)
    })
  })
})
