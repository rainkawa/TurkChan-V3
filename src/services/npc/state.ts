/**
 * NPC YAŞAM KATMANLARI — hafıza, öğrenme, kişilik, görüş, mood AYRI ayrı.
 *
 *   Memory  (memory.ts)   : "ne oldu?"   — olaylar, kavram ağırlıkları
 *   Learning(learning.ts) : "ne öğrendim?" — davranış ağırlıkları
 *   Personality(personas) : "ben kimim?"  — değişmeyen eksenler
 *   Opinion (burada)      : "bu konuda ne düşünüyorum?" — -1..1 + güven
 *   Mood    (burada)      : "şu an nasıl hissediyorum?" — son olaylardan
 *
 * Bu dosya üç şeyi yönetir:
 *   1. Konuşma devamlılığı (`npc_threads`) — aynı gönderiye her seferinde
 *      sıfırdan cevap verilmez.
 *   2. Görüş gelişimi (`npc_opinions`) — küçük adımlarla değişir.
 *   3. Bilgi deposu (`npc_facts`) — NPC'nin bildiği olgular; `last_used` ve
 *      `success_count` ile kullanımı ölçülür.
 */
import type { Ctx } from '../../context'
import { newId } from '../../lib/ids'
import { trLower } from './lexicon'
import { stem } from './lexicon'

/** Bir gönderi üzerindeki konuşma durumu. */
export interface ThreadState {
  agent_id: string
  post_id: string
  subject: string
  last_stance: string
  last_statement: string
  open_question: string
  disagreement: number
  replies: number
  updated_at: number
}

/** Konu bazlı görüş. */
export interface Opinion {
  topic: string
  value: number
  confidence: number
  samples: number
}

/** Bilgi deposu kaydı. */
export interface FactRecord {
  subject: string
  fact: string
  source: 'bilgi' | 'deneyim' | 'tanıdık'
  confidence: number
  success_count: number
}

/** Mood: kısa vadeli ruh hali (-1..1) ve etiketi. */
export interface Mood {
  value: number
  label: 'keyifli' | 'nötr' | 'sinirli' | 'üzgün' | 'enerjik'
}

const CLAMP = (v: number): number => Math.min(1, Math.max(-1, v))

// ---------------------------------------------------------------------------
// 1) KONUŞMA DEVAMLILIĞI
// ---------------------------------------------------------------------------

/** Bir gönderi için konuşma durumu (yoksa boş durum). */
export function threadOf(ctx: Ctx, agentId: string, postId: string): ThreadState {
  const row = ctx.db
    .prepare('SELECT * FROM npc_threads WHERE agent_id = ? AND post_id = ?')
    .get(agentId, postId) as ThreadState | undefined
  return (
    row ?? {
      agent_id: agentId,
      post_id: postId,
      subject: '',
      last_stance: '',
      last_statement: '',
      open_question: '',
      disagreement: 0,
      replies: 0,
      updated_at: 0,
    }
  )
}

/**
 * Cevabı yazdıktan SONRA konuşma durumunu günceller.
 *
 * `openQuestion`: NPC'nin sorduğu ve henüz cevaplanmamış soru.
 * `disagreement`: karşı görüş sertleştikçe artar, uzlaşma olursa azalır.
 */
export function rememberThread(
  ctx: Ctx,
  agentId: string,
  postId: string,
  update: {
    subject?: string
    stance?: string
    statement?: string
    openQuestion?: string
    disagreementDelta?: number
  },
  now: number,
): void {
  const current = threadOf(ctx, agentId, postId)
  const next = {
    subject: update.subject ?? current.subject,
    last_stance: update.stance ?? current.last_stance,
    last_statement: (update.statement ?? current.last_statement).slice(0, 160),
    open_question: update.openQuestion ?? current.open_question,
    disagreement: CLAMP(current.disagreement + (update.disagreementDelta ?? 0)),
    replies: current.replies + 1,
    updated_at: now,
  }
  ctx.db
    .prepare(
      `INSERT INTO npc_threads
         (agent_id, post_id, subject, last_stance, last_statement, open_question, disagreement, replies, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, post_id) DO UPDATE SET
         subject = excluded.subject,
         last_stance = excluded.last_stance,
         last_statement = excluded.last_statement,
         open_question = excluded.open_question,
         disagreement = excluded.disagreement,
         replies = excluded.replies + 1,
         updated_at = excluded.updated_at`,
    )
    .run(
      agentId,
      postId,
      next.subject,
      next.last_stance,
      next.last_statement,
      next.open_question,
      next.disagreement,
      current.replies,
      now,
    )
}

/** Başka birinin yorumu soruyu yanıtladı mı? (açık soru kapatılır) */
export function resolveOpenQuestion(ctx: Ctx, agentId: string, postId: string, now: number): void {
  ctx.db
    .prepare('UPDATE npc_threads SET open_question = %s WHERE agent_id = ? AND post_id = ?')
    .run('', agentId, postId)
  void now
}

/** Gönderinin yorum ağacından son konuşma parçaları (thread awareness). */
export interface ThreadItem {
  author: string
  author_is_ai: boolean
  body: string
  created_at: number
}

/** Gönderinin yorumlarını kronolojik okur (en fazla `limit`). */
export function readThread(ctx: Ctx, postId: string, limit = 12): ThreadItem[] {
  return ctx.db
    .prepare(
      `SELECT u.username AS author, u.is_ai AS author_is_ai, c.body, c.created_at
         FROM comments c JOIN users u ON u.id = c.author_id
        WHERE c.post_id = ? AND c.deleted = 0 AND c.removed = 0 AND c.auto_hidden = 0
        ORDER BY c.created_at ASC LIMIT ?`,
    )
    .all(postId, limit) as unknown as ThreadItem[]
}

// ---------------------------------------------------------------------------
// 2) GÖRÜŞ GELİŞİMİ
// ---------------------------------------------------------------------------

/** Bir konudaki görüş (yoksa nötr). */
export function opinionOf(ctx: Ctx, agentId: string, topic: string): Opinion {
  const row = ctx.db
    .prepare('SELECT topic, value, confidence, samples FROM npc_opinions WHERE agent_id = ? AND topic = ?')
    .get(agentId, topic) as Opinion | undefined
  return row ?? { topic, value: 0, confidence: 0.2, samples: 0 }
}

/** En güçlü görüşler (denetim paneli). */
export function opinionsOf(ctx: Ctx, agentId: string, limit = 10): Opinion[] {
  return ctx.db
    .prepare(
      `SELECT topic, value, confidence, samples FROM npc_opinions
        WHERE agent_id = ? ORDER BY ABS(value) DESC, samples DESC LIMIT ?`,
    )
    .all(agentId, limit) as unknown as Opinion[]
}

/**
 * Görüşü KÜÇÜK ADIMLA kaydırır.
 *
 * @param evidence -1..1 (olayın yönü)
 * @param strength 0..1 (olayın gücü) — tek etkileşim karakteri değiştiremez.
 */
export function shiftOpinion(
  ctx: Ctx,
  agentId: string,
  topic: string,
  evidence: number,
  strength: number,
  now: number,
): void {
  if (topic === '' || topic === 'gündelik') return
  const current = opinionOf(ctx, agentId, topic)
  // Adım en fazla 0.05 ve güvenle sınırlı: karakter bir turda dönüşmez.
  const step = CLAMP(evidence) * Math.min(0.05, 0.05 * Math.min(1, Math.max(0, strength)) * (0.4 + current.confidence))
  const value = CLAMP(current.value + step)
  const confidence = Math.min(1, current.confidence + 0.05 * Math.min(1, Math.max(0, strength)))
  const samples = current.samples + 1
  ctx.db
    .prepare(
      `INSERT INTO npc_opinions (agent_id, topic, value, confidence, samples, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id, topic) DO UPDATE SET
         value = excluded.value, confidence = excluded.confidence,
         samples = excluded.samples, updated_at = excluded.updated_at`,
    )
    .run(agentId, topic, value, confidence, samples, now)
}

/** Bir konudaki görüşün metin etiketi (üretimde kullanılır). */
export function opinionWord(opinion: Opinion): 'olumlu' | 'olumsuz' | 'kararsız' {
  if (opinion.confidence < 0.35 || Math.abs(opinion.value) < 0.2) return 'kararsız'
  return opinion.value > 0 ? 'olumlu' : 'olumsuz'
}

// ---------------------------------------------------------------------------
// 3) BİLGİ DEPOSU
// ---------------------------------------------------------------------------

/** Konuya ait bilgiler (en güvenilir ve en çok kullanılan önce). */
export function factsAbout(ctx: Ctx, agentId: string, subject: string, limit = 4): FactRecord[] {
  return ctx.db
    .prepare(
      `SELECT subject, fact, source, confidence, success_count
         FROM npc_facts
        WHERE agent_id = ? AND subject = ?
        ORDER BY confidence DESC, success_count DESC, last_used DESC LIMIT ?`,
    )
    .all(agentId, subject, limit) as unknown as FactRecord[]
}

/** Bilgileri hatırla (aynı olgu iki kez yazılmaz). */
export function rememberFact(
  ctx: Ctx,
  agentId: string,
  subject: string,
  fact: string,
  source: FactRecord['source'],
  confidence: number,
  now: number,
): void {
  const key = subject === '' ? stem(fact) : subject
  const clean = fact.replace(/\s+/gu, ' ').trim().slice(0, 180)
  if (key === '' || clean === '') return
  ctx.db
    .prepare(
      `INSERT INTO npc_facts (id, agent_id, subject, fact, source, confidence, success_count, last_used, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(agent_id, subject, fact) DO UPDATE SET
         confidence = MAX(npc_facts.confidence, excluded.confidence),
         last_used = excluded.last_used`,
    )
    .run(newId(), agentId, key, clean, source, Math.min(1, Math.max(0, confidence)), now, now)
}

/** Bir bilginin kullanıldığını işaretle. */
export function touchFact(ctx: Ctx, agentId: string, subject: string, fact: string, won: boolean, now: number): void {
  ctx.db
    .prepare(
      `UPDATE npc_facts SET last_used = ?, success_count = success_count + ?
        WHERE agent_id = ? AND subject = ? AND fact = ?`,
    )
    .run(now, won ? 1 : 0, agentId, subject, fact)
}

/** Bilgi deposundaki olgu sayısı (denetim). */
export function factCount(ctx: Ctx, agentId: string): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM npc_facts WHERE agent_id = ?').get(agentId) as { n: number }).n
}

// ---------------------------------------------------------------------------
// 4) MOOD — son olaylardan türetilir, kalıcı değildir
// ---------------------------------------------------------------------------

/**
 * Mood: son yorumlarının kalite ortalaması + günün saati + kişilik.
 * Görünür bir "ruh hali" değil, üretimi çeşitlendiren bir girdidir.
 */
export function moodOf(ctx: Ctx, agentId: string, now: number, patience: number): Mood {
  const row = ctx.db
    .prepare(
      `SELECT AVG(quality) AS avg_score, COUNT(*) AS n
         FROM npc_outcomes
        WHERE agent_id = ? AND settled_at IS NOT NULL AND created_at > ?`,
    )
    .get(agentId, now - 6 * 3_600_000) as { avg_score: number | null; n: number }
  const recent = row.avg_score ?? 0.5
  const hour = new Date(now).getHours()
  // Gece saatleri biraz daha "çekingen", sabah saatleri daha enerjik.
  const timeBias = hour >= 23 || hour < 6 ? -0.15 : hour < 11 ? 0.1 : 0
  const value = CLAMP((recent - 0.6) * 1.2 + timeBias)
  const label: Mood['label'] =
    value > 0.35 ? 'enerjik' : value > 0.1 ? 'keyifli' : value < -0.3 ? 'sinirli' : value < -0.1 ? 'üzgün' : 'nötr'
  void patience
  return { value, label }
}

/** Konuşma durumlarını temizler (yönetim paneli). */
export function clearState(ctx: Ctx, agentId: string): void {
  ctx.db.prepare('DELETE FROM npc_threads WHERE agent_id = ?').run(agentId)
  ctx.db.prepare('DELETE FROM npc_opinions WHERE agent_id = ?').run(agentId)
  ctx.db.prepare('DELETE FROM npc_facts WHERE agent_id = ?').run(agentId)
}

/** Denetim için: konuşurken kullanılan özet. */
export function stateSummary(ctx: Ctx, agentId: string): string {
  const threads = ctx.db
    .prepare('SELECT COUNT(*) AS n FROM npc_threads WHERE agent_id = ?')
    .get(agentId) as { n: number }
  const opinions = opinionsOf(ctx, agentId, 3)
  return `konuşma=${threads.n} görüş=${opinions.map((o) => `${o.topic}:${o.value.toFixed(2)}`).join(', ') || '—'} bilgi=${factCount(ctx, agentId)} mood=${moodOf(ctx, agentId, ctx.now(), 0.5).label}`.trim()
}

/** Küçük yardımcı: metni karşılaştırma için normalize eder. */
export function normalizeTopic(text: string): string {
  return trLower(text).trim()
}

// ---------------------------------------------------------------------------
// 5) ÜRETİM DENETİM İZİ (yönetim paneli)
// ---------------------------------------------------------------------------

/** Bir üretimin tam izi — "neden bu cevabı verdi?" sorusunun cevabı. */
export interface TraceRecord {
  plan: string
  thought: string
  memory: string
  relationship: string
  mood: string
  score: number
  rejected: string
  body: string
  created_at: number
}

/** Üretim izi kaydeder. */
export function saveTrace(
  ctx: Ctx,
  agentId: string,
  kind: 'comment' | 'post',
  targetId: string | null,
  trace: Omit<TraceRecord, 'created_at'>,
  now: number,
): void {
  ctx.db
    .prepare(
      `INSERT INTO npc_traces
         (id, agent_id, kind, target_id, plan, thought, memory, relationship, mood, score, rejected, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId(),
      agentId,
      kind,
      targetId,
      trace.plan,
      trace.thought,
      trace.memory,
      trace.relationship,
      trace.mood,
      trace.score,
      trace.rejected,
      trace.body,
      now,
    )
  // İz sınırlıdır: karakter başına son 40 kayıt.
  ctx.db
    .prepare(
      `DELETE FROM npc_traces
        WHERE agent_id = ? AND id IN (
          SELECT id FROM npc_traces WHERE agent_id = ?
           ORDER BY created_at ASC LIMIT MAX(0, (
             SELECT COUNT(*) FROM npc_traces WHERE agent_id = ?) - 40))`,
    )
    .run(agentId, agentId, agentId)
}

/** Son üretim izleri (yönetim paneli). */
export function recentTraces(ctx: Ctx, agentId: string, limit = 10): TraceRecord[] {
  return ctx.db
    .prepare(
      `SELECT plan, thought, memory, relationship, mood, score, rejected, body, created_at
         FROM npc_traces WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentId, limit) as unknown as TraceRecord[]
}
