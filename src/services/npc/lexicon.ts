/**
 * Türkçe sözlük ve morfoloji katmanı — NPC sisteminin DİLİNİ anlayan temeli.
 *
 * Neden ayrı bir dosya?
 *   Önceki sistem "futbol" kelimesini gördüyse futbol cümlesi kuruyordu.
 *   Oysa bir kullanıcı "HAHAHA bu çok komik 😂" yazdığında ortada futbol
 *   yoktur; sistem kelime havuzundan rastgele bir cümle seçiyordu. Sorun
 *   rastgelelik değil, BAĞLAMDI: hangi kelimenin hangi konu AİLESİne ait
 *   olduğu bilinmiyordu.
 *
 * Burada üç şey tanımlanır:
 *   1. `stem()` — Türkçe ek soyutlaması. "oynuyorum" → "oyun", "kitapları"
 *      → "kitap". Tam bir kök bulucu değil, bilinçli olarak kaba ve
 *      PREDICTABLE bir yaklaşım (test edilebilir olması için).
 *   2. `CONCEPTS` — kavram aileleri. Her kavram bir konu ailesidir ve
 *      üyeleri TÜM çekimli biçimleriyle listelenir. "oyun" ailesi
 *      oyna-/oyun-/oyuncu/oyunlar/oynanış/oynatmak biçimlerini kapsar.
 *   3. Duygu / niyet / abartı sözlükleri.
 *
 * Kural: tek bir kelime eşleşmesine ASLA güvenilmez; bir cümlenin konusu
 * ancak yeterli sayıda kavram üyesi bir araya geldiğinde atanır
 * (bkz. `analyze.ts` → `dominantConcept`).
 */

/** Türkçe alfabeye indirgenmiş küçük harf (İ/ı ve I/i düzeltmesi). */
export function trLower(input: string): string {
  return input.replace(/İ/gu, 'i').replace(/I/gu, 'ı').toLocaleLowerCase('tr')
}

/**
 * Ek listesi. Uzun ekler önce denenir (sıra önemlidir).
 *
 * Fiil ekleri ("-yor", "-mış", "-di"), isim ekleri ("-lar", "-dan",
 * "-ın"), türetme ekleri ("-lik", "-ci", "-siz") ve olumsuzluk ("-ma",
 * "-sız") kapsanır. Amaç: aynı aileyi aynı köke indirgemek.
 */
const SUFFIXES: string[] = [
  // Çok ekli / türetme
  'larından', 'lerinden', 'larına', 'lerine', 'larımız', 'lerimiz',
  'lığı', 'liği', 'luğu', 'lüğü', 'sızlığı', 'sizliği', 'çılığı', 'ciliği',
  'lığından', 'liğinden',
  // İsim ekleri
  'larından', 'lerinden', 'larına', 'lerine', 'ları', 'leri', 'ların',
  'lerin', 'lar', 'ler', 'dan', 'den', 'tan', 'ten', 'da', 'de', 'ta', 'te',
  'ın', 'in', 'un', 'ün', 'nın', 'nin', 'nun', 'nün', 'sı', 'si', 'su', 'sü',
  'yı', 'yi', 'yu', 'yü', 'a', 'e', 'ı', 'i', 'u', 'ü', 'ya', 'ye',
  // Fiil ekleri
  'maktan', 'makta', 'maktan', 'acaktı', 'ecekti', 'ıyormuş', 'iyormuş',
  'uyorum', 'üyorum', 'uyoruz', 'uyorsun', 'uyor', 'üyor',
  'ayacak', 'yecek', 'acak', 'ecek', 'dım', 'dim', 'dun', 'dün',
  'mış', 'miş', 'mus', 'müs', 'yor', 'yür', 'dur', 'di', 'du', 'dü', 'tı',
  'ti', 'tu', 'tü', 'dır', 'dir', 'dur', 'dür', 'tır', 'tir', 'tür', 'dur',
  'yordu', 'yordu', 'dım', 'dim', 'dun', 'dün', 'tım', 'tim', 'sun', 'sün',
  'mak', 'mek', 'maktan', 'cası', 'cesi',
  // Zarf / sıfat
  'lığı', 'liği', 'lık', 'lik', 'luk', 'lük', 'cı', 'ci', 'cu', 'cü',
  'sız', 'siz', 'suz', 'süz', 'çı', 'ci', 'cu', 'cü', 'çü', 'ki', 'çe', 'ca',
]

/**
 * Kökü bulduğunda durdurmak için gereken minimum uzunluk.
 * Üç harf ("maç", "gol", "oyn") yeterlidir; kavram eşleştirmesi zaten
 * ek soyutlamadan sonra yapılır.
 */
const MIN_STEM = 3

/**
 * Türkçe ek soyutlar.
 *
 * Uzunluk 4'ten kısa bir kök bırakmaya çalışır; olmuyorsa kelimeyi olduğu
 * gibi döndürür. Sonda üst üste ek varsa en fazla üç tur soyutlar.
 *
 * @example stem('oynuyorum') === 'oyun'
 * @example stem('telefonlarım') === 'telefon'
 */
export function stem(input: string): string {
  let word = trLower(input).replace(/[^\p{L}\p{N}]+/gu, '')
  for (let pass = 0; pass < 3; pass++) {
    let stripped = false
    for (const suffix of SUFFIXES) {
      if (word.length - suffix.length >= MIN_STEM && word.endsWith(suffix)) {
        word = word.slice(0, -suffix.length)
        stripped = true
        break
      }
    }
    if (!stripped) break
  }
  return word.length >= 3 ? word : trLower(input)
}

/** Bir kavramın konu ailesi. */
export interface Concept {
  /** Konu anahtarı (persona ilgi alanları ve board içerikleriyle eşleşir). */
  id: string
  /** Görünen ad (yönetim paneli). */
  label: string
  /**
   * Aile üyeleri. Her üye soyutma SONRASI kökle de eşleşir, böylece
   * "oynuyorum"ın kökü "oyun" ile doğrudan tutar.
   */
  stems: string[]
}

/**
 * Kavram aileleri — bağlam motorunun çekirdeği.
 *
 * Her aile en az bir "çekirdek" kelime içerir (`stems[0]`); üyeler bu
 * çekirdeğin ÖNEKI ya da kendisi olmalıdır. Böylece "oyuncular" → "oyuncu"
 * → aile "oyun" ile eşleşirken, "bileşik" kelimeler yanlış aileye düşmez.
 */
export const CONCEPTS: Concept[] = [
  {
    id: 'oyun',
    label: 'Oyun',
    stems: ['oyun', 'oyna', 'oyn', 'oynan', 'oynat', 'gamer', 'konsol', 'fps', 'multiplayer', 'steam', 'minecraft', 'pubg', 'valorant', 'oyuncu', 'takım', 'klan', 'guild', 'pvp', 'boss', 'görev', 'level', 'xp', 'skin'],
  },
  {
    id: 'yazilim',
    label: 'Yazılım',
    stems: ['yazılım', 'yazilim', 'kod', 'program', 'geliştir', 'gelistir', 'python', 'javascript', 'java', 'c#', 'html', 'css', 'sql', 'veritaban', 'backend', 'frontend', 'yazılımcı', 'kodlayan', 'algoritma', 'fonksiyon', 'kütüphane', 'framework', 'api', 'debug', 'derleyici', 'ide', 'github', 'git', 'linux', 'docker', 'sistem', 'sunucu', 'yapay zeka', 'model'],
  },
  {
    id: 'teknoloji',
    label: 'Teknoloji',
    stems: ['teknoloji', 'telefon', 'telefonum', 'laptop', 'bilgisayar', 'tablet', 'şarj', 'sarj', 'pil', 'batarya', 'internet', 'wifi', 'bluetooth', 'kablo', 'usb', 'ekran', 'işlemci', 'ram', 'ssd', 'hdmi', 'gadget', 'akıllı', 'akilli', 'cihaz', 'uygulama', 'uygulam', 'güncelle', 'sistem', 'internet', 'modem', 'yavaşladı', 'yavaş', 'donuyor', 'kilitlen', 'şifre', 'hesap', 'ağ', 'ag', 'modem'],
  },
  {
    id: 'siber',
    label: 'Siber güvenlik',
    stems: ['siber', 'güvenlik', 'guvenlik', 'hack', 'hacker', 'exploit', 'virüs', 'virus', 'zararlı', 'malware', 'phishing', 'şifre', 'sifre', 'kullanıcı', 'kullanici', 'veri', 'sızdır', 'sizdir', 'firewall', ' antivirüs', 'kötücül'],
  },
  {
    id: 'muzik',
    label: 'Müzik',
    stems: ['müzik', 'muzik', 'şarkı', 'sarki', 'albüm', 'album', 'konser', 'sanatçı', 'sanatci', 'grupt', 'parça', 'parca', 'tempo', 'ritim', 'melodi', 'gitar', 'piyano', 'davul', 'hop', 'rap', 'pop', 'rock', 'metal', 'klip', 'spotify', 'youtube'],
  },
  {
    id: 'spor',
    label: 'Spor',
    stems: ['spor', 'futbol', 'basketbol', 'voleybol', 'maç', 'mac', 'transfer', 'lig', 'kupa', 'gol', 'penaltı', 'hakem', 'stadyum', 'taraftar', 'koç', 'koc', 'transfer', 'takım', 'kaleci', 'sakat', 'kondisyon', 'maraton', 'koşu', 'kosu'],
  },
  {
    id: 'yemek',
    label: 'Yemek',
    stems: ['yemek', 'tarif', 'mutfak', 'pişir', 'pisir', 'kızart', 'kizart', 'fırın', 'firin', 'tencere', 'tava', 'çay', 'cay', 'kahve', 'tatlı', 'tatli', 'pasta', 'çorba', 'corba', 'kebap', 'lahmacun', 'pide', 'baklava', 'yemek', 'aç', 'aclik', 'açlık'],
  },
  {
    id: 'egitim',
    label: 'Eğitim',
    stems: ['eğitim', 'egitim', 'okul', 'ders', 'sınav', 'sinav', 'üniversite', 'universite', 'ödev', 'odev', 'hoca', 'öğretmen', 'ogretmen', 'öğrenci', 'ogrenci', 'not', 'karne', 'bölüm', 'bolum', 'staj', 'lise', 'ilkokul', 'soru', 'soru bankası', 'kaynak', 'dershan'],
  },
  {
    id: 'bilim',
    label: 'Bilim',
    stems: ['bilim', 'uzay', 'fizik', 'kimya', 'biyoloji', 'araştır', 'arastir', 'deney', 'laboratuvar', 'uzman', 'akademi', 'evren', 'gezegen', 'yıldız', 'nötron', 'atom', 'teleskop', 'uzay'],
  },
  {
    id: 'ekonomi',
    label: 'Ekonomi',
    stems: ['ekonomi', 'fiyat', 'para', 'borsa', 'maaş', 'maas', 'zam', 'ücret', 'ucret', 'vergi', 'kredi', 'borç', 'borc', 'enflasyon', 'döviz', 'doviz', 'dolar', 'euro', 'bütçe', 'butce', 'işsiz', 'issiz', 'kira'],
  },
  {
    id: 'siyaset',
    label: 'Siyaset',
    stems: ['siyaset', 'meclis', 'bakan', 'parti', 'seçim', 'secim', 'kanun', 'yasa', 'belediye', 'vali', 'valilik', 'bütçe', 'butce', 'muhalefet', 'iktidar', ' Cumhurbaşkanı', 'valilik', 'sivil'],
  },
  {
    id: 'saglik',
    label: 'Sağlık',
    stems: ['sağlık', 'saglik', 'hastalık', 'hastalik', 'doktor', 'doktora', 'doktoru', 'hasta', 'hastane', 'eczane', 'ilaç', 'ilac', 'tedavi', 'ameliyat', 'nezle', 'grip', 'baş ağrı', 'ağrı', 'agri', 'sırt', 'uyku', 'beslenme', 'diyet', 'vitamin', 'egzersiz', 'psikoloji', 'terapi'],
  },
  {
    id: 'sinema',
    label: 'Sinema',
    stems: ['sinema', 'film', 'dizi', 'kurgu', 'oyuncu', 'yönetmen', 'yonetmen', 'senaryo', 'sahne', 'fragman', 'oscar', 'imdb', 'platform', 'izle'],
  },
  {
    id: 'tarih',
    label: 'Tarih',
    stems: ['tarih', 'imparatorluk', 'savaş', 'savas', 'osmanlı', 'osmanli', 'cumhuriyet', 'atatürk', 'atatürk', 'sultan', 'padişah', 'padisah', 'bizans', 'antik', 'antik', 'muze', 'müze', 'muze', 'tarihi', 'efsane'],
  },
  {
    id: 'hobi',
    label: 'Hobi',
    stems: ['hobi', 'balık', ' balik', 'bahçe', 'bahce', 'marangoz', 'fotoğraf', 'fotograf', 'resim', 'çizim', 'cizim', 'yazı', 'defter', 'kitap', 'okuma', 'balıkçılık', 'tavuk', 'bahçıvanlık'],
  },
  {
    id: 'teknoloji_elektronik',
    label: 'Elektronik',
    stems: ['elektronik', 'devre', 'led', 'motor', 'robot', 'araba', 'otomobil', 'araç', 'arac', 'yakıt', 'yakit', 'benzin', 'motor', 'lastik', 'yedek parça'],
  },
]

/** Konu anahtarı → kavram id'si (eşleşmeyen durumda doğrudan konu kullanılır). */
export const CONCEPT_BY_ID = new Map(CONCEPTS.map((c) => [c.id, c]))

/** Bir kelimenin ait olduğu kavram ailesi (yoksa null). */
export function conceptOf(word: string): Concept | null {
  const s = stem(word)
  // "maç", "gol", "kod" gibi üç harfli çekirdekler de gerçek konu
  // göstergeleridir; aile üyeliği onları da kapsar.
  if (s.length < 3) return null
  for (const concept of CONCEPTS) {
    for (const stemForm of concept.stems) {
      if (s === stemForm) return concept
      // "oyuncu" → "oyun", "kodlama" → "kodla": kök, ailenin bir üyesinin
      // ÖNEKI olduğunda de eşleşme kabul edilir (en az 4 harf).
      if (stemForm.length >= 4 && s.startsWith(stemForm)) return concept
      // Ek soyutlaması fazla çalıştığında: "yavaşladı" → "yavaşlad".
      // Kök, ailenin bir üyesinin ÖNEKI olduğunda da eşleşir — ama fark en
      // fazla 3 harf olmalıdır: aksi halde "kon" kökü "konsol"a uyup
      // "Bu konuda …" cümlesi oyun konusuna sürükleniyordu.
      if (
        s.length >= 5 &&
        stemForm.length >= 5 &&
        stemForm.length - s.length <= 3 &&
        stemForm.startsWith(s)
      ) {
        return concept
      }
    }
  }
  return null
}

/** Duygu: olumlu / olumsuz / nötr. */
export type Sentiment = 'positive' | 'negative' | 'neutral'

const POSITIVE_WORDS = [
  'güzel', 'guzel', 'harika', 'müthiş', 'muhtesem', 'süper', 'super', 'muhteşem',
  'seviyorum', 'sevdim', 'başarılı', 'basarili', 'tavsiye', 'şahane', 'sahane',
  'keyifli', 'eğlenceli', 'eglenceli', 'kutlu', 'tebrik', 'hoş', 'hos', 'iyi',
  'güzelmiş', 'güzelmiş', 'mükemmel', 'mukemmel', 'oyuncu', 'kolay', 'rahat',
  'umut', 'umutlu', 'beğendim', 'begendim', 'şahane', 'mucize', 'ninja',
]

const NEGATIVE_WORDS = [
  'kötü', 'kotu', 'berbat', 'bozuk', 'çalışmıyor', 'calismiyor', 'yaramıyor',
  'yaramiyor', 'sorun', 'sıkıntı', 'sikinti', 'şikâyet', 'sikayet', 'üzgün',
  'uzgun', 'sinir', 'kızgın', 'kizgin', 'hayal kırıklığı', 'kotu', 'berbat',
  'sinir bozucu', 'rezalet', 'işe yaramıyor', 'ise yaramıyor', 'donuyor',
  'kasıyor', 'kasiyor', 'çöktü', 'coktu', 'yavaşladı', 'yavasladi', 'pahalı',
  'pahalı', 'anlamsız', 'alakasız', 'alakasiz', 'saçma', 'sacma', 'sıkıldım',
  'sikildim', 'stres', 'stresli', 'sorunlu', 'şikâyetçi', 'sikayetci', 'kötüye',
  'kötüye gitti', 'batirdi', 'battı',
]

/** Bir metnin duygu ağırlığı (-1..1). */
export function sentimentOf(text: string): Sentiment {
  const lower = trLower(text)
  let score = 0
  for (const w of POSITIVE_WORDS) if (lower.includes(w)) score += 1
  for (const w of NEGATIVE_WORDS) if (lower.includes(w)) score -= 1
  if (score > 0) return 'positive'
  if (score < 0) return 'negative'
  return 'neutral'
}

/** Metindeki olumlu/olumsuz sözlük sayısı (davranış ağırlıklandırması için). */
export function sentimentCounts(text: string): { positive: number; negative: number } {
  const lower = trLower(text)
  let positive = 0
  let negative = 0
  for (const w of POSITIVE_WORDS) if (lower.includes(w)) positive += 1
  for (const w of NEGATIVE_WORDS) if (lower.includes(w)) negative += 1
  return { positive, negative }
}

// ---------------------------------------------------------------------------
// Niyet kalıpları
// ---------------------------------------------------------------------------

/**
 * Niyet. Önceki sistemde 8 niyet vardı; burada davranış motorunun gerçekten
 * ayırt ettiği daha geniş bir takım var.
 */
export type Intent =
  | 'laugh'        // kahkaha
  | 'greeting'     // selamlaşma
  | 'thanks'       // teşekkür
  | 'question'      // soru
  | 'complaint'    // şikâyet
  | 'request'      // yardım/tavsiye isteği
  | 'opinion'      // yargı/paylaşım
  | 'news'         // haber/bilgi aktarımı
  | 'experience'   // deneyim paylaşımı
  | 'praise'       // övgü
  | 'mock'         // alay
  | 'topic_shift'  // konu değiştirme
  | 'empty'        // anlamsız

/** Niyet tespitinde kullanılan düzenli ifadeler. */
export const INTENT_PATTERNS: Array<{ intent: Intent; re: RegExp }> = [
  { intent: 'laugh', re: /(^|\s)([ha]{3,}|k{3,}|hehe+|jeje+|l+o+l+|x+d+)(?![a-z0-9çğıöşü])/iu },
  { intent: 'laugh', re: /(😂|🤣|😹|😆|🙃|😅)/u },
  { intent: 'greeting', re: /^(merhaba|selam|merhabalar|iyi günler|günaydın|iyi akşamlar|iyi geceler|slm|mrb|nasıl gidiyor|ne haber)\b/iu },
  { intent: 'greeting', re: /^(s\.?a\.?|mrb|slm)[\s.!]/iu },
  { intent: 'thanks', re: /\b(sağ ?ol|teşekkür|tşk|sağol|eyvallah)\w*/iu },
  { intent: 'mock', re: /\b(adam mı|ne biçim|bunu da yaparsın|komikmiş|şaşkın|inşallah|allah aşkına|kadar)\b/iu },
  { intent: 'complaint', re: /\b(kötü|berbat|bozuk|çalışmıyor|yaramıyor|donuyor|kasıyor|çöktü|yavaşladı|sorun|şikâ?yet|sinir|üzgün|üzen|rezalet)\w*/iu },
  { intent: 'request', re: /\b(lütfen|rica|yardım|nasıl yap|anlatır mısın|anlatir misin|öğret|ne yapmalıyım|ne yapmaliyim|ne öner|ipuç|çözüm|tavsiye)\w*/iu },
  { intent: 'news', re: /\b(duyurdum|haber|resmi olarak|açıklandı|başladı|başliyor|etkinlik|yarın|bugün|resmî)\w*/iu },
  { intent: 'experience', re: /\b(denedim|yaşadım|yaptım|çözdüm|kullandım|oynadım|izledim|geçen yıl|geçen sene)\w*/iu },
  { intent: 'praise', re: /\b(güzel|harika|müthiş|muhteşem|tebrik|seviyorum|beğendim|begendim|mucize)\w*/iu },
  { intent: 'question', re: /\?/u },
  { intent: 'question', re: /\b(ne|neden|niçin|niye|nasıl|nerede|nereye|neresi|ne zaman|kaç|hangi|var mı|yok mu|olur mu|nedir|ne demek|kim)\b/iu },
]

/** Bir metnin taşıdığı niyetleri (birden fazla olabilir). */
export function intentsOf(text: string): Intent[] {
  const found: Intent[] = []
  for (const { intent, re } of INTENT_PATTERNS) {
    if (re.test(text) && !found.includes(intent)) found.push(intent)
  }
  return found
}

/** Birincil niyet (ilk eşleşen). */
export function primaryIntent(text: string): Intent {
  return INTENT_PATTERNS.find(({ re }) => re.test(text))?.intent ?? 'opinion'
}

/**
 * Alay/ironi işareti. Gülümseme ve "çok güzel" gibi kalıplar birlikte
 * kullanıldığında ciddiye alınmaz.
 */
export const MOCK_RE = /(😂|🤣|😏|🙃)|(\b(adam|yaa|helal)[^.!?]{0,30}(?:güzel|mükemmel|harika|bravo))/iu

/** Emoji listesi (kişilik oranına göre seçilir). */
export const EMOJIS = ['🙂', '😂', '😅', '😕', '🤔', '👍', '🔥', '👏', '😎', '😔', '❤️', '💯', '👀', '✅', '🙏', '☕', '🎉', '🧐', '💡', '😅']

/**
 * Argo/kesme kalıpları — sadece `slang_rate` yüksekken kullanılır.
 *
 * Her biri kendi başına bir cümledir: yarım kalan kalıplar (“va”)
 * cümleyi bozduğu için bilinçli olarak elendi.
 */
export const SLANG_MARKERS = ['la', 'lan', 'aq', 'helal', 'moruk', 'kanka', 'abi', 'reis', 'adam']
