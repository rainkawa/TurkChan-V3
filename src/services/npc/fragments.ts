/**
 * CÜMLE PARÇASI ÜRETİMİ.
 *
 * Hazır TAM cümle seçilmez. Her parça, birbirinden bağımsız birkaç
 * seçimden (çerçeve + bağlaç + kaynak kelimesi + ek) kurulur; sonuç
 * önceden yazılmış bir cümle DEĞİLDİR.
 *
 * Örnek — "telefon ısınıyor" düşüncesi için deneyim rolü:
 *   çerçeve:  "bende de" | "kendi başıma da"
 *   zaman:    "son güncellemeden sonra" (KAYNAKTAN)
 *   özne:     "telefonum" / "telefonumda"  (iyelik + hâl eki)
 *   →  "Son güncellemeden sonra bende de telefonumda aynısı oldu."
 *
 * Tüm kaynak bağlantıları `thought` alanlarından gelir; kaynakta olmayan
 * bir sözcük cümleye giremez.
 */
import { accusative, baseOf, capitalize, dative, ensureStop, plural, possessive, similarity } from './grammar'
import type { NpcPersona } from './personas'
import type { PartRole } from './plan'
import type { Opinion, ThreadState } from './state'
import type { Thought } from './thought'
import { trLower } from './lexicon'

/** Parça üretimi için gereken bağlam. */
export interface FragmentInput {
  thought: Thought
  persona: NpcPersona
  opinion: Opinion
  thread: ThreadState
  rng: () => number
}

/** Deterministik seçim; liste boşsa null. */
function pick<T>(rng: () => number, items: readonly T[]): T | null {
  if (items.length === 0) return null
  return items[Math.floor(rng() * items.length) % items.length] as T
}

/** "konu/soru" gibi meta sözcükler özne olamaz. */
function usableSubject(word: string): boolean {
  if (word === '') return false
  const lower = trLower(word)
  if (/^(konu|soru|mesaj|yorum|g[öo]nderi|şey|oran)/u.test(lower)) return false
  // Fiil çekimli kelimeler ("paylaşır", "güncellemeden") özne olamaz.
  if (/(iyor|uyor|yor|mış|miş|müş|du|dü|dı|di|den|dan|den|yor)$/u.test(lower)) return false
  return true
}

/** Güvenli seçim: null dönerse çağıran taraf devam eder. */
function pickOr<T>(rng: () => number, items: readonly T[], fallback: T): T {
  return pick(rng, items) ?? fallback
}

/**
 * SON KULLANILAN ÇERÇEVELER (küresel çeşitlilikBelleği).
 *
 * 50 karakter aynı havuzdan çektiği için aynı çerçeve (ör. "bende de aynısı
 * oldu") tekrar tekrar düşebiliyordu. Burada TÜM NPC'ler tarafından son
 * seçilen çerçeveler tutulur ve aynı çerçeve tekrar seçilmezken tercih
 * edilir. Bu, "50 kişi aynı kalıbı dolduruyor" görüntüsünü kırar.
 */
const RECENT_FRAMES: string[] = []
const FRAME_MEMORY = 48

/** Çerçeve seçimi: yakın zamanda kullanılmayan bir havuz üyesini tercih eder. */
function pickFrame(rng: () => number, frames: readonly string[], fallback: string): string {
  const fresh = frames.filter((f) => !RECENT_FRAMES.includes(f))
  const pool = fresh.length > 0 ? fresh : frames
  const chosen = pickOr(rng, pool, pool.length > 0 ? (pool[0] as string) : fallback)
  RECENT_FRAMES.push(chosen)
  if (RECENT_FRAMES.length > FRAME_MEMORY) RECENT_FRAMES.shift()
  return chosen
}

/** Özne ifadesi: kişiye göre iyelik + hâl. */
function subjectRef(input: FragmentInput, caseKind: 'plain' | 'acc' | 'dat' = 'plain'): string {
  const subject = usableSubject(input.thought.subject) ? input.thought.subject : ''
  if (subject === '') return ''
  const base = input.rng() < 0.45 ? possessive(subject, 'ben') : subject
  switch (caseKind) {
    case 'acc':
      return accusative(base)
    case 'dat':
      return dative(base)
    default:
      return base
  }
}

/**
 * Öznenin KÖK biçimi — hâl eki (locative/ablative) eklenmeden önce iyelik
 * sıyırılır: "sunucumda" yerine "sunucuda".
 */
function subjectRootOf(input: FragmentInput): string {
  const subject = usableSubject(input.thought.subject) ? input.thought.subject : ''
  return subject === '' ? '' : baseOf(subject)
}

/** Kaynaktaki olay ifadesi ("son güncellemeden sonra"); yoksa genel zaman. */
function timeRef(input: FragmentInput): string {
  const event = input.thought.event
  if (event !== '' && input.rng() < 0.75) return event
  return pickFrame(
    input.rng,
    ['bu arada', 'son bir süredir', 'kısa süre önce', 'bundan birkaç gün önce', 'geçen hafta'],
    'bu arada',
  )
}

/** Belirti yüklemi: "ısınma sorunu var" / "ısınma başladı". */
function symptomPredicate(input: FragmentInput): string {
  const symptom = input.thought.symptom
  if (symptom === '') return ''
  return pickFrame(
    input.rng,
    [
      `${symptom} sorunu var`,
      `${symptom} yüzünden zorlanıyorum`,
      `${symptom} gibi bir durum oluşmuş`,
      `${symptom} başladı`,
      `${symptom} rahatsızlığı çıkmış`,
      `${symptom} bana de geliyor`,
      `${symptom} tam olarak bu yüzden`,
    ],
    `${symptom} sorunu var`,
  )
}

/** Neden yüklemi — düşüncedeki OLASI nedenlerden. */
function causeClause(input: FragmentInput): string | null {
  const cause = pick(input.rng, input.thought.causes)
  if (cause === null) return null
  return pickFrame(
    input.rng,
    [
      `${cause} ihtimali var`,
      `${dative(cause)} bakmak gerekiyor`,
      `${dative(cause)} önce kontrol edilmeli`,
      `${cause} yüzünden olmuş olabilir`,
      `en çok ${cause} buna geliyor`,
      `${cause} tarafını eleyebilirdim`,
      `ben önce ${dative(cause)} bakardım`,
    ],
    `${cause} ihtimali var`,
  )
}

/** "Ben şunu düşünüyorum" çerçeveleri — sürekli aynı yapı kullanılmaz. */
function stanceClause(input: FragmentInput, tone: 'agree' | 'disagree' | 'question' | 'build'): string {
  const agreeFrames = ['bende aynı fikirdeyim', 'ben de aynı sonucu çıkardım', 'bu tarafta ben de varım', 'kendim de yaşadığım için katılıyorum']
  const disagreeFrames = ['bende tam tersi bir izlenim oluştu', 'bu noktada ben farklı düşünüyorum', 'katılmadığım yer burası', 'ben olsam daha temiz çözerdim']
  const questionFrames = ['burada kafamda bir soru kaldı', 'bir şeyi merak ettim', 'aklıma takıldı bir nokta']
  const buildFrames = ['buraya bir şey daha eklemek isterim', 'ben olsam şu yönden ilerlerdim', 'bana göre eksik kalan taraf şu']
  const frames =
    tone === 'agree' ? agreeFrames : tone === 'disagree' ? disagreeFrames : tone === 'question' ? questionFrames : buildFrames
  return pickFrame(input.rng, frames, frames[0] as string)
}

/** Tepki: kaynağın duygusuna ve konusuna göre. */
function reactionClause(input: FragmentInput): string {
  const subject = usableSubject(input.thought.subject) ? input.thought.subject : ''
  const claim = input.thought.claim
  const frames =
    claim === 'olumsuz değerlendirme'
      ? ['durum ciddi görünüyor', 'bu pek iyiye gitmiyor', 'söylediğin şey can sıkıcıymış']
      : claim === 'olumlu değerlendirme'
        ? ['sonuç güzel görünüyor', 'bu iyi bir haber', 'beğenmişsin demek']
        : ['farklı bir bakış açısı', 'üzerinde durulacak bir şey', 'biraz daha açar mısın']
  if (subject !== '') {
    return pickFrame(
      input.rng,
      [
        `${subject} tarafında ${pickFrame(input.rng, frames, 'durum')}`,
        `${subject} ciddiye alınmalı`,
        `${subject} başlığı tek başına çok şey anlatmıyor`,
        `${subject} konusunda aynı şeyi hissediyorum`,
        `${dative(subjectRootOf(input))} bakınca tablo netleşiyor`,
      ],
      `${subject} ciddiye alınmalı`,
    )
  }
  return pickFrame(input.rng, frames, 'durum')
}

/** Deneyim: kendi yaşadığı, kaynakla uyumlu. */
function experienceClause(input: FragmentInput): string {
  const subject = usableSubject(input.thought.subject) ? input.thought.subject : ''
  const time = timeRef(input)
  // Çoğul özneye iyelik eklenmez: "fiyatlarım başımdan geçti" yerine
  // "fiyatlarda aynı sonucu aldım".
  const pluralSubject = /(?:lar|ler)$/u.test(subject)
  const mine = subject === '' ? '' : pluralSubject ? subject : possessive(baseOf(subject), 'ben')
  const frames =
    subject === ''
      ? ['bende de aynısı olmuştu', 'benim de başıma geldi']
      : [
          `${mine}da aynı sonucu aldım`,
          `${mine} başımdan geçti`,
          `${mine} konusunda aynı sonucu aldım`,
          `${mine} için aynı sıkıntıyı yaşadım`,
        ]
  // Zaman ifadesi zaten `timeRef` tarafından verildi; girişte ikinci bir
  // zaman kullanılmaz ("bundan birkaç gün önce geçen ay ben de ...").
  const lead = pickFrame(input.rng, ['bende de', 'kendi başıma da', 'bende bir kez'], 'bende de')
  const body = pickFrame(input.rng, frames, frames[0] as string)
  const symptom = symptomPredicate(input)
  const cause = causeClause(input)
  const tail = input.rng() < 0.5 ? (cause !== null ? cause : symptom) : ''
  if (tail === '') return `${time} ${lead} ${body}`
  return `${time} ${lead} ${body}, ${tail}`
}

/** Karşı görüş gerekçesi. */
function counterClause(input: FragmentInput): string {
  const symptom = input.thought.symptom
  const cause = input.thought.causes[0] ?? ''
  const frames: string[] = []
  if (cause !== '') {
    frames.push(
      `bende ağırlıklı ${cause} gibi görünüyordu`,
      `benim tecrübemde ${cause} daha çok etkiliydi`,
      `ben ${cause} tarafını daha önemli görüyorum`,
      `bana göre ${cause} ihtimali daha güçlü`,
    )
  }
  if (symptom !== '') {
    frames.push(`${symptom} tek başına yeterli bir açıklama değil`, `bana göre ${symptom} başka bir şeyin sonucu`)
  }
  frames.push('biraz daha fazla bilgi gerekiyor', 'zamanlama önemli olabilir', 'bence burada tek neden aranmaz')
  return pickFrame(input.rng, frames, 'biraz daha fazla bilgi gerekiyor')
}

/** Kaynakla ilgili soru (cevapsız kalan yönü hedefler). */
function questionClause(input: FragmentInput): string {
  const subject = usableSubject(input.thought.subject) ? input.thought.subject : ''
  const event = input.thought.event
  const frames: string[] = []
  if (subject !== '') {
    const yours = possessive(baseOf(subject), 'sen')
    frames.push(
      `${yours} için ne yaptın?`,
      'hangi adımı denedin?',
      `${accusative(yours)} ne zaman fark ettin?`,
    )
  }
  if (event !== '') frames.push('bu durum o zamandan mı başladı?', 'öncesiyle sonrası arasında fark var mı?')
  if (input.thought.symptom !== '') {
    frames.push('sorun ne zaman başladı?', 'başka bir belirti de var mı?')
  }
  frames.push('detayı biraz daha açar mısın?', 'somut bir örnek verebilir misin?', 'sonrasında ne yaptın?')
  return pickFrame(input.rng, frames, 'detayı biraz daha açar mısın?')
}

/** Ayrıntı/ek bilgi cümlesi. */
function detailClause(input: FragmentInput, fact: string | null): string | null {
  if (fact !== null && input.rng() < 0.6) return fact
  const cause = pick(input.rng, input.thought.causes)
  if (cause === null) {
    const subject = usableSubject(input.thought.subject) ? input.thought.subject : ''
    if (subject === '') return 'biraz daha fazla detay lazım'
    return pickFrame(
      input.rng,
      [
        `${dative(subjectRootOf(input))} bakmak gerekiyor`,
        `${accusative(subjectRootOf(input))} biraz daha açmalı`,
        `${dative(subjectRootOf(input))} bir süre daha izlemek gerekiyor`,
        `${accusative(subjectRootOf(input))} kısa bir özet geçiyor musun?`,
      ],
      `${dative(subjectRootOf(input))} bakmak gerekiyor`,
    )
  }
  return pickFrame(
    input.rng,
    [
      `${dative(cause)} bakmak gerekiyor`,
      `${plural(cause)} arasında hangisi baskın?`,
      `birden fazla neden olabilir, ${dative(cause)} ölçülmeli`,
      `${dative(cause)} eleyince geriye bir şey kalıyor mu?`,
      `${cause} tarafında ne ölçtün?`,
    ],
    `${dative(cause)} bakmak gerekiyor`,
  )
}

/**
 * SORUYA SOMUT CEVAP.
 *
 * knowledge.ts'te karşılığı olan bir soruda cümle kalıbı kurulmaz: elimizdeki
 * doğrulanabilir bilgi doğrudan yazılır. Bilginin ikinci bir anlatımı ya da
 * tamamlayıcı cümlesi varsa karakter sezgisiyle birleştirilir.
 */
function answerClause(input: FragmentInput, fact: string | null): string | null {
  const facts = input.thought.facts
  if (fact === null && facts.length === 0) return null
  const chosen = fact ?? (pick(input.rng, facts) as string)
  // Kısa yazan karakter iki cümlelik cevap yazmaz: tek kayıt yeter.
  if (input.persona.verbosity < 0.45) return chosen
  // İki kaydı birleştirmek ancak birbirinin anlatımı DEĞİLSE mantıklı;
  // aksi halde "telefon yavaşladıysa ..." iki kez yazılır.
  const others = facts.filter((f) => f !== chosen && similarity(f, chosen) < 0.35)
  if (others.length > 0 && input.rng() < 0.5) return `${chosen} ${pickOr(input.rng, others, chosen)}`
  return chosen
}

/** Sonuç cümlesi. */
function conclusionClause(input: FragmentInput): string {
  const subject = usableSubject(input.thought.subject) ? input.thought.subject : ''
  const value = input.opinion.value
  const frames =
    value > 0.3
      ? ['sonuçta iyiye gidiyor', 'benim tahminim olumlu yönde']
      : value < -0.3
        ? ['sonuçta kötüye gidiyor', 'benim tahminim olumsuz yönde']
        : ['net bir yargıya varamadım', 'sonuç şimdilik belirsiz']
  const frame = pickFrame(input.rng, frames, frames[0] as string)
  // "Fiyatlar tarafında net bir yargıya varamadım" gibi türetimler yanlış
  // okunduğu için özneye bağlı sonuç cümleleri kaldırıldı.
  if (subject === '') return frame
  return pickFrame(
    input.rng,
    [
      `${frame}, durum biraz daha uzun sürebilir`,
      `${frame}, tek denemede bitmiyor`,
      `${frame}, izlemeye devam ediyorum`,
      `${frame}, zaman gösterecek`,
    ],
    `${frame}, durum biraz daha uzun sürebilir`,
  )
}

/** Tartışmayı sürdüren giriş (konuşma devamlılığı). */
function continueClause(input: FragmentInput): string {
  const last = input.thread.last_statement
  if (last !== '' && input.rng() < 0.5) {
    const short = last.split(/[.!?…]/u)[0]?.trim() ?? ''
    if (short.length > 12) return `az önce "${short}" demiştim`
  }
  if (input.thread.open_question !== '' && input.rng() < 0.6) {
    return `sorduğum soruya dönmek istiyorum: ${input.thread.open_question}`
  }
  return pickFrame(input.rng, ['buraya geri döneceğim', 'aynı yerden devam edeyim', 'bu noktada biraz daha durayım'], 'buraya geri döneceğim')
}

/** Bir rol için cümle parçası üretir. */
export function buildFragment(
  role: PartRole,
  input: FragmentInput,
  fact: string | null,
): string | null {
  const { thought, opinion } = input
  switch (role) {
    case 'reaction':
      return ensureStop(reactionClause(input))
    case 'stance': {
      const tone =
        thought.kind === 'claim' || thought.kind === 'complaint' ? 'disagree' : opinion.value > 0.3 ? 'agree' : 'build'
      return ensureStop(stanceClause(input, tone))
    }
    case 'reason': {
      const symptom = symptomPredicate(input)
      const cause = causeClause(input)
      const noun = thought.symptom
      if (noun !== '' && cause !== null && input.rng() < 0.6) {
        return ensureStop(`${capitalize(noun)} var, ${cause}`)
      }
      if (cause !== null) return ensureStop(cause)
      if (symptom !== '') return ensureStop(symptom)
      return null
    }
    case 'example':
      return ensureStop(experienceClause(input))
    case 'counter':
      return ensureStop(counterClause(input))
    case 'detail': {
      const detail = detailClause(input, fact)
      return detail === null ? null : ensureStop(detail)
    }
    case 'answer': {
      const answer = answerClause(input, fact)
      return answer === null ? null : ensureStop(answer)
    }
    case 'conclusion':
      return ensureStop(conclusionClause(input))
    case 'question':
      return ensureStop(questionClause(input)).replace(/\.$/u, '?')
    default:
      return null
  }
}

/** 'continue' hamlesi için tartışma devam parçası. */
export function buildDiscussion(input: FragmentInput): string {
  return ensureStop(continueClause(input))
}
