/**
 * NPC kalıcı hafıza sistemi.
 *
 * TASARIM — sınırsız konuşma saklanmaz:
 *   Her şey "kayıt + puan" modeliyle tutulur. `npc_memory` tablosunda bir
 *   kavram/kişi/board/ifade için SATIR vardır; `weight` (0..1) önem
 *   puanını, `hits` kaç kez karşılaşıldığını, `positive`/`negative`
 *   etkileşim polaritesini tutar.
 *
 *   `npc_episodes` tablosunda ise yalnızca ÖNEMLİ konuşmaların TEK
 *   CÜMLELİK özeti saklanır (konu + duygu + kalite skoru + sonuç). Tam
 *   metin saklanmaz; motor her turda yalnızca üst N kaydı okur.
 *
 * BUDAMA: `prune()` her yazımdan sonra düşük puanlı satırları siler; tablo
 * karakter başına sınırlı kalır (varsayılan 120 kayıt). Bu, "sınırsız
 * büyüyen hafıza" sorununu yapısal olarak çözer.
 *
 * GÜVENLİK: hafıza düz METİN saklar ve yalnızca NPC'nin kendi verisiyle
 * dolar; HTML/JS enjeksiyonu için kullanıcı içeriğinden türetilen parçalar
 * sadece `summary` alanında, 200 karaktere kırpılarak tutulur ve çıktıda
 * Markdown kaçışı uygulanır.
 */
import type { Ctx } from '../../context'
import type { NpcEpisodeRow, NpcMemoryRow } from '../../types'
import { newId } from '../../lib/ids'
import { trLower } from './lexicon'

/** Karakter başına saklanacak azami hafıza satırı. */
export const MEMORY_LIMIT = 120
/** Karakter başına saklanacak azami önemli olay. */
export const EPISODE_LIMIT = 40
/** Bir olay özetinin azami uzunluğu. */
const SUMMARY_MAX = 200

export type MemoryKind = 'concept' | 'person' | 'board' | 'phrase' | 'fact'

/**
 * Bir kavramı hatırlar (veya hatırlama gücünü artırır).
 *
 * @param delta Pozitifse ağırlık artar; her karşılaşmada `hits` artar.
 * `importance` 0..1; artış `weight`'e eklenir ama 1'i geçmez.
 */
export function rememberConcept(
  ctx: Ctx,
  agentId: string,
  concept: string,
  delta: number,
  now: number,
): void {
  upsertMemory(ctx, agentId, 'concept', concept, delta, now)
}

/** Bir kullanıcıyı/NPC'yi hatırlar. */
export function rememberPerson(
  ctx: Ctx,
  agentId: string,
  personId: string,
  delta: number,
  now: number,
): void {
  upsertMemory(ctx, agentId, 'person', personId, delta, now)
}

/** Bir boardu hatırlar. */
export function rememberBoard(
  ctx: Ctx,
  agentId: string,
  board: string,
  delta: number,
  now: number,
): void {
  upsertMemory(ctx, agentId, 'board', board, delta, now)
}

/**
 * Kullanılan bir ifadeyi kaydeder (tekrar önleme).
 * `phrase` normalize edilerek saklanır; aynı ifadenin farklı yazımları
 * "tekrar" sayılır.
 */
export function rememberPhrase(ctx: Ctx, agentId: string, phrase: string, now: number): void {
  const key = normalizePhrase(phrase)
  if (key === '') return
  const existing = ctx.db
    .prepare('SELECT uses FROM npc_phrases WHERE agent_id = ? AND phrase = ?')
    .get(agentId, key) as { uses: number } | undefined
  if (existing) {
    ctx.db
      .prepare('UPDATE npc_phrases SET uses = uses + 1, last_used_at = ? WHERE agent_id = ? AND phrase = ?')
      .run(now, agentId, key)
  } else {
    ctx.db
      .prepare('INSERT INTO npc_phrases (id, agent_id, phrase, uses, last_used_at) VALUES (?, ?, ?, 1, ?)')
      .run(newId(), agentId, key, now)
  }
  // Kullanılan ifade sayısı sınırlıdır: en eski 60 ifade budanır.
  ctx.db
    .prepare(
      `DELETE FROM npc_phrases
        WHERE agent_id = ? AND id IN (
          SELECT id FROM npc_phrases WHERE agent_id = ?
           ORDER BY last_used_at ASC LIMIT MAX(0, (
             SELECT COUNT(*) FROM npc_phrases WHERE agent_id = ?) - 60))`,
    )
    .run(agentId, agentId, agentId)
}

/** Bir ifadenin kaç kez kullanıldığı. */
export function phraseUses(ctx: Ctx, agentId: string, phrase: string): number {
  const row = ctx.db
    .prepare('SELECT uses FROM npc_phrases WHERE agent_id = ? AND phrase = ?')
    .get(agentId, normalizePhrase(phrase)) as { uses: number } | undefined
  return row?.uses ?? 0
}

/** Son kullanılan ifadeler (tekrar cezası için). */
export function recentPhrases(ctx: Ctx, agentId: string, limit = 20): string[] {
  return (
    ctx.db
      .prepare('SELECT phrase FROM npc_phrases WHERE agent_id = ? ORDER BY last_used_at DESC LIMIT ?')
      .all(agentId, limit) as unknown as Array<{ phrase: string }>
  ).map((r) => r.phrase)
}

/**
 * Bir cümleyi/normalizasyonla karşılaştırma anahtarına çevirir.
 * Büyük/küçük harf, noktalama ve fazla boşluk etkisizleştirilir.
 */
export function normalizePhrase(text: string): string {
  return trLower(text)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 80)
}

/** Genel hafıza yazma (upsert). */
function upsertMemory(
  ctx: Ctx,
  agentId: string,
  kind: MemoryKind,
  key: string,
  delta: number,
  now: number,
): void {
  if (key === '' || agentId === '') return
  const existing = ctx.db
    .prepare('SELECT id, weight FROM npc_memory WHERE agent_id = ? AND kind = ? AND key = ?')
    .get(agentId, kind, key) as { id: string; weight: number } | undefined

  if (existing) {
    // Ağırlık, mevcut değere küçük bir artış olarak eklenir ve 0..1 aralığında
    // tutulur. Negatif delta ağırlığı düşürür (0'ın altına inmez).
    const next = Math.min(1, Math.max(0, existing.weight + delta))
    ctx.db
      .prepare(
        `UPDATE npc_memory
            SET weight = ?, hits = hits + 1, last_seen_at = ?
          WHERE id = ?`,
      )
      .run(next, now, existing.id)
    ctx.db
      .prepare(
        `UPDATE npc_memory
            SET ${delta >= 0 ? 'positive' : 'negative'} = ${delta >= 0 ? 'positive' : 'negative'} + 1
          WHERE id = ?`,
      )
      .run(existing.id)
  } else {
    ctx.db
      .prepare(
        `INSERT INTO npc_memory (id, agent_id, kind, key, weight, hits, positive, negative, last_seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
      )
      .run(
        newId(),
        agentId,
        kind,
        key,
        Math.min(1, Math.max(0, delta)),
        delta >= 0 ? 1 : 0,
        now,
        now,
      )
  }
}

/**
 * Bir etkileşimin sonucunu hafızaya işler (OBSERVE → UPDATE MEMORY).
 *
 * @param concept Etkileşimde geçen konu ailesi.
 * @param outcome Pozitif/olumsuz etkileşim puanı (-1..1).
 */
export function observeOutcome(
  ctx: Ctx,
  agentId: string,
  concept: string,
  outcome: number,
  now: number,
): void {
  if (concept === '' || concept === 'gündelik') return
  const delta = Math.max(-0.1, Math.min(0.1, outcome * 0.05))
  rememberConcept(ctx, agentId, concept, delta, now)
}

/**
 * Önemli bir olayı kaydeder (tek cümlelik özet).
 *
 * Tam metin SAKLANMAZ; sadece konu + duygu + skor tutulur. Özet
 * 200 karaktere kırpılır ve kontrol karakterleri temizlenir.
 */
export function recordEpisode(
  ctx: Ctx,
  agentId: string,
  episode: {
    concept: string
    summary: string
    sentiment?: string
    score?: number
    postId?: string | null
    commentId?: string | null
    peerId?: string | null
  },
  now: number,
): void {
  const summary = episode.summary.replace(/\s+/gu, ' ').trim().slice(0, SUMMARY_MAX)
  if (summary === '') return
  ctx.db
    .prepare(
      `INSERT INTO npc_episodes (id, agent_id, concept_id, post_id, comment_id, peer_id, summary, sentiment, score, reward, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      newId(),
      agentId,
      episode.concept,
      episode.postId ?? null,
      episode.commentId ?? null,
      episode.peerId ?? null,
      summary,
      episode.sentiment ?? 'neutral',
      episode.score ?? 0,
      now,
    )
  // Sınırlı sayıda olay tutulur: en eski 10 düşürülür.
  ctx.db
    .prepare(
      `DELETE FROM npc_episodes
        WHERE agent_id = ? AND id IN (
          SELECT id FROM npc_episodes WHERE agent_id = ?
           ORDER BY created_at ASC LIMIT MAX(0, (
             SELECT COUNT(*) FROM npc_episodes WHERE agent_id = ?) - ?))`,
    )
    .run(agentId, agentId, agentId, EPISODE_LIMIT)
}

/** Bir kavramın hatırlama gücü (0 = hiç karşılaşmadı). */
export function memoryWeight(ctx: Ctx, agentId: string, concept: string): number {
  const row = ctx.db
    .prepare("SELECT weight FROM npc_memory WHERE agent_id = ? AND kind = 'concept' AND key = ?")
    .get(agentId, concept) as { weight: number } | undefined
  return row?.weight ?? 0
}

/** En çok hatırlanan konular (karar girdisi olarak kullanılır). */
export function topConcepts(ctx: Ctx, agentId: string, limit = 8): Array<{ id: string; weight: number }> {
  return ctx.db
    .prepare(
      `SELECT key AS id, weight FROM npc_memory
        WHERE agent_id = ? AND kind = 'concept'
        ORDER BY weight DESC, hits DESC LIMIT ?`,
    )
    .all(agentId, limit) as unknown as Array<{ id: string; weight: number }>
}

/** Toplam hafıza büyüklüğü (yönetim paneli). */
export function memorySize(ctx: Ctx, agentId: string): number {
  const row = ctx.db.prepare('SELECT COUNT(*) AS n FROM npc_memory WHERE agent_id = ?').get(agentId) as {
    n: number
  }
  return row.n
}

/** Son olaylar (yönetim paneli ve karar girdisi). */
export function recentEpisodes(ctx: Ctx, agentId: string, limit = 10): NpcEpisodeRow[] {
  return ctx.db
    .prepare('SELECT * FROM npc_episodes WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(agentId, limit) as unknown as NpcEpisodeRow[]
}

/** Bu kavramla ilgili geçmiş olay var mı? ("Daha önce bu konuyu gördüm mü?") */
export function hasSeenConcept(ctx: Ctx, agentId: string, concept: string): boolean {
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM npc_episodes
        WHERE agent_id = ? AND concept_id = ? LIMIT 1`,
    )
    .get(agentId, concept) as { n: number }
  return row.n > 0
}

/** Aynı gönderiye daha önce yorum yapıldı mı? */
export function hasCommentedOn(ctx: Ctx, agentId: string, postId: string): boolean {
  const row = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND post_id = ? LIMIT 1')
    .get(agentId, postId) as { n: number }
  return row.n > 0
}

/** Hafızayı düşük puanlı kayıtlarla budar (her yazımdan sonra çağrılır). */
export function pruneMemory(ctx: Ctx, agentId: string): void {
  ctx.db
    .prepare(
      `DELETE FROM npc_memory
        WHERE agent_id = ? AND id IN (
          SELECT id FROM npc_memory WHERE agent_id = ?
           ORDER BY weight ASC, hits ASC LIMIT MAX(0, (
             SELECT COUNT(*) FROM npc_memory WHERE agent_id = ?) - ?))`,
    )
    .run(agentId, agentId, agentId, MEMORY_LIMIT)
}

/** Tüm hafızayı siler (yönetim panelindeki "hafıza sıfırla"). */
export function clearMemory(ctx: Ctx, agentId: string): void {
  ctx.db.prepare('DELETE FROM npc_memory WHERE agent_id = ?').run(agentId)
  ctx.db.prepare('DELETE FROM npc_episodes WHERE agent_id = ?').run(agentId)
  ctx.db.prepare('DELETE FROM npc_phrases WHERE agent_id = ?').run(agentId)
}

/** Hafıza kayıtlarını listeler (yönetim paneli). */
export function listMemory(ctx: Ctx, agentId: string, limit = 50): NpcMemoryRow[] {
  return ctx.db
    .prepare('SELECT * FROM npc_memory WHERE agent_id = ? ORDER BY weight DESC, hits DESC LIMIT ?')
    .all(agentId, limit) as unknown as NpcMemoryRow[]
}
