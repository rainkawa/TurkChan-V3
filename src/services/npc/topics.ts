/**
 * YENİ KONU (GÖNDERİ) ÜRETİMİ — yorum üretiminden ayrı bir yol.
 *
 * Gönderi üretimi yorum üretiminin küçük bir varyantı DEĞİLDİR. Burada
 * konu şu dört kaynaktan türetilir:
 *
 *   1. NPC'nin ilgi alanı (ilgi ekseni)
 *   2. NPC'nin o konudaki hafızası ve görüşü
 *   3. Board kültürü (board adı, başlığı, açıklaması)
 *   4. Boarddaki GÜNDEMDEKİ GERÇEK İÇERİK (son gönderi başlıkları)
 *
 * "Şu konuda bir sorum var" havuzundan başlık seçilmez: başlık ve gövde,
 * gündemdeki gerçek başlıklardan ve karakterin kendi deneyiminden kurulur.
 */
import type { Ctx } from '../../context'
import type { ContextAnalysis } from './analyze'
import type { NpcPersona } from './personas'
import { CONCEPTS, stem, trLower } from './lexicon'
import { makeRng } from './rng'
import { scoreText } from './quality'
import { rememberPhrase } from './memory'
import { behaviorOf } from './learning'
import { finishSafe, joinSentences, possessive, dative } from './grammar'
import { analyzeContext } from './analyze'
import { memoryWeight, rememberConcept, recordEpisode } from './memory'
import { opinionOf, rememberFact, shiftOpinion, factsAbout } from './state'
import type { ComposedPost } from './compose'

/** Gönderi üretiminin girdisi. */
export interface PostInput {
  agentId: string
  persona: NpcPersona
  analysis: ContextAnalysis
  content: string
  seed: number
  boardName?: string
  board?: { name: string; title: string; description: string }
  /** Boarddaki gündemdeki gerçek başlıklar. */
  agenda?: string[]
  peerAffinity?: number
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length] as T
}

/** Kavram ailesinden gerçek bir konu sözcüğü. */
function topicWord(topic: string, rng: () => number): string {
  const concept = CONCEPTS.find((c) => c.id === topic)
  if (!concept) return ''
  // İlk iki stem soyut ("oyun"), sonrakiler somuttur ("minecraft", "valorant").
  // Sözlükte ASCII karşılıkları da var ("sarki", "sanatci"); bunlar bağlam için
  // gereklidir ama başlığa girerse Türkçe yazım bozulur.
  const turkish = concept.stems.slice(2, 12).filter((s) => /[ıİşğüöçŞĞÜÖÇ]/u.test(s))
  const concrete = turkish.length > 0 ? turkish : concept.stems.slice(2, 10)
  const pool = concrete.length > 0 ? concrete : concept.stems
  return pick(rng, pool)
}

/** Gündemdeki gerçek bir başlıktan somut bir kelime çeker. */
function agendaAnchor(agenda: string[], rng: () => number): string {
  if (agenda.length === 0) return ''
  const title = pick(rng, agenda)
  const words = trLower(title)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4)
  return words.length > 0 ? pick(rng, words) : ''
}

/**
 * Yeni konu üretir.
 *
 * @returns `null` — bağlam yetersizse gönderi açılmaz (konu uydurulmaz).
 */
export function composeTopicPost(ctx: Ctx, input: PostInput): ComposedPost | null {
  const { persona, analysis, seed, board, agenda = [] } = input
  if (analysis.topic === 'gündelik') return null

  const policy = behaviorOf(ctx, input.agentId, analysis.topic)
  const boardText = `${board?.name ?? input.boardName ?? ''} ${board?.title ?? ''} ${board?.description ?? ''}`.trim()
  const agendaText = agenda.join(' ').slice(0, 400)

  // Kaynak metin: board kültürü + gündem. Konu buradan da türetilebilir.
  const sourceText = `${boardText} ${agendaText}`.trim()
  const analysisFull = sourceText === '' ? analysis : analyzeContext(sourceText.slice(0, 600))
  const topic = analysisFull.topic !== 'gündelik' ? analysisFull.topic : analysis.topic

  const word = topicWord(topic, makeRng(seed)) || boardText.split(' ')[0] || ''
  if (word === '') return null

  const anchor = agendaAnchor(agenda, makeRng(seed + 11))
  const opinion = opinionOf(ctx, input.agentId, topic)
  const familiarity = memoryWeight(ctx, input.agentId, topic)
  const known = factsAbout(ctx, input.agentId, stem(word), 2)

  let best: ComposedPost | null = null

  for (let attempt = 0; attempt < 4; attempt++) {
    const rng = makeRng(seed + attempt * 104729)
    const { title, body } = buildPost(rng, { input, word, anchor, opinion, familiarity, known, boardText, topic })
    const score = scoreText(ctx, input.agentId, `${title} ${body}`, { ...analysis, subject: word }, persona)
    const titleOk = title.length >= 12 && title.length <= 110 && !/[*_#`\n]/u.test(title)
    if (score.ok && titleOk) {
      rememberPhrase(ctx, input.agentId, title, ctx.now())
      // Konu hafızaya yazılır: yeni gönderiler aynı konudan türer.
      rememberConcept(ctx, input.agentId, topic, 0.04, ctx.now())
      shiftOpinion(ctx, input.agentId, topic, 0.1 * Math.max(0, 1 - familiarity), 0.2, ctx.now())
      recordEpisode(
        ctx,
        input.agentId,
        { concept: topic, summary: `${topic} konusunda yeni gönderi: ${title}`, score: score.total },
        ctx.now(),
      )
      if (anchor !== '') {
        rememberFact(ctx, input.agentId, stem(anchor), `${anchor} boardda gündemde`, 'tanıdık', 0.4, ctx.now())
      }
      return { title, body, style: 'post-düşünce', score, topic }
    }
    if (!best || score.total > best.score.total) {
      best = { title, body, style: 'post-düşünce', score, topic }
    }
    void policy
  }
  return best && best.score.total >= 0.5 && best.score.context > 0 ? best : null
}

/** Başlık + gövde kurulumu. */
function buildPost(
  rng: () => number,
  parts: {
    input: PostInput
    word: string
    anchor: string
    opinion: { value: number; confidence: number }
    familiarity: number
    known: Array<{ fact: string }>
    boardText: string
    topic: string
  },
): { title: string; body: string } {
  const { input, word, anchor, opinion, familiarity, known, boardText } = parts
  const { persona } = input

  // BAŞLIK: gerçek sözcüklerden kurulur (şablon havuzu yok).
  const titleFrames = [
    `${word} tarafında ${pick(rng, ['bir şeyler değişti', 'eskisi gibi değil', 'uzun süredir kimse bakmıyor'])}`,
    `${word} konusunda ${pick(rng, ['kafamda bir soru var', 'bir açıklama bekliyorum', 'iki farklı görüş gördüm'])}`,
    `${word} ile ilgili ${pick(rng, ['kendi notlarımı paylaşayım', 'uzun zamandır biriken izlenimlerim var', 'deneyimlerimi yazayım'])}`,
  ]
  let title = pick(rng, titleFrames)
  if (anchor !== '' && rng() < 0.5) title = `${title} (${anchor})`.slice(0, 110)

  // GÖVDE: düşünce parçalarından kurulur.
  const sentences: string[] = []
  const opener = pick(rng, [
    `${boardText.split(' ')[0] ?? word} tarafında sürekli aynı şeyler konuşuluyor`,
    `${capitalizeFirst(word)} tarafında son zamanlarda kafamda birikenler var`,
    `buradaki ${word} başlıklarını okurken şunu düşündüm`,
    `${capitalizeFirst(word)} başlıkları altında bugün biraz bekledim`,
  ])
  sentences.push(opener)
  if (anchor !== '') {
    sentences.push(`${capitalizeFirst(anchor)} tarafındaki tartışma da buna yakın bir konu gibi görünüyor`)
  }
  if (known.length > 0 && rng() < 0.6) {
    sentences.push(pick(rng, ['elimde şu bilgi var', 'önceden not aldığım şuydu', 'geçen denememde şunu gördüm']) + `: ${known[0]!.fact}`)
  }
  const opinionWord = opinion.value > 0.3 ? 'bende olumlu bir izlenim bıraktı' : opinion.value < -0.3 ? 'bende olumsuz bir izlenim bıraktı' : 'bende tam net bir yön oluşmadı'
  sentences.push(
    familiarity > 0.4
      ? `Bu konuda ${possessive(word, 'ben')} tarafında ${opinionWord}, ${dative(word)} da birkaç sorum kaldı`
      : `Konuyu ${pick(rng, ['biraz daha açmak', 'somut örneklerle konuşmak', 'birlikte değerlendirmek'])} istiyorum`,
  )
  if (persona.curiosity > 0.6 && rng() < persona.curiosity * 0.6) {
    sentences.push(`${capitalizeFirst(word)} konusunda siz ne düşünüyorsunuz?`)
  }
  if (persona.verbosity > 0.7 && rng() < 0.4) {
    sentences.push(pick(rng, ['Yardımcı olabilecek bir şey varsa yazın', 'Farklı deneyimi olan varsa katılımı beklerim', 'Konuyu dağıtmadan konuşalım']))
  }
  if (persona.slang_rate > 0.5 && rng() < persona.slang_rate * 0.4) {
    sentences.push(pick(rng, ['Herkese selam', 'Merhaba arkadaşlar']))
  }
  const body = finishSafe(joinSentences(sentences)).slice(0, 700)
  void opinionWord
  return { title: finishSafe(title).replace(/[.!?…]+$/u, ''), body }
}

function capitalizeFirst(word: string): string {
  return word === '' ? word : `${(word[0] as string).toLocaleUpperCase('tr')}${word.slice(1)}`
}
