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
import { MediaGallery, SingleMedia } from '../views/components'
import {
  createComment,
  editComment,
  deleteComment,
  getComment,
  getCommentTree,
  commentMediaByPost,
  commentMentionNamesByPost,
  updateCommentMeta,
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
import { requestUpload, receiveUpload } from '../services/uploads'
import { referencesOut, repliesTo, syncReferences } from '../services/references'

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
import { type AppEnv, collectFiles, dmUnread, formData, loginRedirect, safeNext, setFlash, takeFlash, unread } from './helpers'

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
    const isMod = isModerator(ctx, viewer, community.id)
    const postFlairs = listFlairs(ctx, community.id)
    const media = listPostMedia(ctx, postId)
    const commentMedia = commentMediaByPost(ctx, postId)
    const commentMentions = commentMentionNamesByPost(ctx, postId)
    const stats = postStats(ctx, post)
    // Görüntülenmeyi yalnızca erişebilen kullanıcılar için say.
    if (contentHidden === null) {
      recordView(ctx, post, viewer, c.req.header('x-forwarded-for') ?? null)
    }
    const postFlair = post.flair_id ? postFlairs.find((f) => f.id === post.flair_id) ?? null : null
    const isOwn = viewer?.id === post.author_id
    const canReply = Boolean(viewer) && !community.archived && contentHidden === null
    // Anonim kutusu kullanıcının varsayılan tercihiyle başlar.
    const anonDefault = viewer?.anon_by_default === 1
    const hideMinutes = community.hide_comment_scores_minutes
    const scoreHidden = (createdAt: number) => hideMinutes > 0 && now - createdAt < hideMinutes * 60 * 1000

    // >>12345 referansları: yalnızca AYNI topluluktaki gerçek gönderiler
    // çözülür; backlink listesi de aynı eşleşmeden üretilir.
    const postRefs = syncReferences(ctx, post.id, post.community_id, `${post.title} ${post.body ?? ''}`)
    const inbound = contentHidden === null ? repliesTo(ctx, post.id) : []
    const outbound = referencesOut(ctx, post.id)

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
        <Markdown source={post.body} refs={postRefs} />
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
                      <span class="anon-author" title={t.post.anonBylineHint}>
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
                  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
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

          {/* Anonim rozeti */}
          <div class="post-badges">
            {post.is_anonymous === 1 && (
              <span class="post-badge anon" title={t.post.anonBylineHint}>
                🕶 {t.post.anonByline} · <b>{post.anon_name}</b>
              </span>
            )}
          </div>

          {/* Kimlik, kalıcı bağlantı, tarihler ve istatistik */}
          <div class="post-meta-bar">
            <div class="post-meta-row">
              {post.number !== null && (
                <span class="post-meta-item post-number" title={t.post.numberHint}>
                  № <code>{post.number}</code>
                </span>
              )}
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

          {/* >>12345 referansları: geri bağlantılar */}
          {(inbound.length > 0 || outbound.length > 0) && (
            <div class="post-refs">
              {outbound.length > 0 && (
                <div class="post-refs-row">
                  <span class="post-refs-label">{t.post.referencesOut}</span>
                  {outbound.map((ref) => (
                    <a class="post-ref" href={`/p/${ref.id}`}>
                      {ref.number !== null ? `>>${ref.number}` : '>>?'} {ref.title}
                    </a>
                  ))}
                </div>
              )}
              {inbound.length > 0 && (
                <div class="post-refs-row">
                  <span class="post-refs-label">{t.post.repliesTo}</span>
                  {inbound.map((ref) => (
                    <a class="post-ref" href={`/p/${ref.id}`}>
                      {ref.number !== null ? `>>${ref.number}` : '>>?'}{' '}
                      {ref.anon_name ?? `@${ref.author_username ?? '?'}`}
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}

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
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
              </svg>
              <span>{post.comment_count} {t.feed.comments}</span>
            </a>
            <button class="action-btn" type="button" data-share={`/c/${community.name}/comments/${post.id}`}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M12 15V4m0 0L8 8m4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
              </svg>
              <span>{t.card.share}</span>
            </button>
            {contentHidden === null && (
              <button class="action-btn" type="button" data-save-post={post.id} data-save-title={post.title}
                data-save-href={`/c/${community.name}/comments/${post.id}`} data-save-community={community.name}>
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path d="M7 4h10v16l-5-4-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
                </svg>
                <span data-save-label>{t.card.save}</span>
              </button>
            )}
          </div>
        </article>

        <div class="comments-block" id="comments">
          <div class="sort-tabs">
            {(['best', 'top', 'new'] as const).map((s) => (
              <a href={`/c/${community.name}/comments/${post.id}?sort=${s}`} class={sort === s ? 'active' : ''}>
                {s === 'best' ? t.feed.best : s === 'new' ? t.feed.new : t.feed.hot}
              </a>
            ))}
          </div>
          {canReply ? (
            <form
              class="comment-form"
              method="post"
              action={`/c/${community.name}/comments/${post.id}/comment`}
              id="reply"
              enctype="multipart/form-data"
            >
              {highlightCommentId && <input type="hidden" name="parentId" value={highlightCommentId} />}
              {highlightCommentId && (
                <p class="hint">
                  {t.post.replyingTo}{' '}
                  <a href={`/c/${community.name}/comments/${post.id}`}>{t.post.commentOnPostInstead}</a>
                </p>
              )}
              <div class="field">
                <textarea name="body" placeholder={t.comment.placeholder} maxlength={10000}></textarea>
              </div>
              <div class="field">
                <label for="comment-files">{t.comment.addMedia}</label>
                <input id="comment-files" type="file" name="media" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" multiple />
                <div class="hint">{t.comment.mediaHint}</div>
              </div>
              <div class="field post-extra-fields">
                <label class="checkbox">
                  <input type="checkbox" name="spoiler" value="1" />
                  <span>{t.comment.spoilerLabel}</span>
                </label>
                <label class="checkbox">
                  <input type="checkbox" name="anonymous" value="1" checked={anonDefault} />
                  <span>{t.comment.anonymousLabel}</span>
                </label>
              </div>
              <p class="hint">{t.comment.mentionHint}</p>
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
            mediaByComment={commentMedia}
            mentionsByComment={commentMentions}
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
    return c.redirect(`/c/${community.name}/comments/${post.id}`, 301)
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
    const redirectBack = `/c/${name}/comments/${postId}`
    try {
      // multipart: gövde + yorum medyası aynı istekte gelir.
      const parsed = await c.req.formData()
      const keys: string[] = []
      for (const file of collectFiles(parsed, 'media')) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const slot = requestUpload(ctx, viewer)
        await receiveUpload(ctx, slot.key, slot.token, bytes)
        keys.push(slot.key)
      }
      const text = (parsed.get('body') as string) ?? ''
      if (text.trim() === '' && keys.length === 0) {
        throw new ValidationError('body', 'Yorum boş olamaz.')
      }
      const comment = createComment(ctx, viewer, postId, {
        body: text,
        parentId: ((parsed.get('parentId') as string) ?? '') || null,
        mediaKeys: keys,
        spoiler: parsed.get('spoiler') === '1',
        anonymous: parsed.get('anonymous') === '1',
      })
      return c.redirect(`/c/${name}/comments/${postId}/comment/${comment.id}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(redirectBack)
      }
      throw err
    }
  })

  /** Yazarın kendi yorumunun spoiler / anonim ayarını günceller. */
  app.post('/comments/:id/meta', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const body = await formData(c)
    try {
      const comment = updateCommentMeta(ctx, viewer, c.req.param('id'), {
        ...(body.spoiler !== undefined ? { spoiler: body.spoiler === '1' } : {}),
        ...(body.anonymous !== undefined ? { anonymous: body.anonymous === '1' } : {}),
      })
      setFlash(c, 'ok', t.comment.settingsSaved)
      const post = getPost(ctx, comment.post_id)
      const community = post ? getCommunityById(ctx, post.community_id) : null
      const target = community
        ? `/c/${community.name}/comments/${comment.post_id}/comment/${comment.id}`
        : '/'
      return c.redirect(body.back ? safeNext(body.back) : target)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
      else throw err
      return c.redirect(body.back ? safeNext(body.back) : '/')
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
