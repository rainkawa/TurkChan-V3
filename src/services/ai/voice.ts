/**
 * AI karakterlerinin konuşma sesi (metin üretimi).
 *
 * Tasarım: cevap ÖNCE okunan içeriğe göre seçilir, sonra kişiliğe göre
 * kurulur. `analyze.ts` metni yapılandırır (konu, özne, niyet, ton, ortam),
 * buradaki kalıp havuzları o niyete göre seçilir. Bu yüzden "hhh" yazan
 * birine "bu konu hakkında bilgim var" yerine gülüş tepkisi gelir, soru
 * soran birine cevap verilir, fotoğraf/video gönderisine ortam tepkisi
 * yazılır.
 *
 * Kalıplar kasıtlı olarak KISA ve günlük dildir: cümle üst üste yığmak,
 * virgülle boğmak ve her cümlenin sonuna noktalama koymak yapay görünür.
 * Karakterin söz kalıbı (persona `tic`) her cevapta geçer; 50 persona
 * içinde benzersiz olduğu için iki karakter aynı cümleyi kuramaz.
 *
 * Dışarıdan LLM/dış servis çağrısı YOKTUR: sistem tamamen çevrimdışıdır.
 */
import { PERSONAS } from './personas'
import { analyzeContent, questionKind, type ContentAnalysis, type Intent } from './analyze'
import type { AiAgentRow } from '../../types'

export { detectTopic } from './analyze'

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
// Cevap kalıpları — niyete göre seçilir
// ---------------------------------------------------------------------------

/**
 * Cevap cümleleri. `{k}` = içerikten çıkarılan özne, `{topic}` = konu
 * anahtarı. Cümleler kısa tutulur: yapay görünümün en büyük kaynağı,
 * kalıpları arka arkaya yığmaktı.
 */
const POOLS = {
  /** "hhh", "ahaha" gibi kahkaha içeriklerine tepki. */
  laugh: [
    'Kahkaha attın da.', 'Gülmem gerekiyordu.', 'Ben de güldüm.',
    'Anlaşılan iş güldürücüymüş.', 'Gülüyorsun iyi.', 'Bu da güzelmiş.',
  ],
  /** Selamlaşmaya cevap. */
  greeting: [
    'Selam.', 'Merhaba.', 'Selam, nasılsın?', 'Hoş geldin.',
    'Merhaba, umarım iyisin.', 'Selamlar.',
  ],
  /** Teşekküre cevap. */
  thanks: [
    'Rica ederim.', 'Ne demek, ne demek.', 'Rica ederim, kolay gelsin.',
    'Önemli değil.', 'Asla.',
  ],
  /** Soruya cevap ({k} = sorunun öznesi). */
  answer: {
    why: [
      'Nedenini ben de tam bilmiyorum.', 'Sebep biraz daha karmaşık görünüyor.',
      'Nedenini sorgulamak lazım.', 'Kesin sebebini bilen varsa yazsın.',
      'Bence sebebi başka bir yerde.', 'Nedeni açıkçası çok net değil.',
    ],
    how: [
      'Nasıl yapılacağını bilmiyorum, ama deneyenler anlatmış.',
      'Yöntem kişiden kişiye değişiyor.', '{k} için adım adım anlatmak gerek.',
      'En sağlıklısı {k} konusunda güvenilir bir kaynak bulmak.',
      'Bunu denemedim, ama mantıklı görünüyor.',
    ],
    exist: [
      'Sanırım var.', 'Var, ama nerede olduğunu bilmiyorum.',
      '{k} konusunda kaynak gösterebilirim.',
      'Emin değilim, {k} için bir bağlantı lazım.',
      'Olur gibi ama doğruluğunu teyit etmek gerekir.',
    ],
    generic: [
      '{k} konusunda fikrim var ama kısaca.',
      '{k} üzerine düşüncelerimi yazayım.',
      '{k} konusunu biraz açar mısın?',
      'Bunu düşünmüştim, {k} hakkında görüşüm şu.',
      '{k} konusunda kafamda birkaç şey var.',
    ],
  },
  /** Şikâyete tepki. */
  complaint: [
    '{k} konusunda başım da dertli.', 'Aynı sorunu yaşayan var sanırım.',
    'Umarım {k} çözülür, sinir bozucu bir durum.',
    'Bunu kabul etmek zor.', 'Seninle aynı şekilde düşünüyorum.',
    'Başka çözümü var mı bilmiyorum ama umarım çözülür.',
  ],
  /** Yardım isteğine cevap. */
  request: [
    '{k} için bir yol varsa paylaşıyorum: kaynağa bakmak en iyisi.',
    'Deneyimimi anlatayım, işe yaramazsa kusura bakma.',
    'Bunu daha önce yaptım, biraz uzun sürüyordu.',
    '{k} konusunda en çok sorulan şey buydu sanırım.',
    'Adım adım anlatayım istersen.',
  ],
  /** Genel yargı/fikir. */
  opinion: {
    agree: ['Katılıyorum.', 'Aynen.', 'Bende de öyle.', 'Tespitin doğru.'],
    disagree: ['Katılmıyorum.', 'Bence tam tersi.', 'Olmadı bu.', 'Bunda katılmıyorum.'],
    question: ['Bunu anlamadım.', 'Nasıl yani?', 'Biraz açar mısın?', 'Emin misin?'],
    neutral: ['İlginç.', 'Hmm.', 'Düşüneceğim.', 'Dur bir saniye.', 'Anladım.'],
    build: ['Bir de şunu ekleyeyim.', 'Devamı var.', 'Üstüne bir şey daha.'],
  },
  /** Ortam tepkileri (fotoğraf / video / gif / bağlantı). */
  media: {
    image: ['Fotoğrafa baktım, ilginç.', 'Görsel iyi.', 'Fotoğrafı beğendim.', 'Bu fotoğraf güzelmiş.'],
    gif: ['Gif iyi.', 'Bu gif güldürdü.', 'Gif de güzel.', 'Gif şakaya yakışmış.'],
    video: ['Videoyu izledim.', 'Videoda anlatılanlar ilginç.', 'Videoyu beğendim.', 'Videonun sesi iyi çıkmış.'],
    embed: ['Bağlantıya baktım.', 'Bağlantıdaki içerik ilginç.', 'Bunu okudum, ilginçmiş.'],
  },
  /** İçerik anlamsızsa: kısa karşılık (motor bunların çoğuna yanıt vermez). */
  empty: ['Anladım.', 'Tamam.', 'Not aldım.', 'Geçti.', 'Neyse.'],
} as const

/** Cevabı ikinci cümleyle uzatır — uzun yazan karakterler için. */
const SECOND_SENTENCES = [
  'Nasıl bir şey hissettirdi sende?',
  'Başka görüşü olan var mı?',
  'Benim tecrübem farklıydı.',
  'Devamını merak ediyorum.',
  'Sen olsan ne derdin?',
]

/** Bağlaç + devam cümlesi (çok uzun yazanlar için). */
const CONNECTORS = ['Bir de şunu ekleyeyim:', 'Neyse,', 'Dahası,', 'Bu arada,']

/** Uzun geliştirme cümleleri (gönderi gövdesi için). */
const DEVELOPERS = [
  'Birkaç gündür bu konuyu düşünüyorum, sonunda yazmaya karar verdim.',
  'Benim deneyimim şöyle oldu, umarım birilerine işe yarar.',
  'Farklı görüşlerinizi de merak ediyorum, özellikle karşıt olanları.',
  'Konuyu biraz daha açayım ki tam anlaşılsın.',
  'Yazmayı uzun uzatmak istemiyorum ama birkaç noktaya değineyim.',
]

/** Kısa cümlelik karakterler için tek parça cevaplar. */
const SHORT_REPLIES = [
  'Katılıyorum.', 'Katılmıyorum.', 'Doğru.', 'Yanlış.', 'Emin değilim.',
  'Bunu bilmiyorum.', 'İlginç.', 'Haklısın.', 'Olabilir.', 'Olur.', 'Olmaz.',
  'Kesinlikle.', 'Asla.', 'Bu sefer haklısın.', 'Bir dakika.', 'Bunu düşüneceğim.',
  'Bana göre öyle değil.', 'Uyuşuyorum.', 'Öyle de olur.', 'Bence olur.',
  'Bunu beğenmedim.', 'Güzel olmuş.', 'Geçer.', 'Sana katılıyorum.', 'Kısmen.',
  'Tartışırız.', 'Dur bir saniye.', 'Haklı olabilirsin.', 'Bunun cevabı yok bence.',
]

/** Küfürlü son ekler (yüksek profanity gerektirir). */
const PROFANITY_TAILS = ['Ne saçmalı.', 'Boş ver.', 'Anlaşılmıyor.']

/** Nazik son ekler. */
const POLITE_TAILS = ['Teşekkürler.', 'İyi fikir, sağ ol.', 'Saygılar.']

/** Emoji havuzu. */
const EMOJIS = ['🙂', '😂', '😅', '😕', '🤔', '👍', '🔥', '👏', '😎', '😔', '❤️', '💯', '👀', '✅', '🙏', '☕', '🎉']

// ---------------------------------------------------------------------------
// Karakterin konuşma imzası
// ---------------------------------------------------------------------------

/**
 * Karakterin konuşma imzası.
 *
 * Kalıp havuzları kaydırılır (rotate), böylece karakter A'nın açılışı
 * karakter B'de başka bir açılışa denk gelir; noktalama kişiselleştirilir.
 */
export interface VoiceSignature {
  /** Kalıp havuzlarının kaydırma ofseti. */
  rotate: number
  /** Cümle sonu noktalama eğilimi. */
  endMark: string
  /** Araya giren "düşünme" parçası ekleme olasılığı. */
  fillerChance: number
}

/**
 * Karakter kimliğinden türetilen kararlı bir sayı (FNV-1a).
 *
 * Yalnızca davranış ölçeklerinden türetilen ofset, benzer profilli iki
 * karaktere AYNI imzayı veriyordu. Kimlik karıştırıcı koymak her karaktere
 * farklı bir başlangıç noktası verir.
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

/**
 * Cümlenin son noktalama işaretini belirler.
 *
 * Yapay görünümün en belirgin iziydi: her cümlenin sonunda "!" olması.
 * Artık "!" yalnızca gerçekten sert bir karakterde ve karşı görüşte,
 * seyrek olarak kullanılır; soru cevaplarında "?" gelir; emojiyle biten
 * cümlüye hiç noktalama eklenmez.
 */
function finish(text: string, mark: '.' | '?' | '!'): string {
  const trimmed = text.trim().replace(/[.!?…]+$/u, '')
  if (/\p{Extended_Pictographic}$/u.test(trimmed)) return trimmed
  return `${trimmed}${mark}`
}

/** Gönderi gövdesinin son noktalama işareti (her zaman yumuşak). */
function applyEndMark(text: string): string {
  return finish(text, '.')
}

/** Kalıptaki {k} ve {topic} yer tutucularını doldurur. */
function fill(template: string, analysis: ContentAnalysis): string {
  // Özne kalıbın BAŞINDA geliyorsa büyük harfle başlar ("Site konusu"),
  // cümlenin ortasında küçük kalır ("umarım site çözülür").
  const atStart = template.startsWith('{k}') || template.startsWith('{topic}')
  const raw = analysis.subject || analysis.topic
  const subject = atStart ? capitalize(raw) : raw
  return template.replace(/\{k\}/g, subject).replace(/\{topic\}/g, analysis.topic)
}

/** Emoji ekleme: sadece kendi eğilimi kadar. */
function maybeEmoji(agent: AiAgentRow, text: string, rng: () => number): string {
  if (rng() < agent.emoji_rate * 0.35) {
    return `${text} ${pick(rng, EMOJIS)}`
  }
  return text
}

/** Cümle başını büyük harfe çevirir. */
function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase('tr') + text.slice(1)
}

// ---------------------------------------------------------------------------
// Gönderi üretimi
// ---------------------------------------------------------------------------

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

/** Gövde açılış cümleleri (uzunluk ölçeğine göre filtrelenir). */
const OPENERS: Array<{ text: string; minVerbosity: number }> = [
  { text: 'Bugün {t} konusunu düşünüyorum da, bir şeyler söylemek istedim.', minVerbosity: 0.4 },
  { text: '{t} üzerine uzun zamandır kafa yoruyorum.', minVerbosity: 0.5 },
  { text: 'Merhaba, {t} konusunda deneyimimi paylaşmak istiyorum.', minVerbosity: 0.45 },
  { text: '{t} hakkında bir sorum var aslında.', minVerbosity: 0.3 },
  { text: 'Şu {t} meselesi kafamı meşgul ediyor.', minVerbosity: 0.4 },
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
  const topics = parseTopics(agent.interests)
  const keyword = (topics.length > 0 ? pick(rng, topics) : 'gündelik') ?? 'gündelik'

  const baseTitles = TITLE_TEMPLATES[keyword] ?? TITLE_TEMPLATES['gündelik'] ?? []
  const title = capitalize(fillTopic(pick(rng, rotatePool(baseTitles, signature.rotate)), keyword))

  let body = ''
  const openerPool = rotatePool(OPENERS.filter((o) => agent.verbosity >= o.minVerbosity), signature.rotate)
  const opener = pick(rng, openerPool.length > 0 ? openerPool : OPENERS)
  body += fillTopic(opener.text, keyword)

  // Uzun yazanlar ek cümle ekler; kısa yazanlar durur. Cümle sayısı
  // verbosity ile sınırlıdır: uzun yazı "akıcı", yapay yığın değil.
  const extra = Math.round(agent.verbosity * 3)
  const developers = rotatePool(DEVELOPERS, signature.rotate)
  const connectors = rotatePool(CONNECTORS, signature.rotate)
  for (let i = 0; i < extra; i++) {
    if (rng() > agent.verbosity) break
    body += i === 0 ? ` ${pick(rng, developers)}` : ` ${pick(rng, connectors)} ${pick(rng, developers)}`
  }

  if (agent.verbosity > 0.15 && rng() < agent.humor * 0.4) {
    body += ' ' + pick(rng, rotatePool([
      'Neyse, en azından güldük.',
      'Herkes kendi yolunu bulsun.',
      'Olur belki, görürüz.',
      'Sonra konuşuruz.',
    ], signature.rotate))
  }

  // Tek cümlelik karakterler ("tek cümle" arketipi) ek cümle almaz.
  if (agent.verbosity > 0.15) {
    if (rng() < agent.profanity * 0.4) body += pick(rng, rotatePool(PROFANITY_TAILS, signature.rotate))
    else if (rng() < agent.politeness * 0.4) body += ` ${pick(rng, rotatePool(POLITE_TAILS, signature.rotate))}`
  }

  body = applyTic(body, ticFor(agent), rng)
  body = maybeEmoji(agent, body, rng)
  return { title, body: applyEndMark(body), topic: keyword }
}

// ---------------------------------------------------------------------------
// Yorum üretimi — içeriğe göre
// ---------------------------------------------------------------------------

/** Cevabın tutumu; ilişki/itibar hesabında kullanılır. */
export type Stance = 'agree' | 'disagree' | 'question' | 'neutral' | 'build'

/** Gönderi ortamı: cevabın fotoğraf/vidoya göre değişmesi için. */
export interface MediaContext {
  postType?: string
  mediaKind?: string
}

/** Niyet + kişilik + ortam → cevap cümlesi ve soru mu değil mi. */
function composeReply(
  rng: () => number,
  agent: VoiceAgent,
  analysis: ContentAnalysis,
  signature: VoiceSignature,
  stance: Stance,
  context: string,
): { core: string; ask: boolean } {
  // 1) Anlamsız içerik ("hhh", ":)"): karşılığı da kısa olmalı.
  if (analysis.isTrivial) {
    const core =
      analysis.intent === 'laugh'
        ? pick(rng, rotatePool(POOLS.laugh, signature.rotate))
        : pick(rng, rotatePool(POOLS.empty, signature.rotate))
    return { core, ask: false }
  }

  // 2) Ortam: fotoğraf / video / gif / bağlantı gönderisine tepki.
  if (analysis.mediaKind !== 'none') {
    const key = (['image', 'gif', 'video', 'embed'] as const).find((k) => k === analysis.mediaKind)
    const pool = key ? POOLS.media[key] : POOLS.media.image
    let body = pick(rng, rotatePool(pool, signature.rotate))
    // Uzun yazanlar ortamı yorumun içine bağlar.
    if (agent.verbosity > 0.5 && analysis.subject !== '' && rng() < 0.6) {
      body += ` "${analysis.subject}" konusu da buna bağlı bence.`
    }
    return { core: body, ask: false }
  }

  // 3) Niyete göre kalıp havuzu.
  let core: string
  switch (analysis.intent) {
    case 'laugh':
      core = pick(rng, rotatePool(POOLS.laugh, signature.rotate))
      break
    case 'greeting':
      core = pick(rng, rotatePool(POOLS.greeting, signature.rotate))
      break
    case 'thanks':
      core = pick(rng, rotatePool(POOLS.thanks, signature.rotate))
      break
    case 'question':
      core = pick(rng, rotatePool(POOLS.answer[questionKind(analysis, context)], signature.rotate))
      break
    case 'complaint':
      core = pick(rng, rotatePool(POOLS.complaint, signature.rotate))
      break
    case 'request':
      core = pick(rng, rotatePool(POOLS.request, signature.rotate))
      break
    default:
      core = pick(rng, rotatePool(POOLS.opinion[stance], signature.rotate))
      break
  }
  core = fill(core, analysis)
  let ask = /\?\s*$/u.test(core)

  // 4) Kişilik: uzun yazanlar ikinci bir cümle ekler, sert karakter karşı
  // görüşte küfürlü bir kapanış yapar. Kısa yazanlar tek cümlede kalır.
  if (agent.verbosity > 0.45 && rng() < agent.verbosity * 0.6) {
    const extra = pick(rng, rotatePool(SECOND_SENTENCES, signature.rotate))
    core += ` ${extra}`
    ask = /\?\s*$/u.test(core)
  } else if (
    agent.profanity > 0.5 &&
    stance === 'disagree' &&
    rng() < 0.4 &&
    // Küfür bir selamlaşmaya ya da kahkahaya yakışmaz.
    analysis.intent !== 'greeting' &&
    analysis.intent !== 'laugh' &&
    analysis.intent !== 'thanks'
  ) {
    core += ` ${pick(rng, rotatePool(PROFANITY_TAILS, signature.rotate))}`
  }

  // 5) İçerikten bir kelimeyi geri yankılamak cevabı konuya bağlar.
  //    Tırnak kullanılır: kelimenin biçimi ne olursa olsun cümle bozulmaz.
  if (analysis.subject !== '' && analysis.intent === 'opinion' && rng() < 0.45) {
    core += ` "${analysis.subject}" kısmını biraz daha açar mısın?`
    ask = true
  }
  return { core, ask }
}

/**
 * Karakterin bir yoruma cevabını üretir.
 *
 * @param agent Karakter profili.
 * @param context Cevaplanan içerik (yorum metni veya gönderi başlığı+gövdesi).
 * @param seed Tohum; verilmezse zamana bağlı.
 * @param stance Tutum; verilmezse karakterin kişiliğinden türetilir.
 * @param peerRelation Cevaplanan kişiye ilişkisi (-1..1).
 * @param media Gönderi ortamı (fotoğraf/video/gif/bağlantı).
 */
export function generateComment(
  agent: VoiceAgent,
  context: string,
  seed?: number,
  stance?: Stance,
  peerRelation?: number,
  media?: MediaContext,
): { body: string; stance: Stance; topic: string } {
  const rng = makeRng(seed)
  const signature = voiceSignature(agent)
  const analysis = analyzeContent(context, media ?? {})
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

  // Sadece yazmak için yazmaz: anlamsız içerik ve kısa tepkilerde
  // karakter sessiz kalabilir (motor ayrıca rastgele atlar).
  const { core, ask } = composeReply(rng, agent, analysis, signature, resolvedStance, context)

  let body = applyTic(core, ticFor(agent), rng)
  body = maybeEmoji(agent, body, rng)
  // "!" yalnızca sert karakterde ve karşı görüşte; normalde sade "." / "?".
  const aggressive = signature.endMark === '!' && resolvedStance === 'disagree' && rng() < 0.35
  const mark = aggressive ? '!' : ask ? '?' : '.'
  return { body: finish(body, mark), stance: resolvedStance, topic: analysis.topic }
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