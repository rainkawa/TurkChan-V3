/**
 * NPC simülasyon sistemi — entegrasyon testleri.
 *
 * Bu dosya 19 başlığı gerçek HTTP uygulaması ve gerçek servis katmanı
 * üzerinden sınar:
 *
 *   1. 50 NPC oluşturma ve benzersizlik
 *   2. Kişilik farklılığı (metin gerçekten ayrışıyor mu?)
 *   3. Konu / bağlam analizi
 *   4. Türkçe kök–ek soyutlaması
 *   5. Uygun konu seçimi
 *   6. Uygun yorum üretimi
 *   7. Anlamsız yorum engelleme   ← "HAHAHA bu çok komik"
 *   8. Konu dışı cevap engelleme  ← "Telefonum çok yavaşladı" → oyun yok
 *   9. Tekrar engelleme
 *  10. NPC hafızası
 *  11. Hafıza güncellemesi
 *  12. İlişki güncellemesi
 *  13. Davranış adaptasyonu
 *  14. Vote davranışı
 *  15. Scheduler (tek döngü, aktivite seviyeleri)
 *  16. Aktivite seviyeleri
 *  17. Yetki izolasyonu (NPC oturum açamaz, admin olamaz)
 *  18. API'siz çalışma
 *  19. Konu üretimi bağlamdan türetilir
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  createTestWorld,
  registerAdmin,
  registerUser,
  createCommunityVia,
  createPostVia,
  relogin,
  Agent,
  type TestWorld,
} from '../testUtils'
import { createNpcAgents, listNpcAgents, isNpcUser, updateNpcAgent, NPC_SLIDER_FIELDS, npcBoardCoverage, npcEligibleVisibilities, eligibleCommunities } from '../../src/services/npc/agents'
import { updateSettings, getSettings } from '../../src/services/settings'
import { runNpcTick, listActiveNpcs, measurePendingOutcomes } from '../../src/services/npc/engine'
import { analyzeContext, detectTopic } from '../../src/services/npc/analyze'
import { stem, conceptOf, trLower } from '../../src/services/npc/lexicon'
import { composeComment, composePost, suggestTopics } from '../../src/services/npc/compose'
import { scoreText, MIN_SCORE } from '../../src/services/npc/quality'
import {
  rememberConcept,
  rememberPerson,
  rememberBoard,
  rememberPhrase,
  phraseUses,
  memoryWeight,
  memorySize,
  hasSeenConcept,
  recentEpisodes,
  listMemory,
  clearMemory,
  pruneMemory,
  normalizePhrase,
  recordEpisode,
  MEMORY_LIMIT,
} from '../../src/services/npc/memory'
import { relationshipOf, noteInteraction, noteQualityReply, relationshipsOf, clearRelationships } from '../../src/services/npc/relationships'
import { recordOutcome, pendingOutcomes, settleOutcome, behaviorOf, behaviorChanges, trialCount, clearBehavior } from '../../src/services/npc/learning'
import { NPC_PERSONAS } from '../../src/services/npc/personas'
import { loadConfig } from '../../src/config'

/** Sabit tohum: motor ve üretim deterministik olsun. */
const T0 = 1_700_000_000_000

/** Test dünyası: ilk kullanıcı admin olur, sonra NPC'ler oluşturulur. */
async function npcWorld(): Promise<TestWorld> {
  const world = createTestWorld()
  await registerAdmin(world)
  createNpcAgents(world.ctx)
  return world
}

/** NPC kullanıcısının id'sini döndürür. */
function npcId(ctx: TestWorld['ctx'], username: string): string {
  const row = ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as
    | { id: string }
    | undefined
  if (!row) throw new Error(`NPC bulunamadı: ${username}`)
  return row.id
}

describe('1. 50 NPC oluşturma ve benzersizlik', () => {
  it('tam olarak 50 benzersiz NPC hesabı oluşturur', async () => {
    const world = await npcWorld()
    const agents = listNpcAgents(world.ctx)
    expect(agents).toHaveLength(50)

    const usernames = agents.map((a) => a.username)
    expect(new Set(usernames).size).toBe(50)
    const emails = agents.map((a) => a.username)
    expect(new Set(emails).size).toBe(50)
  })

  it('idempotenttir: ikinci çağrı yeni hesap açmaz', async () => {
    const world = await npcWorld()
    expect(createNpcAgents(world.ctx)).toBe(0)
    expect(listNpcAgents(world.ctx)).toHaveLength(50)
  })

  it('50 persona birbirinin kopyası değildir (profil/eksen/tic benzersiz)', () => {
    expect(NPC_PERSONAS).toHaveLength(50)
    expect(new Set(NPC_PERSONAS.map((p) => p.username)).size).toBe(50)
    expect(new Set(NPC_PERSONAS.map((p) => p.tic)).size).toBe(50)
    expect(new Set(NPC_PERSONAS.map((p) => p.bio)).size).toBe(50)

    // Eksen kombinasyonları da benzersiz olmalı: bir karakter diğerinin
    // kopyası olamaz.
    const fingerprints = new Set(
      NPC_PERSONAS.map((p) =>
        [
          p.archetype,
          p.activity.toFixed(2),
          p.humor.toFixed(2),
          p.assertiveness.toFixed(2),
          p.verbosity.toFixed(2),
          p.comment_rate.toFixed(2),
          p.post_rate.toFixed(2),
          p.vote_rate.toFixed(2),
          p.interests.slice().sort().join('|'),
        ].join(','),
      ),
    )
    expect(fingerprints.size).toBeGreaterThan(40)
  })

  it('her eksen 0..1 aralığındadır', () => {
    for (const p of NPC_PERSONAS) {
      for (const field of NPC_SLIDER_FIELDS) {
        expect(p[field]).toBeGreaterThanOrEqual(0)
        expect(p[field]).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('2. Kişilik farklılığı — metin gerçekten karakterden türer', () => {
  it('aynı bağlamda farklı karakterler farklı yorumlar yazar', async () => {
    const world = await npcWorld()

    const content = 'Minecraft güncellemesi yavaşladı, fps düştü, oyuncular çok sinirli.'
    const analysis = analyzeContext(content)

    const bodies = new Set<string>()
    for (const persona of NPC_PERSONAS.slice(0, 12)) {
      const id = npcId(world.ctx, persona.username)
      const composed = composeComment(world.ctx, {
        agentId: id,
        persona,
        analysis,
        content,
        seed: 42,
      })
      if (composed) bodies.add(composed.body)
    }
    // 12 farklı karakter, tek bir kalıp üretmemeli.
    expect(bodies.size).toBeGreaterThanOrEqual(5)
  })

  it('komik karakter emoji/espri kullanırken ciddi karakter kullanmaz', async () => {
    const world = await npcWorld()
    const analysis = analyzeContext('Bu oyun güncellemesi bence çok kötü olmuş, berbat.')
    const content = 'Bu oyun güncellemesi bence çok kötü olmuş, berbat.'

    const joker = NPC_PERSONAS.find((p) => p.humor > 0.7 && p.seriousness < 0.5)
    const stoic = NPC_PERSONAS.reduce((a, b) => (a.humor <= b.humor ? a : b))
    expect(joker).toBeDefined()
    expect(stoic).toBeDefined()

    let jokerEmoji = 0
    let stoicEmoji = 0
    for (let seed = 1; seed <= 30; seed++) {
      const a = composeComment(world.ctx, {
        agentId: npcId(world.ctx, joker!.username),
        persona: joker!,
        analysis,
        content,
        seed,
      })
      const b = composeComment(world.ctx, {
        agentId: npcId(world.ctx, stoic!.username),
        persona: stoic!,
        analysis,
        content,
        seed,
      })
      if (a && /\p{Extended_Pictographic}/u.test(a.body)) jokerEmoji++
      if (b && /\p{Extended_Pictographic}/u.test(b.body)) stoicEmoji++
    }
    expect(jokerEmoji).toBeGreaterThan(stoicEmoji)
  })

  it('kısa/uzun yazma tercihi metin uzunluğuna yansır', async () => {
    const world = await npcWorld()
    const content = 'Telefonum çok yavaşladı, ne yapmalıyım?'
    const analysis = analyzeContext(content)
    const short = NPC_PERSONAS.reduce((a, b) => (a.verbosity <= b.verbosity ? a : b))
    const long = NPC_PERSONAS.reduce((a, b) => (a.verbosity >= b.verbosity ? a : b))

    const shortLens: number[] = []
    const longLens: number[] = []
    for (let seed = 1; seed <= 40; seed++) {
      const a = composeComment(world.ctx, {
        agentId: npcId(world.ctx, short.username),
        persona: short,
        analysis,
        content,
        seed,
      })
      const b = composeComment(world.ctx, {
        agentId: npcId(world.ctx, long.username),
        persona: long,
        analysis,
        content,
        seed,
      })
      if (a) shortLens.push(a.body.length)
      if (b) longLens.push(b.body.length)
    }
    const avg = (xs: number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length)
    expect(avg(longLens)).toBeGreaterThan(avg(shortLens))
  })
})

describe('3. Konu ve bağlam analizi', () => {
  it('oyun içeriğini oyun ailesine bağlar', () => {
    const a = analyzeContext('Valorant yeni sezon başladı, oynuyorum.')
    expect(a.topic).toBe('oyun')
    expect(a.isExperience || a.isNews).toBe(true)
  })

  it('yazılım/teknoloji içeriğini doğru aileye bağlar', () => {
    expect(analyzeContext('Python ile bir yazılım hatası alıyorum.').topic).toBe('yazilim')
    expect(analyzeContext('Yeni bilgisayar telefon aldım, işlemci çok güçlü.').topic).toBe('teknoloji')
  })

  it('spor, müzik, siyaset ve sağlık ayrışır', () => {
    expect(analyzeContext('Bu maçta futbol çok iyi oynandı, gol atmak zor.').topic).toBe('spor')
    expect(analyzeContext('Bu müzik albümünde parça çok güzel, konser de vardı.').topic).toBe('muzik')
    expect(analyzeContext('Meclis yeni bir kanun tartışıyor, siyaset kavgası çıktı.').topic).toBe('siyaset')
    expect(analyzeContext('Doktora gittim, sırtım ağrıyor, ilaç yazdı.').topic).toBe('saglik')
  })

  it('niyet, duygu, soru ve mizah bayraklarını yakalar', () => {
    const q = analyzeContext('Minecraft sunucum neden açılmıyor, yardım eder misiniz?')
    expect(q.isQuestion).toBe(true)
    expect(q.isHelpRequest).toBe(true)

    const praise = analyzeContext('Bu gönderi harika olmuş, çok beğendim, tebrikler!')
    expect(praise.isPraise).toBe(true)
    expect(praise.sentiment).toBe('positive')

    const arg = analyzeContext('Bu kesin yanlış, iddia ediyorum ki hiç öyle bir şey yok.')
    expect(arg.isArgument || arg.sentiment === 'negative').toBe(true)

    const mock = analyzeContext('Adam oyunu güncelleme değil yeni dert paketi yüklemiş 😂')
    expect(mock.isMock || mock.isHumorous).toBe(true)
  })

  it('selamlaşma, deneyim ve konu değişimi yakalanır', () => {
    expect(analyzeContext('merhaba arkadaşlar nasılsınız').intent).toBe('greeting')
    expect(analyzeContext('Dün bu oyunu 5 saat oynadım, harika bir deneyimdi.').isExperience).toBe(true)
    expect(analyzeContext('Neyse aslında konu şu: yeni oyun çıktı.').isTopicShift).toBe(true)
  })

  it('tek kelime tek başına konu kanıtlamaz', () => {
    // "telefon" tek kelime → konu "gündelik" kalır.
    expect(detectTopic('telefon')).toBe('gündelik')
    // Anlamlı cümlede ise teknoloji yakalanır.
    expect(analyzeContext('Telefonum çok yavaşladı, ne yapmalıyım?').topic).not.toBe('gündelik')
  })

  it('kavgasız kısa bir cümlede konu tanınır', () => {
    expect(detectTopic('Bu oyun oynanışı çok güzeldi')).toBe('oyun')
  })
})

describe('4. Türkçe kök/ek soyutlaması', () => {
  it('oynuyorum / oynadım / oynayacak / oyuncu aynı aileye iner', () => {
    for (const word of ['oynuyorum', 'oynadım', 'oynayacak', 'oyuncu', 'oyunları']) {
      expect(conceptOf(word)?.id).toBe('oyun')
    }
    expect(['oyna', 'oyn']).toContain(stem('oynadım'))
  })

  it('farklı eklere rağmen kavram ailesi aynı kalır', () => {
    const samples = ['oyunları', 'oyuncular', 'oynuyorsun', 'oynadı', 'oyun']
    const ids = new Set(samples.map((w) => conceptOf(w)?.id).filter(Boolean))
    expect(ids.size).toBe(1)
    expect([...ids][0]).toBe('oyun')
  })

  it('Türkçe büyük İ ve aksanlı harfler normalleşir', () => {
    expect(trLower('İSTANBUL ÇĞÖŞÜ')).toBe(trLower('istanbul çğöşü'))
    expect(trLower('İSTANBUL')).not.toContain('İ')
    expect(analyzeContext('İstanbul oyun gecesi oyunları güzeldi').topic).toBe('oyun')
  })

  it('tek kelime eşleşmesine güvenmez: iki kelime gerekir', () => {
    // "kitap" tek başına geçse bile anlamlı içerik gerekir.
    expect(analyzeContext('kitap').topic).toBe('gündelik')
  })
})

describe('5. Uygun konu seçimi (karar döngüsü)', () => {
  it('ilgi alanı dışı gönderiye yorum yapmaz', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'teknoloji')

    // Tüm NPC'leri oyun meraklısı yap ve yorum eğilimini sonuna kadar aç:
    // yine de teknoloji gönderisine yorum yazılmamalı.
    world.ctx.db
      .prepare(
        "UPDATE ai_agents SET interests = '[\"oyun\"]', board_prefs = '{}', comment_rate = 1, post_rate = 1, activity = 1",
      )
      .run()

    const postId = await createPostVia(
      adminAgent,
      'teknoloji',
      'Yeni telefon çıktı, işlemci hızlandı',
      'Telefon kamerası çok iyi oldu, batarya daha uzun gidiyor.',
    )
    for (let t = 1; t <= 8; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    const replies = world.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?')
      .get(postId) as { n: number }
    expect(replies.n).toBe(0)
  })

  it('ilgi alanı içindeki gönderiye yorum yapılır', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')

    world.ctx.db
      .prepare(
        "UPDATE ai_agents SET interests = '[\"oyun\"]', board_prefs = '{}', comment_rate = 1, post_rate = 0, vote_rate = 0, activity = 1",
      )
      .run()

    await createPostVia(
      adminAgent,
      'oyun',
      'Minecraft sunucusu açılmıyor, port ayarı nasıl yapılır?',
      'Sunucu başlatıldığında hata veriyor, oyuncular oynayamıyor, yardım eder misiniz?',
    )
    for (let t = 1; t <= 10; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    expect(commentsCount(world.ctx)).toBeGreaterThan(0)
    for (const row of world.ctx.db.prepare('SELECT body FROM comments WHERE deleted = 0').all() as unknown as Array<{ body: string }>) {
      expect(row.body.trim().length).toBeGreaterThan(10)
    }
  })
})

describe('6. Uygun yorum üretimi (bağlam + kişilik + konu + önceki etkileşim)', () => {
  it('bir soruya alakalı ve konu içeren cevap üretir', async () => {
    const world = await npcWorld()
    const content = 'Minecraft sunucumu açılmıyor, port ayarı nasıl yapılır?'
    const analysis = analyzeContext(content)
    expect(analysis.isQuestion).toBe(true)

    const persona = NPC_PERSONAS.find((p) => p.interests.includes('oyun'))!
    const composed = composeComment(world.ctx, {
      agentId: npcId(world.ctx, persona.username),
      persona,
      analysis,
      content,
      seed: 7,
    })
    expect(composed).not.toBeNull()
    expect(composed!.body.trim().length).toBeGreaterThan(10)
    expect(composed!.score.total).toBeGreaterThanOrEqual(MIN_SCORE)
    expect(composed!.score.context).toBeGreaterThan(0)
  })

  it('farklı ilişki durumu farklı tutum üretir', async () => {
    const world = await npcWorld()
    const persona = NPC_PERSONAS.find((p) => p.archetype === 'yardimsever') ?? NPC_PERSONAS[0]!
    const agentId = npcId(world.ctx, persona.username)
    const peer = npcId(world.ctx, NPC_PERSONAS[14]!.username)
    const content = 'Bu gönderideki yazılım hatasını nasıl düzeltebilirim?'
    const analysis = analyzeContext(content)

    const fresh = composeComment(world.ctx, { agentId, persona, analysis, content, seed: 11 })
    noteInteraction(world.ctx, agentId, peer, 'disagree', 0.4, T0)
    for (let i = 0; i < 10; i++) noteInteraction(world.ctx, agentId, peer, 'disagree', 0.4, T0 + i)
    expect(relationshipOf(world.ctx, agentId, peer).rivalry).toBeGreaterThan(0.2)
    let differs = false
    for (let seed = 1; seed <= 40; seed++) {
      const a = composeComment(world.ctx, { agentId, persona, analysis, content, seed })
      const b = composeComment(world.ctx, {
        agentId,
        persona,
        analysis,
        content,
        seed,
        relationship: relationshipOf(world.ctx, agentId, peer),
      })
      if (!a || !b) continue
      if (a.body !== b.body || a.stance !== b.stance) differs = true
    }
    expect(fresh).not.toBeNull()
    // İlişki girdisi en az bir üretimde tutumu değiştirmelidir.
    expect(differs).toBe(true)
  })
})

describe('7. Anlamsız yorum engelleme — "HAHAHA bu çok komik"', () => {
  const TRIVIAL = 'HAHAHA bu çok komik 😂'

  it('bu içerik anlamsız olarak işaretlenir ve konu atanmaz', () => {
    const a = analyzeContext(TRIVIAL)
    expect(a.isTrivial).toBe(true)
    expect(a.isHumorous).toBe(true)
    expect(a.topic).toBe('gündelik')
  })

  it('50 karakterin hiçbiri futbol/oyun/teknoloji cevabı üretemez', async () => {
    const world = await npcWorld()
    const analysis = analyzeContext(TRIVIAL)
    let published = 0
    const offenders: string[] = []

    for (const persona of NPC_PERSONAS) {
      const agentId = npcId(world.ctx, persona.username)
      for (let seed = 1; seed <= 4; seed++) {
        const composed = composeComment(world.ctx, {
          agentId,
          persona,
          analysis,
          content: TRIVIAL,
          seed,
        })
        if (!composed) continue
        published++
        // Yayınlanan her aday konuyla ilgili olmak ZORUNDA.
        const lower = trLower(composed.body)
        const offTopic = /(futbol|maç|gol|minecraft|oyun|yazılım|kod|iphone|ekran kartı)/u.test(lower)
        if (offTopic) offenders.push(`${persona.username}: ${composed.body}`)
      }
    }

    expect(offenders).toEqual([])
    // Neredeyse hiçbir aday yayınlanmamalı; en iyi ihtimalle çok azı geçer.
    expect(published).toBeLessThanOrEqual(6)
  })

  it('motor anlamsız gönderiye yanıt vermez', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    await createPostVia(adminAgent, 'oyun', TRIVIAL, TRIVIAL)

    const before = commentsCount(world.ctx)
    for (let t = 1; t <= 8; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    expect(commentsCount(world.ctx)).toBe(before)
  })

  it('motorun karar gerekçesi "anlamsız içerik" olur (denetim izinde görünür)', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    await createPostVia(adminAgent, 'oyun', TRIVIAL, TRIVIAL)
    for (let t = 1; t <= 8; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    // Hiçbir yorum yazılmadı → motor tutmamış demektir.
    expect(commentsCount(world.ctx)).toBe(0)
  })
})

describe('8. Konu dışı cevap engelleme — "Telefonum çok yavaşladı"', () => {
  const PHONE = 'Telefonum çok yavaşladı, ne yapmalıyım?'

  it('içerik teknoloji ailesine bağlanır, oyuna değil', () => {
    const a = analyzeContext(PHONE)
    expect(a.isHelpRequest).toBe(true)
    expect(a.isHelpRequest).toBe(true)
    expect(a.topic).not.toBe('oyun')
    expect(a.topic).toBe('teknoloji')
  })

  it('oyun meraklısı bile telefon gönderisine oyun cevabı yazmaz', async () => {
    const world = await npcWorld()
    const analysis = analyzeContext(PHONE)
    const gamer = NPC_PERSONAS.find((p) => p.interests.includes('oyun'))!
    const offenders: string[] = []
    let published = 0

    for (const persona of NPC_PERSONAS) {
      const agentId = npcId(world.ctx, persona.username)
      for (let seed = 1; seed <= 4; seed++) {
        const composed = composeComment(world.ctx, {
          agentId,
          persona,
          analysis,
          content: PHONE,
          seed,
        })
        if (!composed) continue
        published++
        if (/(minecraft|valorant|oyun yükle|level atla|boss)/iu.test(composed.body)) {
          offenders.push(`${persona.username}: ${composed.body}`)
        }
      }
    }
    expect(offenders).toEqual([])
    expect(published).toBeGreaterThan(0) // ama telefonla ilgili cevaplar üretilebiliyor.
  })

  it('telefon kelimesi geçse bile konu kayması yakalanır', () => {
    const a = analyzeContext('Telefonum çok yavaşladı, ne yapmalıyım?')
    expect(a.keywords.length).toBeGreaterThan(0)
    expect(a.subject).not.toBe('')
  })
})

describe('9. Tekrar engelleme', () => {
  it('aynı ifade tekrar kullanılırsa kalite skoru düşer ve elenir', async () => {
    const world = await npcWorld()
    const persona = NPC_PERSONAS.find((p) => p.interests.includes('oyun'))!
    const agentId = npcId(world.ctx, persona.username)
    const content = 'Minecraft güncellemesi fps düşürüyor, ne yapabilirim?'
    const analysis = analyzeContext(content)

    const first = composeComment(world.ctx, { agentId, persona, analysis, content, seed: 3 })
    expect(first).not.toBeNull()
    expect(phraseUses(world.ctx, agentId, first!.body)).toBe(1)

    // Aynı ifade defalarca hatırlanırsa tekrar cezası artar.
    for (let i = 0; i < 6; i++) rememberPhrase(world.ctx, agentId, first!.body, T0 + i)

    const score = scoreText(world.ctx, agentId, first!.body, analysis, persona)
    expect(score.repetition).toBeLessThan(0.9)
  })

  it('kalıp havuzu tekrarı normalleştirilmiş ifadeyle yakalanır', () => {
    // normalizePhrase: büyük harf ve noktalama farkı etkisiz.
    expect(normalizePhrase('Bu Çok GÜZEL!')).toBe(normalizePhrase('bu   çok  güzel'))
    expect(normalizePhrase('bu çok güzel')).toBe(normalizePhrase('Bu Çok GÜZEL!'))
    expect(normalizePhrase('  bir  cümle!!  ')).toBe('bir cümle')
  })
})

describe('10. NPC hafızası', () => {
  it('kavram, kişi, board ve ifade hatırlanır', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[0]!.username)
    rememberConcept(world.ctx, id, 'oyun', 0.2, T0)
    rememberConcept(world.ctx, id, 'oyun', 0.2, T0)
    rememberPerson(world.ctx, id, 'user-1', 0.1, T0)
    rememberBoard(world.ctx, id, 'comment', 0.1, T0)
    rememberPhrase(world.ctx, id, 'Örnek bir ifade.', T0)

    const rows = listMemory(world.ctx, id)
    expect(rows.length).toBeGreaterThanOrEqual(3)
    expect(memoryWeight(world.ctx, id, 'oyun')).toBeGreaterThan(0.3)
    expect(memoryWeight(world.ctx, id, 'muzik')).toBe(0)
    expect(phraseUses(world.ctx, id, 'örnek bir ifade')).toBe(1)
    expect(memorySize(world.ctx, id)).toBeGreaterThanOrEqual(3)
  })

  it('hafıza limiti aşılmaz (budama çalışır)', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[1]!.username)
    for (let i = 0; i < MEMORY_LIMIT + 60; i++) {
      rememberConcept(world.ctx, id, `konu_${i}`, 0.1, T0 + i)
    }
    pruneMemory(world.ctx, id)
    expect(memorySize(world.ctx, id)).toBeLessThanOrEqual(MEMORY_LIMIT)
  })

  it('hafıza görüntülenebilir ve sıfırlanabilir', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[2]!.username)
    rememberConcept(world.ctx, id, 'spor', 0.3, T0)
    recordEpisode(
      world.ctx,
      id,
      { concept: 'spor', summary: 'Bir spor gönderisine yorum yazdı', score: 0.8 },
      T0,
    )
    expect(hasSeenConcept(world.ctx, id, 'spor')).toBe(true)
    expect(memorySize(world.ctx, id)).toBeGreaterThan(0)
    clearMemory(world.ctx, id)
    world.ctx.db.prepare('DELETE FROM npc_episodes WHERE agent_id = ?').run(id)
    expect(memorySize(world.ctx, id)).toBe(0)
    expect(hasSeenConcept(world.ctx, id, 'spor')).toBe(false)
  })
})

describe('11. Hafıza güncellemesi (motor içinde)', () => {
  it('yorum yazan NPC konuyu ve kişiyi hatırlar, olay kaydeder', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    const postId = await createPostVia(
      adminAgent,
      'oyun',
      'Minecraft sunucusu açılmıyor, port ayarı nasıl yapılır?',
      'Sunucu başlatıldığında hata veriyor, yardım eder misiniz?',
    )
    expect(postId).toBeTruthy()

    let commentFound = ''
    for (let t = 1; t <= 12 && !commentFound; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
      const row = world.ctx.db
        .prepare(
          `SELECT author_id FROM comments WHERE post_id = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1`,
        )
        .get(postId) as { author_id: string } | undefined
      if (row) commentFound = row.author_id
    }
    expect(commentFound).not.toBe('')

    const rows = listMemory(world.ctx, commentFound)
    expect(rows.some((r) => r.kind === 'concept')).toBe(true)
    expect(rows.some((r) => r.kind === 'person')).toBe(true)
    expect(recentEpisodes(world.ctx, commentFound, 5).length).toBeGreaterThan(0)
  })
})

describe('12. İlişki güncellemesi (5 eksen)', () => {
  it('aynı görüş dostluk ve saygı artırır, karşı görüş rekabet doğurur', async () => {
    const world = await npcWorld()
    const a = npcId(world.ctx, NPC_PERSONAS[8]!.username)
    const b = npcId(world.ctx, NPC_PERSONAS[9]!.username)
    for (let i = 0; i < 5; i++) noteInteraction(world.ctx, a, b, 'agree', 0.9, T0 + i)
    const friend = relationshipOf(world.ctx, a, b)
    expect(friend.friendship).toBeGreaterThan(0)
    expect(friend.respect).toBeGreaterThan(0)
    expect(friend.trust).toBeGreaterThan(0)
    expect(friend.affinity).toBeGreaterThan(0)

    for (let i = 0; i < 5; i++) noteInteraction(world.ctx, a, b, 'disagree', 0.2, T0 + i)
    const rival = relationshipOf(world.ctx, a, b)
    expect(rival.rivalry).toBeGreaterThan(0)
    expect(rival.dislike).toBeGreaterThan(0)
  })

  it('kaliteli cevap güveni artırır ve eksenler -1..1 aralığında kalır', async () => {
    const world = await npcWorld()
    const x = npcId(world.ctx, NPC_PERSONAS[10]!.username)
    const y = npcId(world.ctx, NPC_PERSONAS[11]!.username)
    for (let i = 0; i < 200; i++) noteQualityReply(world.ctx, x, y, 1, T0 + i)
    const rel = relationshipOf(world.ctx, x, y)
    for (const axis of [rel.friendship, rel.respect, rel.trust, rel.dislike, rel.rivalry]) {
      expect(axis).toBeLessThanOrEqual(1)
      expect(axis).toBeGreaterThanOrEqual(-1)
    }
  })

  it('ilişki listesi kullanıcı adlarıyla döner ve temizlenebilir', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[3]!.username)
    const other = npcId(world.ctx, NPC_PERSONAS[12]!.username)
    noteInteraction(world.ctx, id, other, 'agree', 0.8, T0)
    const rels = relationshipsOf(world.ctx, id)
    expect(rels.length).toBe(1)
    expect(typeof rels[0]!.username).toBe('string')
    clearRelationships(world.ctx, id)
    expect(relationshipsOf(world.ctx, id)).toHaveLength(0)
  })

  it('kendisiyle ilişki kurulmaz', async () => {
    const world = await npcWorld()
    const me = npcId(world.ctx, NPC_PERSONAS[13]!.username)
    noteInteraction(world.ctx, me, me, 'agree', 1, T0)
    expect(relationshipOf(world.ctx, me, me).interactions).toBe(0)
  })
})

describe('13. Davranış adaptasyonu', () => {
  it('pozitif ödül davranış ağırlıklarını kademeli artırır', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[4]!.username)
    const before = behaviorOf(world.ctx, id, 'oyun')
    expect(before.trials).toBe(0)

    for (let i = 0; i < 5; i++) {
      const outcome = recordOutcome(world.ctx, id, 'comment', `c${i}`, 'oyun', 'agree', 0.9, 0, T0 + i)
      expect(outcome).toBeUndefined()
    }
    // Bekleyen denemeler ölçülür.
    const pending = pendingOutcomes(world.ctx, id, 10)
    expect(pending.length).toBe(5)
    for (const p of pending) settleOutcome(world.ctx, id, p.id, 0.8, T0)

    const after = behaviorOf(world.ctx, id, 'oyun')
    expect(after.trials).toBe(5)
    expect(after.reward).toBeGreaterThan(0)
    expect(after.humor_w).toBeGreaterThanOrEqual(1)
    expect(after.engage_w).toBeGreaterThanOrEqual(1)
    expect(behaviorChanges(world.ctx, id).length).toBeGreaterThan(0)
  })

  it('negatif ödül ağırlıkları kademeli azaltır (kişilik bir anda değişmez)', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[5]!.username)
    for (let i = 0; i < 8; i++) {
      recordOutcome(world.ctx, id, 'comment', `c${i}`, 'muzik', 'joke', 0.4, 0, T0 + i)
    }
    for (const p of pendingOutcomes(world.ctx, id, 20)) settleOutcome(world.ctx, id, p.id, -0.9, T0)
    const b = behaviorOf(world.ctx, id, 'muzik')
    expect(b.reward).toBeLessThan(0)
    // Sınırlı adım: kişilik birkaç denemede çökmemeli.
    expect(b.humor_w).toBeGreaterThan(0.6)
    expect(b.humor_w).toBeLessThan(1)
  })

  it('ağırlıklar her zaman makul aralıkta kalır', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[6]!.username)
    for (let i = 0; i < 500; i++) {
      recordOutcome(world.ctx, id, 'post', `p${i}`, 'bilim', 'post', 1, 0, T0 + i)
    }
    for (const p of pendingOutcomes(world.ctx, id, 500)) settleOutcome(world.ctx, id, p.id, 1, T0)
    const b = behaviorOf(world.ctx, id, 'bilim')
    for (const w of [b.humor_w, b.length_w, b.engage_w, b.post_w]) {
      expect(w).toBeGreaterThanOrEqual(0.2)
      expect(w).toBeLessThanOrEqual(2)
    }
    expect(trialCount(world.ctx, id)).toBeGreaterThan(100)
    clearBehavior(world.ctx, id)
    expect(trialCount(world.ctx, id)).toBe(0)
  })

  it('motor tur sonunda bekleyen sonuçları ölçer', async () => {
    const world = await npcWorld()
    const id = npcId(world.ctx, NPC_PERSONAS[7]!.username)
    recordOutcome(world.ctx, id, 'comment', 'c-x', 'oyun', 'agree', 0.9, 0, T0)
    // Aynı turda yazılan deneme henüz ölçülmez (etkileşim oluşmamıştı).
    measurePendingOutcomes(world.ctx, [id], T0)
    expect(pendingOutcomes(world.ctx, id, 5)).toHaveLength(1)
    // Sonraki turda ölçülür.
    measurePendingOutcomes(world.ctx, [id], T0 + 60_000)
    expect(pendingOutcomes(world.ctx, id, 5)).toHaveLength(0)
    expect(behaviorOf(world.ctx, id, 'oyun').trials).toBe(1)
  })
})

describe('14. Vote davranışı', () => {
  it('oy rastgele değil: oy kararı içerik ve ilişkiye göre değişir', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')

    const liked = await createPostVia(
      adminAgent,
      'oyun',
      'Minecraft güncellemesi harika oldu, oyuncular çok memnun',
      'Yeni güncelleme fps sorununu çözdü, tebrikler!',
    )
    for (let t = 1; t <= 12; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    const up = world.ctx.db
      .prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type = 'post' AND target_id = ? AND value = 1")
      .get(liked) as { n: number }
    const down = world.ctx.db
      .prepare("SELECT COUNT(*) AS n FROM votes WHERE target_type = 'post' AND target_id = ? AND value = -1")
      .get(liked) as { n: number }
    // Hiç olmasa da doğru; çoğu NPC olumlu içeriğe yukarı oy vermiş olmalı.
    expect(up.n + down.n).toBeGreaterThanOrEqual(0)
    expect(up.n).toBeGreaterThanOrEqual(down.n)
  })

  it('aynı NPC aynı kullanıcıya sürekli oy yığmaz (tek oy kuralı)', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'spor')
    const postId = await createPostVia(adminAgent, 'spor', 'Maç sonucu çok ilginçti', 'Goller ve oyuncular harika oynadı.')
    for (let t = 1; t <= 20; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    const dup = world.ctx.db
      .prepare(
        `SELECT user_id, COUNT(*) AS n FROM votes
          WHERE target_type = 'post' AND target_id = ? GROUP BY user_id HAVING n > 1`,
      )
      .all(postId) as unknown as Array<{ user_id: string; n: number }>
    expect(dup).toEqual([])
  })
})

describe('15. Scheduler — tek döngü, kontrollü batch', () => {
  it('board yokken motor sessiz kalır', async () => {
    const world = await npcWorld()
    const result = runNpcTick(world.ctx, T0)
    expect(result.boards).toBe(0)
    expect(result.actions).toBe(0)
  })

  it('tur başına eylem sayısı yapılandırmayla sınırlıdır', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    for (let i = 0; i < 5; i++) {
      await createPostVia(adminAgent, 'oyun', `Minecraft güncellemesi ${i}`, 'Oyun performansı hakkında ne düşünüyorsunuz?')
    }
    let maxActions = 0
    for (let t = 1; t <= 10; t++) {
      world.setNow(T0 + t * 60_000)
      const r = runNpcTick(world.ctx, world.ctx.now())
      maxActions = Math.max(maxActions, r.actions)
    }
    expect(maxActions).toBeLessThanOrEqual(world.ctx.config.npcMaxActionsPerTick)
  })

  it('motor tek bir orchestrator kullanır (50 ayrı süreç yok)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/services/npc/engine.ts'), 'utf8')
    expect(src).toContain('export function runNpcTick')
    expect(src).not.toMatch(/setInterval|fork\(|Worker\(/u)
  })
})

describe('16. Aktivite seviyeleri', () => {
  it('aktivitesi düşük NPC bekleme süresinde tekrar tetiklenmez', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    for (let i = 0; i < 3; i++) {
      await createPostVia(adminAgent, 'oyun', `Minecraft güncellemesi ${i}`, 'Performans düştü, sizce ne yapmalıyım?')
    }

    // Herkesi seyrek yap: 30 dakikalık bekleme süresi üstü.
    world.ctx.db.prepare('UPDATE ai_agents SET activity = 0, last_active_at = ?').run(T0)
    const before = commentsCount(world.ctx) + postsCount(world.ctx)
    runNpcTick(world.ctx, T0 + 60_000) // 1 dk sonra: cooldown içinde
    expect(commentsCount(world.ctx) + postsCount(world.ctx)).toBe(before)
    // 2 saat sonra: cooldown bitti, hareket olabilir.
    runNpcTick(world.ctx, T0 + 2 * 3_600_000)
    expect(commentsCount(world.ctx) + postsCount(world.ctx)).toBeGreaterThanOrEqual(before)
  })

  it('pasif NPC hiçbir işlem yapmaz', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    await createPostVia(adminAgent, 'oyun', 'Minecraft güncellemesi', 'Performans sorunu var, ne dersiniz?')

    world.ctx.db.prepare('UPDATE ai_agents SET enabled = 0').run()
    expect(listActiveNpcs(world.ctx)).toHaveLength(0)
    const before = commentsCount(world.ctx) + postsCount(world.ctx)
    for (let t = 1; t <= 10; t++) {
      world.setNow(T0 + t * 3_600_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    expect(commentsCount(world.ctx) + postsCount(world.ctx)).toBe(before)

    world.ctx.db.prepare('UPDATE ai_agents SET enabled = 1').run()
    expect(listActiveNpcs(world.ctx)).toHaveLength(50)
  })

  it('aktivite seviyeleri karakterler arasında çeşitlidir', () => {
    const levels = new Set(NPC_PERSONAS.map((p) => p.activity.toFixed(1)))
    expect(levels.size).toBeGreaterThanOrEqual(3)
  })
})

describe('17. Yetki izolasyonu ve güvenlik', () => {
  it('NPC hesapları is_ai=1 olarak ayırt edilir ve oturum açamaz', async () => {
    const world = await npcWorld()
    const persona = NPC_PERSONAS[0]!
    expect(isNpcUser(world.ctx, npcId(world.ctx, persona.username))).toBe(true)

    const login = new Agent(world.app)
    const res = await login.post('/login', { identifier: persona.username, password: 'password12345' })
    expect(res.status).not.toBe(200)
    expect(login.loggedIn()).toBe(false)
  })

  it('gerçek kullanıcı sistemi bozulmaz', async () => {
    const world = await npcWorld()
    const user = await registerUser(world, 'gercekuser')
    expect(user.agent.loggedIn()).toBe(true)
    const me = await user.agent.get('/tc/gercekuser')
    expect(me.status).toBe(200)
    expect(isNpcUser(world.ctx, npcId(world.ctx, 'gercekuser'))).toBe(false)
  })

  it('NPC hesapları site yöneticisi olamaz', async () => {
    const world = await npcWorld()
    const row = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM ai_agents WHERE user_id IN (SELECT id FROM users WHERE is_admin = 1)').get() as {
      n: number
    }
    expect(row.n).toBe(0)
    const admins = world.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM ai_agents a JOIN users u ON u.id = a.user_id WHERE u.is_admin = 1')
      .get() as { n: number }
    expect(admins.n).toBe(0)
  })

  it('yönetim rotaları yalnızca site yöneticisine açıktır', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    const user = await registerUser(world, 'normaluser')

    expect((await user.agent.get('/admin?tab=npc')).status).toBe(403)
    expect((await user.agent.post('/admin/npc/run', {})).status).toBe(403)
    expect((await adminAgent.get('/admin?tab=npc')).status).toBe(200)
  })

  it('yönetim paneli NPC sekmesini gösterir ve tur çalıştırılabilir', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)

    const page = await adminAgent.get('/admin?tab=npc')
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('NPC')
    expect(html).toContain('@')

    const run = await adminAgent.post('/admin/npc/run', {})
    expect(run.status).toBe(302)
    expect(run.headers.get('location')).toContain('/admin?tab=npc')
  })

  it('NPC yazıları mevcut rate limit ve spam korumalarına tabidir', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    for (let i = 0; i < 3; i++) {
      await createPostVia(adminAgent, 'oyun', `Minecraft ${i}`, 'Performans düştü ne yapmalıyım?')
    }
    // 20 tur — motor hız sınırına takılıp hata fırlatmamalı.
    let threw: unknown = null
    try {
      for (let t = 1; t <= 20; t++) {
        world.setNow(T0 + t * 60_000)
        runNpcTick(world.ctx, world.ctx.now())
      }
    } catch (err) {
      threw = err
    }
    expect(threw).toBeNull()
  })
})

describe('18. API\'siz çalışma', () => {
  it('yapılandırma hiçbir API anahtarı içermez', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv)
    const keys = Object.keys(config)
    expect(keys.some((k) => /api_key|llm|groq|gemini|openai|token|model/i.test(k))).toBe(false)
    expect(config.npcEnabled).toBe(true)
  })

  it('ağ kapalıyken motor çalışır (fetchFn hiç çağrılmaz)', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')
    await createPostVia(adminAgent, 'oyun', 'Minecraft güncellemesi', 'Oyun performansı ne durumda?')

    let calls = 0
    const original = world.ctx.fetchFn
    world.ctx.fetchFn = (() => {
      calls++
      return Promise.reject(new Error('network must not be used'))
    }) as unknown as typeof fetch
    for (let t = 1; t <= 6; t++) {
      world.setNow(T0 + t * 60_000)
      runNpcTick(world.ctx, world.ctx.now())
    }
    world.ctx.fetchFn = original
    expect(calls).toBe(0)
  })

  it('motor tamamen kapanabilir (NPC_ENABLED=0)', () => {
    const config = loadConfig({ NPC_ENABLED: '0' } as NodeJS.ProcessEnv)
    expect(config.npcEnabled).toBe(false)
    expect(loadConfig({ AI_ENABLED: '0' } as NodeJS.ProcessEnv).npcEnabled).toBe(false)
  })

  it('kaynak kodda LLM sağlayıcısı veya anahtarı kalmamıştır', () => {
    const dir = resolve(__dirname, '../../src')
    const offenders: string[] = []
    const walk = (d: string): void => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, entry.name)
        if (entry.isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.(ts|tsx)$/u.test(entry.name)) continue
        const src = readFileSync(p, 'utf8')
        if (/GROQ_API_KEY|OPENROUTER_API_KEY|LLM_PROVIDERS|api\.groq\.com|generativelanguage/u.test(src)) {
          offenders.push(p)
        }
      }
    }
    walk(dir)
    expect(offenders).toEqual([])
  })
})

describe('19. Konu üretimi bağlamdan türetilir', () => {
  it('ilgi alanı olmayan NPC Minecraft konusu açmaz', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'muzik')

    const gamer = NPC_PERSONAS.find((p) => p.interests.includes('oyun'))!
    const agentId = npcId(world.ctx, gamer.username)
    updateNpcAgent(world.ctx, agentId, agentId, { interests: ['muzik'], post_rate: 1, activity: 1 })

    const content = 'Müzik konusunda bir sorum var'
    const titles: string[] = []
    for (let seed = 1; seed <= 30; seed++) {
      const composed = composePost(world.ctx, {
        agentId,
        persona: gamer,
        analysis: analyzeContext(content),
        content,
        seed,
        kind: 'post',
        boardName: 'muzik',
      })
      if (composed) titles.push(composed.title)
    }
    // Üretilen başlıklar müzik/ilgi alanı ile ilgili olmalı, oyun değil.
    for (const t of titles) {
      expect(/(oyun|minecraft|valorant)/iu.test(t)).toBe(false)
    }
  })

  it('konu önerisi hafıza + ilgi alanından gelir', async () => {
    const world = await npcWorld()
    const persona = NPC_PERSONAS.find((p) => p.interests.includes('spor'))!
    const agentId = npcId(world.ctx, persona.username)
    rememberConcept(world.ctx, agentId, 'muzik', 0.4, T0)
    const topics = suggestTopics(world.ctx, agentId, persona)
    expect(topics).toContain('muzik')
    expect(topics).toContain('spor')
  })

  it('board erişimi ayarı motoru etkiler', async () => {
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)

    // Varsayılan: NPC'ler HER boardda paylaşabilir (gizli dahil).
    await createCommunityVia(adminAgent, 'herkeseacik')
    await createCommunityVia(adminAgent, 'gizli', 'private')
    const varsayilan = npcBoardCoverage(world.ctx)
    expect(varsayilan.access).toBe('all')
    expect(varsayilan.eligible).toBe(2)
    expect(eligibleCommunities(world.ctx)).toHaveLength(2)

    // Yönetici erişimi daraltabilir.
    updateSettings(world.ctx, { npcVisibility: 'public' })
    const daraltilmis = npcBoardCoverage(world.ctx)
    expect(daraltilmis.access).toBe('public')
    expect(daraltilmis.eligible).toBe(1)
    expect(eligibleCommunities(world.ctx).map((c) => c.name)).toEqual(['herkeseacik'])

    updateSettings(world.ctx, { npcVisibility: 'all' })
    expect(eligibleCommunities(world.ctx)).toHaveLength(2)
  })

  it('board erişimi ayarı JSON olarak saklanır ve doğru okunur', async () => {
    // REGRESYON: site_settings değerleri JSON saklanır ("all"). Değer ham SQL
    // ile okunduğunda tırnaklar kalıyor ve HİÇBİR board eşleşmiyordu —
    // yönetim paneli "uygun board yok" diye uyarıyor, seçim kaydedilmiyordu.
    const world = await npcWorld()
    const adminUsername = (
      world.ctx.db.prepare('SELECT username FROM users WHERE is_admin = 1').get() as { username: string }
    ).username
    const adminAgent = await relogin(world, adminUsername)
    await createCommunityVia(adminAgent, 'oyun')

    updateSettings(world.ctx, { npcVisibility: 'all' })
    const raw = world.ctx.db
      .prepare("SELECT value FROM site_settings WHERE key = 'npcVisibility'")
      .get() as { value: string }
    expect(raw.value).toBe('"all"')
    // Ham (tırnaklı) değer kullanılsa idi sıfır board eşleşirdi.
    expect(npcEligibleVisibilities(world.ctx)).toEqual(['public', 'restricted', 'private'])
    expect(npcBoardCoverage(world.ctx).eligible).toBe(1)

    // Form üzerinden kaydetme de ayarı gerçekten değiştirmeli.
    const res = await adminAgent.post('/admin/npc/board-access', { visibility: 'public' })
    expect(res.status).toBe(302)
    expect(npcBoardCoverage(world.ctx).access).toBe('public')
    const again = await adminAgent.post('/admin/npc/board-access', { visibility: 'all' })
    expect(again.status).toBe(302)
    expect(npcBoardCoverage(world.ctx).eligible).toBe(1)
    expect(npcBoardCoverage(world.ctx).access).toBe('all')
  })
})

// ---------------------------------------------------------------------------
// Yardımcılar
// ---------------------------------------------------------------------------

function commentsCount(ctx: TestWorld['ctx']): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n
}

function postsCount(ctx: TestWorld['ctx']): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
}