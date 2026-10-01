/**
 * YAYIN ÖNCESİ DENETİM (SELF-CHECK).
 *
 * Üretilen cevap yayınlanmadan önce dokuz sorudan geçer:
 *
 *   1. Kaynakla ilgili mi?            (kaynak köklerinden en az biri var mı)
 *   2. Gerçekten soruya cevap veriyor mu?
 *   3. Karaktere uygun mu?
 *   4. Önceki mesajıyla çelişiyor mu?
 *   5. Aynı şeyi tekrar ediyor mu?
 *   6. Gramer doğru mu?
 *   7. Uydurma bilgi içeriyor mu?
 *   8. Thread bağlamını bozuyor mu?
 *   9. Gereksiz konu değiştiriyor mu?
 *
 * BAŞARISIZSA YENİDEN ÜRETİLİR: `selfCheck` yalnızca "kabul/ret" değil,
 * hangi sorunun çıktığını döndürür; üretici bu bilgiyle adayı değiştirir.
 */
import { lint, sentences, similarity } from './grammar'
import type { Thought } from './thought'
import type { NpcPersona } from './personas'
import { trLower } from './lexicon'

/** Denetim girdisi. */
export interface SelfCheckInput {
  text: string
  thought: Thought
  persona: NpcPersona
  /** Kaynak metnin kelimeleri (kök). */
  sourceRoots: string[]
  /** NPC'nin bu konuşmadaki son cümlesi. */
  lastStatement: string
  /** Sorgu: kullanıcı soru sordu mu? */
  askedQuestion: boolean
  /** Kullanılan bilgi (doğrulanabilir olgu) — uydurma kontrolü. */
  fact: string | null
  /** Cevapta soru soruldu mu? */
  asksBack: boolean
}

export interface SelfCheckResult {
  ok: boolean
  /** Kaçınma sebebi (denetim günlüğü + yeniden üretim ipucu). */
  reasons: string[]
  /** Puan (0..1) — düşükse üretici farklı plan dener. */
  score: number
}

/** İki sözcüğün ortak ön ek uzunluğu. */
function commonPrefix(a: string, b: string): number {
  const max = Math.min(a.length, b.length)
  let i = 0
  while (i < max && a[i] === b[i]) i++
  return i
}

/**
 * Sözcüğün kaynakta (kök olarak) geçiyor mu?
 *
 * Türkçe ekler birleşik olduğu için tam eşleşme yerine ORTAK ÖN EK aranır:
 * kaynaktaki "telefonum" ile cevaptaki "telefonda" kökü aynıdır ama
 * biçimleri farklıdır. 5 harflik ortak ön ek eşiği, "telefon/telefonu"
 * eşleşmesini yakalar, "depolama/depo" gibi tesadüfleri elemeler.
 */
function hitsSource(text: string, sourceRoots: string[]): boolean {
  const words = [
    ...new Set(
      trLower(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length >= 4),
    ),
  ]
  if (words.length === 0 || sourceRoots.length === 0) return false
  return sourceRoots.some((r) => r.length >= 4 && words.some((t) => commonPrefix(r, t) >= 5))
}

export function selfCheck(input: SelfCheckInput): SelfCheckResult {
  const reasons: string[] = []
  const text = input.text.trim()

  // 1) Kaynakla ilgili mi?
  const relevant = hitsSource(text, input.sourceRoots)
  if (!relevant) reasons.push('kaynakla ilgisiz')

  // 2) Soruya gerçekten cevap veriyor mu?
  //    Kesin bilgi yoksa konuşmayı en az iki cümleyle sürdürmek de "yanıt"
  //    sayılır: tek cümlelik alıklama soruyu cevaplamaz.
  if (input.askedQuestion && input.fact === null && !input.asksBack && sentences(text).length < 2) {
    reasons.push('soruya cevap yok')
  }
  if (input.askedQuestion && input.asksBack && sentences(text).length < 2) reasons.push('cevap yok, soruyla değiştirilmiş')

  // 3) Karaktere uygun mu?
  const len = text.length
  if (input.persona.verbosity < 0.35 && len > 220) reasons.push('kişilik: fazla uzun')
  if (input.persona.verbosity > 0.7 && len < 45) reasons.push('kişilik: fazla kısa')
  if (input.persona.seriousness > 0.75 && /😂|🤣/u.test(text)) reasons.push('kişilik: mizah uyumsuz')

  // 4) Önceki mesajla çelişiyor mu?
  if (input.lastStatement !== '' && similarity(text, input.lastStatement) > 0.7) {
    reasons.push('önceki mesajla çelişiyor')
  }

  // 5) Aynı şeyi tekrar ediyor mu?
  if (input.lastStatement !== '' && similarity(text, input.lastStatement) > 0.5) {
    reasons.push('kendi kendini tekrar ediyor')
  }

  // 6) Gramer doğru mu?
  const l = lint(text)
  if (!l.ok) reasons.push(...l.reasons)

  // 7) Uydurma bilgi: kesin bilgi kaynağı yokken "kesin/kanıt" dili.
  if (input.fact === null && /\b(kanıtlanmış|istatistiklere göre|araştırmalara göre|garanti veriyorum|kesinlikle)\b/iu.test(text)) {
    reasons.push('uydurma bilgi')
  }

  // 8) Thread bağlamı: en fazla 5 cümle.
  if (sentences(text).length > 5) reasons.push('thread bağlamı dağıtıldı')

  // 9) Gereksiz konu değişikliği — kaynak dışı bir konu ailesine geçiş.
  const switchesTopic = /(oyun|maç|film|şarkı|tarif)/iu.test(text) && !/(oyun|maç|film|şarkı|tarif)/iu.test(input.thought.claim)
  if (switchesTopic && !input.thought.anchors.some((a) => /oyun|maç|film|şarkı|tarif/iu.test(a))) {
    reasons.push('gereksiz konu değiştirme')
  }

  const score = Math.max(0, 1 - reasons.length * 0.25)
  return { ok: reasons.length === 0, reasons, score }
}
