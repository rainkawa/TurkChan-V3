/**
 * Özel mesajlaşma (DM) servisi.
 *
 * Sohbet iki üyeden oluşur ve `conversation_members` üzerinden yönetilir:
 *  - `last_read_at` → okundu/okunmadı (rozet ve koyu satır rengi)
 *  - `archived`    → arşiv (sağ sütundaki "Arşiv" bölümü)
 *  - `hidden`      → "sohbeti benden sil" (kendi listemden gizler, veri kalır)
 *  - `accepted`    → 0 ise karşı taraf henüz kabul etmedi, mesaj "İstekler"de durur
 *
 * Mesaj silme iki kişiliktir: `deleted_for_everyone` herkesten siler,
 * `message_deletions` ise "sadece benden sil" (diğer kullanıcılar görmeye devam eder).
 */
import type { Ctx } from '../context'
import type { MessageRow, UserRow } from '../types'
import { newId } from '../lib/ids'
import { LIMITS } from '../lib/validation'
import { badRequest, forbidden, notFound, rateLimited } from './errors'
import { assertNotDuplicate } from '../lib/spam'
import { isSuspended } from './access'
import { getUserById } from './users'
import { t } from '../i18n/tr'

const HOUR_MS = 60 * 60 * 1000

/* -------------------------------------------------------------------------- */
/* Yardımcılar                                                               */
/* -------------------------------------------------------------------------- */

/** Kullanıcının üyesi olduğu sohbeti döndürür; üye değilse undefined. */
function memberOf(ctx: Ctx, conversationId: string, userId: string) {
  return ctx.db
    .prepare('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId) as { last_read_at: number; archived: number; hidden: number; accepted: number } | undefined
}

/** Sohbetin diğer üyesi. */
function otherMemberId(ctx: Ctx, conversationId: string, userId: string): string | null {
  const row = ctx.db
    .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id != ?')
    .get(conversationId, userId) as { user_id: string } | undefined
  return row?.user_id ?? null
}

export function isMember(ctx: Ctx, conversationId: string, userId: string): boolean {
  return memberOf(ctx, conversationId, userId) !== undefined
}

/* -------------------------------------------------------------------------- */
/* Sohbet oluşturma / bulma                                                    */
/* -------------------------------------------------------------------------- */

/** İki kullanıcı arasındaki sohbeti bulur; yoksa oluşturur (idempotent). */
export function conversationBetween(ctx: Ctx, aId: string, bId: string): string {
  if (aId === bId) throw badRequest('self', t.dm.errors.selfMessage)
  const existing = ctx.db
    .prepare(
      `SELECT a.conversation_id AS id
         FROM conversation_members a
         JOIN conversation_members b ON b.conversation_id = a.conversation_id
        WHERE a.user_id = ? AND b.user_id = ? AND a.user_id != b.user_id
        LIMIT 1`,
    )
    .get(aId, bId) as { id: string } | undefined
  if (existing) return existing.id

  const id = newId()
  const now = ctx.now()
  ctx.db.prepare('INSERT INTO conversations (id, created_at) VALUES (?, ?)').run(id, now)
  const insert = ctx.db.prepare(
    'INSERT INTO conversation_members (conversation_id, user_id, last_read_at, archived, hidden, accepted) VALUES (?, ?, ?, 0, 0, ?)',
  )
  // Gönderen kabul etmiş sayılır (kendi istek kutusunda görmez), alıcı ise istek alır.
  insert.run(id, aId, now, 1)
  insert.run(id, bId, 0, 0)
  return id
}

/** Kullanıcı adına göre sohbeti bulur veya oluşturur (yeni DM başlatma). */
export function conversationWithUsername(ctx: Ctx, viewer: UserRow, username: string): string {
  const target = getUserByUsername(ctx, username)
  if (!target || target.deleted === 1) throw notFound(t.dm.errors.userNotFound)
  if (target.id === viewer.id) throw badRequest('self', t.dm.errors.selfMessage)
  return conversationBetween(ctx, viewer.id, target.id)
}

function getUserByUsername(ctx: Ctx, username: string): UserRow | null {
  const row = ctx.db
    .prepare('SELECT * FROM users WHERE username_lower = ?')
    .get(username.trim().toLowerCase()) as UserRow | undefined
  return row ?? null
}

/* -------------------------------------------------------------------------- */
/* Mesaj gönderme                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mesaj gönderir. Alıcının kutusu "istek" değilse sohbeti alıcı için kabul eder
 * (yani normal listeye düşer). Gönderene anında okunmuş işaretlenir.
 */
export function sendMessage(
  ctx: Ctx,
  viewer: UserRow,
  conversationId: string,
  body: string,
  replyToId?: string | null,
): MessageRow {
  if (isSuspended(ctx, viewer)) throw forbidden(t.dm.errors.suspended)
  if (!isMember(ctx, conversationId, viewer.id)) throw forbidden(t.dm.errors.notAMember)
  const text = body.trim()
  if (!text) throw badRequest('body', t.dm.errors.empty)
  if (text.length > LIMITS.dmMessageMax) {
    throw badRequest('body', t.dm.errors.tooLong.replace('{max}', String(LIMITS.dmMessageMax)))
  }
  const limit = ctx.rateLimiter.check(`dm:${viewer.id}`, LIMITS.dmMessagesPerHour, HOUR_MS)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)
  assertNotDuplicate(ctx, {
    scope: `dm:${conversationId}`,
    userId: viewer.id,
    content: text,
    max: 2,
    windowMs: 5 * 60_000,
  })

  const now = ctx.now()
  const id = newId()
  const reply = typeof replyToId === 'string' && isMessageInConversation(ctx, replyToId, conversationId) ? replyToId : null
  ctx.db
    .prepare(
      `INSERT INTO messages (id, conversation_id, sender_id, body, reply_to_id, created_at, deleted_for_everyone)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(id, conversationId, viewer.id, text, reply, now)

  // Gönderen okumuş sayılır ve isteği kabul etmiş sayılır. Karşı tarafın ise
  // "accepted" değeri korunur: kabul edene kadar sohbet onun "İstekler"
  // bölümünde durur. Yeni mesaj, gizlenmiş (silinmiş) sohbeti tekrar görünür kılar.
  ctx.db
    .prepare('UPDATE conversation_members SET last_read_at = ?, accepted = 1, hidden = 0 WHERE conversation_id = ? AND user_id = ?')
    .run(now, conversationId, viewer.id)
  ctx.db
    .prepare('UPDATE conversation_members SET hidden = 0 WHERE conversation_id = ? AND user_id = ?')
    .run(conversationId, otherMemberId(ctx, conversationId, viewer.id))
  return getMessage(ctx, id) as MessageRow
}

function isMessageInConversation(ctx: Ctx, messageId: string, conversationId: string): boolean {
  return (
    ctx.db.prepare('SELECT 1 FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, conversationId) !== undefined
  )
}

export function getMessage(ctx: Ctx, messageId: string): MessageRow | null {
  return (ctx.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as MessageRow | undefined) ?? null
}

/* -------------------------------------------------------------------------- */
/* Sohbet listesi                                                            */
/* -------------------------------------------------------------------------- */

export interface ConversationSummary {
  id: string
  peer: UserRow
  lastMessageAt: number
  lastMessage: string
  lastMessageFromMe: boolean
  /** Son mesaj herkesten silinmişse önizleme yerine "silinmiş" yazılır. */
  lastMessageDeleted: boolean
  unread: number
  archived: boolean
  requested: boolean
  online: boolean
}

export interface ConversationList {
  main: ConversationSummary[]
  requests: ConversationSummary[]
  archived: ConversationSummary[]
  unreadTotal: number
}

interface RawSummaryRow {
  id: string
  last_read_at: number
  last_read_rowid: number
  archived: number
  hidden: number
  accepted: number
  last_message_at: number | null
  last_body: string | null
  last_sender: string | null
  last_deleted: number | null
}

/** Görünür sohbetler: gizlenmemiş olanlar (arşiv/istek ayrı bölümlere ayrılır). */
function summaryRows(ctx: Ctx, userId: string): RawSummaryRow[] {
  return ctx.db
    .prepare(
      `SELECT cm.conversation_id AS id, cm.last_read_at, cm.last_read_rowid, cm.archived, cm.hidden, cm.accepted,
              (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = cm.conversation_id) AS last_message_at,
              (SELECT body FROM messages m WHERE m.conversation_id = cm.conversation_id
                ORDER BY created_at DESC, id DESC LIMIT 1) AS last_body,
              (SELECT sender_id FROM messages m WHERE m.conversation_id = cm.conversation_id
                ORDER BY created_at DESC, id DESC LIMIT 1) AS last_sender,
              (SELECT deleted_for_everyone FROM messages m WHERE m.conversation_id = cm.conversation_id
                ORDER BY created_at DESC, id DESC LIMIT 1) AS last_deleted
         FROM conversation_members cm
        WHERE cm.user_id = ? AND cm.hidden = 0
        ORDER BY COALESCE(last_message_at, 0) DESC`,
    )
    .all(userId) as unknown as RawSummaryRow[]
}

function toSummary(ctx: Ctx, row: RawSummaryRow, userId: string, onlineIds: Set<string>): ConversationSummary | null {
  const peerId = otherMemberId(ctx, row.id, userId)
  if (!peerId) return null
  const peer = getUserById(ctx, peerId)
  if (!peer || peer.deleted === 1) return null
  const lastAt = row.last_message_at ?? 0
  const unread = countUnreadIn(ctx, row.id, userId, row.last_read_rowid, lastAt)
  return {
    id: row.id,
    peer,
    lastMessageAt: lastAt,
    lastMessage: row.last_body ?? '',
    lastMessageFromMe: row.last_sender === userId,
    lastMessageDeleted: row.last_deleted === 1,
    unread,
    archived: row.archived === 1,
    requested: row.accepted === 0,
    online: onlineIds.has(peerId),
  }
}

/**
 * Sohbetteki okunmamış mesaj sayısı.
 *
 * Karşılaştırma zaman damgasıyla değil `rowid` ile yapılır: mesajlar aynı
 * milisaniyede geldiğinde zaman damgası ayrım yapamaz ve yeni mesaj "okunmuş"
 * sayılıp rozet kaybolurdu. `rowid` yazılma sırasına göre artar ve tek
 * yönlüdür; bu yüzden aynı kapsama yazan eşzamanlı isteklerde "daha eski" bir
 * su damgası yazılsa bile okunmamış sayımı bozulmaz.
 */
function countUnreadIn(ctx: Ctx, conversationId: string, userId: string, lastReadRowid: number, lastAt: number): number {
  if (lastAt === 0) return 0
  const row = ctx.db
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE conversation_id = ? AND sender_id != ? AND rowid > ?`,
    )
    .get(conversationId, userId, lastReadRowid) as { n: number }
  return row.n
}

/** Gelen kutusu: mesajlar / istekler / arşiv. */
export function listConversations(ctx: Ctx, userId: string, onlineIds: Set<string> = new Set()): ConversationList {
  const rows = summaryRows(ctx, userId)
  const main: ConversationSummary[] = []
  const requests: ConversationSummary[] = []
  const archived: ConversationSummary[] = []
  let unreadTotal = 0
  for (const row of rows) {
    const summary = toSummary(ctx, row, userId, onlineIds)
    if (!summary) continue
    if (summary.archived) archived.push(summary)
    else if (summary.requested) requests.push(summary)
    else main.push(summary)
    // Arşivdeki sohbetler rozet sayılmaz; istekler sayılır (yeni mesaj vardır).
    if (!summary.archived) unreadTotal += summary.unread
  }
  return { main, requests, archived, unreadTotal }
}

/** Alt bar ve bildirim zorında kullanılan toplam okunmamış DM sayısı. */
export function dmUnreadCount(ctx: Ctx, userId: string): number {
  return listConversations(ctx, userId).unreadTotal
}

export function markConversationRead(ctx: Ctx, userId: string, conversationId: string): void {
  markConversationsRead(ctx, userId, [conversationId])
}

/**
 * DM ekranı açıldığında rozeti etkileyen tüm sohbetleri okunmuş işaretler.
 *
 * Arşivlenen sohbetler rozet sayısına girmediği için burada dokunulmaz; aksi
 * halde kullanıcı arşivlediği bir sohbeti açmadan rozeti sıfırlayamaz.
 */
export function markVisibleConversationsRead(ctx: Ctx, userId: string): void {
  const rows = ctx.db
    .prepare(
      'SELECT conversation_id FROM conversation_members WHERE user_id = ? AND hidden = 0 AND archived = 0',
    )
    .all(userId) as unknown as Array<{ conversation_id: string }>
  markConversationsRead(
    ctx,
    userId,
    rows.map((r) => r.conversation_id),
  )
}

/**
 * Sohbetleri okundu işaretler ve su damgasını (watermark) ilerletir.
 *
 * Damga, o anda sohbetteki en büyük `rowid` değerine çekilir; `last_read_at`
 * ise bildirim ekranındaki "okundu zamanı" bilgisi için tutulur.
 */
function markConversationsRead(ctx: Ctx, userId: string, conversationIds: string[]): void {
  if (conversationIds.length === 0) return
  const now = ctx.now()
  const update = ctx.db.prepare(
    `UPDATE conversation_members
        SET last_read_at = ?,
            last_read_rowid = MAX(last_read_rowid, ?)
      WHERE conversation_id = ? AND user_id = ?`,
  )
  const newest = ctx.db.prepare('SELECT MAX(rowid) AS r FROM messages WHERE conversation_id = ?')
  for (const conversationId of conversationIds) {
    const row = newest.get(conversationId) as { r: number | null }
    update.run(now, row.r ?? 0, conversationId, userId)
  }
}

/**
 * Bildirimler sayfasındaki "Tümünü okundu işaretle" düğmesi için.
 *
 * Tüm sohbetler (arşiv dahil) işaretlenir ve su damgası ilerletilir; aksi
 * halde aynı milisaniyede gelen mesaj okunmamış sayılır ve düğme hiçbir işe
 * yaramaz.
 */
export function markAllConversationsRead(ctx: Ctx, userId: string): void {
  const rows = ctx.db
    .prepare('SELECT conversation_id FROM conversation_members WHERE user_id = ?')
    .all(userId) as unknown as Array<{ conversation_id: string }>
  markConversationsRead(
    ctx,
    userId,
    rows.map((r) => r.conversation_id),
  )
}

/** Yalnızca okunmamış mesajı olan sohbetler (bildirimler sayfasında listelenir). */
export function unreadConversations(ctx: Ctx, userId: string): ConversationSummary[] {
  const list = listConversations(ctx, userId)
  return list.main.concat(list.requests).filter((c) => c.unread > 0)
}

/* -------------------------------------------------------------------------- */
/* Sohbet eylemleri (basılı tutma menüsü)                                     */
/* -------------------------------------------------------------------------- */

/** Sohbeti arşivle / arşivden çıkar. */
export function setArchived(ctx: Ctx, userId: string, conversationId: string, archived: boolean): void {
  requireMembership(ctx, userId, conversationId)
  ctx.db
    .prepare('UPDATE conversation_members SET archived = ? WHERE conversation_id = ? AND user_id = ?')
    .run(archived ? 1 : 0, conversationId, userId)
}

/** "Sohbeti benden sil": karşı tarafın listesi etkilenmez. */
export function deleteConversation(ctx: Ctx, userId: string, conversationId: string): void {
  requireMembership(ctx, userId, conversationId)
  ctx.db
    .prepare('UPDATE conversation_members SET hidden = 1, archived = 0 WHERE conversation_id = ? AND user_id = ?')
    .run(conversationId, userId)
}

/** İsteği kabul et (istekler bölümünden ana listeye taşır). */
export function acceptRequest(ctx: Ctx, userId: string, conversationId: string): void {
  requireMembership(ctx, userId, conversationId)
  ctx.db
    .prepare('UPDATE conversation_members SET accepted = 1, hidden = 0 WHERE conversation_id = ? AND user_id = ?')
    .run(conversationId, userId)
}

function requireMembership(ctx: Ctx, userId: string, conversationId: string): void {
  if (!isMember(ctx, conversationId, userId)) throw forbidden(t.dm.errors.notAMember)
}

/* -------------------------------------------------------------------------- */
/* Mesaj eylemleri                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Mesajı sil.
 *  - `everyone`: herkesten siler (yalnızca kendi mesajınızı).
 *  - `self`: sadece benden siler (karşı taraf görmeye devam eder).
 */
export function deleteMessage(
  ctx: Ctx,
  userId: string,
  messageId: string,
  mode: 'everyone' | 'self',
): { mode: 'everyone' | 'self' } {
  const message = getMessage(ctx, messageId)
  if (!message) throw notFound(t.dm.errors.messageNotFound)
  if (!isMember(ctx, message.conversation_id, userId)) throw forbidden(t.dm.errors.notAMember)
  if (mode === 'everyone') {
    if (message.sender_id !== userId) throw forbidden(t.dm.errors.ownMessageOnly)
    ctx.db.prepare('UPDATE messages SET deleted_for_everyone = 1, body = ? WHERE id = ?').run('', messageId)
    return { mode }
  }
  ctx.db
    .prepare('INSERT OR IGNORE INTO message_deletions (message_id, user_id) VALUES (?, ?)')
    .run(messageId, userId)
  return { mode }
}

/** Çift dokunma: beğeniyi aç/kapat. */
export function toggleReaction(ctx: Ctx, userId: string, messageId: string): { liked: boolean } {
  const message = getMessage(ctx, messageId)
  if (!message) throw notFound(t.dm.errors.messageNotFound)
  if (!isMember(ctx, message.conversation_id, userId)) throw forbidden(t.dm.errors.notAMember)
  const existing = ctx.db
    .prepare('SELECT 1 FROM message_reactions WHERE message_id = ? AND user_id = ?')
    .get(messageId, userId)
  if (existing) {
    ctx.db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?').run(messageId, userId)
    return { liked: false }
  }
  ctx.db
    .prepare('INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)')
    .run(messageId, userId, '❤', ctx.now())
  return { liked: true }
}

/** Basılı tutarak mesaj şikayet et (site yönetimine gider). */
export function reportMessage(ctx: Ctx, userId: string, messageId: string, reason: string, detail?: string): void {
  const message = getMessage(ctx, messageId)
  if (!message) throw notFound(t.dm.errors.messageNotFound)
  if (!isMember(ctx, message.conversation_id, userId)) throw forbidden(t.dm.errors.notAMember)
  if (message.sender_id === userId) throw badRequest('own', t.dm.errors.reportOwn)
  const limit = ctx.rateLimiter.check(`dmreport:${userId}`, 10, HOUR_MS)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)
  ctx.db
    .prepare(
      `INSERT INTO message_reports (id, message_id, reporter_id, reason, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(newId(), messageId, userId, reason.trim() || t.dm.report.defaultReason, detail?.trim() || null, ctx.now())
}

/* -------------------------------------------------------------------------- */
/* Sohbet içeriği                                                            */
/* -------------------------------------------------------------------------- */

export interface ThreadMessage {
  id: string
  senderId: string
  body: string
  mine: boolean
  createdAt: number
  replyTo: { id: string; senderId: string; body: string } | null
  deleted: boolean
  /** Kendi mesajım ve karşı taraf bunu okuduysa (tek tik / çift tik). */
  readByPeer: boolean
  liked: boolean
  likes: number
  reactions: string[]
}

/** Sohbet mesajlarını kullanıcının bakış açısına göre döndürür. */
export function thread(ctx: Ctx, userId: string, conversationId: string, since = 0): ThreadMessage[] {
  requireMembership(ctx, userId, conversationId)
  const rows = ctx.db
    .prepare(
      `SELECT * FROM messages WHERE conversation_id = ? AND created_at >= ? ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId, since) as unknown as MessageRow[]

  const hidden = new Set(
    (
      ctx.db.prepare('SELECT message_id FROM message_deletions WHERE user_id = ?').all(userId) as unknown as Array<{
        message_id: string
      }>
    ).map((r) => r.message_id),
  )
  const liked = new Set(
    (
      ctx.db
        .prepare('SELECT message_id FROM message_reactions WHERE user_id = ?')
        .all(userId) as unknown as Array<{ message_id: string }>
    ).map((r) => r.message_id),
  )
  const likes = new Map(
    (
      ctx.db
        .prepare('SELECT message_id, COUNT(*) AS n FROM message_reactions GROUP BY message_id')
        .all() as unknown as Array<{ message_id: string; n: number }>
    ).map((r) => [r.message_id, r.n]),
  )
  const byId = new Map(rows.map((r) => [r.id, r]))
  // Karşı tarafın son okuma anı → "okundu" bilgisi.
  const peerId = otherMemberId(ctx, conversationId, userId)
  const peerMember = peerId ? memberOf(ctx, conversationId, peerId) : undefined
  const peerLastRead = peerMember?.last_read_at ?? 0

  const out: ThreadMessage[] = []
  for (const row of rows) {
    // "Sadece benden sil" → benim görünümümde tamamen gizli
    if (hidden.has(row.id)) continue
    const replyRow = row.reply_to_id ? byId.get(row.reply_to_id) : undefined
    const deleted = row.deleted_for_everyone === 1
    out.push({
      id: row.id,
      senderId: row.sender_id,
      body: deleted ? '' : row.body,
      mine: row.sender_id === userId,
      createdAt: row.created_at,
      deleted,
      readByPeer: !deleted && row.sender_id === userId && row.created_at <= peerLastRead,
      liked: liked.has(row.id),
      likes: likes.get(row.id) ?? 0,
      reactions: liked.has(row.id) ? ['❤'] : [],
      replyTo: replyRow
        ? {
            id: replyRow.id,
            senderId: replyRow.sender_id,
            body: replyRow.deleted_for_everyone ? t.dm.deletedPlaceholder : replyRow.body,
          }
        : null,
    })
  }
  return out
}

/** Kendi mesajlarımın okundu bilgisi (polling ile tazelenir). */
export function ownReadStates(ctx: Ctx, userId: string, conversationId: string): Record<string, boolean> {
  requireMembership(ctx, userId, conversationId)
  const peerId = otherMemberId(ctx, conversationId, userId)
  const peer = peerId ? memberOf(ctx, conversationId, peerId) : undefined
  const lastRead = peer?.last_read_at ?? 0
  const rows = ctx.db
    .prepare('SELECT id, created_at, deleted_for_everyone FROM messages WHERE conversation_id = ? AND sender_id = ?')
    .all(conversationId, userId) as unknown as Array<{ id: string; created_at: number; deleted_for_everyone: number }>
  const out: Record<string, boolean> = {}
  for (const row of rows) out[row.id] = row.deleted_for_everyone === 0 && row.created_at <= lastRead
  return out
}

/** Karşı tarafın profil bilgisi (sohbet başlığı). */
export function conversationPeer(ctx: Ctx, userId: string, conversationId: string): UserRow | null {
  if (!isMember(ctx, conversationId, userId)) return null
  const peerId = otherMemberId(ctx, conversationId, userId)
  return peerId ? getUserById(ctx, peerId) : null
}

/* -------------------------------------------------------------------------- */
/* Kullanıcı arama                                                            */
/* -------------------------------------------------------------------------- */

/** DM ekranındaki arama: kullanıcı adı veya görünen ad ile kullanıcı bulur. */
export function searchUsersForDm(ctx: Ctx, viewerId: string, query: string, limit = 12): UserRow[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  return ctx.db
    .prepare(
      `SELECT * FROM users
        WHERE deleted = 0 AND id != ?
          AND (username_lower LIKE ? OR LOWER(COALESCE(display_name, '')) LIKE ?)
        ORDER BY username_lower LIMIT ?`,
    )
    .all(viewerId, `%${q}%`, `%${q}%`, limit) as unknown as UserRow[]
}

/** Yönetim paneli / inceleme için: bildirilen mesajlar. */
export function reportedMessages(ctx: Ctx, limit = 50) {
  return ctx.db
    .prepare(
      `SELECT r.*, m.body AS message_body, m.conversation_id, u.username AS reporter
         FROM message_reports r
         JOIN messages m ON m.id = r.message_id
         JOIN users u ON u.id = r.reporter_id
        ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(limit)
}
