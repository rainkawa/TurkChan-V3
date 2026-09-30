import type { FC } from 'hono/jsx'
import { t } from '../i18n/tr'
import type { UserRow } from '../types'
import { profilePath, communityColor, communityInitials, relativeTime } from './helpers'
import { UserByline } from './rank'
import type { UserRank } from '../services/ranks'
import type { ConversationSummary, ThreadMessage } from '../services/dm'

/** Ortak avatar: yüklenmiş fotoğraf yoksa kullanıcı adından türetilen baş harfler. */
export const Avatar: FC<{ user: UserRow; size?: number; class?: string }> = ({
  user,
  size = 44,
  class: cls = '',
}) => (
  <span class={`dm-avatar ${cls}`.trim()} style={`--dm-size:${String(size)}px;--c-bg:${communityColor(user.username)}`}>
    {user.avatar_key ? <img src={`/media/${user.avatar_key}`} alt="" loading="lazy" /> : communityInitials(user.username)}
  </span>
)

/** Görünen ad: yoksa kullanıcı adı. */
const displayName = (user: UserRow) => user.display_name?.trim() || user.username

/* -------------------------------------------------------------------------- */
/* Gelen kutusu (sohbet listesi)                                             */
/* -------------------------------------------------------------------------- */

const ConversationRow: FC<{
  conversation: ConversationSummary
  ranks: Map<string, UserRank>
  now: number
  variant: 'main' | 'request' | 'archived'
}> = ({ conversation, ranks, now, variant }) => {
  const unread = conversation.unread > 0
  const preview = conversation.lastMessage || t.dm.noPreview
  return (
    <li
      class={`dm-row${unread ? ' is-unread' : ''}${conversation.online ? ' is-online' : ''}`}
      data-dm-conversation={conversation.id}
      data-unread={unread ? '1' : '0'}
    >
      <a class="dm-row-link" href={`/messages/${conversation.id}`}>
        <Avatar user={conversation.peer} size={48} />
        <span class="dm-row-main">
          <span class="dm-row-head">
            <UserByline
              username={conversation.peer.username}
              info={ranks.get(conversation.peer.id) ?? null}
              link={false}
              class="dm-row-name"
            />
            <time class="dm-row-time">{conversation.lastMessageAt ? relativeTime(conversation.lastMessageAt, now) : ''}</time>
          </span>
          <span class="dm-row-sub">
            <span class="dm-row-username">@{conversation.peer.username}</span>
            <span class="dm-row-preview">
              {conversation.lastMessageFromMe ? `${t.dm.you}: ` : ''}
              {conversation.lastMessageDeleted ? t.dm.deletedPlaceholder : preview}
            </span>
          </span>
        </span>
        {unread && <span class="dm-row-badge">{conversation.unread > 99 ? '99+' : conversation.unread}</span>}
        {variant === 'request' && (
          <form method="post" action={`/messages/${conversation.id}/accept`} class="dm-row-accept">
            <button class="btn small" type="submit">
              {t.dm.accept}
            </button>
          </form>
        )}
      </a>
      {/* Basılı tutma menüsü (JS'siz çalışan form düğmeleri de menüye bağlı) */}
      <div class="dm-row-menu" data-dm-menu hidden>
        <button class="dm-menu-item" type="button" data-dm-action={variant === 'archived' ? 'unarchive' : 'archive'}>
          {variant === 'archived' ? t.dm.actions.unarchiveChat : t.dm.actions.archiveChat}
        </button>
        <button class="dm-menu-item danger" type="button" data-dm-action="delete-chat">
          {t.dm.actions.deleteChat}
        </button>
      </div>
      <form method="post" action={`/messages/${conversation.id}/conversation`} class="dm-row-fallback" data-dm-fallback hidden>
        <input type="hidden" name="intent" value="archive" />
        <button class="btn secondary small" type="submit">
          {variant === 'archived' ? t.dm.actions.unarchiveChat : t.dm.actions.archiveChat}
        </button>
        <button class="btn secondary small" type="submit" name="intent" value="delete">
          {t.dm.actions.deleteChat}
        </button>
      </form>
    </li>
  )
}

const Section: FC<{
  title: string
  count?: number
  empty: string
  variant: 'main' | 'request' | 'archived'
  conversations: ConversationSummary[]
  ranks: Map<string, UserRank>
  now: number
  collapsible?: boolean
}> = ({ title, count, empty, variant, conversations, ranks, now, collapsible }) => (
  <section class={`dm-section dm-section-${variant}`} data-dm-section={variant}>
    <h2 class="dm-section-title">
      <span>{title}</span>
      {typeof count === 'number' && count > 0 && <span class="dm-section-count">{count}</span>}
      {collapsible && (
        <button class="dm-section-toggle" type="button" data-dm-toggle={variant} aria-expanded="true">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      )}
    </h2>
    {conversations.length === 0 ? (
      <p class="placeholder">{empty}</p>
    ) : (
      <ul class="dm-list">
        {conversations.map((c) => (
          <ConversationRow conversation={c} ranks={ranks} now={now} variant={variant} />
        ))}
      </ul>
    )}
  </section>
)

export const MessagesPage: FC<{
  list: { main: ConversationSummary[]; requests: ConversationSummary[]; archived: ConversationSummary[] }
  ranks: Map<string, UserRank>
  now: number
  query: string
  results: UserRow[]
  resultRanks: Map<string, UserRank>
  conversationId?: string
}> = ({ list, ranks, now, query, results, resultRanks }) => (
  <div class="dm-page" data-dm-page>
    <header class="dm-page-head">
      <h1 class="dm-title">{t.dm.title}</h1>
      <button class="icon-btn dm-search-open" type="button" data-dm-search-toggle aria-expanded={query ? 'true' : 'false'}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="m16 16 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
        <span class="visually-hidden">{t.dm.searchTitle}</span>
      </button>
    </header>

    <form class={`dm-search${query ? ' is-open' : ''}`} action="/messages" method="get" role="search" data-dm-search>
      <input
        type="search"
        name="q"
        value={query}
        placeholder={t.dm.searchPlaceholder}
        aria-label={t.dm.searchPlaceholder}
        autocomplete="off"
      />
      <button class="btn small" type="submit">
        {t.nav.search}
      </button>
    </form>

    {query && (
      <section class="dm-search-results">
        {query.length < 2 ? (
          <p class="placeholder">{t.dm.searchHint}</p>
        ) : results.length === 0 ? (
          <p class="placeholder">{t.dm.searchEmpty}</p>
        ) : (
          <ul class="dm-list">
            {results.map((u) => (
              <li class="dm-row">
                <form method="post" action="/messages/new" class="dm-row-link dm-row-form">
                  <input type="hidden" name="username" value={u.username} />
                  <Avatar user={u} size={48} />
                  <span class="dm-row-main">
                    <span class="dm-row-head">
                      <UserByline username={u.username} info={resultRanks.get(u.id) ?? null} link={false} class="dm-row-name" />
                    </span>
                    <span class="dm-row-sub">
                      <span class="dm-row-username">@{u.username}</span>
                    </span>
                  </span>
                  <span class="btn small">{t.dm.startChat}</span>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    )}

    <Section
      title={t.dm.sections.messages}
      count={list.main.length}
      empty={t.dm.empty}
      variant="main"
      conversations={list.main}
      ranks={ranks}
      now={now}
    />
    <Section
      title={t.dm.sections.requests}
      count={list.requests.length}
      empty={t.dm.emptyRequests}
      variant="request"
      conversations={list.requests}
      ranks={ranks}
      now={now}
      collapsible
    />
    <Section
      title={t.dm.sections.archive}
      count={list.archived.length}
      empty={t.dm.emptyArchive}
      variant="archived"
      conversations={list.archived}
      ranks={ranks}
      now={now}
      collapsible
    />
  </div>
)

/* -------------------------------------------------------------------------- */
/* Sohbet ekranı                                                              */
/* -------------------------------------------------------------------------- */

const TimeOfDay: FC<{ ms: number }> = ({ ms }) => {
  const d = new Date(ms)
  return (
    <time class="dm-bubble-time">
      {String(d.getUTCHours()).padStart(2, '0')}:{String(d.getUTCMinutes()).padStart(2, '0')}
    </time>
  )
}

const MessageBubble: FC<{ message: ThreadMessage; peer: UserRow }> = ({ message, peer }) => (
  <li
    class={`dm-bubble-row${message.mine ? ' is-mine' : ''}`}
    data-dm-message={message.id}
    data-dm-mine={message.mine ? '1' : '0'}
    data-deleted={message.deleted ? '1' : '0'}
    data-liked={message.liked ? '1' : '0'}
  >
    <div class="dm-bubble" data-dm-bubble>
      {!message.mine && <Avatar user={peer} size={30} class="dm-bubble-avatar" />}
      <div class="dm-bubble-body">
        {message.replyTo && !message.deleted && (
          <p class="dm-bubble-reply">
            <span class="dm-bubble-reply-name">{message.replyTo.senderId === peer.id ? displayName(peer) : t.dm.you}</span>
            <span class="dm-bubble-reply-text">{message.replyTo.body}</span>
          </p>
        )}
        {message.deleted ? (
          <p class="dm-bubble-text is-deleted">{t.dm.deletedPlaceholder}</p>
        ) : (
          <p class="dm-bubble-text">{message.body}</p>
        )}
        <span class="dm-bubble-meta">
          <TimeOfDay ms={message.createdAt} />
          {message.mine && !message.deleted && (
            <span class={`dm-bubble-read${message.readByPeer ? ' is-read' : ''}`} data-dm-read={message.readByPeer ? '1' : '0'}>
              <svg viewBox="0 0 20 20" aria-hidden="true" class="dm-tick dm-tick-single">
                <path d="m4 10.5 4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <svg viewBox="0 0 24 20" aria-hidden="true" class="dm-tick dm-tick-double">
                <path d="m1 10.5 4 4 8-9M9 10.5l4 4 8-9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span class="visually-hidden">{message.readByPeer ? t.dm.read : t.dm.sent}</span>
            </span>
          )}
        </span>
        {message.liked && (
          <span class="dm-bubble-like" data-dm-like>
            ❤ {message.likes > 1 ? message.likes : ''}
          </span>
        )}
      </div>
    </div>

    {/* Basılı tutma menüsü: JS'siz de kullanılabilir form düğmeleri */}
    <div class="dm-msg-menu" data-dm-menu hidden>
      <button class="dm-menu-item" type="button" data-dm-action="reply">
        {t.dm.actions.reply}
      </button>
      <button class="dm-menu-item" type="button" data-dm-action="like">
        {t.dm.actions.like}
      </button>
      <button class="dm-menu-item" type="button" data-dm-action="report">
        {t.dm.actions.report}
      </button>
      {message.mine && (
        <button class="dm-menu-item danger" type="button" data-dm-action="delete-everyone">
          {t.dm.actions.deleteEveryone}
        </button>
      )}
      <button class="dm-menu-item danger" type="button" data-dm-action="delete-self">
        {t.dm.actions.deleteSelf}
      </button>
    </div>
    <form method="post" action={`/messages/message/${message.id}`} class="dm-msg-fallback" data-dm-fallback hidden>
      <input type="hidden" name="intent" value="delete-self" />
      <button class="btn secondary small" type="submit">
        {t.dm.actions.deleteSelf}
      </button>
      {message.mine && (
        <button class="btn secondary small" type="submit" name="intent" value="delete-everyone">
          {t.dm.actions.deleteEveryone}
        </button>
      )}
      {!message.mine && !message.deleted && (
        <button class="btn secondary small" type="submit" name="intent" value="report">
          {t.dm.actions.report}
        </button>
      )}
    </form>
  </li>
)

export const ChatPage: FC<{
  conversationId: string
  peer: UserRow
  peerRank: UserRank | null
  messages: ThreadMessage[]
  now: number
  online: boolean
  typing: boolean
  draft: string
  replyTo: { id: string; body: string } | null
  error?: string
}> = ({ conversationId, peer, peerRank, messages, online, typing, draft, replyTo, error }) => (
  <div class="dm-chat" data-dm-chat data-conversation={conversationId}>
    <header class="dm-chat-head">
      <a class="icon-btn" href="/messages" aria-label={t.dm.title}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m14 6-6 6 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </a>
      <a class="dm-chat-person" href={profilePath(peer.username)}>
        <Avatar user={peer} size={40} />
        <span class="dm-chat-ident">
          <UserByline username={peer.username} info={peerRank} link={false} class="dm-chat-name" />
          <span class="dm-chat-username">@{peer.username}</span>
        </span>
      </a>
      <span class={`dm-presence${online ? ' is-online' : ''}`} data-dm-presence>
        {online ? t.dm.online : t.dm.offline}
      </span>
    </header>

    <p class={`dm-typing${typing ? ' is-typing' : ''}`} data-dm-typing hidden={!typing} aria-live="polite">
      {typing ? `${displayName(peer)} ${t.dm.typing}` : ''}
    </p>

    <ol class="dm-thread" data-dm-thread data-since={String(messages[messages.length - 1]?.createdAt ?? 0)}>
      {messages.length === 0 ? (
        <li class="placeholder">{t.dm.empty}</li>
      ) : (
        messages.map((m) => <MessageBubble message={m} peer={peer} />)
      )}
    </ol>

    {error && <p class="flash error">{error}</p>}

    {replyTo && (
      <div class="dm-reply-bar" data-dm-reply-bar>
        <span class="dm-reply-text">
          <span class="dm-reply-label">{t.dm.replyingTo}</span> {replyTo.body}
        </span>
        <input type="hidden" name="replyTo" value={replyTo.id} form="dm-composer" />
        <button class="icon-btn" type="button" data-dm-cancel-reply>
          <span class="visually-hidden">{t.dm.cancelReply}</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    )}

    <form class="dm-composer" id="dm-composer" method="post" action={`/messages/${conversationId}/send`} data-dm-composer>
      <textarea
        name="body"
        rows={1}
        placeholder={t.dm.placeholder}
        aria-label={t.dm.placeholder}
        maxlength={2000}
        data-dm-input
      >
        {draft}
      </textarea>
      <input type="hidden" name="replyTo" value={replyTo?.id ?? ''} data-dm-reply-input />
      <button class="btn dm-send" type="submit">
        {t.dm.send}
      </button>
    </form>
    <p class="dm-hint">{t.dm.hint.longPress} · {t.dm.hint.swipe} · {t.dm.hint.doubleTap}</p>
  </div>
)

/* -------------------------------------------------------------------------- */
/* Şikayet formu                                                             */
/* -------------------------------------------------------------------------- */

const REASONS: Array<{ value: string; label: string }> = [
  { value: 'harassment', label: t.dm.report.reasons.harassment },
  { value: 'spam', label: t.dm.report.reasons.spam },
  { value: 'nsfw', label: t.dm.report.reasons.nsfw },
  { value: 'other', label: t.dm.report.reasons.other },
]

export const ReportPage: FC<{
  messageId: string
  conversationId: string
  peer: UserRow
  body: string
  reason: string
  detail: string
}> = ({ messageId, conversationId, peer, body, reason, detail }) => (
  <div class="card form-narrow dm-report">
    <h2>{t.dm.report.title}</h2>
    <p class="hint">{t.dm.report.subtitle}</p>
    <blockquote class="dm-report-quote">
      <span class="dm-report-from">@{peer.username}</span>
      <p>{body}</p>
    </blockquote>
    <form method="post" action={`/messages/report/${messageId}`}>
      <input type="hidden" name="back" value={conversationId} />
      <fieldset class="report-reasons">
        <legend class="report-reasons-legend">{t.dm.report.reason}</legend>
        {REASONS.map((r) => (
          <label class="report-reason">
            <input type="radio" name="reason" value={r.value} checked={reason === r.value} required={r.value === 'other'} />
            {r.label}
          </label>
        ))}
      </fieldset>
      <div class="field">
        <label for="detail">{t.dm.report.detail}</label>
        <textarea id="detail" name="detail" maxlength={1000}>{detail}</textarea>
        <div class="hint">{t.dm.report.detailHint}</div>
      </div>
      <button class="btn" type="submit">{t.dm.report.submit}</button>{' '}
      <a class="btn secondary" href={`/messages/${conversationId}`}>{t.dm.back}</a>
    </form>
  </div>
)
