/**
 * Davranış öğrenme ve adaptasyon.
 *
 * Ne öğreniyor? "Hangi tarz işe yarıyor." Her yorum/gönderi bir DENEY
 * (trial) olarak kaydedilir; sonradan ölçülen sonuç (etkileşim, oy, cevap
 * alıp almama) REWARD olarak işlenir ve davranış ağırlıkları kademeli
 * güncellenir.
 *
 *   topic'a özgü politika satırı varsa o güncellenir, yoksa genel politika.
 *
 * Örnek:
 *   "Bu konu tipinde kısa cevaplarım etkileşim almıyor" → length_w düşer.
 *   "Bu konuda komik cevaplarım çok etkileşim alıyor" → humor_w artar.
 *
 * SINIRLAR (kritik):
 *   - Adım küçüktür (0.02–0.05). Tek deneme karakteri değiştirmez.
 *   - Ağırlıklar 0.2–2.0 aralığına kıstlanır (asla patlamaz).
 *   - EMA ile yumuşatılır: reward ortalaması üzerinden ilerler, tek bir
 *     yüksek oy tek seferde davranışı çeviremez.
 */
import type { Ctx } from '../../context'
import type { NpcBehaviorRow } from '../../types'
import { newId } from '../../lib/ids'

/** Davranış ağırlıklarının aralığı. */
const MIN_W = 0.2
const MAX_W = 2.0
/** Bir adımda maksimum değişim. */
const MAX_STEP = 0.05

/** Ağırlığı aralığa kıstlar. */
function clampWeight(value: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, value))
}

/** Satırı okur; yoksa varsayılan politika döner. */
export function behaviorOf(ctx: Ctx, agentId: string, topic = ''): NpcBehaviorRow {
  const row = ctx.db
    .prepare('SELECT * FROM npc_behavior WHERE agent_id = ? AND topic = ?')
    .get(agentId, topic) as NpcBehaviorRow | undefined
  return (
    row ?? {
      agent_id: agentId,
      topic,
      humor_w: 1,
      length_w: 1,
      engage_w: 1,
      post_w: 1,
      trials: 0,
      reward: 0,
      updated_at: 0,
    }
  )
}

/**
 * Bir davranış denemesini kaydeder ve sonucu (reward) işler.
 *
 * @param kind 'comment' | 'post'
 * @param topic Etkileşimde geçen konu ailesi.
 * @param style Kullanılan üretim biçimi (hangi şablon ailesi seçildi).
 * @param quality Yayın anındaki kalite skoru (0..1).
 * @param reward Gözlenen sonuç (-1..1): cevap/etkileşim aldıysa pozitif.
 */
export function recordOutcome(
  ctx: Ctx,
  agentId: string,
  kind: 'comment' | 'post',
  targetId: string,
  topic: string,
  style: string,
  quality: number,
  reward: number,
  now: number,
): void {
  ctx.db
    .prepare(
      `INSERT INTO npc_outcomes (id, agent_id, kind, target_id, topic, quality, reward, style, created_at, settled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      newId(),
      agentId,
      kind,
      targetId,
      topic,
      Math.min(1, Math.max(0, quality)),
      Math.min(1, Math.max(-1, reward)),
      style,
      now,
    )
}

/**
 * Henüz ölçülmemiş (bekleyen) denemeler.
 *
 * `before` verilirse yalnızca o andan ÖNCE yazılmış denemeler döner —
 * yani yeni yazılan bir yorum aynı turda "başarılı" sayılmaz, sonraki
 * turlarda gerçek etkileşimi ölçülür.
 */
export function pendingOutcomes(
  ctx: Ctx,
  agentId: string,
  limit = 20,
  before?: number,
): Array<{
  id: string
  kind: string
  target_id: string
  topic: string
  quality: number
  style: string
}> {
  const rows = (
    before === undefined
      ? ctx.db
          .prepare(
            `SELECT id, kind, target_id, topic, quality, style
               FROM npc_outcomes WHERE agent_id = ? AND settled_at IS NULL
               ORDER BY created_at ASC LIMIT ?`,
          )
          .all(agentId, limit)
      : ctx.db
          .prepare(
            `SELECT id, kind, target_id, topic, quality, style
               FROM npc_outcomes WHERE agent_id = ? AND settled_at IS NULL AND created_at < ?
               ORDER BY created_at ASC LIMIT ?`,
          )
          .all(agentId, before, limit)
  ) as unknown as Array<{
    id: string
    kind: string
    target_id: string
    topic: string
    quality: number
    style: string
  }>
  return rows
}

/**
 * Bir denemenin sonucunu ölçer ve politikayı günceller.
 *
 * @param measuredReward Gözlenen etkileşim puanı (-1..1).
 */
export function settleOutcome(
  ctx: Ctx,
  agentId: string,
  outcomeId: string,
  measuredReward: number,
  now: number,
): void {
  const reward = Math.min(1, Math.max(-1, measuredReward))
  const row = ctx.db
    .prepare('SELECT topic, quality FROM npc_outcomes WHERE id = ? AND agent_id = ?')
    .get(outcomeId, agentId) as { topic: string; quality: number } | undefined
  if (!row) return

  ctx.db
    .prepare('UPDATE npc_outcomes SET reward = ?, settled_at = ? WHERE id = ?')
    .run(reward, now, outcomeId)

  // Konuya özel politika varsa onu, yoksa genel politikayı güncelle.
  updatePolicy(ctx, agentId, row.topic, reward, row.quality, now)
}

/**
 * Bir davranış ağırlığını reward ile uyumlu yönde küçük bir adım kaydırır.
 * EMA (üstel hareketli ortalama) kullanılır: yeni reward = 0.8*eski + 0.2*yeni.
 */
export function updatePolicy(
  ctx: Ctx,
  agentId: string,
  topic: string,
  reward: number,
  quality: number,
  now: number,
): void {
  const current = behaviorOf(ctx, agentId, topic)
  const avg = current.trials === 0 ? reward : current.reward * 0.8 + reward * 0.2

  // Adım büyüklüğü: kaliteli ve etkili denemeler daha güçlü sinyal.
  const strength = Math.min(1, Math.abs(reward)) * (0.5 + quality * 0.5) * MAX_STEP

  // Yüksek ödül → o davranış ağırlığı artsın, düşük/negatif → azalsın.
  const direction = reward > 0 ? 1 : reward < 0 ? -1 : 0
  const humor_w = clampWeight(current.humor_w + direction * strength)
  const length_w = clampWeight(current.length_w + direction * strength * 0.8)
  const engage_w = clampWeight(current.engage_w + (reward > 0 ? strength : -strength * 0.5))
  const post_w = clampWeight(current.post_w + (reward > 0 ? strength * 0.6 : -strength * 0.4))

  ctx.db
    .prepare(
      `INSERT INTO npc_behavior (agent_id, topic, humor_w, length_w, engage_w, post_w, trials, reward, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT(agent_id, topic) DO UPDATE SET
         humor_w = excluded.humor_w, length_w = excluded.length_w,
         engage_w = excluded.engage_w, post_w = excluded.post_w,
         trials = npc_behavior.trials + 1, reward = excluded.reward,
         updated_at = excluded.updated_at`,
    )
    .run(agentId, topic, humor_w, length_w, engage_w, post_w, avg, now)
}

/**
 * Davranış değişimlerini listeler (yönetim paneli — "davranış değişimleri").
 * Sadece varsayılandan (1.0) sapan politikalar döner.
 */
export function behaviorChanges(ctx: Ctx, agentId: string, limit = 10): NpcBehaviorRow[] {
  return ctx.db
    .prepare(
      `SELECT * FROM npc_behavior
        WHERE agent_id = ?
          AND (ABS(humor_w - 1) > 0.05 OR ABS(length_w - 1) > 0.05
               OR ABS(engage_w - 1) > 0.05 OR ABS(post_w - 1) > 0.05)
        ORDER BY ABS(reward) DESC, updated_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as unknown as NpcBehaviorRow[]
}

/** Toplam öğrenme denemesi sayısı (yönetim paneli). */
export function trialCount(ctx: Ctx, agentId: string): number {
  const row = ctx.db
    .prepare('SELECT COALESCE(SUM(trials), 0) AS n FROM npc_behavior WHERE agent_id = ?')
    .get(agentId) as { n: number }
  return row.n
}

/** Davranış politikasını sıfırlar. */
export function clearBehavior(ctx: Ctx, agentId: string): void {
  ctx.db.prepare('DELETE FROM npc_behavior WHERE agent_id = ?').run(agentId)
  ctx.db.prepare('DELETE FROM npc_outcomes WHERE agent_id = ?').run(agentId)
}
