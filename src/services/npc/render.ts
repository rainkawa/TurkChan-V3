/**
 * METİN KURUMU (render).
 *
 * Plan + parçalar + stil parmak izi → tek bir yorum metni.
 *
 * Burada yapılanlar:
 *   - plan sırasına göre parçaların kurulması
 *   - stil parmak izinin (emoji, argo, söz kalıbı, uzunluk) UYGULANMASI
 *   - dinamik mizah (yalnızca bağlam uygunsa ve son mesajda kullanılmadıysa)
 *   - dilbilgisel denetim (grammar.lint) ve gerektiğinde yeniden kurulum
 *
 * Dış kaynak, API veya model YOKTUR.
 */
import { buildDiscussion, buildFragment } from './fragments'
import type { FragmentInput } from './fragments'
import { finishSafe, lint, capitalize, ensureStop } from './grammar'
import { joinSentences, similarity } from './grammar'
import type { ResponsePlan } from './plan'
import type { Thought } from './thought'
import type { NpcPersona } from './personas'
import { EMOJIS, SLANG_MARKERS } from './lexicon'

/** Stil girdileri. */
export interface StyleInput {
  persona: NpcPersona
  rng: () => number
  /** Son mesajda mizah kullanıldı mı? (tekrarı önler) */
  humorRecently: boolean
  /** Uzunluk politikası (öğrenme ağırlığı). */
  lengthWeight: number
  /** Mizahtan sonra gelen ödül (davranış öğrenmesi). */
  humorWeight: number
}

/** Üretilen adayın hâlâ izlenebilir yapısal bilgisi. */
export interface RenderResult {
  text: string
  /** Kullanılan parçalar (denetim). */
  usedParts: string[]
  /** Stil eylemleri (denetim). */
  styleActions: string[]
  /** lint sonucu. */
  lintReasons: string[]
  ok: boolean
}

/** Mizah: kaynaktan türeyen, bağlama uygun tek cümlelik düşünce. */
function humorLine(input: FragmentInput, style: StyleInput): string | null {
  if (style.humorRecently) return null
  if (style.humorWeight < 0.8) return null
  // Kişilik eşiğinin altındaki karakter espri yapmaz; üstündeki karakter
  // nadiren yapar (her mesajda emoji koyan bot olmamak için).
  const gate = input.persona.humor * 0.45
  if (gate < 0.25) return null
  if (input.rng() > gate) return null
  const { thought } = input
  if (thought.symptom === '' && thought.kind !== 'smalltalk') return null
  const subject = usableSubjectForHumor(thought.subject)
  const noun = thought.symptom !== '' ? thought.symptom : subject
  if (noun === '') return null
  const lines = [
    `${capitalize(noun)} artık kendi halinden komik`,
    `${capitalize(noun)} konusu ciddi bir yere gidiyor`,
    `bunu söyleyen benden çok haklı`,
    thought.symptom === ''
      ? `${capitalize(noun)} tarafında işin rengi ne bilmiyorum`
      : `${capitalize(noun)} konusunda hep aynı şeyi yaşıyoruz`,
    `bunu bir yerden okumuş gibi geliyor`,
    `${capitalize(noun)} için duyduğum şey bambaşka, sonra konuşalım`,
  ]
  return pickOne(input, lines)
}

function usableSubjectForHumor(word: string): string {
  return word === '' ? '' : word
}

function pickOne(input: FragmentInput, items: string[]): string {
  return items[Math.floor(input.rng() * items.length) % items.length] as string
}

/** Stil parmak izinin uygulanması (emoji, argo, söz kalıbı). */
function applyStyle(text: string, style: StyleInput): { text: string; actions: string[] } {
  const actions: string[] = []
  let out = text
  const { persona, rng } = style

  if (persona.slang_rate > 0.3 && rng() < persona.slang_rate * 0.45) {
    const marker = SLANG_MARKERS[Math.floor(rng() * SLANG_MARKERS.length)] ?? 'la'
    out = `${/[.!?…]$/u.test(out) ? out : `${out}.`} ${capitalize(marker)}.`
    actions.push('argo')
  }
  const tic = persona.tic.trim()
  if (tic !== '' && rng() < 0.4) {
    // Söz kalıbı bir soruyla bitiyor olabilir ("Kaynağı nedir bunun?");
    // nokta eklenirse "?." olur.
    out = `${/[.!?…]$/u.test(out) ? out : `${out}.`} ${ensureStop(tic)}`
    actions.push('söz-kalıbı')
  }
  if (rng() < persona.emoji_rate * 0.55) {
    const emoji = EMOJIS[Math.floor(rng() * EMOJIS.length)] ?? '🙂'
    out = `${out} ${emoji}`
    actions.push('emoji')
  }
  return { text: out, actions }
}

/**
 * Planı verilen cümleye çevirir.
 *
 * @param attempt Yeniden deneme numarası — her denemede parçalar yeniden seçilir.
 */
export function render(
  plan: ResponsePlan,
  input: FragmentInput,
  style: StyleInput,
  attempt: number,
): RenderResult {
  const rng = style.rng
  const usedParts: string[] = []
  const styleActions: string[] = []
  const chunks: string[] = []

  // 1) Plan sırasına göre parçaları kur.
  for (const role of plan.parts) {
    if (chunks.length >= 4) break
    const fragment =
      role === 'stance' && plan.move === 'continue'
        ? buildDiscussion(input)
        : buildFragment(role, input, plan.fact)
    if (fragment === null || fragment.trim() === '') continue
    chunks.push(fragment.trim())
    usedParts.push(role)
  }

  // 2) Hiç parça kurulamadıysa: düşüncenin kendisinden bir cümle üret.
  if (chunks.length === 0) {
    const fallback = buildFragment('reason', input, plan.fact) ?? buildFragment('stance', input, plan.fact)
    if (fallback !== null) chunks.push(fallback)
  }
  if (chunks.length === 0) {
    return { text: '', usedParts, styleActions, lintReasons: ['parça üretilemedi'], ok: false }
  }

  // 3) Uzunluk politikası: kısa yazan karakterlerde sondaki parça atılır.
  //    İstisna: bilgi cevabı (answer) her zaman korunur — cevapsız kalan
  //    kısa yorum, soruyu cevaplamış sayılmaz.
  let ordered = chunks
  const keepsAnswer = plan.move === 'add_info' && plan.parts.includes('answer')
  const targetMax = keepsAnswer ? ordered.length : input.persona.verbosity < 0.35 ? 1 : input.persona.verbosity < 0.6 ? 3 : 4
  if (ordered.length > targetMax && style.lengthWeight < 1.1) ordered = ordered.slice(0, targetMax)

  // 4) Mizah (dinamik): yalnızca bağlam uygunsa ve tekrar değilse.
  const joke = attempt === 0 ? humorLine(input, style) : null
  if (joke !== null) {
    styleActions.push('mizah')
    ordered = [joke, ...ordered]
  }

  // 5) Birleştir, stil uygula, denetle.
  const raw = finishSafe(joinSentences(ordered))
  const styled = applyStyle(raw, style)
  const lintResult = lint(styled.text)
  styleActions.push(...styled.actions)

  return {
    text: styled.text,
    usedParts,
    styleActions,
    lintReasons: lintResult.reasons,
    ok: lintResult.ok,
  }
}

/** İki adayın benzerliğini ölçer (kendi kendini tekrar kontrolü). */
export function tooSimilar(a: string, b: string, limit = 0.75): boolean {
  return similarity(a, b) >= limit
}
