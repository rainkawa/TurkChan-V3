/**
 * NPC simülasyon denetimi.
 *
 * Sistemi kontrollü biçimde çalıştırır ve ÇIKTILARI İNSAN GÖZÜYLE
 * DENETLEMEK için ekrana basar:
 *
 *   1.  20 gönderi analizi    → konu, niyet, duygu, "anlamsız mı", cevaplanır mı
 *   2.  100 yorum üretimi     → farklı karakterlerin aynı bağlamda ne yazdığı
 *   3.  100 konuşma devamı   → aynı gönderiye art arda yazılan yorumlar
 *   4.  100 vote kararı       → hangi içeriğe oy verilecek, neden
 *   5.  50 konu üretimi       → bağlamdan türeyen gönderi başlıkları
 *   6.  100 hafıza + 100 öğrenme kaydı → kalıcı durumun büyümesi
 *   7.  Uçtan uca motor turu → gerçek servisler (post/comment/vote) üzerinden
 *
 * Tüm sayılar `reports/npc-sim-latest.md` dosyasına da yazılır.
 *
 * Çalıştırma:  npm run npc:sim
 *
 * Harici API/anahtar kullanmaz; bellek içi SQLite ve sahte saat ile çalışır.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { analyzeContext } from '../src/services/npc/analyze'
import { composeComment, composePost } from '../src/services/npc/compose'
import { NPC_PERSONAS } from '../src/services/npc/personas'
import { createNpcAgents, listNpcAgents } from '../src/services/npc/agents'
import { runNpcTick } from '../src/services/npc/engine'
import { makeRng } from '../src/services/npc/rng'
import { rememberConcept, rememberPhrase } from '../src/services/npc/memory'
import { recordOutcome, behaviorChanges, pendingOutcomes, settleOutcome } from '../src/services/npc/learning'
import { rememberThread, stateSummary } from '../src/services/npc/state'
import { meanPairwiseSimilarity, styleDiversity, tooSimilarPairs, siteMetrics } from '../src/services/npc/metrics'
import {
  createTestWorld,
  registerAdmin,
  registerUser,
  relogin,
  createCommunityVia,
  createPostVia,
} from '../test/testUtils'
import type { TestWorld } from '../test/testUtils'

const T0 = 1_700_000_000_000

/** Denetimde kullanılacak 20 gerçekçi gönderi metni. */
const POSTS: string[] = [
  'Minecraft sunucumu açılmıyor, port ayarı nasıl yapılır?',
  'HAHAHA bu çok komik 😂',
  'Telefonum çok yavaşladı, ne yapmalıyım?',
  'Bu maçta futbol çok iyi oynandı, gol atmak zor.',
  'Yeni telefon aldım, kamera çok iyi ama batarya çabuk bitiyor.',
  'Merhaba arkadaşlar nasılsınız?',
  'Python ile yazdığım kod hata veriyor, neyi yanlış yapıyorum?',
  'Bu albümü dinledim, parçalar çok güzelmiş.',
  'Şu anki fiyatlar çok yüksek, enflasyon her şeyi vurdu.',
  'Meclis yeni bir kanun tartışıyor, siyaset gündemi kızıştı.',
  'Doktora gittim, sırtım ağrıyor, ilaç yazdı.',
  'Bu diziyi izledim, senaryo ve oyunculuk müthiş.',
  'Osmanlı tarihi hakkında bilgi arayanlar için kaynak önerebilir misiniz?',
  'Bahçemde balık tuttum, hobilerinizi siz de paylaşın.',
  'Oyun performansım çok düştü, ayarları sıfırlamam gerekiyor mu?',
  'Bilgisayarımda şifre kurtarma çalışmıyor, iki faktörlü doğrulama açtım.',
  'Bu gönderi harika olmuş, tebrik ederim!',
  'Valentin oyuncu performansları gerçekten iyi.',
  'Neyse aslında konu şu: yeni güncelleme ne getiriyor?',
  'hhh',
]

function line(char = '─', width = 78): string {
  return char.repeat(width)
}

/** Denetim çıktısında başlıkları kısaltır. */
function truncate(text: string, max = 42): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Denetim çıktısı: ekrana basılır ve rapor dosyasına toplanır. */
const report: string[] = []
function out(text = ''): void {
  console.log(text)
  report.push(text)
}

/** Board başına örnek konuşma: konu üretimi bunlardan beslenir. */
const BOARD_CONTEXT: Record<string, string> = {
  oyun:
    'Minecraft güncellemesi oyun performansını düşürdü. Valorant maçında oyuncular çok iyi oynadı, oyun günlüğü kızıştı. Oyun ayarlarını sıfırlamak sorunu çözdü.',
  teknoloji:
    'Telefonum çok yavaşladı, batarya çabuk bitiyor. Yeni bilgisayarın işlemcisi çok güçlü ama ekran kartı yetersiz kaldı.',
  muzik:
    'Bu albümdeki parçalar çok güzel, konser biletleri tükendi. Gitar çalması için yeni bir tel aldım, müzik kalitesi düzelmedi.',
}

async function main(): Promise<void> {
  const world: TestWorld = createTestWorld()
  await registerAdmin(world)
  createNpcAgents(world.ctx)
  const agents = listNpcAgents(world.ctx)
  world.setNow(T0)

  out(line('═'))
  out('TURKCHAN NPC SİMÜLASYONU — canlı örnek çıktı denetimi')
  out('Harici API yok · tamamen yerel · bellek içi SQLite')
  out(line('═'))

  out(`\nOluşturulan NPC: ${agents.length} · konu ailesi: 16 · davranış ekseni: 20\n`)

  // ---------------------------------------------------------------------
  out(line())
  out('1) GÖNDERİ ANALİZİ — 20 örnek')
  out(line())
  let trivial = 0
  for (const [i, raw] of POSTS.entries()) {
    const a = analyzeContext(raw)
    if (a.isTrivial) trivial++
    const flags = [
      a.isTrivial ? 'ANLAMSIZ' : '',
      a.isQuestion ? 'soru' : '',
      a.isHelpRequest ? 'yardım-isteği' : '',
      a.isArgument ? 'tartışma' : '',
      a.isHumorous ? 'mizah' : '',
      a.isNews ? 'haber' : '',
      a.isExperience ? 'deneyim' : '',
      a.isPraise ? 'övgü' : '',
      a.isTopicShift ? 'konu-değişimi' : '',
    ].filter(Boolean).join(' · ')
    out(
      `${String(i + 1).padStart(2)}. "${raw}"\n` +
        `    konu=${a.topic} (${a.topicLabel}) · duygu=${a.sentiment} · niyet=${a.intent}` +
        ` · kavram=${a.concepts.map((c) => `${c.id}:${c.score}`).join(',') || '—'}\n` +
        `    ${flags || '—'}`,
    )
  }
  out(`\n  → ${trivial} gönderi "anlamsız" sayıldı (cevaplanmamalı).`)

  // ---------------------------------------------------------------------
  out('\n' + line())
  out('2) YORUM ÜRETİMİ — 5 bağlam × 20 karakter = 100 deneme')
  out(line())
  const contexts = [
    'Minecraft sunucusu açılmıyor, port ayarı nasıl yapılır?',
    'Telefonum çok yavaşladı, ne yapmalıyım?',
    'Bu gönderi harika olmuş, tebrik ederim!',
    'Bu maçta futbol çok iyi oynandı, gol atmak zor.',
    'HAHAHA bu çok komik 😂',
  ]
  let published = 0
  let suppressed = 0
  let fallbackUsed = 0
  let attempts = 0
  const bodies: string[] = []
  const styles = new Map<string, number>()
  for (const [ci, context] of contexts.entries()) {
    const analysis = analyzeContext(context)
    // İlk iki bağlamın tamamı basılır (gözle denetim), kalanı özetlenir.
    const verbose = ci < 2
    if (verbose) out(`\n  BAĞLAM: "${context}"  → konu=${analysis.topic} anlamsız=${analysis.isTrivial}`)
    else out(`\n  BAĞLAM: "${context}"  → konu=${analysis.topic} anlamsız=${analysis.isTrivial} (özet)`)
    for (const persona of NPC_PERSONAS.slice(0, 20)) {
      attempts++
      const agent = agents.find((a) => a.username === persona.username)
      const composed = agent
        ? composeComment(world.ctx, {
            agentId: agent.user_id,
            persona,
            analysis,
            content: context,
            seed: 1000 + persona.username.length * 31,
          })
        : null
      if (!composed) {
        suppressed++
        if (verbose) out(`    @${persona.username.padEnd(14)} → YAZMADI (kalite kapısı)`)
        continue
      }
      published++
      bodies.push(composed.body)
      styles.set(composed.style, (styles.get(composed.style) ?? 0) + 1)
      if (composed.style === 'fallback-template') {
        fallbackUsed++
        if (verbose) out(`    @${persona.username.padEnd(14)} → "${composed.body}"  [YEDEK ŞABLON — yeni zincirden aday çıkmadı]`)
      }
      if (!verbose) continue
      out(
        `    @${persona.username.padEnd(14)} → "${composed.body}"\n` +
          `        skor=${composed.score.total.toFixed(2)} bağlam=${composed.score.context.toFixed(2)} ` +
          `konu=${composed.score.topic.toFixed(2)} kişilik=${composed.score.personality.toFixed(2)} ` +
          `tekrar=${composed.score.repetition.toFixed(2)} · ${composed.style}`,
      )
    }
  }
  const avgSim = meanPairwiseSimilarity(bodies)
  const dupPairs = tooSimilarPairs(bodies)
  const diversity = styleDiversity(bodies)
  out(`\n  → ${attempts} deneme · ${published} yorum yayınlandı · ${suppressed} kalite kapısında elendi.`)
  out(`  → eski kalıp havuzuna düşen (fallback-template): ${fallbackUsed}`)
  out(`  → ortalama çiftler arası benzerlik=${avgSim.toFixed(3)} · stil çeşitliliği=${diversity.toFixed(3)} · neredeyse-aynı çift=${dupPairs.length}`)
  out(`  → kullanılan üretim biçimleri: ${[...styles.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')}`)

  // ---------------------------------------------------------------------
  out('\n' + line())
  out('3) KONUŞMA DEVAMI — 20 karakter × 5 tur = 100 yorum (aynı gönderiye)')
  out(line())
  // Her karakter aynı gönderiye 5 kez yazar. npc_threads kaydı tutulur;
  // üretici son konuşulan cümleyi ve açık soruyu hatırlamak ZORUNDA.
  let threadTurns = 0
  let threadSkipped = 0
  for (const persona of NPC_PERSONAS.slice(0, 20)) {
    const agent = agents.find((a) => a.username === persona.username)
    if (!agent) continue
    const context = 'Sunucum sürekli kapanıyor, ne yapmalıyım?'
    const analysis = analyzeContext(context)
    const syntheticPostId = `sim-thread-${persona.username}`
    const trace: string[] = []
    for (let turn = 1; turn <= 5; turn++) {
      const composed = composeComment(world.ctx, {
        agentId: agent.user_id,
        persona,
        analysis,
        content: context,
        postId: syntheticPostId,
        seed: 4000 + turn * 131,
      })
      if (!composed) {
        threadSkipped++
        trace.push(`t${turn}: —`)
        continue
      }
      threadTurns++
      rememberThread(
        world.ctx,
        agent.user_id,
        syntheticPostId,
        'sunucu',
        composed.stance,
        composed.body,
        composed.body.includes('?') ? composed.body : '',
        0.1,
        world.ctx.now(),
      )
      trace.push(`t${turn}: ${composed.body}`)
    }
    if (persona.username === NPC_PERSONAS[0]?.username || persona.username === NPC_PERSONAS[7]?.username) {
      out(`\n  @${persona.username}`)
      for (const lineText of trace) out(`    ${lineText}`)
      out(`    durum: ${stateSummary(world.ctx, agent.user_id)}`)
    }
  }
  const threadRows = world.ctx.db
    .prepare('SELECT COUNT(*) AS n FROM npc_threads')
    .get() as { n: number }
  const opinionRows = world.ctx.db
    .prepare('SELECT COUNT(*) AS n FROM npc_opinions')
    .get() as { n: number }
  out(`\n  → ${threadTurns} devam yorumu üretildi, ${threadSkipped} turda üretici sustu.`)
  out(`  → npc_threads=${threadRows.n} kayıt · npc_opinions=${opinionRows.n} kayıt`)

  // ---------------------------------------------------------------------
  out('\n' + line())
  out('4) VOTE KARARLARI — 100 deneme')
  out(line())
  const rng = makeRng(4242)
  const voteTally: Record<number, number> = { '1': 0, '0': 0, '-1': 0 }
  for (let i = 0; i < 100; i++) {
    const raw = POSTS[i % POSTS.length]!
    const analysis = analyzeContext(raw)
    const persona = NPC_PERSONAS[(i * 7) % NPC_PERSONAS.length]!
    const lower = raw.toLocaleLowerCase('tr')
    const relevant = persona.interests.some((x) => lower.includes(x.toLocaleLowerCase('tr')))
    let relevance = relevant ? 1 : 0
    if (analysis.sentiment === 'positive') relevance += 0.3
    if (analysis.sentiment === 'negative') relevance -= 0.2 * (1 - persona.talkativeness)
    if (analysis.isArgument && persona.skepticism > 0.6) relevance -= 0.3
    const upProb = Math.min(0.95, Math.max(0.05, persona.upvote_bias * 0.5 + 0.25 + relevance * 0.15))
    const downProb = Math.min(
      0.6,
      Math.max(0.02, persona.downvote_bias * 0.5 + Math.max(0, -relevance) * 0.15),
    )
    const roll = rng()
    const value = roll < upProb ? 1 : roll < upProb + downProb ? -1 : 0
    voteTally[value]++
    if (i >= 20) continue
    out(
      `${String(i + 1).padStart(2)}. @${persona.username.padEnd(14)} → ` +
        `${value === 1 ? 'YUKARI OY' : value === -1 ? 'AŞAĞI OY' : 'OY VERMEDİ'}` +
        `  (ilgi=${relevant ? 'var' : 'yok'} duygu=${analysis.sentiment} ` +
        `p(up)=${upProb.toFixed(2)} p(down)=${downProb.toFixed(2)} zar=${roll.toFixed(2)})`,
    )
  }
  out(`\n  → 100 karar: yukarı=${voteTally[1]} aşağı=${voteTally[-1]} kararsız=${voteTally[0]}`)

  // ---------------------------------------------------------------------
  out('\n' + line())
  out('5) KONU ÜRETİMİ — 50 deneme (bağlamdan türetilir)')
  out(line())
  const adminRow = world.ctx.db
    .prepare('SELECT username FROM users WHERE is_admin = 1')
    .get() as { username: string }
  const adminAgent = await relogin(world, adminRow.username)
  const boards = ['oyun', 'teknoloji', 'muzik']
  for (const name of boards) {
    await createCommunityVia(adminAgent, name)
  }

  let created = 0
  const titles2: string[] = []
  for (let i = 0; i < 50; i++) {
    const persona = NPC_PERSONAS[(i * 5) % NPC_PERSONAS.length]!
    const agent = agents.find((a) => a.username === persona.username)!
    const board = boards[i % boards.length]!
    const topics = persona.interests.slice(0, 4)
    let composed = null
    for (const topic of topics) {
      // Gerçek motorun yaptığı gibi: ilgi alanı + board içeriği birlikte.
      const analysis = analyzeContext(`${topic} ${board} ${BOARD_CONTEXT[board] ?? ''}`)
      if (analysis.topic === 'gündelik') continue
      composed = composePost(world.ctx, {
        agentId: agent.user_id,
        persona,
        analysis,
        content: board,
        seed: 7000 + i * 977,
        kind: 'post',
        boardName: board,
      })
      if (composed) break
    }
    if (!composed) {
      if (i < 15) out(`  @${persona.username.padEnd(14)} c/${board.padEnd(10)} → YAZMADI (bağlam/kalite kapısı)`)
      continue
    }
    created++
    titles2.push(composed.title)
    if (i >= 15) continue
    out(
      `  @${persona.username.padEnd(14)} c/${board.padEnd(10)} → "${composed.title}"\n` +
        `      ${composed.body}\n` +
        `      konu=${composed.topic} skor=${composed.score.total.toFixed(2)}`,
    )
  }
  out(`\n  → ${created}/50 konu üretildi · başlık çeşitliliği=${styleDiversity(titles2).toFixed(3)}`)

  // ---------------------------------------------------------------------
  out('\n' + line())
  out('6) KALICI DURUM — 100 hafıza + 100 öğrenme kaydı')
  out(line())
  const sampleAgent = agents[0]!
  let memoryWrites = 0
  let learningWrites = 0
  for (let i = 0; i < 100; i++) {
    const persona = NPC_PERSONAS[i % NPC_PERSONAS.length]!
    const agent = agents.find((a) => a.username === persona.username)!
    const raw = POSTS[i % POSTS.length]!
    const analysis = analyzeContext(raw)
    rememberConcept(world.ctx, agent.user_id, analysis.topic, 0.1, world.ctx.now())
    rememberPhrase(world.ctx, agent.user_id, `${analysis.topic} · ${analysis.intent} · tur ${i}`, world.ctx.now())
    memoryWrites += 2
    const reward = ((i * 37) % 21) / 10 - 1
    recordOutcome(
      world.ctx,
      agent.user_id,
      'comment',
      `sim-target-${i}`,
      analysis.topic,
      i % 2 === 0 ? 'solve' : 'experience',
      0.4 + (i % 6) * 0.1,
      reward,
      world.ctx.now(),
    )
    learningWrites++
  }
  const memoryRows = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM npc_memory').get() as { n: number }
  const phraseRows = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM npc_phrases').get() as { n: number }
  const outcomeRows = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM npc_outcomes').get() as { n: number }
  const factRows = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM npc_facts').get() as { n: number }
  out(`  → ${memoryWrites} hafıza yazımı · npc_memory=${memoryRows.n} · npc_phrases=${phraseRows.n}`)
  out(`  → ${learningWrites} öğrenme denemesi · npc_outcomes=${outcomeRows.n} · npc_facts=${factRows.n}`)
  // Öğrenme yalnızca "deneme kaydedildi" değil, deneme ÖLÇÜLDÜĞÜNDE
  // ağırlıkları kaydırır: bekleyen denemeler ödül/ceza ilesettirilir.
  const pending = pendingOutcomes(world.ctx, sampleAgent.user_id, 20)
  for (const [i, p] of pending.entries()) {
    settleOutcome(world.ctx, sampleAgent.user_id, p.id, ((i * 13) % 11) / 5 - 1, world.ctx.now())
  }
  out(`  → ${pending.length} bekleyen deneme ölçüldü ve ağırlıklar kademeli kaydırıldı`)
  const changes = behaviorChanges(world.ctx, sampleAgent.user_id, 5)
  out(`  → ${sampleAgent.username} için davranış kayması (en fazla 5 kayıt):`)
  for (const c of changes) {
    out(`      ${c.topic.padEnd(12)} mizah=${c.humor_w.toFixed(2)} uzunluk=${c.length_w.toFixed(2)} etkileşim=${c.engage_w.toFixed(2)}`)
  }
  if (changes.length === 0) out('      (henüz eşiği aşan kayma yok — kademeli öğrenme beklenen davranış)')

  // ---------------------------------------------------------------------
  out('\n' + line())
  out('7) UÇTAN UCA MOTOR — gerçek servislerle 5 tur')
  out(line())
  const user = await registerUser(world, 'denetleyici')
  for (let i = 0; i < 4; i++) {
    await createPostVia(
      user.agent,
      boards[i % boards.length]!,
      POSTS[i]!,
      'Bu konuda düşüncelerinizi paylaşır mısınız?',
    )
  }
  for (let t = 1; t <= 5; t++) {
    world.setNow(T0 + t * 300_000)
    const result = runNpcTick(world.ctx, world.ctx.now())
    out(
      `  tur ${t}: ${result.actions} işlem · ${result.boards} board · ` +
        `toplam ${result.posts} gönderi / ${result.comments} yorum / ${result.votes} oy`,
    )
  }

  const written = world.ctx.db
    .prepare(
      `SELECT u.username, c.body, p.title AS post_title FROM comments c
        JOIN users u ON u.id = c.author_id
        JOIN posts p ON p.id = c.post_id
        WHERE u.is_ai = 1 AND c.deleted = 0 ORDER BY c.created_at DESC LIMIT 8`,
    )
    .all() as unknown as Array<{ username: string; body: string; post_title: string }>
  out('\n  Motorun yazdığı son yorumlar (hangi gönderiye):')
  for (const row of written) out(`    @${row.username} → "${truncate(row.post_title)}": ${row.body}`)

  const titles = world.ctx.db
    .prepare(
      `SELECT u.username, p.title FROM posts p JOIN users u ON u.id = p.author_id
        WHERE u.is_ai = 1 AND p.deleted = 0 ORDER BY p.created_at DESC LIMIT 8`,
    )
    .all() as unknown as Array<{ username: string; title: string }>
  out('\n  Motorun açtığı son gönderiler:')
  for (const row of titles) out(`    @${row.username}: ${row.title}`)

  // ---------------------------------------------------------------------
  out('\n' + line('═'))
  const site = siteMetrics(world.ctx)
  out('DENETİM SONU')
  out(`  20 gönderi analiz edildi · ${trivial} tanesi anlamsız işaretlendi`)
  out(`  100 yorum denemesi · ${published} yayınlandı · ${suppressed} kalite kapısında elendi`)
  out(`  100 konuşma devamı · ${threadTurns} tur üretildi · npc_threads=${threadRows.n}`)
  out(`  100 vote kararı · yukarı=${voteTally[1]} aşağı=${voteTally[-1]} kararsız=${voteTally[0]}`)
  out(`  50 konu üretim denemesi · ${created} konu üretildi`)
  out(`  100 hafıza + 100 öğrenme kaydı · npc_memory=${memoryRows.n} npc_outcomes=${outcomeRows.n}`)
  out(`  çeşitlilik: ortalama benzerlik=${avgSim.toFixed(3)} · stil=${diversity.toFixed(3)}`)
  out(
    `  saha metrikleri: şablon bağımlılığı=${site.template_dependency.toFixed(3)} ` +
      `ifade tekrarı=${site.phrase_reuse.toFixed(3)} bağlam uyumu=${site.context_alignment.toFixed(3)} ` +
      `yararlı cevap oranı=${site.useful_response_rate.toFixed(3)}`,
  )
  out(line('═'))

  const reportPath = 'reports/npc-sim-latest.md'
  mkdirSync('reports', { recursive: true })
  writeFileSync(reportPath, `# TurkChan NPC simülasyon raporu\n\n\`\`\`\n${report.join('\n')}\n\`\`\`\n`, 'utf8')
  out(`\n  Rapor yazıldı: ${reportPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})