import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t, visibilityLabel } from '../i18n/tr'
import { Layout } from '../views/layout'
import { PostCard, SortTabs } from '../views/components'
import {
  requireVisibleCommunity,
  canReadCommunity,
  isModerator,
  getMembership,
  activeBan,
} from '../services/access'
import {
  joinCommunity,
  leaveCommunity,
  listRules,
  listModerators,
  memberCount,
  updateCommunitySettings,
  replaceRules,
} from '../services/communities'
import { communityFeed } from '../services/feeds'
import { getMyVotes } from '../services/votes'
import { createTextPost, createLinkPost, createImagePost, findDuplicateLinkPost } from '../services/posts'
import { requestUpload, receiveUpload } from '../services/uploads'
import { decodeCursor } from '../lib/cursor'
import { AppError } from '../services/errors'
import { ValidationError } from '../lib/validation'
import { parseSort, parseWindow } from './main'
import { profilePath } from '../views/helpers'
import { type AppEnv, formData, loginRedirect, setFlash, takeFlash, unread } from './helpers'
import type { CommunityRow, UserRow } from '../types'

const PostTypeTabs = ({ name, active }: { name: string; active: string }) => (
  <nav class="type-tabs">
    {(['text', 'link', 'image'] as const).map((type) => (
      <a href={`/c/${name}/submit?type=${type}`} class={active === type ? 'active' : ''}>
        {type === 'text' ? t.post.typeText : type === 'link' ? t.post.typeLink : t.post.typeImage}
      </a>
    ))}
  </nav>
)

function membershipState(ctx: Ctx, viewer: UserRow | null, community: CommunityRow) {
  const membership = viewer ? getMembership(ctx, viewer.id, community.id) : null
  return {
    membership,
    isMember: membership?.status === 'approved',
    isPending: membership?.status === 'pending',
    isMod: isModerator(ctx, viewer, community.id),
    isBanned: viewer ? activeBan(ctx, viewer.id, community.id) !== null : false,
  }
}

export function communityRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/c/:name', (c) => {
    const viewer = c.get('viewer')
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const state = membershipState(ctx, viewer, community)

    if (!canReadCommunity(ctx, viewer, community)) {
      // US-017/US-043: access-required page with zero content leakage.
      return c.html(
        <Layout title={t.community.privateTitle} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
          <div class="card empty-state">
            <div class="big">c/{community.name}</div>
            <p>{t.community.privateGate}</p>
            {viewer ? (
              state.isPending ? (
                <p class="placeholder">{t.community.requested}</p>
              ) : (
                <form method="post" action={`/c/${community.name}/join`}>
                  <button class="btn" type="submit">{t.community.requestJoin}</button>
                </form>
              )
            ) : (
              <a class="btn" href={`/login?next=${encodeURIComponent(`/c/${community.name}`)}`}>{t.auth.registerToDo}</a>
            )}
            <p><a href="/">{t.errors.backHome}</a></p>
          </div>
        </Layout>,
        403,
      )
    }

    const sort = parseSort(c.req.query('sort'))
    const window = parseWindow(c.req.query('t'))
    const cursor = decodeCursor(c.req.query('after'))
    const page = communityFeed(ctx, viewer, community, sort, window, cursor)
    const allIds = [...page.pinned, ...page.items].map((i) => i.id)
    const myVotes = getMyVotes(ctx, viewer, 'post', allIds)
    const rules = listRules(ctx, community.id)
    const moderators = listModerators(ctx, community.id)
    const members = memberCount(ctx, community.id)
    const now = ctx.now()

    return c.html(
      <Layout
        title={community.title}
        viewer={viewer}
        unread={unread(ctx, viewer)}
        flash={takeFlash(c)}
        og={{ title: community.title, description: community.description }}
      >
        <div class="community-head">
          <div>
            <h1>{community.title}</h1>
            <span class="slug">
              c/{community.name} · {members} {t.community.members} · {visibilityLabel(community.visibility)}
            </span>
          </div>
          {viewer && !state.isBanned && (
            state.isMember ? (
              <form method="post" action={`/c/${community.name}/leave`}>
                <button class="btn secondary small" type="submit">{t.community.leave}</button>
              </form>
            ) : state.isPending ? (
              <span class="placeholder">{t.community.requested}</span>
            ) : (
              <form method="post" action={`/c/${community.name}/join`}>
                <button class="btn small" type="submit">
                  {community.visibility === 'public' ? t.community.join : t.community.requestJoin}
                </button>
              </form>
            )
          )}
          {!community.archived && (state.isMember || (viewer && community.visibility === 'public' && !state.isBanned)) && (
            <a class="btn small" href={`/c/${community.name}/submit`}>{t.post.submit}</a>
          )}
        </div>
        {community.archived === 1 && <div class="banner">{t.community.archived}</div>}
        {state.isMod && (
          <nav class="mod-tools">
            <a class="btn secondary small" href={`/c/${community.name}/mod/queue`}>{t.community.modQueue}</a>
            <a class="btn secondary small" href={`/c/${community.name}/mod/members`}>{t.community.approvals}</a>
            <a class="btn secondary small" href={`/c/${community.name}/mod/log`}>{t.community.modLog}</a>
            <a class="btn secondary small" href={`/c/${community.name}/settings`}>{t.community.settings}</a>
          </nav>
        )}
        <div class="layout with-sidebar">
          <section>
            <SortTabs basePath={`/c/${community.name}`} sort={sort} window={window} />
            <div class="feed">
              {page.pinned.map((item) => (
                <PostCard item={item} now={now} viewer={viewer} myVote={myVotes.get(item.id) ?? 0} showCommunity={false} pinned />
              ))}
              {page.items.length === 0 && page.pinned.length === 0 && (
                <div class="card empty-state"><div class="big">{t.feed.emptyCommunity}</div></div>
              )}
              {page.items.map((item) => (
                <PostCard item={item} now={now} viewer={viewer} myVote={myVotes.get(item.id) ?? 0} showCommunity={false} />
              ))}
            </div>
            {page.nextCursor && (
              <p style="text-align:center;margin-top:1rem">
                <a class="btn secondary" href={`/c/${community.name}?sort=${sort}&t=${window}&after=${page.nextCursor}`}>{t.feed.loadMore}</a>
              </p>
            )}
          </section>
          <aside class="sidebar">
            <div class="card">
              <h3>{community.title}</h3>
              <p>{community.description}</p>
              <form method="get" action="/search">
                <input type="hidden" name="community" value={community.name} />
                <input type="search" name="q" placeholder={`${t.community.searchCommunityPlaceholder} c/${community.name}`} />
              </form>
            </div>
            {rules.length > 0 && (
              <div class="card">
                <h3>{t.community.rules}</h3>
                <ol>
                  {rules.map((rule) => (
                    <li>
                      <strong>{rule.title}</strong>
                      {rule.detail && <div class="hint">{rule.detail}</div>}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <div class="card">
              <h3>{t.community.moderators}</h3>
              <ul>
                {moderators.map((m) => (
                  <li><a href={profilePath(m.username)}>/tc/{m.username}</a></li>
                ))}
              </ul>
            </div>
          </aside>
        </div>
      </Layout>,
    )
  })

  app.post('/c/:name/join', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    try {
      const membership = joinCommunity(ctx, viewer, community)
      if (membership.status === 'pending') setFlash(c, 'ok', t.community.requestSent)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}`)
  })

  app.post('/c/:name/leave', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    try {
      leaveCommunity(ctx, viewer, community)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}`)
  })

  app.get('/c/:name/submit', (c) => {
    const viewer = c.get('viewer')
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    if (!viewer) return loginRedirect(c)
    if (!canReadCommunity(ctx, viewer, community)) return c.redirect(`/c/${community.name}`)
    const type = ['text', 'link', 'image'].includes(c.req.query('type') ?? '') ? (c.req.query('type') as string) : 'text'
    return c.html(
      <Layout title={t.post.submit} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card">
          <h2>{t.post.submit} — c/{community.name}</h2>
          <PostTypeTabs name={community.name} active={type} />
          <form
            method="post"
            action={`/c/${community.name}/submit?type=${type}`}
            enctype={type === 'image' ? 'multipart/form-data' : undefined}
            data-draft-key={`${community.name}:${type}`}
          >
            <div class="field">
              <label for="title">{t.post.title}</label>
              <input id="title" name="title" type="text" required maxlength={300} />
            </div>
            {type === 'text' && (
              <div class="field">
                <label for="body">{t.post.body}</label>
                <textarea id="body" name="body" maxlength={40000}></textarea>
                <button class="btn secondary small" type="button" data-md-preview="body" data-md-target="body-preview" style="margin-top:0.5rem">
                  {t.post.preview}
                </button>
                <div id="body-preview" class="md card" style="display:none;margin-top:0.5rem"></div>
              </div>
            )}
            {type === 'link' && (
              <div class="field">
                <label for="url">{t.post.url}</label>
                <input id="url" name="url" type="url" required placeholder="https://" />
              </div>
            )}
            {type === 'image' && (
              <div class="field">
                <label for="image">{t.post.image}</label>
                <input id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp" required />
              </div>
            )}
            <button class="btn" type="submit">{t.post.postCta}</button>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/c/:name/submit', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const type = c.req.query('type') ?? 'text'
    try {
      if (type === 'link') {
        const body = await formData(c)
        const url = (body.url ?? '').trim()
        const duplicate = findDuplicateLinkPost(ctx, community, url)
        const { post } = await createLinkPost(ctx, viewer, community, { title: body.title ?? '', url })
        if (duplicate) {
          // Non-blocking duplicate warning (US-014).
          setFlash(c, 'warn', `${t.post.duplicateWarning} /c/${community.name}/comments/${duplicate.id}`)
        }
        return c.redirect(`/c/${community.name}/comments/${post.id}`)
      }
      if (type === 'image') {
        const parsed = await c.req.parseBody()
        const file = parsed.image
        if (!(file instanceof File)) throw new AppError(400, 'image', 'Yüklemek için bir görsel dosyası seçin.')
        const bytes = new Uint8Array(await file.arrayBuffer())
        const slot = requestUpload(ctx, viewer)
        await receiveUpload(ctx, slot.key, slot.token, bytes)
        const title = typeof parsed.title === 'string' ? parsed.title : ''
        const post = createImagePost(ctx, viewer, community, { title, imageKey: slot.key })
        return c.redirect(`/c/${community.name}/comments/${post.id}`)
      }
      const body = await formData(c)
      const post = createTextPost(ctx, viewer, community, { title: body.title ?? '', body: body.body ?? '' })
      return c.redirect(`/c/${community.name}/comments/${post.id}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/c/${community.name}/submit?type=${type}`)
      }
      throw err
    }
  })

  app.get('/c/:name/settings', (c) => {
    const viewer = c.get('viewer')
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    if (!isModerator(ctx, viewer, community.id)) return c.redirect(`/c/${community.name}`)
    const rules = listRules(ctx, community.id)
    const rulesText = rules.map((r) => (r.detail ? `${r.title} | ${r.detail}` : r.title)).join('\n')
    return c.html(
      <Layout title={t.community.settings} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.community.settings} — c/{community.name}</h2>
          <form method="post" action={`/c/${community.name}/settings`}>
            <div class="field">
              <label for="title">{t.community.title}</label>
              <input id="title" name="title" type="text" maxlength={100} value={community.title} />
            </div>
            <div class="field">
              <label for="description">{t.community.description}</label>
              <textarea id="description" name="description" maxlength={1000}>{community.description}</textarea>
            </div>
            <div class="field">
              <label for="visibility">{t.community.visibility}</label>
              <select id="visibility" name="visibility">
                <option value="public" selected={community.visibility === 'public'}>{t.community.public}</option>
                <option value="restricted" selected={community.visibility === 'restricted'}>{t.community.restricted}</option>
                <option value="private" selected={community.visibility === 'private'}>{t.community.private}</option>
              </select>
            </div>
            <div class="field">
              <label for="rules">{t.community.rulesHint}</label>
              <textarea id="rules" name="rules" rows={8}>{rulesText}</textarea>
            </div>
            <div class="field">
              <label for="autoHideReports">{t.community.autoHideReports}</label>
              <input id="autoHideReports" name="autoHideReports" type="number" min={0} max={100} value={String(community.auto_hide_reports)} />
            </div>
            <div class="field">
              <label for="hideScores">{t.community.hideScores}</label>
              <input id="hideScores" name="hideScores" type="number" min={0} max={1440} value={String(community.hide_comment_scores_minutes)} />
            </div>
            <button class="btn" type="submit">{t.post.save}</button>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/c/:name/settings', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const body = await formData(c)
    try {
      updateCommunitySettings(ctx, viewer, community, {
        title: body.title,
        description: body.description,
        visibility: body.visibility,
        autoHideReports: Number(body.autoHideReports ?? community.auto_hide_reports),
        hideCommentScoresMinutes: Number(body.hideScores ?? community.hide_comment_scores_minutes),
      })
      const rules = (body.rules ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [title, ...rest] = line.split('|')
          return { title: (title ?? '').trim(), detail: rest.join('|').trim() }
        })
      replaceRules(ctx, viewer, community, rules)
      setFlash(c, 'ok', t.community.settingsSaved)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/settings`)
  })

  return app
}
