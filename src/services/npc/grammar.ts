/**
 * TÜRKÇE CÜMLE BİLEŞTİRİCİ (yerel, kural tabanlı).
 *
 * Amaç: üretilen metni "şablon cümle seç"erek değil, KÖK/EK kurallarıyla
 * birleştirerek kurmak. Bu dosya o birleştirmenin dilbilgisel kısmıdır:
 *
 *   - ses uyumu (ünlü/alçak ünlü: a/e, ı/i, u/ü)
 *   - son ünsüz yumuşaması (kitap → kitabı, kitapta)
 *   - hâl ekleri (belirtme -i/-ı/-u/-ü, yönelme -a/-e, bulunma -da/-de)
 *   - iyelik (telefon → telefonum / telefonu)
 *   - çoğul (-lar/-ler)
 *   - cümle birleştirme, noktalama, büyük harf
 *   - BOZUK BİRLEŞİM DENETİMİ (lint): aynı sözcük iki kez, aynı ek iki
 *     kez, çelişen kişi/zaman, eksik noktalama, boşluk hatası
 *
 * Harici servis, model veya API YOKTUR; her şey kural + tablodur.
 */

/** Son ünlü uyumu. */
export type Backness = 'hard' | 'soft'

const FRONT = new Set(['e', 'i', 'ö', 'ü'])
const BACK = new Set(['a', 'o', 'u', 'ı'])
const ROUNDED_BACK = new Set(['o', 'u'])
const ROUNDED_FRONT = new Set(['ö', 'ü'])
const ROUNDED_SET = new Set(['o', 'u', 'ö', 'ü'])

/** Bir sözcüğün son ünlüsünü döndürür (bulunamazsa 'e'). */
export function lastVowel(word: string): string {
  for (let i = word.length - 1; i >= 0; i--) {
    const ch = word[i] as string
    if (FRONT.has(ch) || BACK.has(ch)) return ch
  }
  return 'e'
}

/** Ünlü uyumu: 'hard' (a/ı/u) veya 'soft' (e/i/ü). */
export function backness(word: string): Backness {
  return FRONT.has(lastVowel(word)) ? 'soft' : 'hard'
}

/** Düzeltme (m) ünlüsü: o/u veya ö/ü. */
export function rounded(word: string): boolean {
  const v = lastVowel(word)
  return ROUNDED_BACK.has(v) || ROUNDED_FRONT.has(v)
}

/** Kök + eki birleştirirken kullanılacak uyumlu ünlüyü verir. */
function harmonize(word: string, set: 'front' | 'back' | 'vowelHarmony'): string {
  if (set === 'vowelHarmony') return backness(word) === 'soft' ? 'front' : 'back'
  return set
}

const VOWELS = new Set([...FRONT, ...BACK])

/** Sözcük ünlüyle mi bitiyor? */
function endsWithVowel(word: string): boolean {
  const last = word[word.length - 1] ?? ''
  return VOWELS.has(last)
}

/** Eklenmeden önce son ünsüzün yumuşaması (kitap → kitab-). */
function soften(word: string, kind: 'voiceless' | 'voiced' | 'devoice'): string {
  if (word === '' || endsWithVowel(word)) return word
  const last = word[word.length - 1] as string
  const maps: Record<'voiceless' | 'voiced' | 'devoice', Record<string, string>> = {
    voiceless: { p: 'b', ç: 'c', k: 'g', g: 'ğ', t: 'd' },
    voiced: { p: 'b', ç: 'c', k: 'ğ', g: 'g', t: 'd' },
    devoice: { b: 'p', c: 'ç', ğ: 'k', d: 't' },
  }
  const table = maps[kind]
  const replacement = table[last]
  return replacement === undefined ? word : `${word.slice(0, -1)}${replacement}`
}

/** Ek almış biçimde kök: uyumlu ünlü ve yumuşama uygulanır. */
export function stemFor(word: string, set: 'front' | 'back' | 'vowelHarmony'): string {
  const kind = harmonize(word, set)
  return soften(word, kind === 'front' ? 'voiceless' : 'voiced')
}

/** Ünlüyle biten köklerde ek alırken “y” tamponu kullanılır. */
function buffer(word: string): string {
  return endsWithVowel(word) ? 'y' : ''
}

/**
 * Ünsüz düşmesi olan eklerden sonra kaybolan "n" sesinin geri getirilmesi.
 *
 * hatası → hatasını, verisi → verisini, kaybı → kaybını, uyumsuzluğu →
 * uyumsuzluğunu. Bu olmadan "hatasıyı", "kaybıyı" gibi hatalar oluşur.
 */
function withDroppedN(word: string, suffix: string): string | null {
  // 3. tekil iyelik eki: uygulaması → uygulamasına, kitabı → kitabına.
  if (/(s[ıiuü]|n[ıiuü]|m[ıiuü])$/u.test(word)) return `${word}n${suffix}`
  // -lık biçimleri: yetersizliği → yetersizliğine, uyumsuzluğu →
  // uyumsuzluğuna.
  if (/ğ[ıiuü]$/u.test(word) && /l[aeıioöuü]ğ[ıiuü]$/u.test(word)) return `${word}n${suffix}`
  if (/(?:[ğg][uü])$/u.test(word)) return `${word}n${suffix}`
  // Düşen ünsüzlü biçimler: kaybı → kaybına, düzeni → düzenine.
  if (/(?:[bpkçt][ıiuü])$/u.test(word)) return `${word}n${suffix}`
  return null
}

/** Belirtme hâli: kitap → kitabı, telefon → telefonu, internet → interneti. */
export function accusative(word: string): string {
  const target = lastWord(word)
  if (isAcronym(word)) {
    const roundedWord = rounded(target)
    return acronymCase(word, roundedWord ? 'u' : 'ü')
  }
  const soft = backness(target) === 'soft'
  const vowel = rounded(target) ? (soft ? 'ü' : 'u') : soft ? 'i' : 'ı'
  const dropped = withDroppedN(target, vowel)
  if (dropped !== null) return head(word) + dropped
  if (endsWithVowel(target)) return head(word) + target + buffer(target) + vowel
  // Belirtme hâlinde ünsüz yumuşaması yalnızca p/ç/k'da olur:
  // kitap → kitabı, ağaç → ağacı. "t" yumuşamaz: saat → saati.
  return head(word) + caseSoftening(target, vowel) + vowel
}

/** Yönelme hâli: kitap → kitaba, telefon → telefona, güncelleme → güncellemeye. */
/**
 * Yönelme hâlinde "y" tamponu alan yaygın sözcükler.
 *
 * Türkçede son ünlüsü düşen kökler yönelmede tampon alır: su → suya,
 * vergi → vergiye, hile → hileye, kova → kovaya. Bu düzensizlik sözlükte
 * çözülür; dava tablosu kullanılır.
 */
const Y_BUFFER = new Set(['su', 'vergi', 'sunucu', 'hile', 'ana', 'kola', 'hoca', 'baba', 'yapı', 'kova', 'hediye', 'oruç'])

export function dative(word: string): string {
  const target = lastWord(word)
  if (isAcronym(word)) return acronymCase(word, backness(target) === 'soft' ? 'e' : 'a')
  const soft = backness(target) === 'soft'
  const vowel = soft ? 'e' : 'a'
  // Düzensiz yönelme: su → suya, sunucu → sunucuya, vergi → vergiye.
  if (Y_BUFFER.has(target)) return `${head(word)}${target}y${vowel}`
  // Ek almış köklerde düşen "n" geri gelir: uygulaması → uygulamasına,
  // uyumsuzluğu → uyumsuzluğuna, kaybı → kaybına.
  const dropped = withDroppedN(target, vowel)
  if (dropped !== null) return head(word) + dropped
  if (endsWithVowel(target)) {
    const last = target[target.length - 1] as string
    // Ünlüyle biten köklerde tampon: depolama → depolamaya.
    // Düz iyelik biçimlerinde tampon yok: oyun → oyuna, yapı → yapıya.
    return /[aeoöuü]/u.test(last) ? `${head(word)}${target}y${vowel}` : head(word) + target + vowel
  }
  // Yönelme hâlinde yumuşama yalnızca p/ç/k'da olur: kitap → kitaba,
  // çocuk → çocuğa. "t" yumuşamaz: saat → saate, yurt → yurta.
  return head(word) + caseSoftening(target, vowel) + vowel
}

/**
 * Hâl eki öncesi ünsüz yumuşaması.
 *
 * Türkçede çoğu ünsüz ek almadan yumuşar (kitap → kitabı). Yumuşayanlar
 * yalnızca p/ç/k'dır. "t" yumuşamaz (saat → saati, minecraft → minecrafta)
 * ve hiçbir ünsüz düşmez. Önceden "t" de yumuşatıldığı için
 * "Minecrafda" gibi bozuk biçimler üretiliyordu.
 */
function caseSoftening(target: string, _vowel: string): string {
  const last = target[target.length - 1] as string
  // p/ç/k yumuşar (kitap → kitabı, çocuk → çocuğu, ağaç → ağacı);
  // "t" yumuşamaz (saat → saati). Kalan ünsüzler olduğu gibi kalır.
  const map: Record<string, string> = { p: 'b', ç: 'c', k: 'ğ' }
  const replacement = map[last]
  return replacement === undefined ? target : `${target.slice(0, -1)}${replacement}`
}

/** Çok sözcüklü ifadenin son sözcüğü ("bellek yetersizliği" → "yetersizliği"). */
function lastWord(word: string): string {
  const cut = word.lastIndexOf(' ')
  return cut < 0 ? word : word.slice(cut + 1)
}

/** Çok sözcüklü ifadenin son sözcüğe kadar olan kısmı. */
function head(word: string): string {
  const cut = word.lastIndexOf(' ')
  return cut < 0 ? '' : word.slice(0, cut + 1)
}

/** Bulunma hâli: kitap → kitapta, telefon → telefonda, hatası → hatasında. */
export function locative(word: string): string {
  const target = lastWord(word)
  if (isAcronym(word)) return acronymCase(word, /[A-ZÇĞİÖŞÜ]$/u.test(target) ? 'da' : 'de')
  const suffix = locativeSuffix(target)
  // Düşen "n" geri gelir: veri kaybı → veri kaybında (değil "kaybınde").
  const dropped = withDroppedN(target, suffix)
  if (dropped !== null) return head(word) + dropped
  return `${head(word)}${target}${suffix}`
}

/** Bulunma hâli eki: saat → saatte, ağaç → ağaçta, oyun → oyunda. */
function locativeSuffix(target: string): string {
  const soft = backness(target) === 'soft'
  if (endsWithVowel(target)) return soft ? 'de' : 'da'
  // "t", "ç", "ş" ve "k" ile biten kökler ek "ta/te" alır: saatte, ağaçta,
  // arkadaşta, çocukta. Diğer ünsüzler "da/de" alır: kitapta, oyunda.
  if (/[tçşk]$/u.test(target)) return soft ? 'te' : 'ta'
  return soft ? 'de' : 'da'
}

/** Ayırılma hâli: kitaptan, telefondan, hatasından. */
export function ablative(word: string): string {
  const target = lastWord(word)
  const soft = backness(target) === 'soft'
  if (isAcronym(word)) return acronymCase(word, soft ? 'den' : 'dan')
  const suffix = endsWithVowel(target)
    ? soft
      ? 'den'
      : 'dan'
    : target.endsWith('t')
      ? soft
        ? 'ten'
        : 'tan'
      : /[çşk]$/u.test(target)
        ? soft
          ? 'ten'
          : 'tan'
      : soft
        ? 'den'
        : 'dan'
  const dropped = withDroppedN(target, suffix)
  if (dropped !== null) return head(word) + dropped
  return `${head(word)}${target}${suffix}`
}

/**
 * Çoğul: kitap → kitaplar, araba → arabalar, hata → hatalar, soru → sorular.
 *
 * Belirsiz biçimler (kısaltma, düzensiz ünlü düşmesi) DÖNÜŞTÜRÜLMEZ; çağıran
 * taraf bunu dil denetiminde eler.
 */
export function plural(word: string): string {
  const fixed = PLURAL_FIX.get(word)
  if (fixed !== undefined) return fixed
  if (/(lar|ler)$/u.test(word)) return word
  const target = lastWord(word)
  // Kısaltmalar ve sayılar çoğullaştırılmaz (boş RAM, sürüm 3).
  if (isAcronym(word) || /[0-9]$/u.test(target)) return word
  const suffix = backness(target) === 'soft' ? 'ler' : 'lar'
  // 3. tekil iyelik eki düşer: hatası → hataları, sunucusu → sunucuları.
  const poss = /(?:s[ıiuü]|n[ıiuü])$/u.exec(target)
  if (poss && poss[0] !== undefined) {
    const root = target.slice(0, -poss[0].length)
    const dropped = DROPPING_VOWEL.get(root)
    return `${head(word)}${root}${dropped !== undefined ? dropped : ''}${suffix}${poss[0][poss[0].length - 1] as string}`
  }
  if (!endsWithVowel(target)) return `${head(word)}${soften(target, 'devoice')}${suffix}`
  // Ünlüyle biten köklerde ünlü çoğunlukla KORUNUR: araba → arabalar,
  // sunucu → sunucular, güncelleme → güncellemeler.
  const droppedVowel = DROPPING_VOWEL.get(target)
  if (droppedVowel !== undefined) return `${head(word)}${target}${droppedVowel}${suffix}`
  return `${head(word)}${target}${suffix}`
}

/**
 * Çoğulda ünlüsü düşen yaygın sözcükler (Türkçede düzensizdir).
 * soru → sorular, huzur → huzurlar, uç → uçlar.
 */
/** Son sözcük kısaltma mı? (RAM, CPU, FPS) */
function isAcronym(word: string): boolean {
  return /^[A-ZÇĞİÖŞÜ]{2,}$/u.test(lastWord(word))
}

/** Kısaltma ek alırken kesme işareti: RAM → RAM'e, CPU → CPU'yu. */
function acronymCase(word: string, suffix: string): string {
  return `${word}'${suffix}`
}

const DROPPING_VOWEL = new Map<string, string>([
  ['soru', 'u'],
  ['huzur', 'u'],
  ['uç', 'ü'],
  ['ağaç', 'a'],
])

/** Kural dışı çoğul biçimleri (kayıp → kayıplar). */
const PLURAL_FIX = new Map<string, string>([
  ['kayıp', 'kayıplar'],
  ['kaybı', 'kayıpları'],
  ['veri kaybı', 'veri kayıpları'],
  ['vergi kaybı', 'vergi kayıpları'],
])

/**
 * İyelik: telefon → telefonum / telefonun / telefonu.
 *
 * Ünsüzle biten köklerde yumuşama olur (kitap → kitab-), ünlüyle bitenlerde
 * “y” tamponu kullanılır (su → suyum).
 */
export function possessive(word: string, person: 'ben' | 'sen' | 'o' = 'ben'): string {
  if (isAcronym(word)) {
    const target = lastWord(word)
    const bufferChar = endsWithVowel(target) ? 'y' : ''
    const roundedWord = rounded(target)
    const suffix =
      person === 'ben' ? (roundedWord ? 'su' : 'sü') : person === 'sen' ? (roundedWord ? 'sunuz' : 'sünüz') : roundedWord ? 'su' : 'sü'
    return `${word}'${bufferChar}${suffix}`
  }
  const roundedWord = rounded(word)
  const soft = backness(word) === 'soft'
  // Çokluuk zaten ekliyse iyelik "fiyatlarım" olur.
  if (/(lar|ler)$/u.test(word)) {
    return `${word}${soft ? 'im' : 'ım'}`
  }
  // Kaynak metin zaten iyelikliyse ("sunucum") üst üste ek kurulmaz.
  if (alreadyPossessive(word)) return word
  if (endsWithVowel(word)) {
    // Yuvarlak ünlüde son ünlü düşer: sunucu → sunucum.
    const stem = roundedWord ? word.slice(0, -1) : word
    if (person === 'ben') return `${stem}${roundedWord ? (soft ? 'üm' : 'um') : 'm'}`
    if (person === 'sen') return `${stem}${roundedWord ? (soft ? 'ün' : 'un') : 'n'}`
    return `${stem}${roundedWord ? (soft ? 'sü' : 'su') : 'si'}`
  }
  // Yumuşama yalnızca arka ünlü iyelikte olur: kitap → kitabım, ama
  // internet → internetim (ön ünlü) yumuşamaz.
  const suffix =
    person === 'ben'
      ? roundedWord
        ? soft
          ? 'üm'
          : 'um'
        : soft
          ? 'im'
          : 'ım'
      : person === 'sen'
        ? roundedWord
          ? soft
            ? 'ün'
            : 'un'
          : soft
            ? 'in'
            : 'ın'
        : roundedWord
          ? soft
            ? 'sü'
            : 'su'
          : soft
            ? 'si'
            : 'ı'
  // İyelikte de yumuşama yalnızca p/ç/k'da olur: kitap → kitabım,
  // saat → saatım. Önceden "t" de yumuşatıldığı için "saadım", "robodum"
  // gibi bozuk biçimler üretiliyordu.
  return `${caseSoftening(word, suffix)}${suffix}`
}

/**
 * Sözcük zaten iyelik eki taşıyor mu? ("sunucum", "moralim", "oyunun")
 *
 * Kaynak metinde iyelikli biçim gelmişse ("Sunucum sürekli kapanıyor" →
 * subject "sunucum") üstüne ikinci kez iyelik eklenmez.
 */
export function alreadyPossessive(word: string): boolean {
  if (word.length < 5) return false
  if (/(um|üm|im|ım)$/u.test(word)) return true
  // 2. tekil ("oyunun", "sunucun") — kök en az 4 harfli olmalı ki
  // "gün" gibi kısa kökler yanlışlıkla eşleşmesin.
  return /(un|ün|in|ın)$/u.test(word) && word.length >= 6
}

/**
 * Sözcükten iyelik eki sıyırıp KÖK (ad biçimine dönmüş haline) isme döner.
 *
 * "sunucum" -> "sunucu", "oyunun" -> "oyun", "telefonum" -> "telefon",
 * "moralim" -> "moral", "fiyatlarım" -> "fiyatlar".
 *
 * Hâl eki (locative/dative/accusative) eklenmeden once çağrılır; aksi
 * hâlde "oyununda", "oyununa" gibi hatalı biçimler oluşur.
 */
export function baseOf(word: string): string {
  if (!alreadyPossessive(word)) return word
  const match = /(üm|um|im|ım|ün|un|ın|in)$/u.exec(word)
  if (!match || match[0] === undefined) return word
  const stem = word.slice(0, -match[0].length)
  if (KNOWN_ROOTS.has(stem)) return stem
  // Yuvarlak ünlü düşmüş kökler: "sunucu" -> "sunucum".
  for (const vowel of ROUNDED_SET) {
    if (KNOWN_ROOTS.has(stem + vowel)) return stem + vowel
  }
  // Çoğul biçimler: "fiyatlar" -> "fiyatlarım".
  if (KNOWN_ROOTS.has(`${stem}lar`) || KNOWN_ROOTS.has(`${stem}ler`)) return stem
  return word
}

/**
 * Sıyırma yalnızca KESİN KÖKLERDE yapılır.
 *
 * "yazılım" -> "yazıl", "resim" -> "res" gibi yanlış kökler oluşmasın diye
 * iyelik eki sıyırılan biçimin kökü bu listede değilse sözcük DÖNÜŞTÜRULMEZ.
 * Liste NPC'lerin sık konuştuğu gündelik konu köklerini içerir.
 */
const KNOWN_ROOTS = new Set([
  'oyun',
  'film',
  'dizi',
  'şarkı',
  'telefon',
  'bilgisayar',
  'laptop',
  'sunucu',
  'internet',
  'fiyat',
  'maç',
  'transfer',
  'program',
  'uygulama',
  'oyuncu',
  'okul',
  'üniversite',
  'sınav',
  'ders',
  'iş',
  'para',
  'hesap',
  'sifre',
  'şifre',
  'tarif',
  'yemek',
  'sağlık',
  'kaldırma',
  'abonelik',
  'kredi',
  'borç',
  'video',
  'yayın',
  'kanal',
  'kamera',
  'fotoğraf',
  'oyuncu',
  'konsol',
  'tarayıcı',
  'güncelleme',
  'pil',
])

/** Sözcüğü cümle başına uygun hale getirir (ilk harf büyük). */
export function capitalize(word: string): string {
  if (word === '') return word
  return `${(word[0] as string).toLocaleUpperCase('tr')}${word.slice(1)}`
}

/** Sondaki noktalama normalize edilir. */
export function ensureStop(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '') return trimmed
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`
}

/** Cümle listesini tek metne çevirir (arada uygun boşluk, sonunda noktalama). */
export function joinSentences(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => capitalize(ensureStop(p)))
    .join(' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
}

/** Cümleleri böler. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * Metni son haline getirir: boşlukları toplar, noktalama koyar, ardışık
 * noktalama ve cümle başı küçük harfi düzeltir.
 */
export function finishSafe(text: string): string {
  let out = text.replace(/\s+/gu, ' ').trim()
  if (out === '') return out
  if (!/[.!?…]$/u.test(out)) out += '.'
  out = out.replace(/([.!?…])\1{2,}/gu, '$1')
  out = out.replace(/(^|[.!?…]\s+)([a-zçğıöşü])/gu, (_m, head: string, ch: string) =>
    `${head}${ch.toLocaleUpperCase('tr')}`,
  )
  return out.replace(/([!?…])\.(?=[\s"])/u, '$1')
}

/** Denetim sonucu. */
export interface LintResult {
  ok: boolean
  reasons: string[]
}

const PAST_MARKERS = /\b(yaptım|ettim|gördüm|aldım|başladım|denedim|bildim)\b/iu
const PRESENT_MARKERS = /\b(yapıyorum|ediyorum|görüyorum|alıyorum|deniyorum|kullanıyorum)\b/iu
const FUTURE_MARKERS = /\b(yapacağım|edeceğim|olacak|olacaklar|deneyeceğim)\b/iu

/**
 * BOZUK BİRLEŞİM DENETİMİ.
 *
 * Kalite kapısından önce çalışır: dilbilgisel olarak bozuk metin üretimi
 * hiçbir puanlamaya girmeden elenir. Kurallar:
 *   - aynı sözcük üst üste ("konusunda konusunda")
 *   - aynı ek/bağlaç üst üste ("için için")
 *   - tek cümlede çelişen zaman ("ben yaptım yapıyorum")
 *   - boş/çok kısa metin
 *   - sondaki noktalama eksikliği
 *   - üç+ boşluk
 */
export function lint(text: string): LintResult {
  const reasons: string[] = []
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, reasons: ['boş metin'] }
  if (trimmed.length < 18) reasons.push('metin çok kısa')

  // Aynı sözcük üst üste (küçük harfe çevrilerek).
  if (/\b(\p{L}{2,})\s+\1\b/iu.test(trimmed)) reasons.push('tekrar eden sözcük')
  // Aynı edat/ek üst üste: "için için", "da de", "konusunda konusunda".
  if (/\b(için|konusunda|üzerine|nasıl|neden|şey|olarak|çok|ve|de|da)\s+\1\b/iu.test(trimmed)) {
    reasons.push('tekrar eden ek/bağlaç')
  }
  // Tek cümlede iki farklı zaman.
  for (const sentence of sentences(trimmed)) {
    const hits =
      (PAST_MARKERS.test(sentence) ? 1 : 0) +
      (PRESENT_MARKERS.test(sentence) ? 1 : 0) +
      (FUTURE_MARKERS.test(sentence) ? 1 : 0)
    if (hits >= 2) reasons.push('çelişen zaman biçimi')
  }
  if (/\s{3,}/u.test(trimmed)) reasons.push('fazla boşluk')
  // Sonda duran emoji bir noktalama sayılmaz: "Güzel yazı. 😂" bozuk değildir.
  // Aksi halde mizahçı karakterin her emoji'li adayı elenir ve emoji hiç
  // üretilmezdi.
  const withoutEmoji = trimmed
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{200D}]+\s*$/u, '')
    .trim()
  if (!/[.!?…]$/u.test(withoutEmoji)) reasons.push('noktalama eksik')
  // Soru işareti başladı ama bitmedi.
  if (/\?/.test(trimmed) && !trimmed.endsWith('?')) reasons.push('soru tümcesi eksik')
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] }
}

/** Benzersiz, karışık büyük/küçük harf karşılaştırma anahtarı. */
export function shapeKey(text: string): string {
  return text
    .toLocaleLowerCase('tr')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** İki metnin içerik örtüşmesi (Jaccard, 0..1). */
export function similarity(a: string, b: string): number {
  const ta = new Set(shapeKey(a).split(' ').filter((w) => w.length >= 4))
  const tb = new Set(shapeKey(b).split(' ').filter((w) => w.length >= 4))
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const w of ta) if (tb.has(w)) shared += 1
  return shared / (ta.size + tb.size - shared)
}

/** Cümle ortalaması uzunluğu (stil ölçümü için). */
export function averageSentenceLength(text: string): number {
  const list = sentences(text)
  if (list.length === 0) return 0
  return list.reduce((sum, s) => sum + s.split(' ').length, 0) / list.length
}
