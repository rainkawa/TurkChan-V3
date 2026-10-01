/**
 * Yorum/gönderi ÜRETİM motoru — tamamen yerel, şablon + kalıp parçası.
 *
 * Üretim formülü (istenen yapı):
 *
 *   BAĞLAM (okunan içerik)
 *   + NPC KİŞİLİĞİ (20 eksen)
 *   + NPC BİLGİSİ (hafızadan: daha önce gördüğü konu, tanıdığı kişi)
 *   + KONU (baskın kavram ailesi)
 *   + ÖNCEKİ ETKİLEŞİM (ilişki eksenleri)
 *   + YAZI STİLİ (uzunluk, emoji, argo, söz kalıbı)
 *   = YORUM
 *
 * Kritik kural: HER üretilen cümle, `analysis.topic` ile ilgili bir
 * kavram kelimesi veya `analysis.subject` kökü taşır. Rastgele kelime
 * havuzlarından bağımsız cümle kurulmaz — konu dışı yanıt üretmek bu
 * tasarımla mümkün değildir.
 *
 * Kalite kapısı (quality.ts) elerse, üretici farklı kalıplarla YENİ
 * aday dener; `MAX_ATTEMPTS` boyunca da geçilemezse karakter SESSİZ kalır
 * (yazmamak saçma yazmaktan iyidir).
 */
import type { Ctx } from '../../context'
import type { ContextAnalysis } from './analyze'
import type { NpcPersona } from './personas'
import { CONCEPTS, EMOJIS, SLANG_MARKERS, stem, trLower } from './lexicon'
import { makeRng } from './rng'
import { scoreText } from './quality'
import type { QualityScore } from './quality'
import { normalizePhrase, rememberPhrase, topConcepts } from './memory'
import { behaviorOf } from './learning'
import { findAnswer } from './knowledge'
import type { NpcRelationshipRow } from '../../types'

/** Bir üretim denemesi için en fazla aday sayısı. */
const MAX_ATTEMPTS = 5

/** Cevabın tutumu — ilişki ve sonuç puanlamasında kullanılır. */
export type Stance = 'agree' | 'disagree' | 'question' | 'neutral' | 'build'

export interface ComposeInput {
  agentId: string
  persona: NpcPersona
  analysis: ContextAnalysis
  /** Okunan içerik (ham metin). */
  content: string
  /** Yazarın NPC'ye karşı ilişkisi. */
  relationship?: NpcRelationshipRow
  /** NPC'nin bu konuyla ilgili geçmiş hatırlama gücü (0..1). */
  memoryWeight?: number
  /** Tohum (test edilebilirlik için). */
  seed: number
  /** Gönderi üretimi mi? */
  kind?: 'comment' | 'post'
  /** Gönderi başlığı için board adı. */
  boardName?: string
}

export interface ComposedReply {
  body: string
  stance: Stance
  /** Kullanılan kalıp ailesi — davranış öğrenmesi bunu izler. */
  style: string
  score: QualityScore
  research: string[]
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

/** Metni cümle sonunda düzgün bitirir ve her cümlenin başını büyük harfe çevirir. */
function finish(text: string): string {
  let out = text.replace(/\s+/gu, ' ').trim()
  if (out === '') return out
  if (!/[.!?…]$/u.test(out)) out += '.'
  // Ardışık noktalama temizliği.
  out = out.replace(/([.!?…])\1{2,}/gu, '$1')
  // Cümle başları büyük harf: kalıplar küçük harfle birleştirildiği için
  // metin "… sıkıldım. telefonum ile …" gibi görünüyordu.
  out = out.replace(/(^|[.!?…]\s+)([a-zçğıöşü])/gu, (_m, head: string, ch: string) =>
    `${head}${ch.toLocaleUpperCase('tr')}`,
  )
  return out
}

/** Cümlenin sonunda noktalama yoksa nokta koyar (ek cümle eklerken kullanılır). */
function ensureStop(text: string): string {
  return /[.!?…]$/u.test(text) ? text : `${text}.`
}

/**
 * Emoji ekler (kişilik oranına göre). Basit bir eşzamanlı üreteçtir;
 * kişiliğe bağlı olması yeterlidir.
 */
function maybeEmoji(text: string, persona: NpcPersona, rng: () => number, chance: number): string {
  if (rng() > persona.emoji_rate * chance) return text
  const emoji = EMOJIS[Math.floor(rng() * EMOJIS.length)] ?? '🙂'
  return `${text} ${emoji}`
}

/** Argo ekler (yalnızca `slang_rate` yüksekse). */
function maybeSlang(text: string, persona: NpcPersona, rng: () => number): string {
  if (rng() > persona.slang_rate * 0.5) return text
  const marker = SLANG_MARKERS[Math.floor(rng() * SLANG_MARKERS.length)] ?? 'la'
  return `${ensureStop(text)} ${marker}.`
}

/** Söz kalıbını (tic) cümleye iliştirir — kişiliğin imzası. */
function applyTic(text: string, persona: NpcPersona, rng: () => number): string {
  if (rng() > 0.55) return text
  const tic = persona.tic.trim()
  if (tic === '') return text
  return `${ensureStop(text)} ${ensureStop(tic)}`
}

// ---------------------------------------------------------------------------
// Kalıp havuzları — HEPSİ bağlam alanı doldurur
// ---------------------------------------------------------------------------

/**
 * Yardım isteyen içeriklerde NPC'nin açılışı.
 *
 * DİKKAT: gönderiyi yazan yardım İSTİYOR; NPC de “bana yardım lazım” diyerek
 * aynı cümleyi tekrarlamaz, kendisi çözüm tarafında durur.
 */
const HELP_OPENERS: string[] = [
  '{konu} konusunda sana birkaç şey söyleyebilirim',
  '{özne} tarafında önce şunu denemek mantıklı',
  '{konu} için pratik bir yol var',
]

/** Niyete göre açılış kalıpları. `{konu}` ve `{özne}` ile doldurulur. */
const OPENERS: Record<string, string[]> = {
  laugh: ['{özne} konusunda kahkaha attırdı ya', 'bu {konu} espirisi güzelmiş'],
  greeting: ['{konu} için selam', 'buraya hoş geldin, {konu} güzel'],
  thanks: ['{konu} için teşekkürler', 'sağ ol, {konu} konusunda yardımcı oldun'],
  question: ['{konu} konusunda bir sorum var', '{özne} hakkında merak ettim'],
  complaint: ['{konu} konusunda gerçekten sıkıldım', 'bu {konu} meselesi çok yorucu'],
  request: ['{konu} konusunda ne önerirsiniz', '{özne} tarafında denediğin bir şey var mı'],
  news: ['{konu} konusunda bilgi paylaşayım', '{konu} tarafında yeni gelişme var'],
  experience: ['{konu} konusunda kendi tecrübem şu', '{özne} ile ilgili yaşadıklarım'],
  praise: ['{konu} konusunda çok iyi olmuş', '{özne} gerçekten başarılı'],
  mock: ['{konu} konusunda bu yaklaşım komik', '{özne} fikri biraz abartı'],
  topic_shift: ['{konu} konusundan ayrılıp şunu söyleyeyim', 'aslında {konu} dışında da var'],
  opinion: ['{konu} konusunda şöyle düşünüyorum', '{özne} konusunda farklı düşünüyorum'],
}

/** Niyet + tutum için gövde kalıpları. Hepsi konuya bağlı. */
const BODIES: Record<Stance, string[]> = {
  agree: [
    '{konu} konusundaki bakışına katılıyorum',
    '{özne} ile ilgili söylediğin doğru, {konu} aynen böyle',
    '{konu} tarafında aynı şeyi düşünüyorum',
    'evet, {konu} konusunda seninle aynı fikirdeyim',
  ],
  disagree: [
    'bence {konu} konusunda biraz abartıyorsun',
    '{özne} ile ilgili bu yaklaşım tam tersi olabilir',
    '{konu} için bu kadar kesin konuşmak doğru olmaz',
    'katılmıyorum, {konu} sorunu bu kadar basit değil',
  ],
  question: [
    '{konu} için neden bu yolu seçtin',
    '{özne} başka bir şey mi denedin mi',
    '{konu} konusunda hangi kaynaktan yararlandın',
  ],
  neutral: [
    '{konu} konusunda düşüncelerim biraz farklı ama saygıyla',
    '{özne} konusunda kendi açımdan şunu düşünüyorum',
    '{konu} için şimdilik net bir fikrim yok',
  ],
  build: [
    '{konu} konusunda buna ekleyeyim',
    '{özne} ile ilgili bir de şunu söyleyeyim',
    '{konu} tarafında bir adım daha atılabilir',
  ],
}

/** Şikâyet/yardım isteyen içeriğe verilen destekleyici kalıplar. */
const EMPATHIC: string[] = [
  '{konu} konusunda gerçekten can sıkıcı bir durum',
  'bu {konu} meselesi çok yorucu, anlıyorum',
  '{konu} için üzülürüm, umarım çözülür',
]

/** Soruya verilen somut yardım kalıpları (kavram ailelerine göre). */
const ADVICE: Record<string, string[]> = {
  oyun: [
    '{konu} için ayarları sıfırlayıp tekrar dene',
    '{konu} tarafında güncelleme yapıldı mı kontrol et',
  ],
  yazilim: [
    '{konu} için önce küçük bir örnekle başla',
    '{konu} sorununda hata mesajının en alt satırına bak',
  ],
  teknoloji: [
    '{konu} için önce yeniden başlatmayı dene',
    '{konu} meselesinde güncelleme kontrol edilmeli',
  ],
  siber: [
    '{konu} için şifreni değiştir, aynı şifreyi kullanma',
    '{konu} konusunda iki faktörlü doğrulama aç',
  ],
  genel: [
    '{konu} için basit bir çözüm var sanırım',
    '{konu} konusunda adım adım bakmak gerekir',
  ],
}

/** Uzun yazan karakterler için ek cümle kalıpları. */
const ELABORATIONS: string[] = [
  'Aslında burada birkaç şeyi ayırmak lazım.',
  'Ben olsam önce küçük bir adımla başlardım.',
  'Konu biraz daha geniş, tek cevapla bitmiyor.',
]

/** Konu yokken kullanılan empati cümleleri (kavram adı geçmez). */
const EMPATHIC_NOPIC: string[] = [
  'sorunun çözüldüğünü umarım',
  'merak ettim, sonucu yazarsan sevinirim',
  'umuyorum ki çabuk çözülür',
]

/**
 * Kavram ailesi tanınmayan ama gerçek bir soru/yardım isteği olan içerikler
 * için kalıplar.
 *
 * Bunlar KONU UYDURMAZ: yalnızca okunan gönderinin kendi kelimelerine
 * (`{özne}`) atıf yapar ve konuyu netleştirmeyi ister. “Yardım İstiyorum”
 * gibi bir gönderiye oyun cümlesi kurmanın tek dürüst karşılığı budur.
 */
const CLARIFY: string[] = [
  '{özne} kısmını biraz açar mısın, tam anlamadım',
  'hangi konuda yardım istediğini biraz daha somut yazar mısın',
  '{özne} için ne denediğini paylaşırsan daha iyi yardımcı olabilirim',
  'biraz daha detay verirsen {özne} tarafında fikrim olur',
]

/** Şüpheci karakterler için sorgulayan kalıplar. */
const SKEPTICAL: string[] = [
  'Bu iddianın kaynağı ne, emin misin?',
  'Somut bir örnek var mı bu söylediğinde?',
]

/** Meraklı karakterler için öğrenme kalıpları. */
const CURIOUS: string[] = [
  'Bu konuda öğrenmek istiyorum, anlatır mısın?',
  'Bunu hiç bilmiyordum, nasıl öğrenebilirim?',
]

/** Haber/deneyim kalıpları. */
const NEWS: string[] = [
  '{konu} tarafında yeni bir şey duydum, paylaşayım.',
  '{konu} konusunda bilgi aktarmak istedim.',
]

const EXPERIENCE: string[] = [
  '{konu} konusunda kendim de yaşadım, şöyle oldu.',
  '{konu} ile ilgili tecrübem var, anlatayım.',
]

/**
 * Kalıplardan doldurulmuş cümle üretir.
 * `{konu}` → kavram etiketi, `{özne}` → içerikten çıkarılmış kök.
 */
function fill(template: string, analysis: ContextAnalysis, words: string[]): string {
  const raw = analysis.subject !== '' ? analysis.subject : (words[0] ?? 'konu')
  // “konu”, “soru”, “gönderi” gibi kelimeler gerçek bir özne değildir:
  // kalıba konduğunda “konuda konusunda farklı düşünüyorum” gibi
  // anlamsız tekrarlar çıkıyordu. Bu durumda gönderinin odağı kullanılır,
  // o da metada ise nötr bir zamir (“bu”) seçilir.
  const isMeta = (w: string): boolean => /^(konu|soru|mesaj|yorum|g[öo]nderi)/u.test(trLower(w))
  const subject = isMeta(raw)
    ? analysis.focus !== '' && !isMeta(analysis.focus)
      ? analysis.focus
      : 'bu'
    : raw
  // "gündelik" bir etiket değil, kavram yokluğudur: "bu" ile birleşince
  // cümle doğal okunur ("bu konusunda…").
  const topic = analysis.topic === 'gündelik' ? 'bu' : analysis.topicLabel.toLocaleLowerCase('tr')
  return template.replace(/\{konu\}/gu, topic).replace(/\{özne\}/gu, subject)
}

/** Rastgele seçim (deterministik tohumlu). */
function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length) % items.length] as T
}

/**
 * Konuya uygun bir tutum seçer. Karakterin kişiliği + ilişki + içerik
 * tonu birlikte belirler; rastgele değil.
 */
export function chooseStance(
  analysis: ContextAnalysis,
  persona: NpcPersona,
  relationship: NpcRelationshipRow | undefined,
  rng: () => number,
): Stance {
  // Temel ağırlıklar: tutum → göreli olasılık.
  const w: Record<Stance, number> = {
    agree: 0.8 + persona.politeness * 0.5 + persona.empathy * 0.4,
    disagree: persona.assertiveness * 1.2 + persona.skepticism * 0.5,
    question: persona.curiosity * 1.2 + persona.verbosity * 0.4,
    neutral: 0.6,
    build: persona.verbosity * 0.6 + persona.confidence * 0.4,
  }

  // Bağlama göre ayarla.
  if (analysis.sentiment === 'negative') {
    w.agree *= 1.3 // olumsuz içeriğe katılı daha zor
    w.disagree *= 0.7
  }
  if (analysis.isQuestion) {
    w.question *= 1.5 // soruya soru/normal cevap uygun
  }
  if (analysis.isArgument) {
    w.disagree *= 1.8 // tartışmaya karşı görüş uygun
    w.agree *= 0.5
  }
  // İlişki etkisi: yakın dost → katılı; rakip → karşı görüş.
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

/**
 * Tek bir yorum adayı üretir (kalite kapısı YOK).
 *
 * @returns Gövde metni ve tutum.
 */
function draftComment(input: ComposeInput, rng: () => number): { body: string; stance: Stance } {
  const { persona, analysis, relationship } = input
  const words = topicWords(analysis.topic)
  const stance = chooseStance(analysis, persona, relationship, rng)
  const intent = analysis.intent

  const fillOne = (list: string[]): string => fill(pick(rng, list), analysis, words)

  /** Stil eklerini (argo, söz kalıbı, bitiş, emoji) toplu uygular. */
  const style = (text: string): string =>
    maybeEmoji(finish(applyTic(maybeSlang(ensureStop(text), persona, rng), persona, rng)), persona, rng, 1)

  // 0) SORU CEVABI — bilgi tabanında karşılığı varsa CEVAP yazılır.
  //
  // Bu adım önce gelir: “HTML ana şablonunu atar mısınız?” sorusuna
  // kalıp cümleleri değil, sorunun cevabı üretilir. Cevap yoksa üretici
  // bir sonraki adıma (konuşma kalıplarına) düşer.
  const answer = findAnswer(input.content, analysis)
  if (answer && !analysis.isTrivial) {
    // On NPC aynı soruya cevap verdiğinde kelimesi kelimesine aynı metni
    // yapmamaları için kaydın iki anlatımı arasında seçim yapılır.
    const phrasing = answer.alt && rng() < 0.5 ? answer.alt : answer.answer
    let body = fill(phrasing, analysis, words)
    // Yalnızca bilgi tabanındaki GERÇEK ek bilgi eklenir. Genel “birkaç şeyi
    // ayırmak lazım” türü dolgu cümleleri cevabı sulandırıyordu.
    if (answer.followUp && rng() < 0.45 + persona.verbosity * 0.4) {
      body += ` ${fill(answer.followUp, analysis, words)}`
    }
    return { body: style(body), stance: 'build' }
  }

  // 0b) KONUSUZ YARDIM İSTEĞİ — konu uydurmak yerine netleştir.
  if (
    analysis.concepts.length === 0 &&
    analysis.mediaKind === 'none' &&
    !analysis.isTrivial &&
    (analysis.isQuestion || analysis.isHelpRequest)
  ) {
    let body = fill(pick(rng, CLARIFY), analysis, words)
    body = ensureStop(body)
    if (persona.empathy > 0.5) body += ` ${pick(rng, EMPATHIC_NOPIC)}`
    if (persona.curiosity > 0.6 && rng() < persona.curiosity * 0.5) {
      body += ` ${ensureStop(fill(pick(rng, CURIOUS), analysis, words))}`
    }
    return { body: style(body), stance: 'question' }
  }

  // 1) AÇILIŞ — niyete göre. Yardım isteyen gönderide NPC çözüm tarafında
  // durur (gönderiyi yankılayan “yardım lazım” cümlesi tekrarlanmaz).
  const openers = analysis.isHelpRequest ? HELP_OPENERS : (OPENERS[intent] ?? OPENERS['opinion'] ?? [])
  let body = fillOne(openers)

  // 2) GÖVDE — tutuma göre.
  body += `. ${fillOne(BODIES[stance])}`

  // 3) EK CÜMLE — bağlama ve kişiliğe göre.
  let concreteAdded = false
  if (analysis.sentiment === 'negative' && persona.empathy > 0.5) {
    body += `. ${fillOne(EMPATHIC)}`
  } else if (analysis.isHelpRequest && persona.curiosity > 0.4) {
    body += `. ${fillOne(ADVICE[analysis.topic] ?? ADVICE['genel'] ?? [])}`
    concreteAdded = true
  } else if (analysis.isNews && persona.seriousness > 0.4) {
    body += `. ${fillOne(NEWS)}`
    concreteAdded = true
  } else if (analysis.isExperience && persona.empathy > 0.4) {
    body += `. ${fillOne(EXPERIENCE)}`
    concreteAdded = true
  }

  // 4) UZUN YAZAN — ek detay. Somut bir cümle zaten varsa tekrarı önle:
  //    ardışık “dolgu” cümleleri yorumu anlamsızlaştırıyordu.
  if (!concreteAdded && persona.verbosity > 0.6 && rng() < persona.verbosity) {
    body += `. ${pick(rng, ELABORATIONS)}`
  }

  // 5) ŞÜPHECİ — sorgulama.
  if (persona.skepticism > 0.5 && analysis.isArgument && rng() < persona.skepticism) {
    body += ` ${ensureStop(pick(rng, SKEPTICAL))}`
  }

  // 6) MERAKLI — öğrenme isteği.
  if (persona.curiosity > 0.6 && analysis.isQuestion && rng() < persona.curiosity * 0.6) {
    body += ` ${ensureStop(fill(pick(rng, CURIOUS), analysis, words))}`
  }

  // 7) HAIZA — daha önce bu konuyu gördüyse atıf yap.
  const recalled = input.memoryWeight ?? 0
  if (recalled > 0.3 && rng() < recalled * 0.5) {
    body = ensureStop(body)
    body += ' Bu konuda daha önce de konuşmuştuk.'
  }

  // 8) İLİŞKİ — yakın dostsa selamlaşma.
  if (relationship && relationship.friendship > 0.35 && rng() < relationship.friendship) {
    body = ensureStop(body)
    body += ' Sana iyi gelsin.'
  }

  // 9) STİL — argo, söz kalıbı, bitiş, en son emoji.
  body = maybeSlang(body, persona, rng)
  body = applyTic(body, persona, rng)
  body = finish(body)
  body = maybeEmoji(body, persona, rng, 1)

  return { body, stance }
}

/**
 * Yorum üretir: en fazla `MAX_ATTEMPTS` aday dener, kalite kapısından
 * geçen İLK adayı döndürür.
 *
 * @returns null → hiçbir aday geçemedi, karakter sessiz kalır.
 */
export function composeComment(ctx: Ctx, input: ComposeInput): ComposedReply | null {
  const policy = behaviorOf(ctx, input.agentId, input.analysis.topic)

  // BAĞLAM YOKSA KONU UYDURMA. Okunan içerikte hiçbir kavram ailesi
  // tanınmadıysa üretilecek cümlenin konu dışı olması kaçınılmazdır.
  // "HAHAHA bu çok komik" için üretilen futbol cümlesi tam olarak bu
  // boşluktan geliyordu.
  //
  // Tek istisna: gerçek bir soru/yardım isteği ("Yardım İstiyorum") için
  // konuyu uydurmak yerine gönderinin KENDİ kelimelerine atıf yapıp
  // netleştirme istenir — bu da bağlamlı bir cevaptır.
  const topicless =
    input.analysis.mediaKind === 'none' && input.analysis.concepts.length === 0
  const canClarify =
    topicless &&
    (input.analysis.isQuestion || input.analysis.isHelpRequest) &&
    input.analysis.wordCount >= 2 &&
    !input.analysis.isTrivial
  if (topicless && !canClarify) return null

  let best: ComposedReply | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = makeRng(input.seed + attempt * 7919)
    const { body, stance } = draftComment(input, rng)
    const score = scoreText(ctx, input.agentId, body, input.analysis, input.persona)

    if (score.ok) {
      rememberPhrase(ctx, input.agentId, body, ctx.now())
      return { body, stance, style: stance, score, research: [] }
    }
    // En iyi adayı sakla (bütün denemeler başarısız olursa döndürmek için).
    if (!best || score.total > best.score.total) {
      best = { body, stance, style: stance, score, research: [] }
    }
    void policy
  }

  // Yedek aday da bağlam taşımak zorunda: kaynak metnin köklerine hiç
  // değinmeyen bir cümle "kısmen iyi" olsa da yayınlanmaz.
  return best && best.score.total >= 0.4 && best.score.context > 0 ? best : null
}

/**
 * Gönderi başlığı + gövdesi üretir.
 *
 * Konu, NPC'nin ilgi alanlarından VE board içeriğinden türetilir — rastgele
 * değil. Bağlam filtresi: başlık en az bir konu kelimesi içermeli.
 */
export function composePost(ctx: Ctx, input: ComposeInput): ComposedPost | null {
  // Konu ailesi tanınmadan gönderi açılmaz: "gündelik" etiketiyle
  // başlık üretmek, bağlamı olmayan bir cümle kurmaktır.
  if (input.analysis.topic === 'gündelik' || input.analysis.concepts.length === 0) return null

  const policy = behaviorOf(ctx, input.agentId, input.analysis.topic)
  const words = topicWords(input.analysis.topic)
  const base = words[0] ?? input.analysis.topicLabel.toLocaleLowerCase('tr')

  // Başlık havuzları — hepsi bağlam kelimesi içerir.
  const titles = [
    `${base} konusunda bir sorum var`,
    `${base} tarafında durum nasıl`,
    `${base} ile ilgili deneyim paylaşayım`,
    `${base} hakkında düşüncelerim`,
    `${base} konusunda yardım lazım`,
    `${base} tarafında yeni bir şey mi var`,
  ]

  const bodies = [
    `${base} konusunda kafamda birkaç soru var. Siz ne düşünüyorsunuz?`,
    `${base} ile uğraşırken bazı şeyler kafama takıldı, yardımınızı bekliyorum.`,
    `${base} konusunda kendi tecrübemi paylaşmak istedim. Belki sizin de işinize yarar.`,
    `${base} tarafında son dönemde büyük bir değişim var gibi, siz ne dersiniz?`,
    `${base} için doğru yaklaşım nedir bilmiyorum, deneyimi olan varsa yazsın.`,
  ]

  let best: ComposedPost | null = null
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const rng = makeRng(input.seed + attempt * 104729)
    const title = pick(rng, titles)
    let body = pick(rng, bodies)
    if (input.persona.verbosity > 0.6) body += ` ${pick(rng, ELABORATIONS)}`
    body = maybeSlang(body, input.persona, rng)
    body = applyTic(body, input.persona, rng)
    body = finish(body)
    body = maybeEmoji(body, input.persona, rng, 0.5)

    // Gönderi kalite kapısı: başlık + gövde birlikte değerlendirilir.
    const titleAnalysis = { ...input.analysis, subject: base }
    const score = scoreText(ctx, input.agentId, `${title} ${body}`, titleAnalysis, input.persona)
    // Gönderi için başlık ayrıca kontrol edilir.
    const titleOk = title.length >= 10 && title.length <= 120
    if (score.ok && titleOk) {
      rememberPhrase(ctx, input.agentId, title, ctx.now())
      return { title, body, style: 'post', score, topic: input.analysis.topic }
    }
    if (!best || score.total > best.score.total) {
      best = { title, body, style: 'post', score, topic: input.analysis.topic }
    }
  }

  return best && best.score.total >= 0.5 && best.score.context > 0 ? best : null
}

/**
 * Bir NPC'nin en çok ilgilendiği konular (hafıza + ilgi alanları).
 * Konu üretiminde "ne konuşayım" kararını besler.
 */
export function suggestTopics(ctx: Ctx, agentId: string, persona: NpcPersona): string[] {
  const remembered = topConcepts(ctx, agentId, 5).map((c) => c.id)
  const interests = persona.interests.map((i) => trLower(i))
  // Hafızasındaki konular önce gelir (öğrenilmiş ilgi), sonra temel ilgi alanları.
  return [...new Set([...remembered, ...interests])].slice(0, 6)
}

/** Kelime kökü yardımcısı (dışarıdan test edilebilir olsun diye dışa açık). */
export { stem, normalizePhrase }
