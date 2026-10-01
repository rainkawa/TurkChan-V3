/**
 * NPC simülasyon denetimi.
 *
 * Sistemi kontrollü biçimde çalıştırır ve ÇIKTILARI İNSAN GÖZÜYLE
 * DENETLEMEK için ekrana basar:
 *
 *   1. 20 gönderi analizi   → konu, niyet, duygu, "anlamsız mı", cevaplanır mı
 *   2. 30 yorum denemesi    → farklı karakterlerin aynı bağlamda ne yazdığı
 *   3. 20 vote kararı       → hangi içeriğe oy verilecek, neden
 *   4. 10 konu üretimi      → bağlamdan türeyen gönderi başlıkları
 *   5. Uçtan uca motor turu → gerçek servisler (post/comment/vote) üzerinden
 *
 * Çalıştırma:  npm run npc:sim
 *
 * Harici API/anahtar kullanmaz; bellek içi SQLite ve sahte saat ile çalışır.
 */
import { analyzeContext } from '../src/services/npc/analyze'
import { composeComment, composePost } from '../src/services/npc/compose'
import { NPC_PERSONAS } from '../src/services/npc/personas'
import { createNpcAgents, listNpcAgents } from '../src/services/npc/agents'
import { runNpcTick } from '../src/services/npc/engine'
import { makeRng } from '../src/services/npc/rng'
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

  console.log(line('═'))
  console.log('TURKCHAN NPC SİMÜLASYONU — canlı örnek çıktı denetimi')
  console.log('Harici API yok · tamamen yerel · bellek içi SQLite')
  console.log(line('═'))

  console.log(`\nOluşturulan NPC: ${agents.length} · konu ailesi: 16 · davranış ekseni: 20\n`)

  // ---------------------------------------------------------------------
  console.log(line())
  console.log('1) GÖNDERİ ANALİZİ — 20 örnek')
  console.log(line())
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
    console.log(
      `${String(i + 1).padStart(2)}. "${raw}"\n` +
        `    konu=${a.topic} (${a.topicLabel}) · duygu=${a.sentiment} · niyet=${a.intent}` +
        ` · kavram=${a.concepts.map((c) => `${c.id}:${c.score}`).join(',') || '—'}\n` +
        `    ${flags || '—'}`,
    )
  }
  console.log(`\n  → ${trivial} gönderi "anlamsız" sayıldı (cevaplanmamalı).`)

  // ---------------------------------------------------------------------
  console.log('\n' + line())
  console.log('2) YORUM ÜRETİMİ — 5 bağlam × 6 karakter = 30 deneme')
  console.log(line())
  const contexts = [
    'Minecraft sunucusu açılmıyor, port ayarı nasıl yapılır?',
    'Telefonum çok yavaşladı, ne yapmalıyım?',
    'Bu gönderi harika olmuş, tebrik ederim!',
    'Bu maçta futbol çok iyi oynandı, gol atmak zor.',
    'HAHAHA bu çok komik 😂',
  ]
  let published = 0
  let suppressed = 0
  for (const context of contexts) {
    const analysis = analyzeContext(context)
    console.log(`\n  BAĞLAM: "${context}"  → konu=${analysis.topic} anlamsız=${analysis.isTrivial}`)
    for (const persona of NPC_PERSONAS.slice(0, 6)) {
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
        console.log(`    @${persona.username.padEnd(14)} → YAZMADI (kalite kapısı)`)
        continue
      }
      published++
      console.log(
        `    @${persona.username.padEnd(14)} → "${composed.body}"\n` +
          `        skor=${composed.score.total.toFixed(2)} bağlam=${composed.score.context.toFixed(2)} ` +
          `konu=${composed.score.topic.toFixed(2)} kişilik=${composed.score.personality.toFixed(2)} ` +
          `tekrar=${composed.score.repetition.toFixed(2)}`,
      )
    }
  }
  console.log(`\n  → ${published} yorum yayınlandı, ${suppressed} deneme kalite kapısından geçemedi.`)

  // ---------------------------------------------------------------------
  console.log('\n' + line())
  console.log('3) VOTE KARARLARI — 20 deneme')
  console.log(line())
  const rng = makeRng(4242)
  for (const [i, raw] of POSTS.entries()) {
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
    console.log(
      `${String(i + 1).padStart(2)}. @${persona.username.padEnd(14)} → ` +
        `${value === 1 ? 'YUKARI OY' : value === -1 ? 'AŞAĞI OY' : 'OY VERMEDİ'}` +
        `  (ilgi=${relevant ? 'var' : 'yok'} duygu=${analysis.sentiment} ` +
        `p(up)=${upProb.toFixed(2)} p(down)=${downProb.toFixed(2)} zar=${roll.toFixed(2)})`,
    )
  }

  // ---------------------------------------------------------------------
  console.log('\n' + line())
  console.log('4) KONU ÜRETİMİ — 10 deneme (bağlamdan türetilir)')
  console.log(line())
  const adminRow = world.ctx.db
    .prepare('SELECT username FROM users WHERE is_admin = 1')
    .get() as { username: string }
  const adminAgent = await relogin(world, adminRow.username)
  const boards = ['oyun', 'teknoloji', 'muzik']
  for (const name of boards) {
    await createCommunityVia(adminAgent, name)
  }

  let created = 0
  for (let i = 0; i < 10; i++) {
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
      console.log(`  @${persona.username.padEnd(14)} c/${board.padEnd(10)} → YAZMADI (bağlam/kalite kapısı)`)
      continue
    }
    created++
    console.log(
      `  @${persona.username.padEnd(14)} c/${board.padEnd(10)} → "${composed.title}"\n` +
        `      ${composed.body}\n` +
        `      konu=${composed.topic} skor=${composed.score.total.toFixed(2)}`,
    )
  }
  console.log(`\n  → ${created}/10 konu üretildi.`)

  // ---------------------------------------------------------------------
  console.log('\n' + line())
  console.log('5) UÇTAN UCA MOTOR — gerçek servislerle 5 tur')
  console.log(line())
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
    console.log(
      `  tur ${t}: ${result.actions} işlem · ${result.boards} board · ` +
        `toplam ${result.posts} gönderi / ${result.comments} yorum / ${result.votes} oy`,
    )
  }

  const written = world.ctx.db
    .prepare(
      `SELECT u.username, c.body FROM comments c JOIN users u ON u.id = c.author_id
        WHERE u.is_ai = 1 AND c.deleted = 0 ORDER BY c.created_at DESC LIMIT 8`,
    )
    .all() as unknown as Array<{ username: string; body: string }>
  console.log('\n  Motorun yazdığı son yorumlar:')
  for (const row of written) console.log(`    @${row.username}: ${row.body}`)

  const titles = world.ctx.db
    .prepare(
      `SELECT u.username, p.title FROM posts p JOIN users u ON u.id = p.author_id
        WHERE u.is_ai = 1 AND p.deleted = 0 ORDER BY p.created_at DESC LIMIT 8`,
    )
    .all() as unknown as Array<{ username: string; title: string }>
  console.log('\n  Motorun açtığı son gönderiler:')
  for (const row of titles) console.log(`    @${row.username}: ${row.title}`)

  // ---------------------------------------------------------------------
  console.log('\n' + line('═'))
  console.log('DENETİM SONU')
  console.log(`  20 gönderi analiz edildi · ${trivial} tanesi anlamsız işaretlendi`)
  console.log(`  30 yorum denemesi · ${published} yayınlandı · ${suppressed} kalite kapısında elendi`)
  console.log('  20 vote kararı hesaplandı')
  console.log(`  10 konu üretim denemesi · ${created} konu üretildi`)
  console.log(line('═'))
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})