/**
 * Bağlam analiz motoru — NPC'lerin NEYE cevap verdiğini belirleyen katman.
 *
 * Bu katman "hangi konu?" sorusunu kural tabanlı çözer. Harici servis,
 * LLM veya istatistiksel model YOKTUR; her şey `lexicon.ts` içindeki
 * kavram aileleri ve niyet kalıplarından türetilir.
 *
 * Kritik kural: `dominant` alanı, cümlede EN ÇOK geçen kavram ailesini
 * verir. Yorum üretimi bu alanı ZORUNLU olarak kullanır — konu dışı
 * cevap üretmek mimari olarak mümkün olmaz.
 */
import {
  CONCEPTS,
  conceptOf,
  intentsOf,
  MOCK_RE,
  primaryIntent,
  sentimentOf,
  stem,
  trLower,
  type Intent,
  type Sentiment,
} from './lexicon'

/** Türkçe edat/bağlaç — içerik kelimesi sayılmaz. */
const STOPWORDS = new Set([
  'acaba', 'altı', 'ama', 'ancak', 'artık', 'aslında', 'ayrıca', 'az', 'bazı', 'belki',
  'ben', 'benden', 'beni', 'benim', 'beri', 'beş', 'bile', 'bin', 'bir', 'biraz',
  'birçok', 'biri', 'birkaç', 'birkez', 'biz', 'bize', 'bizi', 'bizim', 'böyle',
  'böylece', 'bu', 'buna', 'bunda', 'bundan', 'bunlar', 'bunları', 'bunların',
  'bunu', 'bunun', 'burada', 'bütün', 'çok', 'çünkü', 'da', 'daha', 'dahi', 'de',
  'defa', 'değil', 'diğer', 'diye', 'dokuz', 'dolayı', 'dolayısıyla', 'dört',
  'eden', 'ederek', 'eğer', 'elli', 'en', 'etti', 'ettiği', 'ettiğini', 'gibi',
  'göre', 'hangi', 'hatta', 'hem', 'henüz', 'hep', 'hepsi', 'her', 'herkes',
  'hiç', 'hiçbir', 'için', 'iki', 'ile', 'ilgili', 'ise', 'işte', 'kadar',
  'karşın', 'kendi', 'kez', 'ki', 'kim', 'kime', 'kimi', 'kimse', 'kırk', 'mı',
  'mi', 'mu', 'mü', 'nasıl', 'ne', 'neden', 'nedenle', 'nerde', 'nerede',
  'nereye', 'niçin', 'niye', 'o', 'olan', 'olarak', 'oldu', 'olduğu', 'olduğunu',
  'olmak', 'olması', 'olmaz', 'olsa', 'olsun', 'olup', 'olur', 'olursa',
  'oluyor', 'on', 'ona', 'ondan', 'onlar', 'onlardan', 'onları', 'onların',
  'onu', 'onun', 'otuz', 'oysa', 'öyle', 'pek', 'rağmen', 'sadece', 'sanki',
  'sekiz', 'sen', 'senden', 'seni', 'senin', 'siz', 'sizden', 'sizi', 'sizin',
  'şey', 'şeyden', 'şeyi', 'şeyler', 'şöyle', 'şu', 'şuna', 'şunda', 'şundan',
  'şunu', 'tarafından', 'tüm', 'üç', 'üzere', 'var', 've', 'veya', 'ya', 'yani',
  'yapacak', 'yapılan', 'yapılması', 'yapıyor', 'yapmak', 'yaptı', 'yaptığı',
  'yedi', 'yerine', 'yine', 'yirmi', 'yoksa', 'zaten',
  // Rica/yardım kalıpları cümleye sokulunca bozuk gramer üretiyor.
  'lütfen', 'rica', 'yardım', 'anlatır', 'anlatir', 'söyler', 'baksan', 'bakabilir',
  // Zayıf fiil görünümlü biçimler.
  'eder', 'etti', 'ediyor', 'edildi', 'oldu', 'olmak',
])

/** Sıfat/zarf — özne olamaz ("çok güzel" → özne "güzel" değildir). */
const DESCRIPTORS = new Set([
  'az', 'büyük', 'bütün', 'fazla', 'güzel', 'harika', 'iyi', 'kötü', 'küçük',
  'son', 'sonraki', 'şimdi', 'tüm', 'yeni', 'eski', 'çok', 'pek', 'gibi', 'hoş',
  'genç', 'yavaş', 'hızlı', 'kolay', 'zor', 'doğru', 'yanlış', 'güçlü', 'zayıf',
  'ciddi', 'gerçek', 'süper', 'müthiş', 'harika',
])

/** Bir kelimenin gerçekten içerik kelimesi sayılıp sayılmayacağı. */
function isContentWord(word: string): boolean {
  if (word.length < 3) return false
  if (STOPWORDS.has(word)) return false
  if (DESCRIPTORS.has(word)) return false
  if (!/[a-zçğıöşü]/iu.test(word)) return false
  return true
}

/** Bir kavram ailesinin adı (yönetim paneli ve loglar için). */
export function conceptLabel(id: string): string {
  return CONCEPTS.find((c) => c.id === id)?.label ?? id
}

/**
 * Metni yapılandırılmış bağlama çevirir.
 *
 * `dominant` alanı üretim motorunun ZORUNLU girdisidir: bir cevap
 * `dominant` konusunu içermiyorsa kalite kapısı onu eler. Bu, "kahkahaya
 * futbol cevabı" hatasını yapısal olarak imkânsız kılar.
 */
export interface ContextAnalysis {
  /** Baskın konu ailesi ('gündelik' = kavram tanınmadı). */
  topic: string
  /** Ailenin görünen adı. */
  topicLabel: string
  /** Konuyu destekleyen kavram aileleri (skor sırasıyla). */
  concepts: Array<{ id: string; score: number }>
  /** Konuyu taşıyan kök kelimeler (en fazla 6). */
  keywords: string[]
  /** Cevapta tekrar edilecek en belirgin kök. */
  subject: string
  /** Cümlede geçen gerçek kelimeler (kök değil) — alıntı için. */
  words: string[]
  /** Tespit edilen niyetler (birden fazla olabilir). */
  intents: Intent[]
  /** Birincil niyet. */
  intent: Intent
  /** Duygu. */
  sentiment: Sentiment
  /** Soru mu? */
  isQuestion: boolean
  /** Mizah içeriyor mu? */
  isHumorous: boolean
  /** Tartışma/çatışma içeriyor mu? */
  isArgument: boolean
  /** Yardım/tavsiye istiyor mu? */
  isHelpRequest: boolean
  /** Haber/bilgi aktarımı mı? */
  isNews: boolean
  /** Deneyim paylaşımı mı? */
  isExperience: boolean
  /** Alay/ironi var mı? */
  isMock: boolean
  /** Övgü mü? */
  isPraise: boolean
  /** Konu değiştirme ("neyse, aslında...") */
  isTopicShift: boolean
  /** Cevaplamaya değmez kadar zayıf içerik mi? */
  isTrivial: boolean
  /** Ortam: none | image | gif | video | embed */
  mediaKind: string
  /** Gönderi türü: text | link | image */
  postType: string
  /** Kelime sayısı. */
  wordCount: number
  /** Yazarın bahsettiği @kullanıcılar. */
  mentions: string[]
}

/** Girdiyi kelimelere ayırır (sabit, test edilebilir). */
function tokenize(text: string): string[] {
  return trLower(text)
    .split(/[\s.,;:!?"“”()[\]…/\\|>*#\-–—]+/u)
    .map((w) => w.trim())
    .filter(Boolean)
}

/**
 * Ana giriş noktası.
 *
 * @param text Okunan içerik (gönderi başlığı+ gövdesi veya yorum).
 * @param meta Gönderi türü ve medya ortamı.
 */
export function analyzeContext(
  text: string,
  meta: { postType?: string; mediaKind?: string } = {},
): ContextAnalysis {
  const raw = text.trim()
  const lower = trLower(raw)
  const words = tokenize(raw)
  const contentWords = words.filter(isContentWord)
  const stems = contentWords.map(stem)
  const keywords = [...new Set(stems)].filter((w) => w.length >= 3).slice(0, 6)

  // Kavram aileleri: her aile için kaç üye kelime geçti?
  const scores = new Map<string, number>()
  for (const word of contentWords) {
    const concept = conceptOf(word)
    if (!concept) continue
    scores.set(concept.id, (scores.get(concept.id) ?? 0) + 1)
  }
  const concepts = [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)

  const intents = intentsOf(lower)
  const intent = primaryIntent(lower)
  const sentiment = sentimentOf(raw)
  const mediaKind = meta.mediaKind ?? 'none'
  const postType = meta.postType ?? 'text'
  const mentions = [...raw.matchAll(/@([a-z0-9_]+)/giu)].map((m) => String(m[1]).toLowerCase())

  // Ortam tek başına konuşmaya değer (fotoğraf tepkisi yazılabilir).
  const hasContent = contentWords.length > 0 || mediaKind !== 'none'
  const isQuestion = intents.includes('question') || raw.includes('?')
  const isMock = MOCK_RE.test(raw)
  const isTopicShift = /\b(neyse|asıl|asli|ya konu|ne konuş|başka bir)\b/u.test(lower)

  // Konu: en çok geçen aile. Eşitlik veya tek kelime yeterli mi?
  // Kural: yalnızca TEK kavram üyesi geçtiyse konu "gündelik" kalır —
  // "telefon" kelimesi tek başına bir aileyi kanıtlamaz, "telefonum çok
  // yavaşladı, ne yapmalıyım?" yeterlidir. Cümle gerçek bir cümleyse
  // (en az dört içerik kelimesi) tek kavram üyesi de kabul edilir.
  const top = concepts[0]
  const strongConcept =
    top && (top.score >= 2 || (top.score >= 1 && contentWords.length >= 4)) ? top.id : ''
  const topic = strongConcept || 'gündelik'

  const subject =
    keywords.find((k) => conceptOf(k)?.id === topic) ?? keywords[0] ?? ''

  // KAHKHAHA + konu kelimesi yok → cevaplanacak bir içerik değildir.
  // "HAHAHA bu çok komik 😂" tam olarak bu durumdur.
  const laughOnly = intents.includes('laugh') && concepts.length === 0
  const isTrivial =
    mediaKind === 'none' &&
    (contentWords.length === 0 ||
      laughOnly ||
      (raw.replace(/\s+/gu, '').length < 12 && !isQuestion))

  return {
    topic,
    topicLabel: conceptLabel(topic),
    concepts,
    keywords,
    subject,
    words: contentWords,
    intents,
    intent,
    sentiment,
    isQuestion,
    isHumorous: intents.includes('laugh') || isMock,
    isArgument: /\b(yanlış|saçma|katılmıyorum|olmadı|eleştiri|eleştir|yalan|uygar)\w*/u.test(lower),
    isHelpRequest: intents.includes('request') || (isQuestion && /ne (yap|et|öner|denem)|nasıl/iu.test(lower)),
    isNews: intents.includes('news'),
    isExperience: intents.includes('experience'),
    isMock,
    isPraise: intents.includes('praise'),
    isTopicShift,
    isTrivial,
    mediaKind,
    postType,
    wordCount: words.length,
    mentions,
  }
}

/**
 * Bir metnin konu ailesini bulur (yalnız konu döndürmek için kısa yol).
 * Var olan testlerin kullandığı basit arayüz korunur.
 */
export function detectTopic(text: string): string {
  return analyzeContext(text).topic
}

/** Soru türü — cevap kalıbı seçimi için. */
export function questionKind(
  analysis: ContextAnalysis,
  text: string,
): 'why' | 'how' | 'exist' | 'advice' | 'generic' {
  const lower = trLower(text)
  if (analysis.isHelpRequest) return 'advice'
  if (/\b(neden|niçin|niye|sebep)\b/u.test(lower)) return 'why'
  if (/\b(nasıl|ne zaman|nerede|hangi)\b/u.test(lower)) return 'how'
  if (/\b(var mı|yok mu|olur mu|kaç)\b/u.test(lower)) return 'exist'
  return 'generic'
}
