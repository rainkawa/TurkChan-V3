/**
 * İçerik analizi — AI karakterlerinin NEYE cevap verdiğini belirleyen katman.
 *
 * Sorun: metin üreticisi önceden yazılmış cümleleri birleştiriyordu ve
 * cevabın konuyla hiçbir ilgisi yoktu ("hhh" yazılınca "bu konu hakkında
 * bilgim var" geliyordu). Burada okunan metin (gönderi gövdesi, yorum,
 * başlık, bağlantı önizlemesi) yapılandırılır:
 *
 *   - içerik kelimeleri (konu, özne),
 *   - niyet (selamlaşma / gülüşleme / soru / şikâyet / istek / yargı),
 *   - ton (olumlu / olumsuz / nötr),
 *   - ortam (fotoğraf, video, gif, bağlantı).
 *
 * Metin üreticisi bu sonuca göre cümle kurar. Dış servis/LLM yoktur; tamamı
 * kural tabanlı ve çevrimdışıdır.
 */

/** Konu/board adından ilgi alanı tahmini için anahtar kelimeler. */
const TOPIC_KEYWORDS: Array<{ words: string[]; topic: string }> = [
  { words: ['yazılım', 'kod', 'program', 'geliştir', 'python', 'javascript', 'hata', 'sistem'], topic: 'yazılım' },
  { words: ['spor', 'maç', 'futbol', 'basketbol', 'transfer', 'takım', 'gol'], topic: 'spor' },
  { words: ['müzik', 'şarkı', 'albüm', 'konser', 'grup', 'parça'], topic: 'müzik' },
  { words: ['yemek', 'tarif', 'mutfak', 'pasta', 'çay', 'kahve'], topic: 'yemek' },
  { words: ['eğitim', 'okul', 'ders', 'sınav', 'üniversite', 'ödev', 'hoca'], topic: 'eğitim' },
  { words: ['bilim', 'uzay', 'fizik', 'kimya', 'araştırma', 'deney'], topic: 'bilim' },
  { words: ['ekonomi', 'fiyat', 'para', 'borsa', 'maaş', 'zam', 'vergi'], topic: 'ekonomi' },
  { words: ['siyaset', 'meclis', 'bakan', 'parti', 'seçim', 'kanun'], topic: 'siyaset' },
  { words: ['sağlık', 'hastalık', 'doktor', 'beslenme', 'uyku', 'ilaç'], topic: 'sağlık' },
  { words: ['teknoloji', 'telefon', 'internet', 'yapay zeka', 'gadget'], topic: 'teknoloji' },
  { words: ['oyun', 'gamer', 'fps', 'multiplayer', 'konsol'], topic: 'oyun' },
  { words: ['sinema', 'film', 'dizi', 'oyuncu', 'kurgu'], topic: 'sinema' },
  { words: ['tarih', 'tarihi', 'imparatorluk', 'savaş', 'eski'], topic: 'tarih' },
  { words: ['hobi', 'balık', 'bahçe', 'marangoz', 'fotoğraf'], topic: 'hobi' },
  { words: ['günlük', 'yaşam', 'rutin', 'gece', 'sabah'], topic: 'gündelik' },
]

/** Bir metinden baskın konu anahtarını bulur. */
export function detectTopic(text: string): string {
  const lower = text.toLowerCase()
  let best = { topic: 'gündelik', score: 0 }
  for (const entry of TOPIC_KEYWORDS) {
    const score = entry.words.reduce((sum, w) => (lower.includes(w) ? sum + 1 : sum), 0)
    if (score > best.score) best = { topic: entry.topic, score }
  }
  return best.topic
}

/**
 * Türkçe edat/bağlaç/fiil listesi. Bunlar "içerik kelimesi" sayılmaz;
 * aksi halde cümle kalıpları "bir", "gibi", "çok" gibi kelimelerden üretilir
 * ve yanıt konuyla ilgisiz görünür.
 */
const STOPWORDS = new Set([
  'acaba', 'altı', 'ama', 'ancak', 'artık', 'aslında', 'ayrıca', 'az', 'bazı', 'belki', 'ben',
  'benden', 'beni', 'benim', 'beri', 'beş', 'bile', 'bin', 'bir', 'biraz', 'birçok', 'biri',
  'birkaç', 'birkez', 'biz', 'bize', 'bizi', 'bizim', 'böyle', 'böylece', 'bu', 'buna', 'bunda',
  'bundan', 'bunlar', 'bunları', 'bunların', 'bunu', 'bunun', 'burada', 'bütün', 'çok', 'çünkü',
  'da', 'daha', 'dahi', 'de', 'defa', 'değil', 'diğer', 'diye', 'dokuz', 'dolayı', 'dolayısıyla',
  'dört', 'edecek', 'eden', 'ederek', 'edilecek', 'ediliyor', 'edilmesi', 'ediyor', 'eğer',
  'elli', 'en', 'etmesi', 'etti', 'ettiği', 'ettiğini', 'gibi', 'göre', 'halen', 'hangi', 'hatta',
  'hem', 'henüz', 'hep', 'hepsi', 'her', 'herhangi', 'herkesin', 'hiç', 'hiçbir', 'için', 'iki',
  'ile', 'ilgili', 'ise', 'işte', 'itibaren', 'itibariyle', 'kadar', 'karşın', 'katrilyon', 'kendi',
  'kez', 'ki', 'kim', 'kime', 'kimi', 'kimse', 'kırk', 'mı', 'mi', 'mu', 'mü', 'mi', 'mı', 'mü',
  'nasıl', 'ne', 'neden', 'nedenle', 'nerde', 'nerede', 'nereye', 'niçin', 'niye', 'o', 'olan',
  'olarak', 'oldu', 'olduğu', 'olduğunu', 'olduklarını', 'olmadı', 'olmadığı', 'olmak', 'olması',
  'olmayan', 'olmaz', 'olsa', 'olsun', 'olup', 'olur', 'olursa', 'oluyor', 'on', 'ona', 'ondan',
  'onlar', 'onlardan', 'onları', 'onların', 'onu', 'onun', 'otuz', 'oysa', 'öyle', 'pek', 'rağmen',
  'sadece', 'sanki', 'sekiz', 'sen', 'senden', 'seni', 'senin', 'siz', 'sizden', 'sizi', 'sizin',
  'şey', 'şeyden', 'şeyi', 'şeyler', 'şöyle', 'şu', 'şuna', 'şunda', 'şundan', 'şunları', 'şunu',
  'tarafından', 'trilyon', 'tüm', 'üç', 'üzere', 'var', 'vardı', 've', 'veya', 'ya', 'yani',
  'yapacak', 'yapılan', 'yapılması', 'yapıyor', 'yapmak', 'yaptı', 'yaptığı', 'yaptığını', 'yaptıkları',
  'yedi', 'yerine', 'yetmiş', 'yine', 'yirmi', 'yoksa', 'yüz', 'zaten',
  // Rica/yardım kalıpları: cümleye sokulduğunda bozuk gramer üretiyor.
  'lütfen', 'rica', 'yardım', 'yardim', 'anlatır', 'anlatir', 'söyler', 'baksan', 'bakabilir',
])

/**
 * Sıfat ve zarf kelimeleri. Bunlar da içerik kelimesi sayılmaz:
 * "yeni bilgisayar çok yavaş" cümlesinden "yeni" ve "çok yavaş" seçilirse
 * cevap ("bilgisayarım için..." yerine "yeni konusunda...") anlam bozar.
 */
const DESCRIPTORS = new Set([
  'az', 'büyük', 'bütün', 'fazla', 'güzel', 'harika', 'iyi', 'kötü', 'küçük', 'son',
  'sonraki', 'şimdi', 'tüm', 'yeni', 'eski', 'çok', 'pek', 'gibi', 'hoş', 'genç',
  'yavaş', 'hızlı', 'kolay', 'zor', 'doğru', 'yanlış', 'güçlü', 'zayıf', 'ciddi',
])

/** Cevabın niyeti — hangi kalıp havuzu kullanılacağını belirler. */
export type Intent =
  | 'laugh'      // "hhh", "ahaha", kahkaha
  | 'greeting'   // merhaba, selam
  | 'thanks'     // sağ ol, teşekkürler
  | 'question'   // soru soruyor
  | 'complaint'  // şikâyet / olumsuz deneyim
  | 'request'    // yardım istiyor
  | 'opinion'    // bir yargı/düşünce paylaşıyor
  | 'empty'      // anlamsız, tek harf, boş

export interface ContentAnalysis {
  /** Konu anahtarı (detectTopic). */
  topic: string
  /** Konuyu taşıyan kelimeler (en fazla 5). */
  keywords: string[]
  /** Cevapta tekrar edilecek en belirgin kelime/öbek. */
  subject: string
  intent: Intent
  tone: 'positive' | 'negative' | 'neutral'
  wordCount: number
  /** Cevap vermeye değmez kadar zayıf içerik ("hhh", "ok", ":)"). */
  isTrivial: boolean
  /** Ortam: none | image | gif | video | embed. */
  mediaKind: string
  /** Gönderi türü: text | link | image. */
  postType: string
}

/**
 * Kahkaha kalıbı.
 *
 * Dikkat: "hangi", "haber", "hasta" gibi "ha" ile başlayan kelimeler
 * kahkaha sanılmasın diye yalnızca "h/a" harflerinden oluşan bir küme
 * eşleşir ve ardından başka bir harf gelmemelidir.
 */
const LAUGH_RE = /(^|\s)([ha]{3,}|k{3,}|hehe+|jeje+|l+o+l+|x+d+)(?![a-z0-9çğıöşü])/i
const GREETING_RE = /^(merhaba|selam|merhabalar|iyi günler|günaydın|iyi akşamlar|iyi geceler|slm|mrb|nasıl gidiyor|ne haber|greetings?)\b/i
/** Kısa selamlaşmalar ("s.a.", "mrb") ayrı kontrol edilir: "sağ ol" ifadesi
 *  selamlaşma değil, teşekkürdür ve "sa" öneki onu yanlış yakalıyordu. */
const SHORT_GREETING_RE = /^(s\.?a\.?|mrb|slm)[\s.!]/i
const THANKS_RE = /\b(sağ ?ol|teşekkür|tşk|sağol)\w*/i
const QUESTION_RE = /[?]|(\b(ne|neden|niçin|niye|nasıl|nerede|nereye|neresi|ne zaman|kaç|hangi|var mı|yok mu|olur mu|nedir|ne demek|kim)\b)/i
const COMPLAINT_RE = /\b(kötü|berbat|bozuk|çalışmıyor|calismiyor|sorun|şikâ?yet|yaramıyor|sinir|üzgün|üzen|hayal kırıklığı|sikil|lan|rezalet| berbat)\w*/i
const REQUEST_RE = /\b(lütfen|rica|yardım|yardim|nasıl yap|anlatır mısın|anlatir misin|öğret|nasıl yaparım|yardımcı|ipuç|çözüm)\w*/i
const POSITIVE_RE = /\b(güzel|harika|müthiş|muhteşem|seviyorum|tebrik|tavsiye|başarılı|güzelmiş)\w*/i

/** Bir kelimenin gerçekten içerik kelimesi sayılıp sayılmayacağı. */
function isContentWord(word: string): boolean {
  if (word.length < 3) return false
  if (STOPWORDS.has(word)) return false
  if (DESCRIPTORS.has(word)) return false
  if (!/[a-zçğıöşü]/i.test(word)) return false
  // Fiil görünümlü kelimeler ("gidiyor", "olmuş") cümleye eklenemez.
  if (VERB_SUFFIX_RE.test(word)) return false
  return true
}

/** Fiil/ortaç kipi: cümlenin içine konulduğunda bozuk gramer üretir. */
const VERB_SUFFIX_RE = /(yor|mış|miş|du|dü|dı|di|mü|mu|tı|ti|acak|ecek|maktan|makta)$/u

/**
 * Kelimeyi isim haline yaklaştırır: "sitede" → "site", "kitapları" → "kitap".
 *
 * Cevap kalıpları özneye ek (-de/-da, -dan, -lar) takıp "… için",
 * "… hakkında" diyebildiği için bu sadeleştirme gerekir. Tam bir Türkçe
 * kök bulucu değil, bilinçli olarak kaba bir yaklaşım.
 */
function toNounStem(word: string): string {
  if (word.length <= 5) return word
  return word.replace(/(ler|lar|den|dan|ler|lar)$/u, '').replace(/(de|da|le|la)$/u, '')
}

/**
 * Metni yapılandırır. Tüm kararlar buradan veriyle beslenir; üretici katmanı
 * yalnızca bu sonuca göre kalıp seçer.
 */
export function analyzeContent(
  text: string,
  meta: { postType?: string; mediaKind?: string } = {},
): ContentAnalysis {
  const raw = text.trim()
  const lower = raw.toLocaleLowerCase('tr')
  const words = lower
    .split(/[\s.,;:!?"“”()\[\]…/\\|>*#\-–—]+/u)
    .map((w) => w.trim())
    .filter(Boolean)
  const contentWords = words.filter(isContentWord)
  const keywords = [...new Set(contentWords)].map(toNounStem).filter((w) => w.length >= 3).slice(0, 5)

  const mentions = [...raw.matchAll(/@([a-z0-9_]+)/gi)].map((m) => m[1]!.toLowerCase())
  const mediaKind = meta.mediaKind ?? 'none'
  const postType = meta.postType ?? 'text'

  // Ortam tek başına konuşulmaya değer: fotoğraf/vidoya tepki verilebilir.
  if (contentWords.length === 0 && mediaKind === 'none') {
    return {
      topic: 'gündelik',
      keywords: [],
      subject: '',
      intent: 'empty',
      tone: 'neutral',
      wordCount: words.length,
      isTrivial: true,
      mediaKind,
      postType,
    }
  }

  let intent: Intent = 'opinion'
  if (LAUGH_RE.test(lower) || /(😂|🤣|😹|😆|🙃)/u.test(raw)) intent = 'laugh'
  else if (GREETING_RE.test(lower) || SHORT_GREETING_RE.test(lower)) intent = 'greeting'
  else if (THANKS_RE.test(lower)) intent = 'thanks'
  else if (COMPLAINT_RE.test(lower)) intent = 'complaint'
  else if (REQUEST_RE.test(lower)) intent = 'request'
  else if (QUESTION_RE.test(lower) || raw.endsWith('?')) intent = 'question'

  const tone = COMPLAINT_RE.test(lower)
    ? 'negative'
    : POSITIVE_RE.test(lower)
      ? 'positive'
      : 'neutral'

  // Konuşmaya değer mi? "hhh", ":)", "ok" gibi içerikler cevaplanmaz.
  const isTrivial =
    mediaKind === 'none' &&
    (contentWords.length === 0 ||
      (raw.replace(/\s+/g, '').length < 12 && !QUESTION_RE.test(raw)))

  return {
    topic: detectTopic(raw),
    keywords,
    subject: keywords[0] ?? '',
    intent,
    tone,
    wordCount: words.length,
    isTrivial,
    mediaKind,
    postType,
  }
}

/** Sorunun türü: niyet + özne → cevap kalıbı havuzu seçimi. */
export function questionKind(analysis: ContentAnalysis, text: string): 'why' | 'how' | 'exist' | 'generic' {
  const lower = text.toLocaleLowerCase('tr')
  if (/\b(neden|niçin|niye|sebep)\b/.test(lower)) return 'why'
  if (/\b(nasıl|ne zaman|nerede|hangi)\b/.test(lower)) return 'how'
  if (/\b(var mı|yok mu|olur mu|var mıydı|kaç)\b/.test(lower)) return 'exist'
  if (analysis.topic !== 'gündelik') return 'generic'
  return 'generic'
}