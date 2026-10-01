/**
 * NPC ÜRETİM ORKESTRATÖRÜ.
 *
 * ESKİ MİMARİ: "OPENERS/BODIES/ADVICE havuzlarından bir cümle seç, kalite
 * kapısına sor, geçmezse başka bir kalıp seç." Bu yöntem 50 karakteri de
 * aynı kalıpları dolduran botlara dönüştürüyordu.
 *
 * YENİ MİMARİ (bu dosya yalnızca orkestrasyon yapar):
 *
 *   1. DÜŞÜNCE  (thought.ts)  — okunan içerik ne söylüyor, ne soruyor,
 *                              hangi belirti/olay var, elimizde hangi
 *                              doğrulanabilir bilgi var?
 *   2. YAŞAM    (state.ts)    — bu gönderide daha önce ne dedim, bu konuda
 *                              görüşüm ne, moodum ne, ne biliyorum?
 *   3. PLAN     (plan.ts)     — bu konuşmada ne yapacağım (çözüm, karşı
 *                              görüş, ayrıntı isteme, deneyim, bilgi…)
 *   4. PARÇA    (fragments.ts + grammar.ts) — cümleler hazır seçilmez;
 *                              köklerden, eklerden ve kaynak kelimelerden
 *                              kurulur.
 *   5. DENETİM  (selfcheck.ts + quality.ts) — kaynakla ilgili mi, soruya
 *                              cevap veriyor mu, karaktere uygun mu,
 *                              önceki mesajla çelişiyor mu, gramer doğru mu.
 *                              Başarısızsa farklı plan/fragment ile yeniden
 *                              üretilir.
 *   6. YEDEK    (legacy.ts)   — ancak zincir hiçbir aday üretemezse
 *                              eski kalıp havuzlarına DÜŞÜLÜR (fallback).
 *
 * Harici servis/model/API YOKTUR.
 */
import type { Ctx } from '../../context'
import type { ContextAnalysis } from './analyze'
import type { NpcPersona } from './personas'
import { CONCEPTS, stem, trLower } from './lexicon'
import { makeRng } from './rng'
import { scoreText } from './quality'
import type { QualityScore } from './quality'
import { normalizePhrase, rememberPhrase, topConcepts, recentPhrases } from './memory'
import { behaviorOf } from './learning'
import { legacyComment } from './legacy'
import { think, describeThought, type Thought } from './thought'
import { planResponse, MOVE_LABELS, type ResponsePlan } from './plan'
import { buildFragment, type FragmentInput } from './fragments'
import { render, tooSimilar } from './render'
import { selfCheck } from './selfcheck'
import { similarity } from './grammar'
import {
  factsAbout,
  moodOf,
  opinionOf,
  rememberFact,
  threadOf,
  touchFact,
  type Mood,
  type ThreadState,
} from './state'
import { composeTopicPost } from './topics'

/** Bir üretim denemesi için en fazla aday sayısı. */
const MAX_ATTEMPTS = 6

/** Cevabın tutumu — ilişki ve sonuç puanlamasında kullanılır. */
export type Stance = 'agree' | 'disagree' | 'question' | 'neutral' | 'build'

export interface ComposeInput {
  agentId: string
  persona: NpcPersona
  analysis: ContextAnalysis
  /** Okunan içerik (ham metin). */
  content: string
  /** Yazarın NPC'ye karşı ilişkisi. */
  relationship?: import('../../types').NpcRelationshipRow
  /** NPC'nin bu konuyla ilgili geçmiş hatırlama gücü (0..1). */
  memoryWeight?: number
  /** Tohum (test edilebilirlik için). */
  seed: number
  /** Gönderi üretimi mi? */
  kind?: 'comment' | 'post'
  /** Gönderi başlığı için board adı. */
  boardName?: string
  /** Konuşma devamlılığı için gönderi kimliği. */
  postId?: string
  /** Board kültürü (yeni konu üretimi). */
  board?: { name: string; title: string; description: string }
  /** Boarddaki gündemdeki gerçek başlıklar (yeni konu üretimi). */
  agenda?: string[]
  /** İlişki bağlamı (yeni konu üretimi). */
  peerAffinity?: number
}

/** Denetim izi — yönetim panelinde gösterilir. */
export interface ComposeTrace {
  plan: string
  thought: string
  memory: string
  relationship: string
  mood: string
  rejected: string
  fact: string | null
}

export interface ComposedReply {
  body: string
  stance: Stance
  /** Kullanılan üretim biçimi (öğrenme ve metrikler bunu izler). */
  style: string
  score: QualityScore
  trace: ComposeTrace
}

export interface ComposedPost {
  title: string
  body: string
  style: string
  score: QualityScore
  topic: string
}

/** Bir kavram ailesinden türetilebilecek somut kelimeler. */
function topicWords(topic: string): string[] {
  const concept = CONCEPTS.find((c) => c.id === topic)
  return concept ? concept.stems.slice(0, 8) : []
}

/**
 * Konuya uygun bir tutum seçer (ilişki + persona + ton).
 *
 * Dışa açık tutulur: motorun karar mantığı testlerde doğrudan sınanır.
 */
export function chooseStance(
  analysis: ContextAnalysis,
  persona: NpcPersona,
  relationship: import('../../types').NpcRelationshipRow | undefined,
  rng: () => number,
): Stance {
  const w: Record<Stance, number> = {
    agree: 0.8 + persona.politeness * 0.5 + persona.empathy * 0.4,
    disagree: persona.assertiveness * 1.2 + persona.skepticism * 0.5,
    question: persona.curiosity * 1.2 + persona.verbosity * 0.4,
    neutral: 0.6,
    build: persona.verbosity * 0.6 + persona.confidence * 0.4,
  }
  if (analysis.sentiment === 'negative') {
    w.agree *= 1.3
    w.disagree *= 0.7
  }
  if (analysis.isQuestion) w.question *= 1.5
  if (analysis.isArgument) {
    w.disagree *= 1.8
    w.agree *= 0.5
  }
  if (relationship) {
    if (relationship.friendship > 0.2) w.agree += 0.8
    if (relationship.rivalry > 0.2 || relationship.dislike > 0.2) w.disagree += 0.8
  }
  const entries: Array<[Stance, number]> = [
    ['agree', w.agree],
    ['disagree', w.disagree],
    ['question', w.question],
    ['neutral', w.neutral],
    ['build', w.build],
  ]
  const total = entries.reduce((sum, [, weight]) => sum + Math.max(0.01, weight), 0)
  let roll = rng() * total
  for (const [stance, weight] of entries) {
    roll -= Math.max(0.01, weight)
    if (roll <= 0) return stance
  }
  return 'neutral'
}

/** Kaynak metnin kökleri (denetimde kullanılır). */
function sourceRoots(input: ComposeInput): string[] {
  return [
    ...new Set(
      [...input.analysis.words, ...input.analysis.keywords, input.analysis.subject, input.analysis.focus]
        .map((w) => stem(w))
        .filter((w) => w.length >= 4),
    ),
  ]
}

/** Geçmiş ifadelerden çok benzeyen adayları eler (özgünlük). */
function avoidRecent(ctx: Ctx, agentId: string, body: string): boolean {
  const recent = recentPhrases(ctx, agentId, 12)
  return recent.every((phrase) => similarity(body, phrase) < 0.6)
}

/**
 * AYNI GÖNDERİYE YAZAN DİĞER NPC'LERDEN FARKLILIK.
 *
 * 10 NPC aynı kaynağa cevap yazdığında kalıplar birbirine dönmemesi için
 * son üretilen metinler süreç içi bir önbellekte tutulur ve yeni aday
 * bunlara fazla benzerse elenir (madde 19: pairwise similarity).
 */
const POST_DUP_CACHE = new Map<string, string[]>()
const DUP_CACHE_LIMIT = 40
const DUP_CACHE_KEYS = 200

function tooSimilarOnPost(postKey: string, body: string, limit = 0.62): boolean {
  const list = POST_DUP_CACHE.get(postKey) ?? []
  if (list.some((other) => similarity(body, other) >= limit)) return true
  // Tam metin benzerliği eşiğin altında kalsa bile aynı açılış cümlesi
  // tekrarlanıyorsa okuyucu "hepsi aynı bot" izlenimi alır. İlk cümle
  // ayrıca karşılaştırılır.
  const opener = openingOf(body)
  return opener !== '' && list.some((other) => openingOf(other) === opener)
}

function rememberOnPost(postKey: string, body: string): void {
  const list = POST_DUP_CACHE.get(postKey) ?? []
  list.push(body)
  if (list.length > DUP_CACHE_LIMIT) list.shift()
  POST_DUP_CACHE.set(postKey, list)
  // Anahtar sayisi sinirsiz buyumesin (uzun sureli surecde bellek sizintisi).
  if (POST_DUP_CACHE.size > DUP_CACHE_KEYS) {
    const oldest = POST_DUP_CACHE.keys().next()
    if (!oldest.done) POST_DUP_CACHE.delete(oldest.value)
  }
}

/**
 * YORUM ÜRETİR — yeni mimari.
 *
 * @returns null → hiçbir aday geçemedi, karakter sessiz kalır.
 */
export function composeComment(ctx: Ctx, input: ComposeInput): ComposedReply | null {
  const { persona, analysis, content, seed } = input

  // KONUSUZ ANLAMSIZ İÇERİK: cevap uydurulmaz.
  //
  // “Konu” kelimesi tanınmayan ama gerçek bir ifade varsa (“Bugün moralim çok
  // bozuk”, “Bu oyunun yeni sezonu sizce nasıl?”) NPC konuyu UYDURMAZ:
  // düşünce motoru kaynaktaki özneyi kullanır, plan katmanı netleştirme ya da
  // tepki seçer. Ancak içerik gerçekten anlamsızsa (kahkaha, tek kelime) hiçbir
  // şey yazılmaz.
  const topicless = analysis.mediaKind === 'none' && analysis.concepts.length === 0
  if (analysis.isTrivial || analysis.wordCount < 2) return null
  if (topicless && analysis.mediaKind !== 'none' && !analysis.isQuestion) return null

  const policy = behaviorOf(ctx, input.agentId, analysis.topic)
  const thought: Thought = think(content, analysis)
  const thread: ThreadState = input.postId !== undefined ? threadOf(ctx, input.agentId, input.postId) : emptyThread()
  const opinion = opinionOf(ctx, input.agentId, analysis.topic)
  const mood: Mood = moodOf(ctx, input.agentId, ctx.now(), persona.patience)
  const known = factsAbout(ctx, input.agentId, thought.subjectRoot !== '' ? thought.subjectRoot : analysis.topic)
  const familiarity = Math.min(1, (input.memoryWeight ?? 0) + opinion.samples * 0.2)
  const roots = sourceRoots(input)
  const recent = recentPhrases(ctx, input.agentId, 10)
  const humorRecently = recent.some((p) => /😂|🤣/u.test(p))

  let best: ComposedReply | null = null
  const rejected: string[] = []

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = makeRng(seed + attempt * 7919)
    const plan = planResponse({
      thought,
      persona,
      mood,
      opinion,
      relationship: input.relationship,
      thread,
      familiarity,
      hasContext: roots.length > 0,
      rng,
    })

    const fragmentInput: FragmentInput = { thought, persona, opinion, thread, rng }
    const result = render(
      plan,
      fragmentInput,
      { persona, rng, humorRecently, lengthWeight: policy.length_w, humorWeight: policy.humor_w },
      attempt,
    )
    if (result.text === '') {
      rejected.push('parça yok')
      continue
    }

    // 5) DENETİM: dilbilgisi + kaynak + tutarlılık.
    const asksBack = result.usedParts.includes('question') || result.text.includes('?')
    // Bilgi cevabında `plan.fact` null olabilir (parça katmanı kayıt arasından
    // seçer); denetime ve hafızaya yazılacak olgu yine ilk kayıttır.
    const factUsed = plan.fact ?? (plan.move === 'add_info' ? (thought.facts[0] ?? null) : null)
    const check = selfCheck({
      text: result.text,
      thought,
      persona,
      sourceRoots: roots,
      lastStatement: thread.last_statement,
      askedQuestion: analysis.isQuestion || analysis.isHelpRequest,
      fact: factUsed,
      asksBack,
    })
    const score = scoreText(ctx, input.agentId, result.text, analysis, persona)

    const candidate: ComposedReply = {
      body: result.text,
      stance: plan.stance,
      style: plan.move,
      score,
      trace: {
        plan: `${MOVE_LABELS[plan.move]} · ${plan.why} · parçalar=${result.usedParts.join('>')}${
          result.styleActions.length > 0 ? ` · stil=${result.styleActions.join('+')}` : ''
        }`,
        thought: describeThought(thought),
        memory: `görüş=${opinion.value.toFixed(2)}/emniyet=${opinion.confidence.toFixed(2)} · geçmiş=${familiarity.toFixed(2)} · bilgi=${known.length} · thread=${thread.replies}`,
        relationship: input.relationship
          ? `dostluk=${input.relationship.friendship.toFixed(2)} saygı=${input.relationship.respect.toFixed(2)} rakip=${input.relationship.rivalry.toFixed(2)}`
          : 'ilk temas',
        mood: `${mood.label} (${mood.value.toFixed(2)})`,
        rejected: check.reasons.length === 0 ? '' : check.reasons.join(', '),
        fact: factUsed,
      },
    }

    // Ayni gonderiye yazan DIGER karakterlerden ayrilma filtresi yalnizca
    // gercek bir gonderi kimligi varken calisir. Kimlik yoksa ayni karakter
    // farkli tohumlarla yeniden uretir ve filtre onun seceneklerini elerdi.
    const postKey = input.postId
    const usable =
      check.ok &&
      result.ok &&
      score.ok &&
      avoidRecent(ctx, input.agentId, result.text) &&
      (thread.last_statement === '' || !tooSimilar(result.text, thread.last_statement, 0.7)) &&
      (postKey === undefined || !tooSimilarOnPost(postKey, result.text))

    if (usable) {
      if (postKey !== undefined) rememberOnPost(postKey, result.text)
      rememberPhrase(ctx, input.agentId, result.text, ctx.now())
      if (factUsed !== null) {
        rememberFact(ctx, input.agentId, thought.subjectRoot, factUsed, 'bilgi', 0.6, ctx.now())
        touchFact(ctx, input.agentId, thought.subjectRoot, factUsed, score.total > 0.6, ctx.now())
      }
      return candidate
    }

    if (check.reasons.length > 0) rejected.push(check.reasons.join('/'))
    if (!score.ok) rejected.push(`kalite ${score.reasons.join('/')}`)
    if (!result.ok) rejected.push(result.lintReasons.join('/'))
    if (check.ok && score.ok && result.ok) {
      if (!avoidRecent(ctx, input.agentId, result.text)) rejected.push('kendi ifadesini tekrar ediyor')
      if (thread.last_statement !== '' && tooSimilar(result.text, thread.last_statement, 0.7)) {
        rejected.push('onceki mesaja benzer')
      }
      if (postKey !== undefined && tooSimilarOnPost(postKey, result.text)) {
        rejected.push('ayni gonderide baska biri yazdi')
      }
    }
    if (!best || candidate.score.total > best.score.total) best = candidate
  }

  // 6) SON DEĞERLENDİRME: denetimden geçen en iyi yeni-mimari aday.
  //    Eski kalıp havuzuna düşmek, yeni zincirin ürettiği bir metinden
  //    daha kötüdür: aday kaynakla ilgiliyse önce o tercih edilir.
  if (best && best.score.total >= 0.45 && best.score.context > 0) {
    best.trace.rejected = rejected.slice(0, 4).join(' | ')
    best.trace.plan += ' · (son değerlendirme)'
    return best
  }

  // 7) YEDEK: yalnızca yeni zincir hiçbir aday üretemezse eski kalıp havuzu.
  const fallback = fallbackReply(ctx, input, thought, policy.engage_w)
  if (fallback) {
    fallback.trace.rejected = rejected.slice(0, 4).join(' | ')
    return fallback
  }
  return null
}

/** Bir metnin ilk cümlesi, karşılaştırma anahtarı olarak küçük harfe iner. */
function openingOf(body: string): string {
  const first = body.split(/(?<=[.!?…])\s/u)[0] ?? ''
  return first.trim().toLocaleLowerCase('tr')
}

/** Boş thread durumu (post kimliği bilinmiyorsa). */
function emptyThread(): ThreadState {
  return {
    agent_id: '',
    post_id: '',
    subject: '',
    last_stance: '',
    last_statement: '',
    open_question: '',
    disagreement: 0,
    replies: 0,
    updated_at: 0,
  }
}

/** Son çare: eski kalıp havuzları. */
function fallbackReply(
  ctx: Ctx,
  input: ComposeInput,
  thought: Thought,
  engageWeight: number,
): ComposedReply | null {
  const rng = makeRng(input.seed + 104729)
  const words = topicWords(input.analysis.topic)
  const stance = chooseStance(input.analysis, input.persona, input.relationship, rng)
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = legacyComment({
      analysis: input.analysis,
      persona: input.persona,
      words,
      stance,
      rng: makeRng(input.seed + attempt * 31 + 5),
    })
    const score = scoreText(ctx, input.agentId, body, input.analysis, input.persona)
    if (score.ok) {
      rememberPhrase(ctx, input.agentId, body, ctx.now())
      void engageWeight
      return {
        body,
        stance,
        style: 'fallback-template',
        score,
        trace: {
          plan: 'yedek şablon (yeni zincirden aday çıkmadı)',
          thought: describeThought(thought),
          memory: '',
          relationship: '',
          mood: '',
          rejected: '',
          fact: null,
        },
      }
    }
  }
  return null
}

/**
 * GÖNDERİ ÜRETİR — yorum üretiminden tamamen ayrı bir yol.
 *
 * Konu: NPC'nin ilgi alanı + hafızası + board kültürü + boarddaki gündemdeki
 * gerçek içerik. Hazır "şu konuda bir sorum var" havuzu yoktur.
 */
export function composePost(ctx: Ctx, input: ComposeInput): ComposedPost | null {
  if (input.analysis.topic === 'gündelik' || input.analysis.concepts.length === 0) return null
  return composeTopicPost(ctx, input)
}

/**
 * Bir NPC'nin en çok ilgilendiği konular (hafıza + ilgi alanları).
 */
export function suggestTopics(ctx: Ctx, agentId: string, persona: NpcPersona): string[] {
  const remembered = topConcepts(ctx, agentId, 5).map((c) => c.id)
  const interests = persona.interests.map((i) => trLower(i))
  return [...new Set([...remembered, ...interests])].slice(0, 6)
}

/** Kelime kökü yardımcısı (dışarıdan test edilebilir olsun diye dışa açık). */
export { stem, normalizePhrase, buildFragment }
export type { ResponsePlan, Thought }
