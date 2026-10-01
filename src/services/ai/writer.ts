/**
 * Karakterin yazım katmanı — kişilik + içerik + araştırma → metin.
 *
 * Bu katman "ne yazılacak" kararını verir; nasıl üretileceği `llm.ts` ve
 * `research.ts` içindedir. Üç katman:
 *
 *   1. Karakterin kimliği (persona): arketip, ses, ölçekler, ilgi alanları,
 *      kendine özgü söz kalıbı. Her karakterin kendi "araştırma tarzı" vardır
 *      (hızlı okuyan, derine inen, şüpheci, esprili) — bu ölçeklerden
 *      türetilir, yani veri değişirse tarz da değişir.
 *   2. Bağlam: cevaplanan içerik + (varsa) web araştırması.
 *   3. Kalite kapısı: üretilen metin gerçekten kullanılabilir mi? Değilse
 *      şablona düşülür. Böylece model "boş" dönse bile saçma içerik
 *      yayınlanmaz — kullanıcının şikayet ettiği tam olarak budur.
 */
import type { Ctx } from '../../context'
import type { AiAgentWithUser } from '../../types'
import type { ContentAnalysis } from './analyze'
import { analyzeContent } from './analyze'
import { chatCompletion, llmAvailable } from './llm'
import { formatNotes, researchTopic, type ResearchNote } from './research'
import { archetypeLabel, PERSONAS } from './personas'
import { parseList } from './agents'

/** Araştırma/yazım tarzı — her karakterinki farklıdır. */
export type ResearchStyle = 'quick' | 'deep' | 'skeptic' | 'curious' | 'playful'

const STYLE_TEXT: Record<ResearchStyle, string> = {
  quick: 'Konuyu kısa bir taramadan sonra kendi fikrini söyler; uzatmaz.',
  deep: 'Konuyu birkaç kaynaktan okumuş gibi konuşur, somut ayrıntı verir, kendi deneyimini ekler.',
  skeptic: 'Karşı görüşleri de düşünür; neyin doğru, neyin iddia olduğunu ayırır.',
  curious: 'Meraklıdır; cevabın sonunda aklına takılan somut bir soru sorar.',
  playful: 'Esprili ve rahat bir dille yazar; ciddiyetden fazla espriye kaçar.',
}

const STYLE_BY_ARCHETYPE: Record<string, ResearchStyle> = {
  supheci: 'skeptic',
  dogaci: 'skeptic',
  sofistike: 'skeptic',
  bilgili: 'deep',
  hoceli: 'deep',
  detayli: 'deep',
  terapist: 'deep',
  doktor: 'deep',
  tarihci: 'deep',
  teknik: 'deep',
  merakli: 'curious',
  uzun_yazan: 'deep',
  yalniz: 'curious',
  utangac: 'curious',
  komik: 'playful',
  esprici: 'playful',
  troll: 'playful',
  ironik: 'playful',
  gocu: 'quick',
  sinirli: 'quick',
  kufurbaz: 'quick',
  pragmatik: 'quick',
  umursamaz: 'quick',
  sessiz: 'quick',
}

/**
 * Karakterin araştırma tarzı: önce arketip, yoksa davranış ölçekleri.
 * Böylece "farklı kişilik → farklı araştırma/yazım tarzı" veriden gelir.
 */
export function researchStyle(agent: AiAgentWithUser): ResearchStyle {
  const byArchetype = STYLE_BY_ARCHETYPE[agent.archetype]
  if (byArchetype) return byArchetype
  if (agent.humor >= 0.55) return 'playful'
  if (agent.assertiveness >= 0.7) return 'skeptic'
  if (agent.verbosity >= 0.7) return 'deep'
  if (agent.verbosity <= 0.15) return 'quick'
  return 'curious'
}

/** Karakterin yalnızca kendi verisinden kurulan sistem talimatı. */
export function personaPrompt(agent: AiAgentWithUser): string {
  const persona = PERSONAS.find((p) => p.username === agent.username)
  const style = STYLE_TEXT[researchStyle(agent)]
  const tic = persona?.tic
  const interests = parseList(agent.interests)
  const likes = parseList(agent.likes)
  const dislikes = parseList(agent.dislikes)
  const lengthGuide =
    agent.verbosity < 0.15
      ? 'Çok kısa yazarsın: tek cümle.'
      : agent.verbosity < 0.4
        ? 'Kısa yazarsın: bir-iki cümle.'
        : agent.verbosity < 0.7
          ? 'Orta uzunlukta yazarsın: iki-üç cümle.'
          : 'Açık yazarsın: üç-dört cümle, ama dağınık değil.'

  return [
    `Sen "${agent.username}" adlı bir Türkçe forum kullanıcısısın.`,
    `Karakter: ${archetypeLabel(agent.archetype)} — ${persona?.voice ?? 'normal bir kullanıcı'}.`,
    agent.bio ? `Profil: ${agent.bio}` : '',
    `Yazım özellikleri: ${lengthGuide} Mizah seviyesi ${pct(agent.humor)}, nezaket ${pct(agent.politeness)}, tartışmacılık ${pct(agent.assertiveness)}.`,
    `İlgi alanların: ${interests.join(', ') || 'genel'}. Sevdiğin konular: ${likes.join(', ') || '-'}. Sevmediğin: ${dislikes.join(', ') || '-'}.`,
    `Tarzın: ${style}`,
    tic ? `Söz kalıbın: "${tic}". Her mesajda tekrarlama; yalnızca doğal bir yere denk gelirse kullan.` : '',
    'Kurallar: gerçek bir insan gibi yaz. Hazır kalıplar, "bu konu hakkında bilgim var" gibi içeriksiz cümleler, madde işaretleri, başlık veya biçimlendirme kullanma. Yazdığın şey yazdığın konuyla gerçekten ilgili olsun. Başkasının yazdığını tekrar etme.',
  ]
    .filter(Boolean)
    .join('\n')
}

function pct(value: number): string {
  return `%${Math.round(value * 100)}`
}

/**
 * Metni kelimelere ayırır.
 *
 * DİKKAT: `\W` kullanılamaz — bu karakter sınıfı ASCII dışındaki Türkçe
 * harfleri (ı, ğ, ş, ü, ö, ç) ayırıcı sayar ve "yazılım" kelimesi
 * "yaz" + "l" + "m" olarak parçalanır. Bu, ilgililik kontrolünün sessizce
 * her zaman başarısız olmasına yol açıyordu.
 */
function wordsOf(text: string): string[] {
  return text.toLocaleLowerCase('tr').split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

/** Kalite kapısı: üretilen yanıt gerçekten kullanılabilir mi? */
export function isUsableReply(text: string, analysis: ContentAnalysis, notes: ResearchNote[]): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 15 || trimmed.length > 700) return false
  if (/```|^#{1,6}\s|\bBAŞLIK\b|\bGÖVDE\b/u.test(trimmed)) return false
  if (/^\s*[-*•]\s/mu.test(trimmed)) return false // madde listesi
  if (/https?:\/\//u.test(trimmed)) return false
  // Cevap, kaynak metnin kopyası olamaz.
  if (analysis.subject !== '' && trimmed.toLowerCase() === analysis.subject.toLowerCase()) return false

  const sentences = trimmed.split(/(?<=[.!?…])\s+/u).filter((s) => s.trim() !== '')
  if (sentences.length > 4) return false

  // İlgililik: yanıt ya kaynakla bir kelime paylaşmalı ya da araştırmayı
  // kullanmış görünmeli. Tamamen alakasız bir cümle reddedilir.
  const source = new Set(analysis.keywords)
  const noteWords = new Set(
    notes.flatMap((n) => wordsOf(`${n.title} ${n.snippet}`)).filter((w) => w.length > 4),
  )
  return wordsOf(trimmed).some((w) => source.has(w) || noteWords.has(w))
}

/** Kalite kapısı: gönderi başlığı ve gövdesi yayınlanabilir mi? */
export function isUsablePost(
  title: string,
  body: string,
  topic: string,
  notes: ResearchNote[],
): boolean {
  const t = title.trim()
  const b = body.trim()
  if (t.length < 10 || t.length > 120) return false
  if (b.length < 60 || b.length > 2000) return false
  if (/```|^#{1,6}\s|\bBAŞLIK\b|\bGÖVDE\b/u.test(`${t} ${b}`)) return false
  const sentences = b.split(/(?<=[.!?…])\s+/u).filter((s) => s.trim() !== '')
  if (sentences.length < 2 || sentences.length > 8) return false

  const haystack = `${t} ${b}`.toLocaleLowerCase('tr')
  if (topic && topic.length > 2 && haystack.includes(topic.toLocaleLowerCase('tr'))) return true
  // Konu adı geçmiyorsa en azından araştırmadan bir kelime geçmeli.
  const noteWords = new Set(
    notes.flatMap((n) => wordsOf(`${n.title} ${n.snippet}`)).filter((w) => w.length > 5),
  )
  return wordsOf(haystack).some((w) => noteWords.has(w))
}

export interface ReplyResult {
  body: string
  stance: 'agree' | 'disagree' | 'question' | 'neutral' | 'build'
  research: ResearchNote[]
}

/**
 * Modelin yazdığı metinden tutumu tahmin eder.
 *
 * İlişki/itibar hesabı tutuma göre işlediği için burada kaba bir sezgi
 * yeterli: "katılmıyorum" → karşı görüş, soru işareti → soru.
 */
export function inferStance(text: string): ReplyResult['stance'] {
  const lower = text.toLocaleLowerCase('tr')
  if (/(katılmıyorum|olmadı bu|yanlış|saçma|katılmaz)/u.test(lower)) return 'disagree'
  if (/(katılıyorum|katılırım|aynen|haklısın|doğru)/u.test(lower)) return 'agree'
  if (/\?\s*$/u.test(text)) return 'question'
  if (/(ekleyeyim|bir de şu|devamı)/u.test(lower)) return 'build'
  return 'neutral'
}

/**
 * Karakterin okuduğu içeriğe verdiği cevabı modele yazdırır.
 *
 * @returns Metin veya null (model yok / hata / kalite kapısı reddetti).
 */
export async function writeReply(
  ctx: Ctx,
  agent: AiAgentWithUser,
  content: string,
  peerRelation: number,
  analysis?: ContentAnalysis,
  seedResearch?: ResearchNote[],
): Promise<{ body: string; research: ResearchNote[] } | null> {
  if (!llmAvailable(ctx)) return null
  const resolved = analysis ?? analyzeContent(content)
  const research =
    seedResearch ??
    (resolved.isTrivial ? [] : await researchTopic(ctx, `${resolved.subject || resolved.topic} ${resolved.topic}`))

  const tone =
    peerRelation > 0.3
      ? 'Karşı tarafla aran iyi; sıcak konuş ama abartma.'
      : peerRelation < -0.3
        ? 'Karşı tarafla aran soğuk; sert olabilirsin ama kişiyi küçümseme.'
        : 'Tarafsız bir topluluk üyesi gibi konuş.'

  const user = [
    `Aşağıdaki içeriğe cevap yazıyorsun.`,
    '',
    '---',
    content.slice(0, 1200),
    '---',
    research.length > 0 ? `\nBu konu hakkında bulduğun bilgiler:\n${formatNotes(research)}\n` : '',
    `\n${tone}`,
    'Cevabını yalnızca yaz: başlık, açıklama veya tırnak içinde tekrar yok.',
  ]
    .filter((line) => line !== undefined)
    .join('\n')

  const text = await chatCompletion(ctx, {
    system: personaPrompt(agent),
    user,
    maxTokens: 300,
    temperature: 0.85,
  })
  if (!text) return null
  if (!isUsableReply(text, resolved, research)) return null
  return { body: text, research }
}

export interface PostResult {
  title: string
  body: string
  research: ResearchNote[]
}

/**
 * Karakterin açacağı gönderiyi modele yazdırır.
 *
 * Konu rastgele kelime değil, ilgi alanlarından ve board içeriğinden türetilir;
 * üretilen metin konuyu geçmiyorsa kalite kapısı reddeder.
 */
export async function writePost(
  ctx: Ctx,
  agent: AiAgentWithUser,
  params: { topic: string; boardName: string; seedResearch?: ResearchNote[] },
): Promise<PostResult | null> {
  if (!llmAvailable(ctx)) return null
  const research =
    params.seedResearch ?? (await researchTopic(ctx, `${params.topic} ${params.boardName}`))

  const user = [
    `c/${params.boardName} board'unda bir konu açacaksın.`,
    `Konu alanı: ${params.topic}.`,
    research.length > 0 ? `\nBu konu hakkında bulduğun bilgiler:\n${formatNotes(research)}\n` : '',
    'Önce internette araştırıp öğrendiklerini kullan; sonra kendi deneyimini kat.',
    'Şu biçimde yaz:',
    'BAŞLIK: <kısa ve dikkat çekici başlık>',
    'GÖVDE: <iki ile dört cümle>',
  ].join('\n')

  const text = await chatCompletion(ctx, {
    system: personaPrompt(agent),
    user,
    maxTokens: 500,
    temperature: 0.9,
  })
  if (!text) return null

  const titleMatch = /BAŞLIK\s*:\s*(.+)/iu.exec(text)
  const bodyMatch = /GÖVDE\s*:\s*([\s\S]+)/u.exec(text)
  if (!titleMatch || !bodyMatch) return null
  const title = (titleMatch[1] ?? '').trim().replace(/\s+/gu, ' ')
  const body = bodyMatch[1]!.trim()
  if (!isUsablePost(title, body, params.topic, research)) return null
  return { title, body, research }
}