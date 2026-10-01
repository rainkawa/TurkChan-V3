/**
 * CEVAP PLANI KATMANI.
 *
 * Metin yazılmadan once karar verilir: NPC'nin bu konusmada ne yapacagi
 * (cozum onermek mi, karsi cikmak mi, ayrinti istemek mi, deneyim
 * paylasmak mi...) dusunce + kisisilik + mood + hafiza + iliski +
 * konusma gecmisi ile birlikte secilir.
 *
 * Plan uretim katmanina "hangi cumle soylenecek" degil, "hangi parcalar
 * hangi sirayla kurulacak" bilgisini verir. Metin `render.ts` icinde
 * parcalardan kurulur.
 */
import type { NpcPersona } from './personas'
import type { NpcRelationshipRow } from '../../types'
import type { Thought } from './thought'
import type { Mood, Opinion, ThreadState } from './state'
import { weightedPick } from './rng'

/** Konusma hamlesi. */
export type Move =
  | 'solve'
  | 'ask_clarify'
  | 'experience'
  | 'add_info'
  | 'counter'
  | 'agree'
  | 'react'
  | 'continue'
  | 'admit_unknown'

/** Uretim sirasinda kullanilacak cumle parcalari. */
export type PartRole =
  | 'reaction'
  | 'stance'
  | 'reason'
  | 'example'
  | 'counter'
  | 'detail'
  | 'conclusion'
  | 'question'
  | 'answer'

export interface ResponsePlan {
  move: Move
  /** Onceki cevaptan tureyen tutum; iliski/ogrenme bunu izler. */
  stance: 'agree' | 'disagree' | 'question' | 'neutral' | 'build'
  /** Kurulacak parcalar (sira onemlidir). */
  parts: PartRole[]
  /** Kullanilacak bilgi (dogrulanabilir olgu). */
  fact: string | null
  /** Eminlik (0..1) — dusukse cevap daha temkinli kurulur. */
  certainty: number
  /** Gerekce (denetim gunlugu). */
  why: string
}

export interface PlanInput {
  thought: Thought
  persona: NpcPersona
  mood: Mood
  opinion: Opinion
  relationship: NpcRelationshipRow | undefined
  thread: ThreadState
  /** NPC bu konuda daha once kac kez konustu. */
  familiarity: number
  /** Kaynakta yeterli baglam var mi? */
  hasContext: boolean
  rng: () => number
}

/** Tum hamle anahtarlari (agirlik sozlugu icin). */
const MOVES: Move[] = [
  'solve',
  'ask_clarify',
  'experience',
  'add_info',
  'counter',
  'agree',
  'react',
  'continue',
  'admit_unknown',
]

/** Tutum: persona + iliski + konusma gecmisi. */
function pickStance(input: PlanInput): ResponsePlan['stance'] {
  const { persona, relationship, thread, thought } = input
  const w: Record<ResponsePlan['stance'], number> = {
    agree: 0.5 + persona.politeness * 0.4,
    disagree: persona.assertiveness * 0.9,
    question: 0.4 + persona.curiosity * 0.8,
    neutral: 0.5,
    build: 0.5 + persona.confidence * 0.5,
  }
  if (thought.kind === 'complaint' || thought.kind === 'problem') w.agree *= 1.2
  if (thought.kind === 'claim') {
    w.disagree *= 1.5
    w.agree *= 0.6
  }
  if (relationship) {
    if (relationship.friendship > 0.2) w.agree += 0.7
    if (relationship.rivalry > 0.2 || relationship.dislike > 0.2) w.disagree += 0.7
  }
  if (thread.last_stance === 'disagree' && thread.disagreement > 0.2) w.agree *= 0.5
  if (thread.last_stance === 'agree' && thread.disagreement <= 0) w.agree += 0.4
  if (input.mood.value < -0.2) {
    w.disagree *= 1.3
    w.agree *= 0.8
  }
  return weightedPick(input.rng, [
    ['agree', w.agree],
    ['disagree', w.disagree],
    ['question', w.question],
    ['neutral', w.neutral],
    ['build', w.build],
  ])
}

/** Hamle agirliklari. */
function moveWeights(input: PlanInput): Record<Move, number> {
  const { thought, persona, mood, thread, relationship, familiarity, hasContext } = input
  const fact = thought.facts[0] ?? null
  const w: Record<Move, number> = {
    // Cozum: belirti varsa ve elimizde dogrulanabilir bilgi/olası neden var.
    solve: thought.causes.length > 0 || fact !== null ? 2.4 : 0.1,
    // Netlestirme: soru var ama baglam yok — UYDURMA YAPILMAZ.
    ask_clarify: hasContext ? 0.15 : 2.6,
    // Deneyim: konuyu daha once konusmussa ve kisi paylasmaya acsa.
    experience: 0.5 + familiarity * 1.4 + persona.empathy * 0.6,
    // Bilgi ekle: kesin bilgimiz varsa.
    add_info: fact !== null ? 1.6 : 0.05,
    // Karsi gorus: iddia varsa ve karakter keskin.
    counter: thought.kind === 'claim' ? 0.4 + persona.assertiveness * 1.6 : 0.2,
    // Katilma.
    agree: 0.5 + persona.politeness * 0.5,
    // Kisa tepki: az konusan karakterler, basit olumlu/olumsuz icerik.
    react: (0.3 + (1 - persona.verbosity) * 1.2) * (thought.kind === 'smalltalk' ? 1.6 : 0.6),
    // Tartismayi surdur: ayni gonderide daha once konustuysak.
    continue: thread.replies > 0 ? 1.1 + Math.abs(thread.disagreement) * 1.5 : 0.05,
    // Bilmiyorum: eminlik cok dusuk ve kaynak belirsiz.
    admit_unknown: thought.certainty < 0.2 && !hasContext ? 1.8 : 0.05,
  }

  // Sorularda tek cümlelik alıklama yeterli degildir: konusmayi buyutten
  // bir hamle (deneyim, cozum, bilgi) secilir.
  if (thought.kind === 'question' || thought.kind === 'request') {
    w.react *= 0.2
    w.experience += 1.4
    w.solve += 1.2
    w.add_info += 0.8
  }
  // Konusu belirsiz bir yardim istegi ("Yardim istiyorum"): konu UYDURULMAZ,
  // once kaynagin kendi kelimesine donulup netlestirme sorulur.
  if (thought.kind === 'request' && thought.causes.length === 0 && thought.symptom === '') {
    w.ask_clarify += 2.2
    w.experience *= 0.5
  }
  // Konusma devamliligi: daha once sordugumuz soru hala aciksa once onu
  // takip ederiz; ayni seyi bastan soylemeyiz.
  if (thread.open_question !== '' && input.rng() < 0.45) w.continue += 1.2
  // Rakip karsi gorusu, dostluk uzlasmayi artirir.
  if (relationship && (relationship.rivalry > 0.2 || relationship.dislike > 0.2)) {
    w.counter += 1.2
    w.agree *= 0.4
  }
  if (mood.value > 0.3) {
    w.experience += 0.5
    w.react += 0.3
  }
  if (mood.value < -0.3) {
    w.counter += 0.4
    w.react *= 0.6
  }
  // Gorusun net oldugu konuda "katil" daha olasi.
  if (input.opinion.confidence > 0.6 && Math.abs(input.opinion.value) > 0.5) {
    w.agree *= 1 + input.opinion.value
    w.counter *= 1 - input.opinion.value
  }
  // Kisa yazan karakter uzun açıklamalari sevmez.
  if (persona.verbosity < 0.35) {
    w.solve *= 0.6
    w.experience *= 0.7
  }
  return w
}

/** Hamle secimi: dusunce + kisisilik + hafiza + iliski + konusma gecmisi. */
export function planResponse(input: PlanInput): ResponsePlan {
  const { thought } = input

  // SORUYA SOMUT CEVAP: elimizde dogrulanabilir bilgi varsa (knowledge.ts)
  // kalip cumle kurulmaz, cevap yazilir. Tutum "build" olur: karakter
  // gonderinin uzerine somut bir sey kuruyor, katilmiyor ya da soru
  // sormuyor. Bu yol bilincidir; rastgele secim devre disi kalir.
  if (thought.facts.length > 0 && (thought.kind === 'question' || thought.kind === 'request')) {
    // `fact` bilerek null birakilir: parca katmani kayit arasindan secim yapar,
    // boylece on NPC ayni gonderiye ayni cumleyi yazmaz.
    const fact = null
    return {
      move: 'add_info',
      stance: 'build',
      // Her zaman bir giris parcasi: on NPC'nin hepsi ayni cevabi yazmasin,
      // herkes farkli bir girişle bağlarsin.
      parts: input.persona.verbosity >= 0.45 ? ['stance', 'answer'] : ['reaction', 'answer'],
      fact,
      certainty: thought.certainty,
      why:
        'soruya somut cevap | bilgi=' +
        thought.facts.length +
        ' | kesinlik=' +
        thought.certainty.toFixed(2),
    }
  }

  const w = moveWeights(input)
  const entries = MOVES.map((m) => [m, w[m]] as [Move, number])
  const move = weightedPick(input.rng, entries)
  const stance = pickStance(input)
  return {
    move,
    stance: move === 'counter' ? 'disagree' : stance,
    parts: partsFor(move, input.persona, thought),
    fact: thought.facts[0] ?? null,
    certainty: thought.certainty,
    why:
      move +
      ' | tur=' +
      thought.kind +
      ' | kesinlik=' +
      thought.certainty.toFixed(2) +
      ' | goru=' +
      input.opinion.value.toFixed(2),
  }
}

/** Hamle → kurulacak parcalar. */
function partsFor(move: Move, persona: NpcPersona, thought: Thought): PartRole[] {
  const rich = persona.verbosity > 0.55
  switch (move) {
    case 'solve':
      return rich ? ['reaction', 'reason', 'detail', 'question'] : ['reason', 'detail']
    case 'ask_clarify':
      return ['reaction', 'question']
    case 'experience':
      return rich ? ['stance', 'example', 'detail'] : ['stance', 'example']
    case 'add_info':
      return rich ? ['stance', 'reason', 'detail'] : ['reason', 'detail']
    case 'counter':
      return rich ? ['stance', 'counter', 'conclusion'] : ['stance', 'counter']
    case 'agree':
      return rich ? ['stance', 'example', 'conclusion'] : ['stance', 'example']
    case 'react':
      return ['reaction']
    case 'continue':
      return rich ? ['stance', 'counter', 'question'] : ['stance', 'question']
    case 'admit_unknown':
      return ['stance', 'question']
    default:
      return thought.causes.length > 0 ? ['reason', 'detail'] : ['stance']
  }
}

/** Hamlenin insan okunur adi (denetim gunlugu). */
export const MOVE_LABELS: Record<Move, string> = {
  solve: 'cozum oner',
  ask_clarify: 'ayrinti iste',
  experience: 'deneyim paylas',
  add_info: 'bilgi ekle',
  counter: 'karsi gorus',
  agree: 'katil',
  react: 'kisa tepki',
  continue: 'tartismayi surdur',
  admit_unknown: 'bilmiyorum de',
}
