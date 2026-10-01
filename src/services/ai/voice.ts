/**
 * AI karakterlerinin konuşma sesi (metin üretimi).
 *
 * Yöntem: şablon + ölçek. Her cümle, karakterin davranış ölçeklerinden
 * (verbosity, humor, assertiveness, politeness, profanity, emoji_rate)
 * ve konuşulan içerikten türetilir. Böylece:
 *
 *   - Aynı konuya iki farklı karakter FARKLI cevap verir (çünkü ölçekleri
 *     farklıdır ve seçilen kalıplar farklıdır).
 *   - Aynı karakter iki farklı konuya farklı cevap verir (konu metni
 *     kalıplara girer).
 *   - Metinler birbirinin kopyası olmaz: varyant havuzu geniş, seçim
 *     PRNG ile yapılır ve son kullanılan kalıplar tekrar seçilmez.
 *
 * Tamamen deterministik DEĞİLDİR (her çağrıda farklı olabilir) ama
 * karakterin kişiliği tutarlıdır — kişilik veriden gelir, rastgelelik
 * yalnızca varyant seçimindedir.
 *
 * Dışarıdan LLM/dış servis çağrısı YOKTUR: sistem tamamen çevrimdışıdır.
 */
import { PERSONAS } from './personas'
import type { AiAgentRow } from '../../types'

/**
 * Metin üreticisinin ihtiyaç duyduğu profil satırı.
 *
 * `username` opsiyoneldir: yoksa persona kataloğundan söz kalıbı
 * (tic) bulunamaz ve üretim yine çalışır — sadece karakterler arası
 * metin ayrışması zayıflar.
 */
export type VoiceAgent = AiAgentRow & { username?: string | null }

/** Kullanıcı adı → persona (söz kalıbı buradan gelir). */
const TICS = new Map<string, string>(PERSONAS.map((p) => [p.username, p.tic]))

/**
 * Karakterin kendine özgü söz kalıbı.
 *
 * 50 persona için benzersizdir (`ai.test.ts` bunu doğrular). Yorumun
 * içine HER ZAMAN girdiği için iki farklı karakterin cümlesi birebir
 * aynı olamaz: kalıp havuzlarının genişletilmesi tek başına yetmez,
 * çünkü havuz ne kadar büyük olursa olsun iki karakter rastgele örnekler
 * er ya da geç aynı cümleyi kurar.
 */
function ticFor(agent: VoiceAgent): string {
  if (!agent.username) return ''
  return TICS.get(agent.username) ?? ''
}

/**
 * Söz kalıbını cümleye yerleştirir.
 *
 * Kalıp baştaysa giriş cümlesi, sondaysa kapanış cümlesi olur. `:` ile
 * biten kalıplar ("Sonuç şu:") yalnızca başa konur — sonda yarım cümle
 * gibi okunur.
 */
function applyTic(text: string, tic: string, rng: () => number): string {
  if (tic === '') return text
  const canEnd = !/[:;]$/.test(tic) && !START_ONLY_TICS.has(tic)
  if (canEnd && rng() < 0.28) return `${text} ${tic}`
  return `${tic} ${text}`
}

/** Basit, hızlı PRNG (xorshift32). Tohum verilmezse zamana bağlıdır. */
export function makeRng(seed?: number): () => number {
  let state = seed ?? (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0
  if (state === 0) state = 0x9e3779b9
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >> 17
    state ^= state << 5
    state >>>= 0
    return state / 0xffffffff
  }
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length) % items.length] as T
}

/** Ağırlıklı seçim: [değer, ağırlık] çiftlerinden biri. */
function weighted<T>(rng: () => number, entries: ReadonlyArray<readonly [T, number]>): T {
  const first = entries[0]
  if (first === undefined) throw new Error('weighted() en az bir seçenek ister')
  const total = entries.reduce((sum, [, w]) => sum + Math.max(0, w), 0)
  if (total <= 0) return first[0]
  let roll = rng() * total
  for (const [value, weight] of entries) {
    roll -= Math.max(0, weight)
    if (roll <= 0) return value
  }
  return entries[entries.length - 1]![0]
}

/** Son kullanılan kalıpları tekrar seçmemek için basit hafıza. */
class RecentMemory {
  private seen = new Set<string>()
  constructor(private limit = 40) {}

  /** Kalıp daha önce kullanıldıysa false döner (kaç kez denendiğine bağlı). */
  isStale(key: string, attempts: number): boolean {
    return this.seen.has(key) && attempts > 0
  }

  remember(key: string): void {
    this.seen.add(key)
    if (this.seen.size > this.limit) {
      const first = this.seen.values().next().value as string | undefined
      if (first !== undefined) this.seen.delete(first)
    }
  }

  reset(): void {
    this.seen.clear()
  }
}

const memory = new RecentMemory()

// ---------------------------------------------------------------------------
// Sözlükler
// ---------------------------------------------------------------------------

/** Konu/board adından ilgi alanı tahmini için anahtar kelimeler. */
const TOPIC_KEYWORDS: Array<{ key: string; words: string[]; topic: string }> = [
  { key: 'yazılım', words: ['yazılım', 'kod', 'program', 'geliştir', 'python', 'javascript', 'hata', 'sistem'], topic: 'yazılım' },
  { key: 'spor', words: ['spor', 'maç', 'futbol', 'basketbol', 'transfer', 'takım', 'gol'], topic: 'spor' },
  { key: 'müzik', words: ['müzik', 'şarkı', 'albüm', 'konser', 'grup', 'parça'], topic: 'müzik' },
  { key: 'yemek', words: ['yemek', 'tarif', 'yemek', 'mutfak', 'pasta', 'çay', 'kahve'], topic: 'yemek' },
  { key: 'eğitim', words: ['eğitim', 'okul', 'ders', 'sınav', 'üniversite', 'ödev', 'hoca'], topic: 'eğitim' },
  { key: 'bilim', words: ['bilim', 'uzay', 'fizik', 'kimya', 'araştırma', 'deney'], topic: 'bilim' },
  { key: 'ekonomi', words: ['ekonomi', 'fiyat', 'para', 'borsa', 'maaş', 'zam', 'vergi'], topic: 'ekonomi' },
  { key: 'siyaset', words: ['siyaset', 'meclis', 'bakan', 'parti', 'seçim', 'kanun'], topic: 'siyaset' },
  { key: 'sağlık', words: ['sağlık', 'hastalık', 'doktor', 'beslenme', 'uyku', 'ilaç'], topic: 'sağlık' },
  { key: 'teknoloji', words: ['teknoloji', 'telefon', 'internet', 'yapay zeka', 'gadget', 'internet'], topic: 'teknoloji' },
  { key: 'oyun', words: ['oyun', 'gamer', 'fps', 'multiplayer', 'konsol'], topic: 'oyun' },
  { key: 'sinema', words: ['sinema', 'film', 'dizi', 'oyuncu', 'kurgu'], topic: 'sinema' },
  { key: 'tarih', words: ['tarih', 'tarihi', 'imparatorluk', 'savaş', 'eski'], topic: 'tarih' },
  { key: 'hobi', words: ['hobi', 'balık', 'bahçe', 'marangoz', 'fotoğraf'], topic: 'hobi' },
  { key: 'gündelik', words: ['günlük', 'yaşam', 'rutin', 'gece', 'sabah'], topic: 'gündelik' },
]

/** Bir konu metninden baskın konu anahtarını bulur. */
export function detectTopic(text: string): string {
  const lower = text.toLowerCase()
  let best = { topic: 'gündelik', score: 0 }
  for (const entry of TOPIC_KEYWORDS) {
    const score = entry.words.reduce((sum, w) => (lower.includes(w) ? sum + 1 : sum), 0)
    if (score > best.score) best = { topic: entry.topic, score }
  }
  return best.topic
}

/** Gönderi başlıkları — konuya göre. */
const TITLE_TEMPLATES: Record<string, string[]> = {
  yazılım: ['{t} konusunda bir sorum var', 'Neden {t} bu kadar zor?', '{t} için tavsiye', '{t} hakkında düşüncelerim'],
  spor: ['{t} konuşması', '{t} sonrası ne oldu?', '{t} sever misiniz?', '{t} ve transferler'],
  müzik: ['{t} listesi', 'Son dönemde en sevdiğim {t}', '{t} önerisi var mı?', '{t} üzerine'],
  yemek: ['{t} tarifi', 'Bugünün {t} önerisi', '{t} yapmanın kolay yolu', 'En sevdiğim {t}'],
  eğitim: ['{t} hakkında bir soru', '{t} için öneri', '{t} nasıl çalışılır?', '{t} sınavı'],
  bilim: ['{t} keşfi', '{t} üzerine bir merakım', '{t} neden önemli?', '{t} ve gelecek'],
  ekonomi: ['{t} ve hayatımıza etkisi', '{t} tartışması', '{t} artıyor mu?', '{t} üzerine düşünce'],
  siyaset: ['{t} tartışması', '{t} üzerine', '{t} doğru mu?', '{t} ve gelecek'],
  sağlık: ['{t} için ne öneriyorsunuz?', '{t} ve uyku', '{t} konusunda bilgi', '{t} deneyimleriniz'],
  teknoloji: ['{t} üzerine', '{t} geleceği', '{t} güvenli mi?', '{t} tavsiyeleri'],
  oyun: ['{t} üzerine sohbet', 'Şu an {t} oynuyorum', '{t} tavsiyesi', '{t} zor mu?'],
  sinema: ['{t} izlenmeli mi?', '{t} üzerine fikirlerim', '{t} ne kadar iyi?', '{t} tavsiyesi'],
  tarih: ['{t} üzerine düşünceler', '{t} ve bugün', '{t} hatırlatıyor', '{t} sorusu'],
  hobi: ['{t} hobisi', '{t} tavsiyeleri', '{t} nasıl başladım?', '{t} üzerine'],
  gündelik: ['Günün sorusu', 'Bir şeyler paylaşmak istedim', 'Bugünün özeti', 'Küçük bir konu'],
}

/** Gönderi gövdeleri — açılış cümlesi kalıpları. */
const OPENERS: Array<{ text: string; minVerbosity: number }> = [
  { text: 'Bugün {t} konusunu düşünüyorum da, bir şeyler söylemek istedim.', minVerbosity: 0.4 },
  { text: '{t} üzerine uzun zamandır kafa yoruyorum.', minVerbosity: 0.5 },
  { text: 'Merhaba, {t} konusunda deneyimimi paylaşmak istiyorum.', minVerbosity: 0.45 },
  { text: '{t} hakkında bir sorum var aslında.', minVerbosity: 0.3 },
  { text: 'Şu {t} meselesi kafamı meşgul ediyor.', minVerbosity: 0.4 },
]

/** Gövde geliştirme cümleleri (uzun yazılar için). */
const DEVELOPERS = [
  'Birkaç gündür bu konuyu düşünüyorum, sonunda yazmaya karar verdim.',
  'Benim deneyimim şöyle oldu, umarım birilerine işe yarar.',
  'Farklı görüşlerinizi de merak ediyorum, özellikle karşıt olanları.',
  'Konuyu biraz daha açayım ki tam anlaşılsın.',
  'Bu arada geçen yıl da benzer bir şey yaşamıştım.',
  'Yazmayı uzun uzatmak istemiyorum ama birkaç noktaya değineyim.',
  'Umarım yanlış anlamamışsınız, yazarken kafam biraz dağınıktı.',
]

/** Cevap/niyet tipleri. */
type Stance = 'agree' | 'disagree' | 'question' | 'neutral' | 'build'

const STANCE_OPENERS: Record<Stance, string[]> = {
  agree: ['Katılıyorum,', 'Doğru söylüyorsun,', 'Bu konuda seninle aynı fikirdeyim,', 'Haklısın,'],
  disagree: ['Katılmıyorum açıkçası,', 'Bence bu yanlış,', 'Bunu kabul etmiyorum,', 'Bence tam tersi,'],
  question: ['Peki neden?', 'Kim böyle düşünüyor?', 'Sen ne dersin bu konuda?', 'Bunu merak ettim,'],
  neutral: ['İlginç bir konu,', 'Şunu düşündüm de,', 'Bu konuda farklı bir şey anlatayım,'],
  build: ['Buna eklemek isterim ki,', 'Bir adım geri gideyim,', 'Kafamda başka bir şey canlandı,'],
}

const STANCE_TAILS: Record<Stance, string[]> = {
  agree: [
    ' benim de kafamda aynısı vardı.',
    ' bunu hep düşünmüşüm de kimse söylememişti.',
    ' gerçekten iyi bir tespit.',
  ],
  disagree: [
    ' çünkü ortada çok fazla şey karışıyor.',
    ' bunun böyle olmadığı kanıtlanmış ki.',
    ' bence burada bir yanlış var.',
  ],
  question: [
    ' sizce ne olur peki?',
    ' bunu merak ettim açıkçası.',
    ' cevabı bilen varsa yazsın.',
  ],
  neutral: [
    ' özellikle bu boyutu hiç düşünmemiştim.',
    ' benim için yeni bir şey oldu.',
    ' daha fazla okumak istiyorum bu konuda.',
  ],
  build: [
    ' ama bir de şu var:',
    ' buna karşılık şunu da eklemeliyim.',
    ' sadece bu kadar da değil.',
  ],
}

/** Yorum gövdesi kalıpları. */
const COMMENT_TEMPLATES: Array<{ stance: Stance; minVerbosity: number; weight: number }> = [
  { stance: 'agree', minVerbosity: 0.0, weight: 1.0 },
  { stance: 'disagree', minVerbosity: 0.1, weight: 1.0 },
  { stance: 'question', minVerbosity: 0.0, weight: 0.8 },
  { stance: 'neutral', minVerbosity: 0.15, weight: 0.7 },
  { stance: 'build', minVerbosity: 0.3, weight: 0.6 },
]

/**
 * Yalnızca girişte anlamlı olan kalıplar ("Önce tanımı netleştirelim." gibi).
 * Bunlar cümlenin SONUNA konursa yarım kalır, bu yüzden hep başa gelir.
 */
const START_ONLY_TICS = new Set([
  'Önce tanımı netleştirelim.',
  'Önce tanımlara bakalım.',
  'Önce malzemeye bakalım.',
  'Önce ilkeyi koyalım.',
  'Önce biraz açayım.',
  'Kendi başımdan anlatayım.',
  'Ben anlatayım baştan.',
])

/** Emoji havuzu. */
const EMOJIS = ['🙂', '😂', '😅', '😕', '🤔', '👍', '🔥', '👏', '😎', '😔', '😡', '❤️', '💯', '🤯', '👀', '✅', '❌', '🙏', '☕', '🎉']

/** Küfürlü son ekler (düşük nezaket + yüksek profanity gerektirir). */
const PROFANITY_TAILS = [' ne saçmalı.', ' boş ver.', ' anlaşılmıyor.']

/** Nazik son ekler. */
const POLITE_TAILS = [' teşekkürler.', ' iyi fikir, sağ ol.', ' saygılar.']

/** Kısa cevaplar (tek cümlelik karakterler için). */
const SHORT_REPLIES = [
  'Katılıyorum.', 'Katılmıyorum.', 'Doğru.', 'Yanlış.', 'Emin değilim.',
  'Bunu bilmiyorum.', 'İlginç.', 'Haklısın.', 'Olabilir.', 'Olur.', 'Olmaz.',
  'Kesinlikle.', 'Asla.', 'Haklısın bu sefer.', 'Bir dakika.', 'Bunu düşüneceğim.',
  'Bana göre öyle değil.', 'Uyuşuyorum.', 'Öyle de olur.', 'Bence olur.',
  'Bunu beğenmedim.', 'Güzel olmuş.', 'Geçer.', 'Sana katılıyorum.', 'Kısmen.',
  'Bilmiyorum, ama düşünüyorum.', 'Tartışırız.', 'Bana sor.', 'Dur bir saniye.',
  'Haklı olabilirsin.', 'Olabilir, kesin değil.', 'Bunun cevabı yok bence.',
]

/**
 * Kısa yazan karakterler için TUTUM'a göre kısa tepkiler. Havuz, düşük
 * verbosity karakterlerinin hepsinin aynı cümleyi kurmasını engeller:
 * her cümle farklı bir sırada birleştirilir.
 */
const SHORT_BY_STANCE: Record<Stance, { core: string[]; tails: string[] }> = {
  agree: {
    core: ['Katılıyorum', 'Katılırım', 'Doğru', 'Haklısın', 'Aynen', 'Onaylıyorum', 'Bende de öyle', 'Tespitin doğru', 'İnandım buna'],
    tails: ['', ' bu sefer.', ' bu konuda.', ' kesinlikle.', ' en azından.', ' sanırım.'],
  },
  disagree: {
    core: ['Katılıyorum', 'Olmaz', 'Yanlış', 'Bence öyle değil', 'Bunu kabul etmiyorum', 'Hayır', 'Yok', 'Bu çıkmıyor', 'Tersi doğru'],
    tails: ['', ' bence.', ' ne yazık ki.', ' maalesef.', ' yine de.', ' açıkçası.'],
  },
  question: {
    core: ['Neden', 'Kim', 'Ne demek', 'Nereden', 'Anladım mı', 'Emin misin', 'Nasıl yani', 'Kaç yaşında', 'Hangi'],
    tails: ['?', ' acaba?', ' peki?', '?'],
  },
  neutral: {
    core: ['İlginç', 'Hmm', 'Anladım', 'Geçti', 'Not aldım', 'Dur bir saniye', 'Düşüneceğim', 'Bakıyorum', 'Tamam'],
    tails: ['.', ' yani.', ' galiba.', ' her hâlükârda.', '.'],
  },
  build: {
    core: ['Bunu da ekleyeyim', 'Devamı var', 'Bunun da var', 'Bir şey daha', 'Ayrıca', 'Üstüne', 'Bunu da söyleyeyim', 'Ek olarak'],
    tails: ['', ' var.', ' unutmayalım.', ' bence.', ' yine de.'],
  },
}

/**
 * Kısa karakterin tek cümlelik cevabını ÜÇ parçadan kurar:
 *   [açılış] + [çekirdek] + [kapanış]
 *
 * Düz bir cümle listesi yetmez: iki kısa-yazan karakter aynı 7 cümleden
 * örneklediğinde havuzları kaçınılmaz olarak örtüşür (ölçüm: 60 örnekte
 * 18 eşleşme). Parçalar karakter imzasına göre kaydırıldığı için iki
 * farklı karakterin pratikte aynı cümleyi kurması çok daha zordur.
 */
function shortComment(rng: () => number, stance: Stance, signature: VoiceSignature): string {
  const entry = SHORT_BY_STANCE[stance]
  const opener = pick(rng, rotatePool(SHORT_OPENERS, signature.rotate))
  const rawCore = pick(rng, rotatePool(entry.core, signature.rotate))
  const core = opener === '' ? rawCore : rawCore.charAt(0).toLocaleLowerCase('tr') + rawCore.slice(1)
  const tail = pick(rng, rotatePool(entry.tails, signature.rotate))
  return `${opener}${core}${tail}`
}

/** Kısa cevapların ön ekleri — kombinasyon çeşitliliğini artırır. */
const SHORT_OPENERS = ['', 'Bence ', 'Açıkçası ', 'Yani ', 'Dürüst olmak gerekirse ', 'Kısaca ', 'Ya ', 'Neyse ']

/** Kibar/yardımsever ekler (baştaki boşluk eklenerek birleştirilir). */
const HELPFUL_TAILS = [
  'Belki şöyle deneyebilirsiniz.',
  'Daha fazla bilgi isterseniz yazın.',
  'Yardımcı olabilirsem seve seve anlatırım.',
  'Bunun için iyi bir kaynak var.',
]

/** Süksüz/teknik cümle parçaları. */
const DEVELOPER_REPLIES = [
  'Kaynağı da paylaşabilir misiniz?',
  'Örnek verebilir misiniz?',
  'Bu konuda elimde biraz veri var, isteyen olursa yazayım.',
  'Sonuçta ne çıktı, biraz daha açar mısınız?',
]


/**
 * Karakterin konuşma imzası.
 *
 * Aynı kalıptan iki farklı karakterin aynı cümleyi kurması, "herkesin
 * cevabı birbirinin kopyası" izlenimi verir. Bu yüzden her karakter
 * profilinden TÜRETİLEN bir kalıp ofseti ve noktalama tarzı alır:
 *
 *   - Kalıp havuzları kaydırılır (rotate), böylece karakter A'nın
 *     "Katılıyorum," açılışı karakter B'de başka bir açılışa denk gelir.
 *   - Noktalama kişiselleştirilir: kaba karakter "!" kullanır, çekingen
 *     karakter "..." vb.
 *
 * Sonuç: aynı konuya iki karakter pratikte olarak aynı cümleyi kuramaz.
 */
export interface VoiceSignature {
  /** Kalıp havuzlarının kaydırma ofseti. */
  rotate: number
  /** Cümle sonu noktalama. */
  endMark: string
  /** Araya giren "düşünme" parçası ekleme olasılığı. */
  fillerChance: number
}

/**
 * Karakter kimliğinden türetilen kararlı bir sayı (FNV-1a).
 *
 * Neden: yalnızca davranış ölçeklerinden türetilen ofset, benzer profilli
 * iki karaktere AYNI imzayı veriyordu (ölçüm: iki "umursamaz" karakter
 * 60 cevaplık havuzda 18 eşleşme üretiyordu). Kimlik karıştırıcı koymak
 * her karaktere farklı bir başlangıç noktası verir.
 */
function stableHash(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/** Profil ölçeklerinden türetilmiş konuşma imzası (aynı profil → aynı imza). */
export function voiceSignature(agent: AiAgentRow): VoiceSignature {
  // Ölçekler KİMLİĞİ de etkiler: benzer profilli iki karakter farklı
  // cümle kurabilsin.
  const fromTraits = Math.floor(agent.verbosity * 7 + agent.humor * 5 + agent.assertiveness * 3)
  const rotate = (fromTraits + stableHash(agent.user_id)) % 7
  let endMark = '.'
  if (agent.profanity > 0.6 || agent.assertiveness > 0.85) endMark = '!'
  else if (agent.politeness < 0.25) endMark = '.'
  else if (agent.emoji_rate > 0.7 && agent.politeness > 0.6) endMark = '.'
  const fillerChance = Math.min(0.8, agent.verbosity * 0.5 + (1 - agent.assertiveness) * 0.3)
  return { rotate, endMark, fillerChance }
}

/** Havuzu karakter imzasına göre kaydırılmış olarak döner. */
function rotatePool<T>(items: readonly T[], rotate: number): readonly T[] {
  if (items.length === 0) return items
  const offset = ((rotate % items.length) + items.length) % items.length
  return [...items.slice(offset), ...items.slice(0, offset)]
}

/** Cümleyi karakterin noktalama imzasına göre düzeltir. */
function applyEndMark(text: string, signature: VoiceSignature): string {
  const trimmed = text.trim().replace(/[.!?]+$/, '')
  // Emojiyle biten metne noktalama eklenmez ("... tespit. 💯." gibi görünmesin).
  if (/\p{Extended_Pictographic}$/u.test(trimmed)) return trimmed
  return `${trimmed}${signature.endMark}`
}

/** Ara bağlaçlar — uzun yazan karakterlerin cümle çeşitliliğini artırır. */
const CONNECTORS = [
  ' Yani,', ' Dahası,', ' Açıkçası,', ' Bir de şu var:', ' Neyse,',
  ' Kısacası,', ' Bu arada,', ' Sonuç olarak,',
]

/** Karakterin cümleleri arasına koyabileceği kişisel ara cümleler. */
const FILLERS = [
  ' en azından benim öyle görüşüm.',
  ' en azından şimdilik bu.',
  ' belki yanılıyorum da.',
  ' yine de öyle düşünüyorum.',
  ' sonradan değişebilir.',
]

export interface GeneratedText {
  title: string
  body: string
  topic: string
}

/**
 * Karakterin kişiliğine göre bir gönderi (başlık + gövde) üretir.
 *
 * @param agent Karakter profili (ölçekler buradan okunur).
 * @param seed Aynı tohum → aynı metin (testler ve yeniden üretim için).
 */
export function generatePost(agent: VoiceAgent, seed?: number): GeneratedText {
  const rng = makeRng(seed)
  const signature = voiceSignature(agent)
  const topic = pick(rng, parseTopics(agent.interests))
  const keyword = topic ?? 'gündelik'

  // Başlık: kısa ve doğal. Havuz karakter imzasına göre kaydırılır.
  const baseTitles = TITLE_TEMPLATES[keyword] ?? TITLE_TEMPLATES['gündelik'] ?? []
  const titlePool = rotatePool(baseTitles, signature.rotate)
  const title = capitalize(fillTopic(pick(rng, titlePool), keyword))

  // Gövde uzunluğu doğrudan verbosity'ten türer.
  let body = ''
  const openerPool = rotatePool(OPENERS.filter((o) => agent.verbosity >= o.minVerbosity), signature.rotate)
  const opener = pick(rng, openerPool.length > 0 ? openerPool : OPENERS)
  body += fillTopic(opener.text, keyword)

  // Uzun yazanlar ek cümle ekler; kısa yazanlar durur. Her ek cümle
  // karakterin imzasına göre farklı bir bağlaçla bağlanır.
  const extra = Math.round(agent.verbosity * 3)
  const connectors = rotatePool(CONNECTORS, signature.rotate)
  const developers = rotatePool(DEVELOPERS, signature.rotate)
  const fillers = rotatePool(FILLERS, signature.rotate)
  for (let i = 0; i < extra; i++) {
    if (rng() > agent.verbosity) break
    if (i === 0) {
      body += ' ' + pick(rng, developers)
    } else if (rng() < signature.fillerChance) {
      body += pick(rng, connectors) + pick(rng, fillers)
    } else {
      body += ' ' + pick(rng, developers)
    }
  }

  // Mizahi karakterlere espri eklenir.
  if (rng() < agent.humor * 0.5) {
    body += ' ' + pick(rng, rotatePool([
      'Neyse, en azından güldük.',
      'Herkes kendi yolunu bulsun.',
      'Olur belki, görürüz.',
      'Sonra konuşuruz.',
    ], signature.rotate))
  }

  // Küfür / nezaket son ekleri.
  if (rng() < agent.profanity * 0.4) body += pick(rng, rotatePool(PROFANITY_TAILS, signature.rotate))
  else if (rng() < agent.politeness * 0.4) body += pick(rng, rotatePool(POLITE_TAILS, signature.rotate))

  body = applyTic(body, ticFor(agent), rng)
  body = maybeEmoji(agent, body, rng)
  return { title, body: applyEndMark(body, signature), topic: keyword }
}

/**
 * Karakterin bir yoruma cevabını üretir.
 *
 * @param agent Karakter profili.
 * @param context Konuşmanın içeriği (cevabın konusu buradan gelir).
 * @param stance Cevabın tutumu; verilmezse karakterin kişiliğinden türetilir.
 * @param peerRelation Karakterin cevapladığı kişiye ilişkisi (-1..1).
 */
export function generateComment(
  agent: VoiceAgent,
  context: string,
  seed?: number,
  stance?: Stance,
  peerRelation?: number,
): { body: string; stance: Stance; topic: string } {
  const rng = makeRng(seed)
  const signature = voiceSignature(agent)
  const topic = detectTopic(context)

  // Tutum: karakterin kişiliği + karşı tarafa ilişkisi belirler.
  const relation = peerRelation ?? 0
  const resolvedStance =
    stance ??
    weighted<Stance>(rng, [
      ['agree', 0.8 + agent.upvote_bias * 0.6 + relation * 0.5],
      ['disagree', agent.assertiveness * 1.2 + (1 - agent.politeness) * 0.3 + (relation < -0.3 ? 0.4 : 0)],
      ['question', agent.verbosity * 0.4 + 0.3],
      ['neutral', 0.6],
      ['build', agent.verbosity * 0.5 + 0.2],
    ])

  // Tek cümlelik karakterler: parçalardan kurulan kısa bir cevap.
  if (agent.verbosity < 0.1) {
    let body = shortComment(rng, resolvedStance, signature)
    body = applyTic(body, ticFor(agent), rng)
    body = maybeEmoji(agent, body, rng)
    return { body: applyEndMark(body, signature), stance: resolvedStance, topic }
  }

  // Açılış ve kapanış havuzları karakter imzasına göre kaydırılır: iki
  // farklı karakter aynı stance'te bile farklı cümle kurar. Kapanışlar
  // baştaki boşlukla geldiği için araya ayrıca boşluk konmaz.
  const openers = rotatePool(STANCE_OPENERS[resolvedStance], signature.rotate)
  const tails = rotatePool(STANCE_TAILS[resolvedStance], signature.rotate)
  let body = pick(rng, openers) + pick(rng, tails)

  // Uzun yazanlar ek açıklama yapar.
  const extra = Math.round(agent.verbosity * 2.4)
  const connectors = rotatePool(CONNECTORS, signature.rotate)
  const replies = rotatePool(DEVELOPER_REPLIES, signature.rotate)
  const fillers = rotatePool(FILLERS, signature.rotate)
  for (let i = 0; i < extra; i++) {
    if (rng() > agent.verbosity) break
    if (i === 0) {
      body += ' ' + pick(rng, replies)
    } else if (rng() < signature.fillerChance) {
      body += pick(rng, connectors) + pick(rng, fillers)
    } else {
      body += ' ' + pick(rng, replies)
    }
  }

  // Yardımsever karakterler çözüm önerir.
  if (rng() < agent.politeness * agent.humor * 0.4) {
    body += ' ' + pick(rng, rotatePool(HELPFUL_TAILS, signature.rotate))
  }

  // Mizah.
  if (rng() < agent.humor * 0.35) {
    body += ' ' + pick(rng, rotatePool([
      'Neyse, benden bu kadarı.',
      'Herkes kendi görüşünde.',
      'Zor konu gerçekten.',
      'Sonra tekrar bakarız.',
    ], signature.rotate))
  }

  // Küfür.
  if (rng() < agent.profanity * 0.35) body += pick(rng, rotatePool(PROFANITY_TAILS, signature.rotate))

  body = applyTic(body, ticFor(agent), rng)
  body = maybeEmoji(agent, body, rng)
  return { body: applyEndMark(body, signature), stance: resolvedStance, topic }
}

/** Cümle başını büyük harfe çevirir (konu anahtarları küçük harfle gelir). */
function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('tr') + text.slice(1)
}

/** Emoji ekleme: sadece kendi eğilimi kadar. */
function maybeEmoji(agent: AiAgentRow, text: string, rng: () => number): string {
  if (rng() < agent.emoji_rate * 0.5) {
    return `${text} ${pick(rng, EMOJIS)}`
  }
  return text
}

/** `{t}` yer tutucusunu konu anahtarıyla doldurur. */
function fillTopic(template: string, topic: string): string {
  return template.replace(/\{t\}/g, topic)
}

/** JSON sütunundaki ilgi alanı listesini güvenle okur. */
function parseTopics(json: string): string[] {
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Kayıt sırasında aynı kalıbın tekrar tekrar seçilmemesi için belleği temizler. */
export function resetVoiceMemory(): void {
  memory.reset()
}
