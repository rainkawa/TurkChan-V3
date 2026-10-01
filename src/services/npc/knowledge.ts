/**
 * NPC bilgi tabanı — SORULARA CEVAP.
 *
 * Sorun: NPC'ler “Merhaba, HTML ana şablonunu atar mısınız?” gibi bir
 * soruya “Yazılım için biraz yardım lazım. Hata mesajını okumayı atla.”
 * diye yanıt veriyordu. Bunun sebebi üreticinin yalnızca “kavram ailesi”
 * bilmesiydi: konuyu tanıyordu ama konunun NE olduğunu bilmiyordu.
 *
 * Çözüm: konu ailelerinin altına somut, kısa ve doğru cevaplar konur.
 * Üretici artık bir soru gördüğünde önce buraya bakar; karşılığı varsa
 * gönderiyi yankılayan kalıplar yerine CEVABI yazar.
 *
 * Kurallar:
 *   - Her cevap gönderinin kendi kelimelerine bağlıdır (`match`).
 *   - Cevap metinleri düz metindir: markdown, bağlantı ve kod bloğu
 *     kalite kapısı tarafından elenir (`quality.ts` → BAD_FORMATS).
 *   - Cevap bulunamazsa üretici konuyu netleştirme sorusuna düşer; asla
 *     ilgisiz bir cümle kurmaz.
 */
import { stem } from './lexicon'
import type { ContextAnalysis } from './analyze'

export interface KnowledgeEntry {
  /** Görünen konu başlığı (log ve denetim için). */
  topic: string
  /**
   * Bu cevabı tetikleyen kelimeler. Sözdizimsel kökleriyle karşılaştırılır
   * (“şablonu” → “şablon”, “atabilir misin” → “at”).
   */
  match: string[]
  /** Cevap cümlesi. `{özne}` okunan gönderinin özne kelimesidir. */
  answer: string
  /**
   * Aynı bilginin ikinci bir anlatımı. On NPC aynı gönderiye cevap
   * verdiğinde hepsi kelimesi kelimesine aynı cümleyi yazmasın diye
   * üretici bu iki anlatım arasında seçim yapar.
   */
  alt?: string
  /** Cevabı tamamlayan ikinci cümle (isteğe bağlı). */
  followUp?: string
}

/**
 * Konu → cevap. Sıra önemlidir: daha özgül kayıtlar önce gelir, çünkü
 * eşleşme sayısı eşit olduğunda ilk bulunan kazanır.
 */
export const KNOWLEDGE: KnowledgeEntry[] = [
  {
    topic: 'html-sablon',
    match: ['html', 'sablon', 'şablon', 'template', 'iskelet', 'beton'],
    answer:
      'En sade HTML iskeleti şu: doctype ile başla, head içine charset ve title yaz, gövdeye içeriği koy. Kapatmayı unutma.',
    alt: 'Boş bir sayfa bile şu sırayla kurulur: doctype, head, body. Kapanış etiketlerini atlama.',
    followUp: 'CSS eklemek istersen aynı head içine style etiketi açman yeterli.',
  },
  {
    topic: 'css-tasarim',
    match: ['css', 'tasarim', 'stil', 'renk', 'font', 'layout'],
    answer:
      'CSS dosyasını HTML içinde head etiketinden bağlarsan hemen çalışır; mobil için viewport ayarını da eklemeyi unutma.',
    alt: 'Stilleri ayrı dosyada tutmak yerine head içine bir style bloğu açmak en hızlı yol; viewport ayarını da ekle.',
  },
  {
    topic: 'python-hata',
    match: ['python', 'hata', 'traceback', 'syntax', 'kod', 'programlama', 'fonksiyon'],
    answer:
      'Hata mesajının en alt satırı dosya adını ve satır numarasını verir; hatayı oradan değil, bir üst satırdaki çağrıdan okumak gerekir.',
    alt: 'Traceback yukarıdan aşağı değil aşağıdan yukarı okunur; en alt satırdaki dosya ve satır numarası asıl ipucudur.',
    followUp: 'Önce küçük bir örnekle aynı hatayı tekrar üret, sonra düzeltmeyi dene.',
  },
  {
    topic: 'oyun-sunucu',
    match: ['sunucu', 'server', 'port', 'hoster', 'açılmıyor', 'baglanmiyor', 'baglanmıyor'],
    answer:
      'Sunucu açılmıyorsa kullandığın portun dışarıya açık olduğundan ve istemci ile sunucu sürümlerinin aynı olduğundan emin ol.',
    alt: 'Açılmama sorununda önce portun dışarıya açık olup olmadığına bak, sonra istemci ve sunucu sürümlerini karşılaştır.',
    followUp: 'Sunucu günlüğündeki ilk hata satırına bak; asıl sebep genellikle orada yazar.',
  },
  {
    topic: 'oyun-performans',
    match: ['performans', 'fps', 'kare', 'donma', 'kasma', 'gecikme', 'yavasladi', 'yavaşladı', 'ısınma', 'isinma'],
    answer:
      'Performans düşüyorsa çözünürlüğü ve efektleri kapat, ardından güncelleme olup olmadığına bak.',
    alt: 'Kare düşüyorsa çözünürlük ve efektleri kapatmak en hızlı rahatlama; güncelleme varsa onu da yükle.',
    followUp: 'Cihaz ısınıyorsa yönlendiriciyi veya kılıfı kaldırıp tekrar dene.',
  },
  {
    topic: 'telefon-yavaslik',
    match: ['telefon', 'telefonum', 'smartphone', 'iphone'],
    answer:
      'Telefon yavaşladıysa arka planda açık uygulamaları kapat, depolama alanını boşalt ve güncelleme olup olmadığına bak.',
    alt: 'Yavaşlayan telefonda önce depolama alanını boşalt, sonra arka planda açık uygulamaları kapat; güncelleme varsa yükle.',
  },
  {
    topic: 'pil-batarya',
    match: ['pil', 'batarya', 'sarj', 'şarj', 'sarj', 'gecikiyor', 'bitiyor'],
    answer:
      'Pil normalden hızlı bitiyorsa arka plan kısıtlamasını aç ve ekran parlaklığını düşür; pil sağlığını da ayarlardan kontrol edebilirsin.',
    alt: 'Pil ömrü için arka plan kısıtlaması açık olmalı ve parlaklık düşük tutulmalı; pil sağlığını ayarlardan da gör.',
  },
  {
    topic: 'internet-yavaslik',
    match: ['internet', 'wifi', 'wi-fi', 'baglanti', 'bağlantı', 'modem', 'yavas', 'koptu', 'kopuyor'],
    answer:
      'İnternet yavaşsa modemi on dakika kapatıp yeniden başlat; hâlâ yavaşsa kabloyla dene, kablo da yavaşsa operatöre bildir.',
    alt: 'Bağlantı yavaşsa modemi kapatıp yeniden açmak çoğu zaman işe yarar; yine yavaşsa kabloyla dene, o da yavaşsa operatöre bildir.',
  },
  {
    topic: 'sifre-guvenlik',
    match: ['sifre', 'şifre', 'hesap', 'kurtarma', 'giris', 'giriş', '2fa', 'dogrulama', 'doğrulama'],
    answer:
      'Şifre kurtarma gelmiyorsa önce spam ve tanımsız klasörüne bak; sonra destek formundan hesap doğrulaması iste.',
    alt: 'Kurtarma e-postası gelmiyorsa spam klasörüne ve tanımsızlar bölümüne bak, sonra destekten hesap doğrulaması iste.',
    followUp: 'Güvenlik için aynı şifreyi birden fazla yerde kullanmamaya dikkat et.',
  },
  {
    topic: 'spor-transfer',
    match: ['mac', 'maç', 'transfer', 'lig', 'kupa', 'gol', 'kadro'],
    answer:
      'Maç ve transfer haberlerinde en güvenilir kaynak kulübün resmî duyurusu; kulüp arası dedikodu çoğu zaman doğrulanmıyor.',
    alt: 'Transfer dedikodusu çoğu zaman doğrulanmıyor; kulübün kendi sitesindeki duyuruya bakmak en sağlam yol.',
  },
  {
    topic: 'muzik-oneri',
    match: ['muzik', 'müzik', 'sarki', 'şarkı', 'album', 'albüm', 'konser', 'parca', 'parça'],
    answer:
      'Böyle bir şarkı için önce sana en çok yakışan türü söyle, sonra onun benzerlerini önereyim.',
    alt: 'Hangi türü sevdiğini söyle, ben de ona yakın sanatçıları önereyim.',
  },
  {
    topic: 'yemek-tarif',
    match: ['tarif', 'yemek', 'yapimi', 'piyirmak', 'pişirmek', 'tarifin'],
    answer:
      'Tarifte süreleri gözden geçir; fırını önceden ısıt ve tuzlamayı sona bırak, sonuç daha düzenli olur.',
    alt: 'Fırın önceden ısıtılmalı, tuzlama sona kalmalı; süreleri de tarifte yazanın biraz üstünde tut.',
  },
  {
    topic: 'egitim-calisma',
    match: ['sinav', 'sınav', 'ders', 'okul', 'universite', 'üniversite', 'odev', 'ödev', 'not'],
    answer:
      'Konuyu çalışırken önce özet çıkar, sonra örnekle; test çözmeden çalışmak zaman kaybına yol açar.',
    alt: 'Önce konuyu özetle, sonra örnek çöz; test çözmeden ezberlemek işe yaramaz.',
  },
  {
    topic: 'tarih-kaynak',
    match: ['tarih', 'osmanli', 'osmanlı', 'bizans', 'imparatorluk', 'savas', 'savaş', 'muze'],
    answer:
      'Tarih için dönemi baştan sona kronolojik ilerleyen bir kaynak seç; dönemsel çalışmak kalıcı oluyor.',
    alt: 'Kronolojik ilerleyen bir kaynak seç; dönemsel çalışınca yerler ve tarihler yerine oturur.',
  },
  // BİLEREK KAPSAM DIŞI: “ne yapmalıyım” gibi genel ifadeler bir konuyu
  // göstermez. Bunlar bilgi tabanında değil, üreticinin netleştirme
  // kalıplarında ele alınır; buraya eklenirse her soru aynı cevabı alır.
]

/** Bir metinde geçen kökler (benzersiz). */
function rootsOf(text: string): Set<string> {
  return new Set(
    text
      .toLocaleLowerCase('tr')
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => stem(w))
      .filter((w) => w.length >= 3),
  )
}

/** “yavaşladı” → “yavasladi”: ASCII karşılık, sözlükteki yazımları eşler. */
function fold(text: string): string {
  return text
    .replace(/ş/gu, 's')
    .replace(/Ş/gu, 'S')
    .replace(/ı/gu, 'i')
    .replace(/İ/gu, 'I')
    .replace(/ğ/gu, 'g')
    .replace(/ü/gu, 'u')
    .replace(/ö/gu, 'o')
    .replace(/ç/gu, 'c')
    .replace(/â/gu, 'a')
    .replace(/î/gu, 'i')
    .replace(/û/gu, 'u')
}

/**
 * Okunan gönderi için uygun cevabı bulur.
 *
 * Puanlama: gönderinin ÖZNESİyle (ör. “İnternetim”, “performansım”) eşleşen
 * kayıt güçlü kazanır. Aksi halde “çok yavaşladı” ifadesi hem telefon hem
 * oyun kaydını eşleştirir ve yanlış cevap seçilir.
 *
 * @returns Eşleşen bilgi kaydı ya da `null` (cevap verilemiyorsa).
 */
export function findAnswer(content: string, analysis: ContextAnalysis): KnowledgeEntry | null {
  // Yalnızca soru/yardım isteyen içeriklere cevap verilir; bir yargıya
  // cevap üretmek konu dışı olur.
  if (!analysis.isQuestion && !analysis.isHelpRequest) return null

  const roots = [...rootsOf(`${content} ${analysis.subject} ${analysis.focus}`)].map(fold)
  const focusRoot = fold(stem(analysis.focus))

  let best: { entry: KnowledgeEntry; score: number } | null = null
  for (const entry of KNOWLEDGE) {
    let score = 0
    // Sözlükte hem ASCII hem Türkçe yazımı olan kelimeler katlanınca aynı
    // köke düşer; aksi halde aynı eşleşme iki kez sayılır ve genel kalıp
    // (“nasıl”, “yapılır”) somut konuları yenilidir.
    const needles = [...new Set(entry.match.map((n) => fold(stem(n))))]
    for (const root of needles) {
      if (root.length < 3) continue
      const exact = roots.includes(root)
      // ÖNEK eşleşmesi yalnızca 4+ harfli köklerde yapılır. "yap" gibi
      // kısa bir kök; "yapmalıyım", "yapılır", "yapıyorum" kelimelerinin
      // hepsiyle önek eşleşir ve “Yardım İstiyorum” gönderisine yemek
      // tarifi cevabı üretilmesine yol açıyordu.
      const prefix =
        root.length >= 4 && roots.some((r) => r.length >= 4 && (r.startsWith(root) || root.startsWith(r)))
      if (!exact && !prefix) continue
      const weight = exact ? 1 : 0.6
      // Gönderinin odağıyla ("performansım", "internetim") eşleşen kayıt
      // belirgin biçimde öne çıkar; genel “ne yapmalıyım” kalıbı değil.
      score +=
        root.length >= 4 && focusRoot.length >= 4 && focusRoot.startsWith(root) ? weight * 3 : weight
    }
    if (score === 0) continue
    // Eşitlikte daha küçük eşleşme listesi (daha özgül kayıt) kazanır.
    if (!best || score > best.score || (score === best.score && entry.match.length < best.entry.match.length)) {
      best = { entry, score }
    }
  }

  return best?.entry ?? null
}