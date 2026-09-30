/**
 * Özel mesajlaşma (DM) rotaları.
 *
 *   GET  /messages                  gelen kutusu (mesajlar / istekler / arşiv) + kullanıcı arama (?q=)
 *   GET  /messages/new?u=           kullanıcı adından sohbet aç
 *   POST /messages/new              (arama sonucundan) sohbet aç
 *   GET  /messages/report/:id       mesaj şikayet formu
 *   POST /messages/report/:id       şikayeti kaydet
 *   POST /messages/message/:id      mesaj eylemleri (sil / beğen / şikayet)
 *   GET  /messages/:id              sohbet ekranı
 *   POST /messages/:id/send         mesaj gönder
 *   POST /messages/:id/accept       isteği kabul et
 *   POST /messages/:id/conversation sohbeti arşivle / arşivden çıkar / sil
 *
 * Uzun basma, kaydırarak yanıtlama ve çift dokunma etkileşimleri public/app.js
 * tarafından yönetilir; JS kapalıyken de her eylemin bir form karşılığı vardır.
 */
import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t } from '../i18n/tr'
import { Layout } from '../views/layout'
import { ChatPage, MessagesPage, ReportPage } from '../views/dm'
import { authorRanksFor } from '../services/users'
import { rankInfoFor } from '../services/ranks'
import { isOnline, isTyping, setTyping, touch } from '../services/presence'
import { AppError } from '../services/errors'
import { ValidationError } from '../lib/validation'
import {
  acceptRequest,
  conversationPeer,
  conversationWithUsername,
  deleteConversation,
  deleteMessage,
  getMessage,
  isMember,
  listConversations,
  markConversationRead,
  markVisibleConversationsRead,
  ownReadStates,
  reportMessage,
  searchUsersForDm,
  sendMessage,
  setArchived,
  thread,
  toggleReaction,
} from '../services/dm'
import { type AppEnv, dmUnread, formData, loginRedirect, setFlash, takeFlash, unread } from './helpers'

/** Gelen kutusunda aranacak tüm konuşmacılar (çevrimiçi rozeti için). */
function peerIdsFor(ctx: Ctx, userId: string): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT DISTINCT other.user_id AS id
           FROM conversation_members mine
           JOIN conversation_members other ON other.conversation_id = mine.conversation_id
          WHERE mine.user_id = ? AND other.user_id != ?`,
      )
      .all(userId, userId) as unknown as Array<{ id: string }>
  ).map((r) => r.id)
}

function onlinePeers(ctx: Ctx, userId: string): Set<string> {
  const now = ctx.now()
  const online = new Set<string>()
  for (const id of peerIdsFor(ctx, userId)) if (isOnline(id, now)) online.add(id)
  return online
}

export function dmRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  /* ---------------------------------------------------------------------- */
  /* Gelen kutusu                                                           */
  /* ---------------------------------------------------------------------- */

  app.get('/messages', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login?next=%2Fmessages')
    touch(viewer.id, ctx.now())

    const query = (c.req.query('q') ?? '').trim()
    const now = ctx.now()
    // Gelen kutusu açıldı: listelenen sohbetler okunmuş sayılır (server-side).
    // Rozet bundan SONRA hesaplanır; önce hesaplansaydı görüntülenen sayı
    // veritabanıyla uyuşmaz ve sayfa yenileyince rozet geri gelirdi.
    markVisibleConversationsRead(ctx, viewer.id)
    const list = listConversations(ctx, viewer.id, onlinePeers(ctx, viewer.id))
    const results = query ? searchUsersForDm(ctx, viewer.id, query) : []
    const resultRanks = authorRanksFor(ctx, results.map((u) => u.id))
    const rankPeers = list.main.concat(list.requests, list.archived).map((item) => item.peer.id)
    const ranks = authorRanksFor(ctx, rankPeers)

    return c.html(
      <Layout
        title={t.dm.title}
        viewer={viewer}
        unread={unread(ctx, viewer)}
        dmUnread={dmUnread(ctx, viewer)}
        flash={takeFlash(c)}
        active="messages"
      >
        <MessagesPage
          list={list}
          ranks={ranks}
          now={now}
          query={query}
          results={results}
          resultRanks={resultRanks}
        />
      </Layout>,
    )
  })

  /* ---------------------------------------------------------------------- */
  /* Yeni sohbet                                                            */
  /* ---------------------------------------------------------------------- */

  app.get('/messages/new', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const username = c.req.query('u') ?? ''
    if (!username.trim()) return c.redirect('/messages')
    try {
      const id = conversationWithUsername(ctx, viewer, username)
      return c.redirect(`/messages/${id}`)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      return c.redirect('/messages')
    }
  })

  app.post('/messages/new', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const body = await formData(c)
    const username = (body.username ?? '').trim()
    if (!username) return c.redirect('/messages')
    try {
      const id = conversationWithUsername(ctx, viewer, username)
      return c.redirect(`/messages/${id}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
      return c.redirect('/messages')
    }
  })

  /* ---------------------------------------------------------------------- */
  /* Şikayet                                                                */
  /* ---------------------------------------------------------------------- */

  app.get('/messages/report/:id', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    touch(viewer.id, ctx.now())
    const message = getMessage(ctx, c.req.param('id'))
    if (!message || !isMember(ctx, message.conversation_id, viewer.id)) {
      setFlash(c, 'error', t.dm.errors.messageNotFound)
      return c.redirect('/messages')
    }
    const peer = conversationPeer(ctx, viewer.id, message.conversation_id)
    if (!peer) return c.redirect('/messages')
    return c.html(
      <Layout
        title={t.dm.report.title}
        viewer={viewer}
        unread={unread(ctx, viewer)}
        dmUnread={dmUnread(ctx, viewer)}
        flash={takeFlash(c)}
      >
        <ReportPage
          messageId={message.id}
          conversationId={message.conversation_id}
          peer={peer}
          body={message.deleted_for_everyone === 1 ? t.dm.deletedPlaceholder : message.body}
          reason={c.req.query('reason') ?? ''}
          detail=""
        />
      </Layout>,
    )
  })

  app.post('/messages/report/:id', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const message = getMessage(ctx, c.req.param('id'))
    const form = await formData(c)
    const back = (form.back ?? '').startsWith('/messages/') ? (form.back as string) : '/messages'
    if (!message || !isMember(ctx, message.conversation_id, viewer.id)) {
      setFlash(c, 'error', t.dm.errors.messageNotFound)
      return c.redirect('/messages')
    }
    try {
      reportMessage(ctx, viewer.id, message.id, form.reason ?? '', form.detail ?? '')
      setFlash(c, 'ok', t.dm.report.done)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
    }
    return c.redirect(back)
  })

  /* ---------------------------------------------------------------------- */
  /* Mesaj eylemleri (basılı tutma menüsü / çift dokunma)                    */
  /* ---------------------------------------------------------------------- */

  app.post('/messages/message/:id', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const messageId = c.req.param('id')
    const form = await formData(c)
    const intent = form.intent ?? 'delete-self'
    const message = getMessage(ctx, messageId)
    const back = message && form.back === message.conversation_id ? `/messages/${message.conversation_id}` : '/messages'
    try {
      if (intent === 'delete-everyone') {
        deleteMessage(ctx, viewer.id, messageId, 'everyone')
        setFlash(c, 'ok', t.dm.messageDeleted)
      } else if (intent === 'report') {
        setFlash(c, 'ok', t.dm.report.done)
        return c.redirect(`/messages/report/${messageId}`)
      } else {
        deleteMessage(ctx, viewer.id, messageId, 'self')
        setFlash(c, 'ok', t.dm.deletedForYou)
      }
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
    }
    return c.redirect(back)
  })

  /* ---------------------------------------------------------------------- */
  /* Sohbet ekranı                                                          */
  /* ---------------------------------------------------------------------- */

  app.get('/messages/:id', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login?next=%2Fmessages')
    const conversationId = c.req.param('id')
    const now = ctx.now()
    touch(viewer.id, now)

    const peer = conversationPeer(ctx, viewer.id, conversationId)
    if (!peer) {
      setFlash(c, 'error', t.dm.notFound)
      return c.redirect('/messages')
    }

    // Sohbeti açmak okundu sayılır.
    markConversationRead(ctx, viewer.id, conversationId)

    const replyParam = c.req.query('reply')
    const replyRow = replyParam ? getMessage(ctx, replyParam) : null
    const replyTo =
      replyRow && replyRow.conversation_id === conversationId
        ? { id: replyRow.id, body: replyRow.deleted_for_everyone === 1 ? t.dm.deletedPlaceholder : replyRow.body }
        : null

    const messages = thread(ctx, viewer.id, conversationId)
    const peerRanks = rankInfoFor(ctx, [peer])

    return c.html(
      <Layout
        title={`${t.dm.title} · @${peer.username}`}
        viewer={viewer}
        unread={unread(ctx, viewer)}
        dmUnread={dmUnread(ctx, viewer)}
        flash={takeFlash(c)}
        active="messages"
        immersive
      >
        <ChatPage
          conversationId={conversationId}
          peer={peer}
          peerRank={peerRanks.get(peer.id) ?? null}
          messages={messages}
          now={now}
          online={isOnline(peer.id, now)}
          typing={isTyping(conversationId, peer.id, now)}
          draft={c.req.query('draft') ?? ''}
          replyTo={replyTo}
        />
      </Layout>,
    )
  })

  app.post('/messages/:id/send', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const conversationId = c.req.param('id')
    touch(viewer.id, ctx.now())
    const form = await formData(c)
    try {
      sendMessage(ctx, viewer, conversationId, form.body ?? '', form.replyTo ?? null)
      setTyping(conversationId, viewer.id, false, ctx.now())
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
      } else {
        throw err
      }
    }
    return c.redirect(`/messages/${conversationId}`)
  })

  app.post('/messages/:id/accept', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const conversationId = c.req.param('id')
    try {
      acceptRequest(ctx, viewer.id, conversationId)
      setFlash(c, 'ok', t.dm.requestAccepted)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
    }
    return c.redirect('/messages')
  })

  app.post('/messages/:id/conversation', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const conversationId = c.req.param('id')
    const form = await formData(c)
    const intent = form.intent ?? 'archive'
    try {
      if (intent === 'delete') {
        deleteConversation(ctx, viewer.id, conversationId)
        setFlash(c, 'ok', t.dm.chatDeleted)
      } else if (intent === 'unarchive') {
        setArchived(ctx, viewer.id, conversationId, false)
        setFlash(c, 'ok', t.dm.chatUnarchived)
      } else {
        setArchived(ctx, viewer.id, conversationId, true)
        setFlash(c, 'ok', t.dm.chatArchived)
      }
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
    }
    return c.redirect('/messages')
  })

  /* ---------------------------------------------------------------------- */
  /* JSON uçları (public/app.js yoklaması)                                   */
  /* ---------------------------------------------------------------------- */

  /** Sohbeti yokla: yeni mesajlar, okundu bilgisi, çevrimiçi/yazıyor durumu. */
  app.get('/api/dm/thread', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.json({ error: t.dm.errors.loginRequired }, 401)
    const now = ctx.now()
    touch(viewer.id, now)
    const conversationId = c.req.query('conversation') ?? ''
    if (!isMember(ctx, conversationId, viewer.id)) return c.json({ error: t.dm.errors.notAMember }, 403)
    const since = Number(c.req.query('since') ?? '0') || 0
    // Sekme görünür durumda ise açık sohbeti okundu say.
    if (c.req.query('read') === '1' && isMember(ctx, conversationId, viewer.id)) {
      markConversationRead(ctx, viewer.id, conversationId)
    }
    const peer = conversationPeer(ctx, viewer.id, conversationId)
    const messages = thread(ctx, viewer.id, conversationId, since)
    return c.json({
      messages,
      reads: ownReadStates(ctx, viewer.id, conversationId),
      unread: messages.filter((m) => !m.mine).length,
      online: peer ? isOnline(peer.id, now) : false,
      typing: peer ? isTyping(conversationId, peer.id, now) : false,
      now,
    })
  })

  /** "Yazıyor" göstergesi. */
  app.post('/api/dm/typing', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.json({ error: t.dm.errors.loginRequired }, 401)
    const now = ctx.now()
    touch(viewer.id, now)
    const body = (await c.req.json().catch(() => ({}))) as { conversation?: string; typing?: boolean }
    const conversationId = typeof body.conversation === 'string' ? body.conversation : ''
    if (!isMember(ctx, conversationId, viewer.id)) return c.json({ error: t.dm.errors.notAMember }, 403)
    setTyping(conversationId, viewer.id, body.typing === true, now)
    return c.json({ typing: body.typing === true })
  })

  /** Çift dokunma: beğen. */
  app.post('/api/dm/like', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.json({ error: t.dm.errors.loginRequired }, 401)
    touch(viewer.id, ctx.now())
    const body = (await c.req.json().catch(() => ({}))) as { messageId?: string }
    if (typeof body.messageId !== 'string' || !body.messageId) throw new AppError(400, 'bad_request', t.dm.errors.messageNotFound)
    const result = toggleReaction(ctx, viewer.id, body.messageId)
    return c.json(result)
  })

  return app
}
