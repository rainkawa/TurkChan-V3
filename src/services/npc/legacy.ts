/**
 * ESKİ ŞABLON HAVUZLARI — YALNIZCA SON ÇARE.
 *
 * Bu dosyadaki cümle havuzları artık üretimin ANA YOLU DEĞİLDİR. Yeni
 * üretim mimarisi `thought → plan → parça → dilbilgisi → denetim`
 * zinciridir (bkz. thought.ts / plan.ts / fragments.ts / render.ts).
 *
 * Buraya yalnızca o zincir hiçbir geçerli aday üretemediğinde başvurulur
 * ve üretilen yorum `style: "fallback-*"` olarak işaretlenir; yönetim
 * panelindeki "template_dependency" metriği bu oranı gösterir.
 *
 * Kural: buraya YENİ cümle havuzu eklenmez. Buradaki havuz zamanla
 * küçültülebilir; ana üretim bu dosyaya hiç bağımlı değildir.
 */
import type { ContextAnalysis } from './analyze'
import type { NpcPersona } from './personas'
import type { Stance } from './compose'
import { finishSafe, ensureStop } from './grammar'
import { trLower } from './lexicon'

/** Yardım isteyen içeriklerde açılış (gönderiyi yankılamaz). */
const HELP_OPENERS: string[] = [
  '{konu} konusunda sana birkaç şey söyleyebilirim',
  '{özne} tarafında önce şunu denemek mantıklı',
  '{konu} için pratik bir yol var',
]

/** Niyete göre açılış kalıpları. */
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

/** Tutama göre gövde kalıpları. */
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

/** Empati cümleleri. */
const EMPATHIC: string[] = [
  '{konu} konusunda gerçekten can sıkıcı bir durum',
  'bu {konu} meselesi çok yorucu, anlıyorum',
  '{konu} için üzülürüm, umarım çözülür',
]

/** Somut yardım kalıpları. */
const ADVICE: Record<string, string[]> = {
  oyun: ['{konu} için ayarları sıfırlayıp tekrar dene', '{konu} tarafında güncelleme yapıldı mı kontrol et'],
  yazilim: ['{konu} için önce küçük bir örnekle başla', '{konu} sorununda hata mesajının en alt satırına bak'],
  teknoloji: ['{konu} için önce yeniden başlatmayı dene', '{konu} meselesinde güncelleme kontrol edilmeli'],
  siber: ['{konu} için şifreni değiştir, aynı şifreyi kullanma', '{konu} konusunda iki faktörlü doğrulama aç'],
  genel: ['{konu} için basit bir çözüm var sanırım', '{konu} konusunda adım adım bakmak gerekir'],
}

/** Uzun yazan karakterler için ek cümle. */
const ELABORATIONS: string[] = [
  'Aslında burada birkaç şeyi ayırmak lazım.',
  'Ben olsam önce küçük bir adımla başlardım.',
]

/** Konu yokken kullanılan empati cümleleri. */
const EMPATHIC_NOPIC: string[] = [
  'sorunun çözüldüğünü umarım',
  'merak ettim, sonucu yazarsan sevinirim',
  'umuyorum ki çabuk çözülür',
]

/** Kavram ailesi tanınmayan ama gerçek bir soru olan içerikler için. */
const CLARIFY: string[] = [
  '{özne} kısmını biraz açar mısın, tam anlamadım',
  'hangi konuda yardım istediğini biraz daha somut yazar mısın',
  '{özne} için ne denediğini paylaşırsan daha iyi yardımcı olabilirim',
  'biraz daha detay verirsen {özne} tarafında fikrim olur',
]

/** Şüpheci karakterler için. */
const SKEPTICAL: string[] = ['Bu iddianın kaynağı ne, emin misin?', 'Somut bir örnek var mı bu söylediğinde?']

/** Meraklı karakterler için. */
const CURIOUS: string[] = ['Bu konuda öğrenmek istiyorum, anlatır mısın?', 'Bunu hiç bilmiyordum, nasıl öğrenebilirim?']

/** Haber/deneyim kalıpları. */
const NEWS: string[] = ['{konu} tarafında yeni bir şey duydum, paylaşayım.', '{konu} konusunda bilgi aktarmak istedim.']

const EXPERIENCE: string[] = ['{konu} konusunda kendim de yaşadım, şöyle oldu.', '{konu} ile ilgili tecrübem var, anlatayım.']

/** Deterministik seçim. */
function pick<T>(rng: () => number, items: T[]): T {
  return items[Math.floor(rng() * items.length) % items.length] as T
}

/** Kalıptan gerçek metin üretir. */
function fill(template: string, analysis: ContextAnalysis, words: string[]): string {
  const raw = analysis.subject !== '' ? analysis.subject : (words[0] ?? 'konu')
  const isMeta = (w: string): boolean => /^(konu|soru|mesaj|yorum|g[öo]nderi)/u.test(trLower(w))
  const subject = isMeta(raw)
    ? analysis.focus !== '' && !isMeta(analysis.focus)
      ? analysis.focus
      : 'bu'
    : raw
  const topic = analysis.topic === 'gündelik' ? 'bu' : analysis.topicLabel.toLocaleLowerCase('tr')
  return template.replace(/\{konu\}/gu, topic).replace(/\{özne\}/gu, subject)
}

/** Son çare üretimi. */
export interface LegacyInput {
  analysis: ContextAnalysis
  persona: NpcPersona
  words: string[]
  stance: Stance
  rng: () => number
}

/**
 * ŞABLON YEDEĞİ — yeni üretim zinciri hiçbir aday üretemediğinde çağrılır.
 *
 * @returns Gövde metni (yeni üretimden anlamlı derecede farklı olabilir).
 */
export function legacyComment(input: LegacyInput): string {
  const { analysis, persona, words, stance, rng } = input
  const fillOne = (list: string[]): string => fill(pick(rng, list), analysis, words)

  // Konusuz ama gerçek bir soru: gönderinin kendi kelimesine atıf yap.
  if (analysis.concepts.length === 0 && (analysis.isQuestion || analysis.isHelpRequest) && !analysis.isTrivial) {
    let body = fill(pick(rng, CLARIFY), analysis, words)
    body = ensureStop(body)
    if (persona.empathy > 0.5) body += ` ${pick(rng, EMPATHIC_NOPIC)}`
    if (persona.curiosity > 0.6 && rng() < persona.curiosity * 0.5) {
      body += ` ${ensureStop(fill(pick(rng, CURIOUS), analysis, words))}`
    }
    return finishSafe(body)
  }

  const openers = analysis.isHelpRequest ? HELP_OPENERS : (OPENERS[analysis.intent] ?? OPENERS['opinion'] ?? [])
  let body = fillOne(openers)
  body += `. ${fillOne(BODIES[stance])}`

  let concrete = false
  if (analysis.sentiment === 'negative' && persona.empathy > 0.5) {
    body += `. ${fillOne(EMPATHIC)}`
  } else if (analysis.isHelpRequest && persona.curiosity > 0.4) {
    body += `. ${fillOne(ADVICE[analysis.topic] ?? ADVICE['genel'] ?? [])}`
    concrete = true
  } else if (analysis.isNews && persona.seriousness > 0.4) {
    body += `. ${fillOne(NEWS)}`
    concrete = true
  } else if (analysis.isExperience && persona.empathy > 0.4) {
    body += `. ${fillOne(EXPERIENCE)}`
    concrete = true
  }
  if (!concrete && persona.verbosity > 0.6 && rng() < persona.verbosity) {
    body += `. ${pick(rng, ELABORATIONS)}`
  }
  if (persona.skepticism > 0.5 && analysis.isArgument && rng() < persona.skepticism) {
    body += ` ${ensureStop(pick(rng, SKEPTICAL))}`
  }
  if (persona.curiosity > 0.6 && analysis.isQuestion && rng() < persona.curiosity * 0.6) {
    body += ` ${ensureStop(fill(pick(rng, CURIOUS), analysis, words))}`
  }
  return finishSafe(body)
}
