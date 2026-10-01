/**
 * NPC ilişki sistemi — beş eksenli, zamanla gelişen sosyal model.
 *
 * Tek bir "affinity" skoru yerine beş ayrı eksen tutulur:
 *   friendship  — samimiyet (arkadaşlık)
 *   respect     — saygı (fikir/bilgi değeri)
 *   trust       — güven (tahmin edilebilirlik)
 *   dislike     — hoşnutsuzluk
 *   rivalry     — rekabet
 *
 * Neden beş eksen? Çünkü "birbirini beğeniyor" ile "birbirine güveniyor"
 * farklı şeydir. Karşılıklı destekleme `respect`/`trust` yüksekken devam
 * eder; sürekli tartışma `rivalry` ve `dislike` artırır.
 *
 * Değişimler KÜÇÜK ADIMLIDIR (0.01–0.06). Tek bir etkileşim bir ilişkiyi
 * kurmaz; ilişki birikimle oluşur. Bu, davranışın "birkaç turda tamamen
 * değişmesini" engeller.
 */
import type { Ctx } from '../../context'
import type { NpcRelationshipRow } from '../../types'

/** Bir eksen için geçerli aralık. */
const CLAMP = (v: number): number => Math.min(1, Math.max(-1, v))

/** Boş bir ilişki satırı. */
const EMPTY: Omit<NpcRelationshipRow, 'agent_id' | 'peer_id'> = {
  friendship: 0,
  respect: 0,
  trust: 0,
  dislike: 0,
  rivalry: 0,
  affinity: 0,
  interactions: 0,
  last_interaction_at: null,
}

/**
 * İlişkiyi okur; yoksa boş (sıfır) ilişki döner.
 * Böylece çağıran taraf `?? 0` kalabalığından kurtulur.
 */
export function relationshipOf(ctx: Ctx, agentId: string, peerId: string): NpcRelationshipRow {
  if (agentId === peerId) {
    return { agent_id: agentId, peer_id: peerId, ...EMPTY }
  }
  const row = ctx.db
    .prepare('SELECT * FROM npc_relationships WHERE agent_id = ? AND peer_id = ?')
    .get(agentId, peerId) as NpcRelationshipRow | undefined
  return row ?? { agent_id: agentId, peer_id: peerId, ...EMPTY }
}

/**
 * Bir ekseni küçük bir miktarda değiştirir ve türetilmiş `affinity`'yi
 * günceller. Satır yoksa oluşturur.
 */
function bumpAxis(
  ctx: Ctx,
  agentId: string,
  peerId: string,
  axis: 'friendship' | 'respect' | 'trust' | 'dislike' | 'rivalry',
  delta: number,
  now: number,
): void {
  if (agentId === peerId) return
  const current = relationshipOf(ctx, agentId, peerId)
  const next = {
    ...current,
    [axis]: CLAMP(current[axis] + delta),
  }
  // affinity türetilmiş toplamdır: samimiyet + saygı + güven − hoşnutsuzluk,
  // rakibe göre hafifçe farklılaştırılır. Hızlı okuma için saklanır.
  next.affinity = CLAMP(
    (next.friendship + next.respect * 0.7 + next.trust * 0.6 - next.dislike * 0.9) /
      (1 + next.rivalry * 0.4),
  )
  next.interactions = current.interactions + 1
  next.last_interaction_at = now

  ctx.db
    .prepare(
      `INSERT INTO npc_relationships
         (agent_id, peer_id, friendship, respect, trust, dislike, rivalry, affinity, interactions, last_interaction_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, peer_id) DO UPDATE SET
         friendship = excluded.friendship, respect = excluded.respect,
         trust = excluded.trust, dislike = excluded.dislike,
         rivalry = excluded.rivalry, affinity = excluded.affinity,
         interactions = excluded.interactions, last_interaction_at = excluded.last_interaction_at`,
    )
    .run(
      agentId,
      peerId,
      next.friendship,
      next.respect,
      next.trust,
      next.dislike,
      next.rivalry,
      next.affinity,
      next.interactions,
      now,
    )
}

/**
 * Etkileşim sonrası ilişki güncellemesi.
 *
 * @param tone Karşı tarafın tonu: 'agree' | 'disagree' | 'question' | 'neutral' | 'build'
 * @param quality Yazı kalitesi (0..1) — yüksek kalite saygı kazandırır.
 */
export function noteInteraction(
  ctx: Ctx,
  agentId: string,
  peerId: string,
  tone: 'agree' | 'disagree' | 'question' | 'neutral' | 'build',
  quality: number,
  now: number,
): void {
  if (agentId === peerId) return
  const q = Math.min(1, Math.max(0, quality))
  // Karşılıklı destekleme: samimiyet ve saygı artar.
  if (tone === 'agree') {
    bumpAxis(ctx, agentId, peerId, 'friendship', 0.03, now)
    bumpAxis(ctx, agentId, peerId, 'respect', 0.04, now)
    bumpAxis(ctx, agentId, peerId, 'trust', 0.02, now)
    return
  }
  // Karşı görüş: saygı düşmez, rekabet doğar. Hemen düşmanlaşma yoktur.
  if (tone === 'disagree') {
    bumpAxis(ctx, agentId, peerId, 'respect', 0.01, now)
    bumpAxis(ctx, agentId, peerId, 'rivalry', 0.03, now)
    bumpAxis(ctx, agentId, peerId, 'dislike', 0.02 * (1 - q), now)
    return
  }
  // Soru: merak uyandırır, saygıyı artırabilir.
  if (tone === 'question') {
    bumpAxis(ctx, agentId, peerId, 'respect', 0.02 * q, now)
    bumpAxis(ctx, agentId, peerId, 'friendship', 0.01, now)
    return
  }
  // Nötr: yalnızca etkileşim sayacı artar.
  bumpAxis(ctx, agentId, peerId, 'friendship', 0.01, now)
}

/** Yüksek kaliteli, alakalı bir yorum yazıldığında saygı kazandırır. */
export function noteQualityReply(ctx: Ctx, agentId: string, peerId: string, quality: number, now: number): void {
  if (agentId === peerId) return
  bumpAxis(ctx, agentId, peerId, 'respect', 0.05 * quality, now)
  bumpAxis(ctx, agentId, peerId, 'trust', 0.02 * quality, now)
}

/**
 * Bir NPC'nin en yakın ilişkileri (yönetim paneli ve karar girdisi).
 * `friendship`/`affinity` yüksek olanlar üstte.
 */
export function relationshipsOf(
  ctx: Ctx,
  agentId: string,
  limit = 10,
): Array<NpcRelationshipRow & { username: string }> {
  return ctx.db
    .prepare(
      `SELECT r.*, u.username
         FROM npc_relationships r JOIN users u ON u.id = r.peer_id
        WHERE r.agent_id = ?
        ORDER BY r.affinity DESC, r.interactions DESC
        LIMIT ?`,
    )
    .all(agentId, limit) as unknown as Array<NpcRelationshipRow & { username: string }>
}

/** Toplam etkileşim sayısı (yönetim paneli). */
export function relationshipCount(ctx: Ctx, agentId: string): number {
  const row = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM npc_relationships WHERE agent_id = ?')
    .get(agentId) as { n: number }
  return row.n
}

/** İlişkileri temizler (davranış sıfırlama). */
export function clearRelationships(ctx: Ctx, agentId: string): void {
  ctx.db.prepare('DELETE FROM npc_relationships WHERE agent_id = ? OR peer_id = ?').run(agentId, agentId)
}
