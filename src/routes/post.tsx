import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Ctx } from '../context'
import { t } from '../i18n/tr'
import { Layout } from '../views/layout'
import { CommentTreeView, Markdown, VoteRail, CommunityAvatar } from '../views/components'
import { getPostForViewer, editPostBody, deletePost, getPost, updatePostMeta } from '../services/posts'
import { listFlairs } from '../services/flairs'
import { listPostMedia } from '../services/posts'
import { postStats, recordView } from '../services/stats'
import { canSeeThread, setThreadFlag, threadState } from '../services/threads'
import { MediaGallery, SingleMedia } from '../views/components'
import {
  createComment,
  editComment,
  deleteComment,
  getComment,
  getCommentTree,
  parseCommentSort as parseCommentSortRaw,
  type CommentNode,
  type CommentSort,
} from '../services/comments'
import { getMyVotes } from '../services/votes'
import { createReport } from '../services/reports'
import { listRules } from '../services/communities'
import { isModerator, getCommunityById, canReadCommunity } from '../services/access'
import { AppError, notFound } from '../services/errors'
import { ValidationError } from '../lib/validation'
import { relativeTime, formatDate } from '../views/helpers'
import { embedSrcFor } from '../lib/media'

/** Kırık bağlantılarda detay sayfasının patlamaması için güvenli alan adı. */
function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}
import { UserByline } from '../views/rank'
import { authorRanksFor } from '../services/users'
import { isAdminPower } from '../services/ranks'
import { type AppEnv, dmUnread, formData, loginRedirect, safeNext, setFlash, takeFlash, unread } from './helpers'

function parseCommentSort(raw: string | undefined): CommentSort {
  return parseCommentSortRaw(raw)
}

function collectIds(nodes: CommentNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.comment.id)
    collectIds(node.children, out)
  }
  return out
}

/** Yorum ağacındaki tüm yazar kimlikleri (rozet çözümü için). */
function collectAuthorIds(nodes: CommentNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.comment.author_id)
    collectAuthorIds(node.children, out)
  }
  return out
}

export function postRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const renderPostPage = (c: Context<AppEnv, string>, highlightCommentId: string | null) => {
    const viewer = c.get('viewer')
    const postId = c.req.param('postId') as string
    const view = getPostForViewer(ctx, viewer, postId)
    const sort = parseCommentSort(c.req.query('sort'))
    const tree = getCommentTree(ctx, viewer, postId, sort)
    const ids = collectIds(tree)
    const myVotes = getMyVotes(ctx, viewer, 'comment', ids)
    const myPostVote = getMyVotes(ctx, viewer, 'post', [postId]).get(postId) ?? 0
    // Yazar ve yorum yazarlarının rütbe/rozetleri tek toplu sorguda çözülür.
    const authorRanks = authorRanksFor(ctx, [view.post.author_id, ...collectAuthorIds(tree)])
    const now = ctx.now()
    const { post, community, authorUsername, contentHidden } = view
    const authorRank = authorRanks.get(post.author_id) ?? null
    // Arşivlenmiş thread yalnızca moderatörlere/yöneticilere açıktır.
    if (!canSeeThread(ctx, viewer, post)) throw notFound(t.errors.notFoundBody)
    const isMod = isModerator(ctx, viewer, community.id)
    const postFlairs = listFlairs(ctx, community.id)
    const media = listPostMedia(ctx, postId)
    const stats = postStats(ctx, post)
    const thread = threadState(ctx, post)
    // Görüntülenmeyi yalnızca erişebilen kullanıcılar için say.
    if (contentHidden === null) {
      recordView(ctx, post, viewer, c.req.header('x-forwarded-for') ?? null)
    }
    const postFlair = post.flair_id ? postFlairs.find((f) => f.id === post.flair_id) ?? null : null
    // Thread modunda her yanıt bir önceki yanıtı alıntılar.
    const byThreadNo = new Map<number, string>()
    for (const node of tree) {
      if (node.comment.thread_no) byThreadNo.set(node.comment.thread_no, node.comment.body)
    }
    const quoteFor = (node: CommentNode): string | null => {
      if (!thread.isThread || !node.comment.thread_no || node.comment.thread_no <= 1) return null
      const prev = byThreadNo.get(node.comment.thread_no - 1)
      return prev ? prev.slice(0, 160) : null
    }
    const isOwn = viewer?.id === post.author_id
    // Kilitli thread'e yanıt verilemez.
    const canReply = Boolean(viewer) && !community.archived && contentHidden === null && thread.canReply
    const hideMinutes = community.hide_comment_scores_minutes
    const scoreHidden = (createdAt: number) => hideMinutes > 0 && now - createdAt < hideMinutes * 60 * 1000

    // Gövde tüm gönderi türlerinde markdown olarak çizilir; bağlantı önizlemesi
    // ve medya ayrı bloklarda, gövdenin altında gösterilir.
    const bodyBlock =
      contentHidden === 'deleted' ? (
        <p class="placeholder">{t.post.deletedBody}</p>
      ) : contentHidden === 'removed' ? (
        <p class="placeholder">{t.post.removedBody}</p>
      ) : contentHidden === 'pending_review' ? (
        <p class="placeholder">{t.post.pendingReview}</p>
      ) : post.body ? (
        <Markdown source={post.body} />
      ) : null

    // Bağlantı önizleme kartı (gövde olmasa da görünür).
    const linkBlock =
      contentHidden === null && post.type === 'link' && post.url ? (
        <a class="link-preview" href={post.url} rel="nofollow noopener">
          {post.link_preview_title ?? post.url}
          <div class="hint">{safeHost(post.url)}</div>
        </a>
      ) : null

    // Gönderiye eklenmiş çoklu medya (varsa eski image_key yolunun üstünde).
    const mediaBlock =
      contentHidden !== null ? null : media.length > 0 ? (
        <MediaGallery items={media.map((m) => ({ key: m.media_key, kind: m.kind, mime: m.mime }))} title={post.title} />
      ) : post.type === 'image' && post.image_key ? (
        <SingleMedia
          key={post.image_key}
          kind={post.media_kind === 'video' ? 'video' : post.media_kind === 'gif' ? 'gif' : 'image'}
        />
      ) : null

    const linkPreviewBlock = contentHidden === null ? linkBlock : null

    // Spoiler gönderilerde içerik "Göster" düğmesine kadar gizlenir.
    const renderedBody =
      post.spoiler === 1 && contentHidden === null ? (
        <div class="post-spoiler" data-spoiler="1">
          <button class="spoiler-reveal" type="button" data-spoiler-toggle aria-expanded="false">
            <span class="spoiler-hint">{t.feed.spoilerHidden}</span>
            <span class="spoiler-cta">{t.feed.spoilerReveal}</span>
          </button>
          <div class="spoiler-body" hidden>
            {bodyBlock}
            {linkPreviewBlock}
            {mediaBlock}
            {post.type === 'link' && post.url && (
              <div class="social-card-media is-embed">
                {embedSrcFor(post.url) ? (
                  <iframe
                    src={embedSrcFor(post.url) as string}
                    title={post.title}
                    loading="lazy"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                    allowfullscreen
                    referrerpolicy="strict-origin-when-cross-origin"
                  />
                ) : post.url.endsWith('.mp4') || post.url.endsWith('.webm') ? (
                  <video src={post.url} controls preload="none" playsinline />
                ) : null}
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {bodyBlock}
          {linkPreviewBlock}
          {mediaBlock}
          {post.type === 'link' && post.url && embedSrcFor(post.url) && (
            <div class="social-card-media is-embed">
              <iframe
                src={embedSrcFor(post.url) as string}
                title={post.title}
                loading="lazy"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
                allowfullscreen
                referrerpolicy="strict-origin-when-cross-origin"
              />
            </div>
          )}
        </>
      )

    return c.html(
      <Layout
        title={contentHidden ? t.errors.notFoundTitle : post.title}
        viewer={viewer}
        unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)}
        flash={takeFlash(c)}
        og={
          contentHidden
            ? undefined
            : {
                title: post.title,
                description: `c/${community.name} · ${post.score} ${t.common.points} · ${post.comment_count} ${t.feed.comments}`,
                image: post.type === 'image' && post.image_key ? `${ctx.config.baseUrl}/media/${post.image_key}` : post.link_preview_image,
                url: `${ctx.config.baseUrl}/c/${community.name}/comments/${post.id}`,
              }
        }
      >
        <article class="social-card post-detail">
          {/* Kompakt üst satır: topluluk · kullanıcı · zaman · üç nokta */}
          <header class="social-card-head">
            <a class="social-card-community" href={`/c/${community.name}`}>
              <CommunityAvatar name={community.name} />
              <span class="social-card-community-meta">
                <span class="social-card-community-name">c/{community.name}</span>
                <span class="social-card-time">
                  {authorUsername ? (
                    post.is_anonymous === 1 ? (
                      <span class="anon-author" title={t.post.anonymousHint}>
                        {t.post.anonByline} · <b>{post.anon_name}</b>
                      </span>
                    ) : (
                      <UserByline username={authorUsername} info={authorRank} link={false} />
                    )
                  ) : (
                    t.post.deletedBody
                  )}
                  {' · '}
                  {relativeTime(post.created_at, now)}
                  {post.edited_at !== null ? ` · (${t.post.edited})` : ''}
                </span>
              </span>
            </a>
            <div class="social-card-head-actions">
              <details class="overflow-menu">
                <summary aria-label={t.card.more} title={t.card.more}>
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="5" cy="12" r="2" fill="currentColor" />
                    <circle cx="12" cy="12" r="2" fill="currentColor" />
                    <circle cx="19" cy="12" r="2" fill="currentColor" />
                  </svg>
                </summary>
                <div class="overflow-panel">
                  {isOwn && contentHidden === null && post.type === 'text' && (
                    <a href={`/posts/${post.id}/edit`}>{t.post.edit}</a>
                  )}
                  {isOwn && contentHidden === null && (
                    <form method="post" action={`/posts/${post.id}/delete`} data-confirm={t.post.deleteConfirm}>
                      <button class="danger-link" type="submit">{t.post.delete}</button>
                    </form>
                  )}
                  {viewer && !isOwn && contentHidden === null && <a href={`/report/post/${post.id}`}>{t.card.report}</a>}
                  <button type="button" data-share={`/c/${community.name}/comments/${post.id}`}>{t.card.share}</button>
                  {contentHidden === null && (
                    <button type="button" data-save-post={post.id} data-save-title={post.title}
                      data-save-href={`/c/${community.name}/comments/${post.id}`} data-save-community={community.name}>
                      {t.card.save}
                    </button>
                  )}
                  {/* Moderasyon seçenekleri yalnızca yetkiliye görünür. */}
                  {isMod && contentHidden === null && (
                    <>
                      <form method="post" action={`/mod/remove/post/${post.id}`} data-confirm={t.post.removePostConfirm}>
                        <button class="danger-link" type="submit">{t.common.remove}</button>
                      </form>
                      {post.pinned_at === null ? (
                        <form method="post" action={`/posts/${post.id}/pin`}>
                          <button type="submit">{t.common.pin}</button>
                        </form>
                      ) : (
                        <form method="post" action={`/posts/${post.id}/unpin`}>
                          <button type="submit">{t.common.unpin}</button>
                        </form>
                      )}
                    </>
                  )}
                  {isAdminPower(viewer) && contentHidden === 'removed' && (
                    <form method="post" action={`/mod/restore/post/${post.id}`}>
                      <button type="submit">{t.common.restore}</button>
                    </form>
                  )}
                </div>
              </details>
            </div>
          </header>

          {post.pinned_at !== null && <span class="pin-tag">📌 {t.feed.pinned}</span>}

          {postFlair && contentHidden === null && (
            <a
              class={`post-flair${postFlair.color ? ' has-color' : ''}`}
              href={`/c/${community.name}?flair=${encodeURIComponent(postFlair.id)}`}
              style={postFlair.color ? `--flair-bg:${postFlair.color}` : undefined}
            >
              {postFlair.name}
            </a>
          )}

          {(isOwn || isMod) && contentHidden === null && (
            <form method="post" action={`/posts/${post.id}/meta`} class="post-meta-form">
              <input type="hidden" name="back" value={`/c/${community.name}/comments/${post.id}`} />
              <label class="checkbox">
                <input type="checkbox" name="spoiler" value="1" checked={post.spoiler === 1} />
                <span>{t.feed.spoilerHidden}</span>
              </label>
              {postFlairs.length > 0 && (
                <select name="flairId" aria-label={t.feed.flairPick}>
                  <option value="">{t.feed.flairNone}</option>
                  {postFlairs.map((f) => (
                    <option value={f.id} selected={post.flair_id === f.id}>{f.name}</option>
                  ))}
                </select>
              )}
              <button class="btn secondary small" type="submit">{t.post.save}</button>
            </form>
          )}

          <h1 class="post-detail-title">
            {contentHidden === 'removed'
              ? t.post.removedBody
              : contentHidden === 'deleted'
                ? t.post.deletedBody
                : post.title}
          </h1>

          {/* Anonim / thread rozetleri */}
          <div class="post-badges">
            {post.is_anonymous === 1 && (
              <span class="post-badge anon" title={t.post.anonymousHint}>
                🕶 {t.post.anonByline} · <b>{post.anon_name}</b>
              </span>
            )}
            {thread.isThread && (
              <span class="post-badge thread" title={t.thread.modeHint}>
                🧵 {t.thread.mode} · {post.reply_count} {t.thread.replies}
                {post.bump_count > 0 && ` · ${post.bump_count} ${t.thread.bumps}`}
              </span>
            )}
            {thread.sticky && <span class="post-badge sticky" title={t.thread.stickyHint}>📌 {t.thread.sticky}</span>}
            {thread.locked && <span class="post-badge locked" title={t.thread.lockedHint}>🔒 {t.thread.locked}</span>}
            {thread.archived && <span class="post-badge archived" title={t.thread.archivedHint}>🗄 {t.thread.archived}</span>}
          </div>

          {/* Kimlik, kalıcı bağlantı, tarihler ve istatistik */}
          <div class="post-meta-bar">
            <div class="post-meta-row">
              <span class="post-meta-item" title={t.post.permalink}>
                🔗 <code class="post-id">{post.id}</code>
              </span>
              <button class="btn ghost small" type="button" data-copy={post.id} data-copied-label={t.post.copied}>
                {t.post.copyId}
              </button>
              <button class="btn ghost small" type="button" data-share={`/p/${post.id}`}>
                {t.post.permalink}
              </button>
            </div>
            <div class="post-meta-row">
              <span class="post-meta-item">📅 {t.post.createdAt}: <time datetime={new Date(post.created_at).toISOString()}>{formatDate(post.created_at)}</time></span>
              <span class="post-meta-item">
                ✏️ {t.post.editedAt}:{' '}
                {post.edited_at !== null
                  ? <time datetime={new Date(post.edited_at).toISOString()}>{formatDate(post.edited_at)}</time>
                  : t.post.notEdited}
              </span>
            </div>
            <div class="post-meta-row stats">
              <span class="post-meta-item">👁 {stats.views} {t.post.views}</span>
              <span class="post-meta-item">🧑 {stats.uniqueViewers} {t.post.uniqueViewers}</span>
              <span class="post-meta-item">💬 {stats.comments} {t.feed.comments}</span>
              <span class="post-meta-item">▲ {stats.upvotes} ▼ {stats.downvotes}</span>
            </div>
          </div>

          <div class="post-detail-body">{renderedBody}</div>

          {/* Aksiyonlar: oy, yorum, paylaş, kaydet — dikey öncelikli düzen */}
          <div class="social-card-actions post-detail-actions">
            <VoteRail
              targetType="post"
              targetId={post.id}
              score={post.score}
              myVote={myPostVote}
              guest={!viewer}
              disabled={isOwn || contentHidden !== null}
              layout="horizontal"
            />
            <a class="action-btn" href="#comments">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              </svg>
              <span>{post.comment_count} {t.feed.comments}</span>
            </a>
            <button class="action-btn" type="button" data-share={`/c/${community.name}/comments/${post.id}`}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 15V4m0 0L8 8m4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <span>{t.card.share}</span>
            </button>
            {contentHidden === null && (
              <button class="action-btn" type="button" data-save-post={post.id} data-save-title={post.title}
                data-save-href={`/c/${community.name}/comments/${post.id}`} data-save-community={community.name}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M7 4h10v16l-5-4-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                </svg>
                <span data-save-label>{t.card.save}</span>
              </button>
            )}
          </div>
        </article>

        {/* Thread uyarısı ve yönetici kontrolleri */}
        {thread.isThread && contentHidden === null && (
          <div class={`thread-banner${thread.locked ? ' is-locked' : ''}`}>
            <div class="thread-banner-text">
              <strong>🧵 {t.thread.mode}</strong> — {t.thread.modeHint}
              <span class="thread-counts">
                {post.reply_count} {t.thread.replies} · {post.bump_count} {t.thread.bumps}
              </span>
              {post.bumped_at !== null && (
                <span class="thread-bumped">{t.thread.bumps}: {relativeTime(post.bumped_at, now)}</span>
              )}
            </div>
            {thread.locked && <p class="thread-locked-note">🔒 {t.thread.lockedHint}</p>}
            {isMod && (
              <div class="thread-controls">
                <form method="post" action={`/posts/${post.id}/thread`} style="display:inline">
                  <input type="hidden" name="action" value={thread.sticky ? 'unsticky' : 'sticky'} />
                  <input type="hidden" name="back" value={`/c/${community.name}/comments/${post.id}`} />
                  <button class="btn secondary small" type="submit">{thread.sticky ? t.thread.unpin : t.thread.pin}</button>
                </form>
                <form method="post" action={`/posts/${post.id}/thread`} style="display:inline">
                  <input type="hidden" name="action" value={thread.locked ? 'unlock' : 'lock'} />
                  <input type="hidden" name="back" value={`/c/${community.name}/comments/${post.id}`} />
                  <button class="btn secondary small" type="submit">{thread.locked ? t.thread.unlock : t.thread.lock}</button>
                </form>
                {isAdminPower(viewer) && (
                  <form method="post" action={`/posts/${post.id}/thread`} style="display:inline">
                    <input type="hidden" name="action" value={thread.archived ? 'unarchive' : 'archive'} />
                    <input type="hidden" name="back" value={`/c/${community.name}/comments/${post.id}`} />
                    <button class="btn secondary small" type="submit">
                      {thread.archived ? t.thread.unarchive : t.thread.archive}
                    </button>
                  </form>
                )}
              </div>
            )}
          </div>
        )}

        <div class="comments-block" id="comments">
          <div class="sort-tabs">
            {(['best', 'top', 'new'] as const).map((s) => (
              <a href={`/c/${community.name}/comments/${post.id}?sort=${s}`} class={sort === s ? 'active' : ''}>
                {s === 'best' ? t.feed.best : s === 'new' ? t.feed.new : t.feed.hot}
              </a>
            ))}
          </div>
          {canReply ? (
            <form class="comment-form" method="post" action={`/c/${community.name}/comments/${post.id}/comment`} id="reply">
              {highlightCommentId && <input type="hidden" name="parentId" value={highlightCommentId} />}
              {highlightCommentId && (
                <p class="hint">
                  {t.post.replyingTo}{' '}
                  <a href={`/c/${community.name}/comments/${post.id}`}>{t.post.commentOnPostInstead}</a>
                </p>
              )}
              <div class="field">
                <textarea name="body" placeholder={t.comment.placeholder} required maxlength={10000}></textarea>
              </div>
              <button class="btn" type="submit">{t.comment.submit}</button>
            </form>
          ) : !viewer ? (
            <p>
              <a class="btn" href={`/login?next=${encodeURIComponent(`/c/${community.name}/comments/${post.id}`)}`}>{t.comment.loginToComment}</a>
            </p>
          ) : null}
          <CommentTreeView
            nodes={tree}
            now={now}
            viewer={viewer}
            myVotes={myVotes}
            communityName={community.name}
            postId={post.id}
            canReply={canReply}
            isMod={isMod}
            authorRanks={authorRanks}
            scoreHidden={scoreHidden}
            highlightId={highlightCommentId}
            threadMode={thread.isThread}
            quoteOf={(node) => quoteFor(node)}
          />
        </div>
      </Layout>,
    )
  }

  app.get('/c/:name/comments/:postId', (c) => renderPostPage(c, null))

  /** Kısa kalıcı bağlantı: /p/:id */
  app.get('/p/:id', (c) => {
    const post = getPost(ctx, c.req.param('id'))
    if (!post) return c.notFound()
    const community = getCommunityById(ctx, post.community_id)
    if (!community) return c.notFound()
    // Arşivlenmiş thread yalnızca moderatörlere açık.
    if (!canSeeThread(ctx, c.get('viewer'), post)) return c.notFound()
    return c.redirect(`/c/${community.name}/comments/${post.id}`, 301)
  })

  /** Thread yönetimi: sabitle / kilitle / arşivle. */
  app.post('/posts/:id/thread', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const body = await formData(c)
    const action = body.action ?? ''
    const map: Record<string, 'thread_sticky' | 'thread_locked' | 'thread_archived'> = {
      sticky: 'thread_sticky',
      unsticky: 'thread_sticky',
      lock: 'thread_locked',
      unlock: 'thread_locked',
      archive: 'thread_archived',
      unarchive: 'thread_archived',
    }
    const flag = map[action]
    if (!flag) {
      setFlash(c, 'error', t.errors.genericBody)
      return c.redirect('/')
    }
    try {
      setThreadFlag(ctx, viewer, c.req.param('id'), flag, action === 'sticky' || action === 'lock' || action === 'archive')
      setFlash(c, 'ok', t.settings.saved)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(body.back ? safeNext(body.back) : '/')
  })

  /** Permalink view: highlight the comment; render its ancestor context (US-019). */
  app.get('/c/:name/comments/:postId/comment/:commentId', (c) => {
    const comment = getComment(ctx, c.req.param('commentId'))
    if (!comment || comment.post_id !== c.req.param('postId')) {
      throw notFound(t.errors.notFoundBody)
    }
    return renderPostPage(c, comment.id)
  })

  app.post('/c/:name/comments/:postId/comment', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const postId = c.req.param('postId')
    const name = c.req.param('name')
    const body = await formData(c)
    try {
      const comment = createComment(ctx, viewer, postId, {
        body: body.body ?? '',
        parentId: body.parentId || null,
      })
      return c.redirect(`/c/${name}/comments/${postId}/comment/${comment.id}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/c/${name}/comments/${postId}`)
      }
      throw err
    }
  })

  app.get('/posts/:id/edit', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const post = getPost(ctx, c.req.param('id'))
    if (!post || post.deleted || post.author_id !== viewer.id) throw notFound()
    const community = getCommunityById(ctx, post.community_id)
    return c.html(
      <Layout title={t.post.edit} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card">
          <h2>{t.post.editingPost}: {post.title}</h2>
          <form method="post" action={`/posts/${post.id}/edit`}>
            <div class="field">
              <label for="body">{t.post.body}</label>
              <textarea id="body" name="body" maxlength={40000} rows={10}>{post.body ?? ''}</textarea>
            </div>
            <button class="btn" type="submit">{t.post.save}</button>
            {' '}
            <a class="btn secondary" href={`/c/${community?.name}/comments/${post.id}`}>{t.common.cancel}</a>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/posts/:id/edit', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const body = await formData(c)
    try {
      const post = editPostBody(ctx, viewer, c.req.param('id'), body.body ?? '')
      const community = getCommunityById(ctx, post.community_id)
      return c.redirect(`/c/${community?.name}/comments/${post.id}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/posts/${c.req.param('id')}/edit`)
      }
      throw err
    }
  })

  /** Gönderinin spoiler/etiket bilgisini günceller (yazar veya moderatör). */
  app.post('/posts/:id/meta', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const body = await formData(c)
    try {
      updatePostMeta(ctx, viewer, c.req.param('id'), {
        spoiler: body.spoiler === '1',
        flairId: (body.flairId ?? '') === '' ? null : body.flairId ?? null,
      })
      setFlash(c, 'ok', t.feed.flairSaved)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(body.back ? safeNext(body.back) : '/')
  })

  app.post('/posts/:id/delete', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const post = getPost(ctx, c.req.param('id'))
    try {
      deletePost(ctx, viewer, c.req.param('id'))
      setFlash(c, 'ok', t.post.postDeleted)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    const community = post ? getCommunityById(ctx, post.community_id) : null
    return c.redirect(community ? `/c/${community.name}` : '/')
  })

  app.get('/comments/:id/edit', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const comment = getComment(ctx, c.req.param('id'))
    if (!comment || comment.deleted || comment.author_id !== viewer.id) throw notFound()
    const post = getPost(ctx, comment.post_id)
    const community = post ? getCommunityById(ctx, post.community_id) : null
    return c.html(
      <Layout title={t.post.edit} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card">
          <h2>{t.post.editingComment}</h2>
          <form method="post" action={`/comments/${comment.id}/edit`}>
            <div class="field">
              <textarea name="body" maxlength={10000} rows={6} required>{comment.body}</textarea>
            </div>
            <button class="btn" type="submit">{t.post.save}</button>
            {' '}
            <a class="btn secondary" href={`/c/${community?.name}/comments/${comment.post_id}/comment/${comment.id}`}>{t.common.cancel}</a>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/comments/:id/edit', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const body = await formData(c)
    try {
      const comment = editComment(ctx, viewer, c.req.param('id'), body.body ?? '')
      const post = getPost(ctx, comment.post_id)
      const community = post ? getCommunityById(ctx, post.community_id) : null
      return c.redirect(`/c/${community?.name}/comments/${comment.post_id}/comment/${comment.id}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/comments/${c.req.param('id')}/edit`)
      }
      throw err
    }
  })

  app.post('/comments/:id/delete', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const comment = getComment(ctx, c.req.param('id'))
    const post = comment ? getPost(ctx, comment.post_id) : null
    const community = post ? getCommunityById(ctx, post.community_id) : null
    try {
      deleteComment(ctx, viewer, c.req.param('id'))
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(post && community ? `/c/${community.name}/comments/${post.id}` : '/')
  })

  app.get('/report/:type/:id', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const type = c.req.param('type') === 'comment' ? 'comment' : 'post'
    const targetId = c.req.param('id')
    const target = type === 'post' ? getPost(ctx, targetId) : getComment(ctx, targetId)
    if (!target || target.deleted) throw notFound()
    const communityId = type === 'post'
      ? (target as { community_id: string }).community_id
      : (getPost(ctx, (target as { post_id: string }).post_id) as { community_id: string }).community_id
    const community = getCommunityById(ctx, communityId)
    if (!community || !canReadCommunity(ctx, viewer, community)) throw notFound()
    const rules = listRules(ctx, community.id)
    return c.html(
      <Layout title={t.report.title} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.report.title}</h2>
          <p class="hint">{t.report.subtitle}</p>
          <form method="post" action={`/report/${type}/${targetId}`}>
            <fieldset class="report-reasons">
              <legend class="report-reasons-legend">{t.report.reason}</legend>
              {rules.map((rule) => (
                <label class="report-reason">
                  <input type="radio" name="reason" value={`rule:${rule.id}`} /> {rule.title}
                </label>
              ))}
              <label class="report-reason">
                <input type="radio" name="reason" value="spam" /> {t.report.spam}
              </label>
              <label class="report-reason">
                <input type="radio" name="reason" value="harassment" /> {t.report.harassment}
              </label>
              <label class="report-reason">
                <input type="radio" name="reason" value="other" required /> {t.report.other}
              </label>
            </fieldset>
            <div class="field">
              <label for="detail">{t.report.detail}</label>
              <textarea id="detail" name="detail" maxlength={1000}></textarea>
              <div class="hint">{t.report.detailHint}</div>
            </div>
            <button class="btn" type="submit">{t.report.submit}</button>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/report/:type/:id', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const type = c.req.param('type') === 'comment' ? 'comment' : 'post'
    const targetId = c.req.param('id')
    const body = await formData(c)
    const reason = body.reason ?? ''
    try {
      createReport(ctx, viewer, {
        targetType: type,
        targetId,
        reasonType: reason.startsWith('rule:') ? 'rule' : reason === 'spam' || reason === 'harassment' ? reason : 'other',
        ruleId: reason.startsWith('rule:') ? reason.slice(5) : null,
        detail: body.detail,
      })
      setFlash(c, 'ok', t.report.submitted)
      return c.redirect('/')
    } catch (err) {
      if (err instanceof AppError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/report/${type}/${targetId}`)
      }
      throw err
    }
  })

  return app
}
