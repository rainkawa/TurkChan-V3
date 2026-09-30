import { Hono } from 'hono'
import type { Context } from 'hono'
import type { Ctx } from '../context'
import { t } from '../i18n/tr'
import { Layout } from '../views/layout'
import { CommentTreeView, Markdown, VoteRail } from '../views/components'
import { getPostForViewer, editPostBody, deletePost, getPost } from '../services/posts'
import {
  createComment,
  editComment,
  deleteComment,
  getComment,
  getCommentTree,
  type CommentNode,
  type CommentSort,
} from '../services/comments'
import { getMyVotes } from '../services/votes'
import { createReport } from '../services/reports'
import { listRules } from '../services/communities'
import { isModerator, getCommunityById, canReadCommunity } from '../services/access'
import { AppError, notFound } from '../services/errors'
import { ValidationError } from '../lib/validation'
import { relativeTime } from '../views/helpers'
import { type AppEnv, formData, loginRedirect, setFlash, takeFlash, unread } from './helpers'

function parseCommentSort(raw: string | undefined): CommentSort {
  return raw === 'new' || raw === 'top' ? raw : 'best'
}

function collectIds(nodes: CommentNode[], out: string[] = []): string[] {
  for (const node of nodes) {
    out.push(node.comment.id)
    collectIds(node.children, out)
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
    const now = ctx.now()
    const { post, community, authorUsername, contentHidden } = view
    const isMod = isModerator(ctx, viewer, community.id)
    const isOwn = viewer?.id === post.author_id
    const canReply = Boolean(viewer) && !community.archived && contentHidden === null
    const hideMinutes = community.hide_comment_scores_minutes
    const scoreHidden = (createdAt: number) => hideMinutes > 0 && now - createdAt < hideMinutes * 60 * 1000

    const bodyBlock =
      contentHidden === 'deleted' ? (
        <p class="placeholder">{t.post.deletedBody}</p>
      ) : contentHidden === 'removed' ? (
        <p class="placeholder">{t.post.removedBody}</p>
      ) : contentHidden === 'pending_review' ? (
        <p class="placeholder">{t.post.pendingReview}</p>
      ) : post.type === 'text' && post.body ? (
        <Markdown source={post.body} />
      ) : post.type === 'link' && post.url ? (
        <a class="link-preview" href={post.url} rel="nofollow noopener">
          {post.link_preview_title ?? post.url}
          <div class="hint">{new URL(post.url).hostname}</div>
        </a>
      ) : post.type === 'image' && post.image_key ? (
        <img src={`/media/${post.image_key}`} alt={post.title} loading="eager" />
      ) : null

    return c.html(
      <Layout
        title={contentHidden ? t.errors.notFoundTitle : post.title}
        viewer={viewer}
        unread={unread(ctx, viewer)}
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
        <article class="card post-full">
          <div class="post-card" style="border:none;padding:0">
            <VoteRail targetType="post" targetId={post.id} score={post.score} myVote={myPostVote} guest={!viewer} disabled={isOwn || contentHidden !== null} />
            <div>
              <div class="meta">
                <a href={`/c/${community.name}`}>c/{community.name}</a>
                <span>{authorUsername ? <a href={`/u/${authorUsername}`}>u/{authorUsername}</a> : t.post.deletedBody}</span>
                <span>{relativeTime(post.created_at, now)}</span>
                {post.edited_at !== null && <span>({t.post.edited})</span>}
                {post.pinned_at !== null && <span class="pin-tag">📌 {t.feed.pinned}</span>}
              </div>
              <h1 class="post-title">{contentHidden === 'removed' ? t.post.removedBody : contentHidden === 'deleted' ? t.post.deletedBody : post.title}</h1>
              <div class="post-body">{bodyBlock}</div>
              <div class="post-actions">
                {isOwn && contentHidden === null && post.type === 'text' && <a href={`/posts/${post.id}/edit`}>{t.post.edit}</a>}
                {isOwn && contentHidden === null && (
                  <form method="post" action={`/posts/${post.id}/delete`} style="display:inline" data-confirm={t.post.deleteConfirm}>
                    <button class="linklike" type="submit">{t.post.delete}</button>
                  </form>
                )}
                {viewer && !isOwn && contentHidden === null && <a href={`/report/post/${post.id}`}>{t.post.report}</a>}
                {isMod && contentHidden === null && (
                  <>
                    <form method="post" action={`/mod/remove/post/${post.id}`} style="display:inline" data-confirm={t.post.removePostConfirm}>
                      <button class="linklike" type="submit">{t.common.remove}</button>
                    </form>
                    {post.pinned_at === null ? (
                      <form method="post" action={`/posts/${post.id}/pin`} style="display:inline">
                        <button class="linklike" type="submit">{t.common.pin}</button>
                      </form>
                    ) : (
                      <form method="post" action={`/posts/${post.id}/unpin`} style="display:inline">
                        <button class="linklike" type="submit">{t.common.unpin}</button>
                      </form>
                    )}
                  </>
                )}
                {viewer?.is_admin === 1 && contentHidden === 'removed' && (
                  <form method="post" action={`/mod/restore/post/${post.id}`} style="display:inline">
                    <button class="linklike" type="submit">{t.common.restore}</button>
                  </form>
                )}
              </div>
            </div>
          </div>
        </article>

        <div class="card" style="margin-top:1rem">
          <div class="sort-tabs">
            <span style="font-size:0.8rem;color:var(--ink-faint);padding:0.3rem 0">{t.comment.sortLabel}:</span>
            {(['best', 'new', 'top'] as const).map((s) => (
              <a href={`/c/${community.name}/comments/${post.id}?sort=${s}`} class={sort === s ? 'active' : ''}>
                {s === 'best' ? t.feed.best : s === 'new' ? t.feed.new : t.feed.top}
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
            scoreHidden={scoreHidden}
            highlightId={highlightCommentId}
          />
        </div>
      </Layout>,
    )
  }

  app.get('/c/:name/comments/:postId', (c) => renderPostPage(c, null))

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
      <Layout title={t.post.edit} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
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
      <Layout title={t.post.edit} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
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
      <Layout title={t.report.title} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.report.title}</h2>
          <form method="post" action={`/report/${type}/${targetId}`}>
            <div class="field">
              <label>{t.report.reason}</label>
              {rules.map((rule) => (
                <label style="display:block;font-weight:400">
                  <input type="radio" name="reason" value={`rule:${rule.id}`} /> {rule.title}
                </label>
              ))}
              <label style="display:block;font-weight:400"><input type="radio" name="reason" value="spam" /> {t.report.spam}</label>
              <label style="display:block;font-weight:400"><input type="radio" name="reason" value="harassment" /> {t.report.harassment}</label>
              <label style="display:block;font-weight:400"><input type="radio" name="reason" value="other" required /> {t.report.other}</label>
            </div>
            <div class="field">
              <label for="detail">{t.report.detail}</label>
              <textarea id="detail" name="detail" maxlength={1000}></textarea>
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
