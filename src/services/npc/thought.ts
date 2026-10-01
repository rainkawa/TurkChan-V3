/**
 * YEREL "DÜŞÜNCE" MOTORU.
 *
 * NPC cevap yazmadan ÖNCE okuduğu içeriği çözer. Çıktı bir metin DEĞİL,
 * bir "düşünce" nesnesidir:
 *
 *   subject   — konu (kaynaktan, kökü değil gerçek kelime)
 *   event     — kaynakta geçen olay/zaman çerçevesi ("son güncellemeden sonra")
 *   symptom   — belirti ("ısınma", "yavaşlama", "kapanma")
 *   claim     — iddianın özeti (kaynaktan kelimelerle)
 *   asks      — kullanıcının sorduğu şey
 *   causes    — belirtinin olası nedenleri (iç kural tablosundan)
 *   facts     — doğrulanabilir bilgi (knowledge.ts) — UYDURULMAZ
 *
 * TÜM ALANLAR kaynak metinden türetilir. Kaynakta olmayan hiçbir şey
 * düşünceye girmez; üretim katmanı yalnızca bu alanları kullanır. Bu,
 * "telefonu ısınmayla ilgili olmayan bir gönderiye telefon cevabı"
 * hatasını mimari olarak kapatır.
 */
import type { ContextAnalysis } from './analyze'
import { stem, trLower } from './lexicon'
import { findAnswer } from './knowledge'

/** Düşüncenin türü. */
export type ThoughtKind =
  | 'problem'
  | 'question'
  | 'claim'
  | 'opinion'
  | 'news'
  | 'complaint'
  | 'request'
  | 'smalltalk'

/** Tek bir düşünce. */
export interface Thought {
  kind: ThoughtKind
  /** Kaynaktan gerçek kelime (kök değil): "telefon". */
  subject: string
  subjectRoot: string
  /** Kaynakta geçen olay/zaman çerçevesi; yoksa boş. */
  event: string
  /** Tespit edilen belirti; yoksa boş. */
  symptom: string
  /** İddia (kaynak kelimeleriyle kısaltılmış). */
  claim: string
  /** Kullanıcının sorduğu şey; soru yoksa boş. */
  asks: string
  /** Belirtinin olası nedenleri. */
  causes: string[]
  /** Doğrulanabilir bilgi (knowledge.ts). */
  facts: string[]
  /** NPC'nin bu konudaki kesinliği (0..1). */
  certainty: number
  /** Kaynaktan alınan, cevapta kullanılabilecek kelimeler. */
  anchors: string[]
}

/** Belirti → olası nedenler. Kural tablosu; dış kaynak yok. */
const SYMPTOMS: Array<{ id: string; match: string[]; label: string; causes: string[] }> = [
  {
    id: 'ısınma',
    match: ['ısın', 'ısı', 'kızış', 'sıcak'],
    label: 'ısınma',
    causes: ['pil', 'arka planda çalışan uygulamalar', 'güncelleme sonrası değişiklik'],
  },
  {
    id: 'yavaşlama',
    match: ['yavaş', 'donma', 'kasma', 'gecik', 'takıl'],
    label: 'yavaşlama',
    causes: ['depolama doluluğu', 'arka plan yükü', 'eski bir sürüm'],
  },
  {
    id: 'kapanma',
    match: ['kapan', 'çök', 'kapanıyor', 'sürekli kapanıyor'],
    label: 'kapanma',
    causes: ['bellek yetersizliği', 'arka plan uygulaması', 'kayıt hatası'],
  },
  {
    id: 'bağlantı',
    match: ['açılmıyor', 'baglan', 'bağlan', 'baglanti', 'bağlantı', 'kopuyor', 'koptu'],
    label: 'bağlantı sorunu',
    causes: ['ağ ayarları', 'sürüm uyumsuzluğu', 'servis kesintisi'],
  },
  {
    id: 'artış',
    match: ['arttı', 'artti', 'zam', 'pahalı', 'fiyat', 'küsurat'],
    label: 'fiyat artışı',
    causes: ['kur değişimi', 'vergi', 'talep'],
  },
  {
    id: 'bozulma',
    match: ['bozul', 'calışmıyor', 'çalışmıyor', 'kırık', 'arıza', 'ekran', 'donuyor'],
    label: 'arıza',
    causes: ['donanım', 'yazılım hatası', 'garanti kapsamı'],
  },
  {
    id: 'kayıp',
    match: ['kaybol', 'silindi', 'unuttum', 'sıfırland', 'kayıp'],
    label: 'veri kaybı',
    causes: ['senkronizasyon', 'depolama', 'hesap kapatma'],
  },
]

/** Olay/zaman çerçevesi kalıpları — kaynakta AYNEN bulunan parça kullanılır. */
const EVENT_PATTERNS: RegExp[] = [
  /son\s+[a-zçğıöşü]+den\s+sonra/iu,
  /\b(güncelleme|güncellemesi|güncellemeden)\b/iu,
  /\b(yeni sezon|sezon başı|yeni sürüm|sürüm güncellemesi)\b/iu,
  /\b(dün|bugün|geçen hafta|bu hafta|son günler|şimdi)\b/iu,
  /\b(önce|sonra|ardından)\b/iu,
]

/** Metinden gerçek kelimeler (kısa, anlamlı). */
function realWords(text: string): string[] {
  return trLower(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 4)
}

/** Zaman/sıfat/zarf gibi özne olamayacak kelimeler. */
const NOT_A_NOUN = /^(bugün|dün|yarin|yarın|şimdi|sonra|önce|şey|olay|konu|soru|mesaj|yorum|g[öo]nderi|kısmen|aslında|gerçekten|kesinlikle|bence|bana|sana|size|bize|sizce|senin|benim|bizim|onun|herkes|biraz|çok|daha|en|cok|için| gibi)$/u

/**
 * Fiil çekimi / zarf biçimi → isim gibi kullanılamaz.
 * "güncellemeden", "beklediğimden", "ısınıyor", "sizce" gibi biçimler elenir.
 */
const VERBISH = /(iyor|uyor|ed[eiğü]?$|ıyor$|mış$|miş$|müş$|muş$|d[ıiüu]$|dan$|den$|eç$|ıy$|iy$|dık$|dik$|duk$|dük$|maktan|acakt|ecekt)/u

/**
 * Kelime özne olabilir mi?
 *
 * İyelikli biçimler KIRPILMAZ (telefonum -> telefon diye kırpmak "toplum"u
 * "topl"a çevirirdi); yalnızca zaman/zarf/meta/çekimli-fiil biçimleri elenir.
 * İyelikli biçimler `grammar.possessive` tarafından zaten doğru işlenir.
 */
export function subjectCandidate(word: string): string {
  const lower = trLower(word.trim())
  if (lower.length < 4) return ''
  if (NOT_A_NOUN.test(lower)) return ''
  if (VERBISH.test(lower)) return ''
  return lower
}

/**
 * Özne seçimi: kaynaktaki gerçek bir isim. Sıralama önceliği:
 *   analysis.subject → analysis.focus → keywords → words
 * Zaman/zarf/meta/çekimli-fiil biçimleri elenir, geriye gerçek isim kalır.
 */
export function pickSubject(analysis: ContextAnalysis): string {
  const ordered = [analysis.subject, analysis.focus, ...analysis.keywords, ...analysis.words]
  for (const word of ordered) {
    const candidate = subjectCandidate(word)
    if (candidate !== '') return candidate
  }
  return ''
}

/** Kaynakta geçen olay ifadesini bulur. */
function extractEvent(text: string): string {
  for (const re of EVENT_PATTERNS) {
    const m = text.match(re)
    if (m && m[0]) return trLower(m[0].trim())
  }
  return ''
}

/** Belirtiyi bulur. */
function extractSymptom(text: string): { id: string; label: string; causes: string[] } | null {
  const words = trLower(text)
    .split(/[^a-zçğıöşü0-9]+/iu)
    .filter((w) => w.length >= 3)
  for (const s of SYMPTOMS) {
    // Kelime BASINDA eslesme, serbest alt dizge degil: "mısınız" kelimesi
    // "ısı" ile basliyordu ve HTML sorusu "ısınma" belirtisi saniliyordu.
    // Önek eşleşmesi yalnızca 4+ harfli köklerde yapılır ("zam" -> "zaman").
    const hit = s.match.some((m) =>
      words.some((w) => w === m || (m.length >= 4 && (w.startsWith(m) || m.startsWith(w)))),
    )
    if (hit) return { id: s.id, label: s.label, causes: s.causes }
  }
  return null
}

/** Düşünce türü: içerik ne yapıyor? */
function classify(analysis: ContextAnalysis, symptom: boolean, hasFact: boolean): ThoughtKind {
  // Elimizde hazır bir cevap varsa bu bir "sorun" değil, bir SORUDUR:
  // plan katmanı cevabı yazacak (knowledge.ts).
  if (analysis.isQuestion && hasFact) return 'question'
  if (analysis.isQuestion) return symptom ? 'problem' : 'question'
  if (symptom) return analysis.sentiment === 'negative' ? 'complaint' : 'problem'
  if (analysis.isNews) return 'news'
  if (analysis.isArgument) return 'claim'
  if (analysis.isHelpRequest) return 'request'
  if (analysis.isPraise) return 'opinion'
  if (analysis.isExperience) return 'opinion'
  return 'smalltalk'
}

/**
 * Kaynak içerikten düşünce üretir.
 *
 * @param content Okunan ham metin (gönderi veya yorum).
 * @param analysis `analyzeContext` çıktısı.
 */
export function think(content: string, analysis: ContextAnalysis): Thought {
  const lower = trLower(content)
  const symptom = extractSymptom(lower)
  const event = extractEvent(lower)
  // Özne: gerçek bir isim olmalı. Olay ifadesi ("güncellemeden"), fiil
  // çekimli kelimeler ("paylaşır") ve zaman/zarf biçimleri özne olamaz.
  const subject = pickSubject(analysis)
  const anchors = realWords(content).filter((w) => !/^(mi|mı|mu|mü|ne|neden|nasıl|şey|çok|biraz)$/u.test(w))

  // Bilgi: yalnızca doğrulanabilir yerel kayıtlar (knowledge.ts).
  const entry = findAnswer(content, analysis)
  const facts = entry ? [entry.answer, ...(entry.alt ? [entry.alt] : []), ...(entry.followUp ? [entry.followUp] : [])] : []

  return {
    kind: classify(analysis, symptom !== null, entry !== null),
    subject,
    subjectRoot: stem(subject),
    event,
    symptom: symptom?.label ?? '',
    claim: claimOf(analysis),
    asks: asksOf(analysis, content),
    causes: symptom?.causes ?? [],
    facts,
    certainty: facts.length > 0 ? 0.75 : symptom !== null ? 0.4 : 0.25,
    anchors,
  }
}

/** İddianın kısa özeti. */
function claimOf(analysis: ContextAnalysis): string {
  if (analysis.sentiment === 'negative') return 'olumsuz değerlendirme'
  if (analysis.sentiment === 'positive') return 'olumlu değerlendirme'
  if (analysis.isArgument) return 'tartışma iddiası'
  if (analysis.isNews) return 'bilgi aktarımı'
  if (analysis.isExperience) return 'kişisel deneyim'
  return 'tespit'
}

/** Kullanıcının sorduğu şey (kaynaktan). */
function asksOf(analysis: ContextAnalysis, content: string): string {
  if (!analysis.isQuestion && !analysis.isHelpRequest) return ''
  const m = content.match(/[^\n.!?]*\?/u)
  const q = m && m[0] ? trLower(m[0]).trim() : ''
  return q.replace(/[?.]+$/u, '').trim()
}

/** Düşünce, belirti içeriyor mu? (planlama kullanır) */
export function isProblem(thought: Thought): boolean {
  return thought.symptom !== ''
}

/** Düşünceyi kısa, insan okunur biçimde özetler (denetim günlüğü). */
export function describeThought(thought: Thought): string {
  const bits: string[] = [thought.kind]
  if (thought.subject !== '') bits.push(`özne=${thought.subject}`)
  if (thought.event !== '') bits.push(`olay=${thought.event}`)
  if (thought.symptom !== '') bits.push(`belirti=${thought.symptom}`)
  if (thought.asks !== '') bits.push(`soru=${thought.asks}`)
  return bits.join(' · ')
}
