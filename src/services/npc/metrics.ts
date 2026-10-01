/**
 * ÖZGÜN ÜRETİM METRİKLERİ.
 *
 * "50 karakter aynı şablonu dolduruyor" şüphesini ÖLÇÜLEBİLİR hâle getiren
 * katman. Yedi metrik:
 *
 *   template_dependency — kaç üretim şablon havuzuna düştü (düşük iyi)
 *   phrase_reuse        — daha önce kullanılan ifadelerin tekrar oranı
 *   context_alignment   — yorumların kaynak içerikle örtüşmesi
 *   semantic_diversity  — son yorumların çift çift benzerliğinin tersi
 *   style_diversity     — yazım izi çeşitliliği (uzunluk/emoji/soru oranı)
 *   thread_continuity   — aynı başlıkta devam eden konuşma oranı
 *   useful_response_rate— ödül alan üretim oranı
 */
import type { Ctx } from '../../context'
import { newId } from '../../lib/ids'
import { averageSentenceLength, similarity } from './grammar'

/** Metrik kümesi (0..1). */
export interface NpcMetrics {
  template_dependency: number
  phrase_reuse: number
  context_alignment: number
  semantic_diversity: number
  style_diversity: number
  thread_continuity: number
  useful_response_rate: number
  /** Ölçüm için kullanılan yorum sayısı. */
  samples: number
}

/** Boş metrikler. */
export const EMPTY_METRICS: NpcMetrics = {
  template_dependency: 0,
  phrase_reuse: 0,
  context_alignment: 0,
  semantic_diversity: 0,
  style_diversity: 0,
  thread_continuity: 0,
  useful_response_rate: 0,
  samples: 0,
}

/** Bir karakterin son yorumları. */
function recentBodies(ctx: Ctx, agentId: string, limit: number): Array<{ body: string; post_id: string }> {
  return ctx.db
    .prepare(
      `SELECT c.body, c.post_id FROM comments c
        WHERE c.author_id = ? AND c.deleted = 0
        ORDER BY c.created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as unknown as Array<{ body: string; post_id: string }>
}

/** Ortalama çift çift benzerlik (0..1). */
export function meanPairwiseSimilarity(bodies: string[]): number {
  if (bodies.length < 2) return 0
  let sum = 0
  let count = 0
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      sum += similarity(bodies[i] as string, bodies[j] as string)
      count += 1
    }
  }
  return count === 0 ? 0 : sum / count
}

/** Yazım izi çeşitliliği: ortalama sapma. */
export function styleDiversity(bodies: string[]): number {
  if (bodies.length < 2) return 0
  const lengths = bodies.map((b) => averageSentenceLength(b))
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length
  if (mean === 0) return 0
  const variance = lengths.reduce((acc, l) => acc + (l - mean) ** 2, 0) / lengths.length
  // 0 sapma → 0, ~mean sapma → 1
  return Math.min(1, Math.sqrt(variance) / Math.max(1, mean))
}

/** Bir karakterin üretim metrikleri. */
export function npcMetrics(ctx: Ctx, agentId: string, sample = 20): NpcMetrics {
  const outcomes = ctx.db
    .prepare(
      `SELECT style, quality, reward, settled_at FROM npc_outcomes
        WHERE agent_id = ? AND kind = 'comment' ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, sample) as unknown as Array<{
    style: string
    quality: number
    reward: number
    settled_at: number | null
  }>

  const bodies = recentBodies(ctx, agentId, sample)
  const total = Math.max(1, outcomes.length)

  const templateDependency =
    outcomes.filter((o) => o.style.startsWith('fallback')).length / total
  const phraseReuse =
    outcomes.filter((o) => phraseUseFlag(ctx, agentId, o.style)).length / total
  const contextAlignment = outcomes.reduce((sum, o) => sum + o.quality, 0) / total
  const diversity = 1 - meanPairwiseSimilarity(bodies.map((b) => b.body))
  const settled = outcomes.filter((o) => o.settled_at !== null)
  const useful =
    settled.length === 0 ? 0 : settled.filter((o) => o.reward > 0).length / settled.length
  const multiPost = new Set(bodies.map((b) => b.post_id)).size
  const continuity = bodies.length === 0 ? 0 : Math.min(1, (bodies.length - multiPost + 1) / bodies.length)

  return {
    template_dependency: round(templateDependency),
    phrase_reuse: round(phraseReuse),
    context_alignment: round(contextAlignment),
    semantic_diversity: round(diversity),
    style_diversity: round(styleDiversity(bodies.map((b) => b.body))),
    thread_continuity: round(continuity),
    useful_response_rate: round(useful),
    samples: outcomes.length,
  }
}

/** Şablon kullanımı işareti (style alanı). */
function phraseUseFlag(ctx: Ctx, agentId: string, style: string): boolean {
  const row = ctx.db
    .prepare('SELECT uses FROM npc_phrases WHERE agent_id = ? AND phrase = ?')
    .get(agentId, style) as { uses: number } | undefined
  return (row?.uses ?? 0) > 1
}

/** Tüm sitede toplu üretim metrikleri. */
export function siteMetrics(ctx: Ctx, limit = 50): NpcMetrics {
  const agents = ctx.db
    .prepare('SELECT user_id FROM ai_agents WHERE enabled = 1 ORDER BY activity DESC LIMIT ?')
    .all(limit) as unknown as Array<{ user_id: string }>
  if (agents.length === 0) return EMPTY_METRICS
  const all = agents.map((a) => npcMetrics(ctx, a.user_id, 12))
  const avg = (key: keyof NpcMetrics): number =>
    all.reduce((sum, m) => sum + (m[key] as number), 0) / all.length
  return {
    template_dependency: round(avg('template_dependency')),
    phrase_reuse: round(avg('phrase_reuse')),
    context_alignment: round(avg('context_alignment')),
    semantic_diversity: round(avg('semantic_diversity')),
    style_diversity: round(avg('style_diversity')),
    thread_continuity: round(avg('thread_continuity')),
    useful_response_rate: round(avg('useful_response_rate')),
    samples: all.reduce((sum, m) => sum + m.samples, 0),
  }
}

/** Yeni gönderide kullanılan benzerlik (eşik aşan çiftler). */
export function tooSimilarPairs(bodies: string[], limit = 0.8): Array<[number, number]> {
  const pairs: Array<[number, number]> = []
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      if (similarity(bodies[i] as string, bodies[j] as string) >= limit) pairs.push([i, j])
    }
  }
  return pairs
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Benzer cevapları bastırma yardımcısı: verilen adaylar arasından, daha önce
 * kullanılmış ifadelere en az benzeyeni seçer.
 */
export function leastUsed(
  ctx: Ctx,
  agentId: string,
  candidates: string[],
  normalize: (text: string) => string,
): string | null {
  if (candidates.length === 0) return null
  let best: { text: string; uses: number } | null = null
  for (const candidate of candidates) {
    const row = ctx.db
      .prepare('SELECT uses FROM npc_phrases WHERE agent_id = ? AND phrase = ?')
      .get(agentId, normalize(candidate)) as { uses: number } | undefined
    const uses = row?.uses ?? 0
    if (best === null || uses < best.uses) best = { text: candidate, uses }
  }
  void newId
  return best?.text ?? null
}
