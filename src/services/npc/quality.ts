/**
 * Yorum/gönderi kalite kontrolü.
 *
 * Üretilen metin YAYINLANMADAN ÖNCE beş ayrı skorla değerlendirilir:
 *   contextScore    — okunan içerikle alakalı mı?
 *   personalityScore — karakterin kişiliğine uygun mu?
 *   repetitionScore — daha önce kullanılan ifade mi?
 *   coherenceScore  — cümle yapısı ve biçim geçerli mi?
 *   topicScore      — baskın konu ailesini kullanıyor mu?
 *
 * TOPLAM SKOR eşiğin altındaysa mesaj YAYINLANMAZ ve üretici yeni bir
 * aday dener (`compose.ts` → `for attempt of ...`). Saçma içerik üretmektense
 * yazmamak yeğdir.
 *
 * Bu katman bağlam motorunun en kritik parçasıdır: "HAHAHA bu çok komik"
 * yazılınca üretilen bir futbol cümlesi topicScore/contextScore eşiğini
 * geçemez ve elenir.
 */
import type { ContextAnalysis } from './analyze'
import type { NpcPersona } from './personas'
import { CONCEPTS, stem, trLower } from './lexicon'
import { phraseUses, normalizePhrase } from './memory'
import type { Ctx } from '../../context'

/** Yayınlanabilmesi için gereken minimum toplam skor. */
export const MIN_SCORE = 0.55

/** Skor bileşenleri ve toplamı. */
export interface QualityScore {
  context: number
  personality: number
  repetition: number
  coherence: number
  topic: number
  total: number
  /** Yayınlanabilir mi? */
  ok: boolean
  /** Neden reddedildi (yönetim günlüğü ve hata ayıklama). */
  reasons: string[]
}

/** Biçim olarak geçersiz kalıplar. */
const BAD_FORMATS =
  /```|^#{1,6}\s|^\s*[-*•]\s|\[link|\]\(|https?:\/\/|\*\*|__|<[a-z]/iu

/** Cümleleri böler. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/u).filter((s) => s.trim() !== '')
}

/**
 * Bağlam skoru: metin, okunan içerikle ne kadar örtüşüyor?
 *
 * Kaynak metnin kökleri ve analiz anahtar kelimeleri kullanılır. Metin
 * hiçbir kökü taşımıyorsa alakasızdır → 0.
 */
export function contextScore(text: string, analysis: ContextAnalysis): number {
  const textRoots = new Set(text.split(/\s+/u).map(stem).filter((w) => w.length >= 3))
  const sourceRoots = new Set([...analysis.words.map(stem), ...analysis.keywords.map(stem)])

  // Kaynak köklerinin kaçı yanıtta geçiyor?
  let overlap = 0
  for (const root of sourceRoots) {
    if (root.length >= 3 && textRoots.has(root)) overlap += 1
  }
  // Öznenin doğrudan geçmesi en güçlü sinyaldir.
  const subjectBonus =
    analysis.subject !== '' && textRoots.has(stem(analysis.subject)) ? 0.35 : 0

  if (overlap === 0 && subjectBonus === 0) return 0
  const ratio = overlap / Math.max(1, Math.min(6, sourceRoots.size))
  return Math.min(1, 0.35 + ratio * 0.9 + subjectBonus)
}

/**
 * Kişilik skoru: metin karakterin kişiliğiyle tutarlı mı?
 *
 * Nazik karakter küfürlü/keskin bir cevap verirse, ciddi karakter emoji
 * saçarsa, kısa konuşan karakter uzun paragraf yazarsa puan düşer.
 */
export function personalityScore(text: string, persona: NpcPersona): number {
  let score = 0.7 // varsayılan: nötr bir cevap her karakter için kabul edilebilir
  const lower = trLower(text)

  // Nezaket / sertlik tutarlılığı.
  const harsh = /\b(saçma|aptal|salak|yapma|bırak|kes artık|ne saçma)\b/iu.test(lower)
  const soft = /\b(umarım|rica ederim|özür dilerim|lütfen|nasıl yardımcı)\b/iu.test(lower)
  if (harsh && persona.politeness > 0.6) score -= 0.3
  if (soft && persona.politeness < 0.3) score -= 0.2
  if (harsh && persona.politeness < 0.4) score += 0.2
  if (soft && persona.politeness > 0.7) score += 0.15

  // Ciddiyet / emoji tutarlılığı.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)
  if (emoji && persona.seriousness > 0.7 && persona.emoji_rate < 0.3) score -= 0.2
  if (emoji && persona.emoji_rate > 0.6) score += 0.1

  // Uzunluk / konuşkanlık tutarlılığı.
  const count = sentences(text).length
  if (count <= 2 && persona.verbosity > 0.7) score -= 0.15
  if (count >= 4 && persona.verbosity < 0.3) score -= 0.2

  // Argo tutarlılığı.
  const slangy = /\b(la|lan|aq|moruk|kanka|abi|reis|adam)\b/iu.test(lower)
  if (slangy && persona.slang_rate < 0.2) score -= 0.15
  if (slangy && persona.slang_rate > 0.5) score += 0.1

  // Sakin/nazik karakter emoji kullanmıyorsa pozitif.
  if (!emoji && persona.emoji_rate < 0.2) score += 0.05

  return Math.min(1, Math.max(0, score))
}

/**
 * Tekrar skoru: bu ifade daha önce kaç kez kullanıldı?
 *
 * Tamamen yeni ve özgün cümleler yüksek puan alır; aynı NPC'nin
 * arka arkaya aynı kalıbı kullanması puanı düşürür.
 */
export function repetitionScore(
  ctx: Ctx,
  agentId: string,
  text: string,
): number {
  const normalized = normalizePhrase(text)
  if (normalized === '') return 0
  const uses = phraseUses(ctx, agentId, normalized)
  if (uses === 0) return 1
  // Bir kez daha: hafif ceza. İki kez: ağır. Üç+: elenir.
  return uses === 1 ? 0.5 : uses === 2 ? 0.2 : 0
}

/**
 * Tutarlılık skoru: metin dilbilgisel/biçimsel olarak geçerli mi?
 *
 * Boş mesaj, anlamsız tek kelime, biçimlendirme hataları, aşırı uzun
 * veya kesilmiş cümleler burada elenir.
 */
export function coherenceScore(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  if (trimmed.length < 12) return 0.2 // anlamsız tek kelimelik cevap
  if (trimmed.length > 700) return 0.2 // aşırı uzun
  if (BAD_FORMATS.test(trimmed)) return 0 // markdown/bağlantı/kod

  const count = sentences(trimmed).length
  // Hiç noktalama yoksa veya çok fazla cümle varsa tutarsız.
  if (count === 0) return 0.3
  if (count > 5) return 0.4
  // Cümle sonunda noktalama yoksa kesilmiş sayılır.
  if (!/[.!?…]$/u.test(trimmed)) return 0.4
  // Arka arkaya boşluk / yinelenen kelime.
  if (/\s{3,}/u.test(trimmed)) return 0.3
  if (/\b(\w+)\s+\1\b/iu.test(trimmed)) return 0.3

  return 1
}

/**
 * Konu skoru: baskın konu ailesi yanıtta yansıyor mu?
 *
 * Bu, "kahkahaya futbol cevabı" hatasını YAPISAL olarak engeller: konu
 * aileleri birbirinden ayrıdır, oyun kelimeleri teknoloji cümlesinde
 * geçmez.
 */
export function topicScore(text: string, analysis: ContextAnalysis): number {
  const lower = trLower(text)
  const roots = new Set(lower.split(/\s+/u).map(stem))

  // Analiz konusu gündelikse baskın kavram yok; bu durumda konu
  // gereksinimi yok, geçerli kabul edilir.
  if (analysis.topic === 'gündelik') return 0.8

  // Konuyla ilişkili kelimeler yanıtta geçiyor mu?
  for (const word of lower.split(/\s+/u)) {
    const root = stem(word)
    if (root.length >= 4 && roots.has(root)) {
      // Bu kök hangi kavram ailesine ait? Doğru aile ise tam puan.
      if (conceptMatches(root, analysis.topic)) return 1
    }
  }
  // Konu kelimesi doğrudan geçiyorsa (kök değil) kısmi puan.
  if (analysis.topicLabel && lower.includes(trLower(analysis.topicLabel))) return 0.9
  return 0
}

/** Bir kökün verilen kavram ailesine ait olup olmadığı. */
function conceptMatches(root: string, topic: string): boolean {
  const concept = CONCEPTS.find((c) => c.id === topic)
  if (!concept) return false
  return concept.stems.some((s) => root === s || (s.length >= 4 && root.startsWith(s)))
}

/**
 * Tam kalite skoru. Beş bileşenin ağırlıklı ortalaması.
 *
 * Ağırlıklar: bağlam ve konu EN YÜKSEK (konu dışı cevabı önler),
 * kişilik ve tutarlılık orta, tekrar cezası en düşük ağırlıkla çarpılır
 * (çünkü tekrar zaten yüksek puanı düşürür).
 */
export function scoreText(
  ctx: Ctx,
  agentId: string,
  text: string,
  analysis: ContextAnalysis,
  persona: NpcPersona,
): QualityScore {
  const context = contextScore(text, analysis)
  const personality = personalityScore(text, persona)
  const repetition = repetitionScore(ctx, agentId, text)
  const coherence = coherenceScore(text)
  const topic = topicScore(text, analysis)

  // Ağırlıklı toplam. Konu 0 ise toplam da düşük olur → konu dışı elenir.
  const total = 0.28 * context + 0.16 * personality + 0.12 * repetition + 0.2 * coherence + 0.24 * topic

  const reasons: string[] = []
  if (context < 0.5) reasons.push(`bağlam düşük (${context.toFixed(2)})`)
  // Konu etiketini tekrarlamak "alakalı" sayılmaZ: kaynak metnin en az bir
  // kökünü taşımayan bir cümle bağlam dışıdır ve yayınlanmaz.
  const ok = total >= MIN_SCORE && context > 0
  if (topic < 0.7) reasons.push(`konu uyuşmazlığı (${topic.toFixed(2)})`)
  if (coherence < 0.6) reasons.push(`tutarsız/biçimsiz (${coherence.toFixed(2)})`)
  if (repetition < 0.5) reasons.push('ifade tekrarı')
  if (personality < 0.5) reasons.push('kişilik dışı')
  if (reasons.length === 0) reasons.push('ok')

  return { context, personality, repetition, coherence, topic, total, ok, reasons }
}

/**
 * Kalite kapısı: eşiğin altındaysa reddet.
 *
 * @returns null → yayınlanabilir, QualityScore → reddedildi (nedenleriyle).
 */
export function enforceQuality(
  ctx: Ctx,
  agentId: string,
  text: string,
  analysis: ContextAnalysis,
  persona: NpcPersona,
): QualityScore | null {
  const score = scoreText(ctx, agentId, text, analysis, persona)
  return score.ok ? null : score
}
