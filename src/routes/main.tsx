import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t } from '../i18n/tr'
import { Layout } from '../views/layout'
import { PostCard, SortTabs } from '../views/components'
import { homeFeed, type FeedSort, type TopWindow } from '../services/feeds'
import { listDirectory, createCommunity } from '../services/communities'
import { search } from '../services/search'
import { getProfile, updateProfile } from '../services/users'
import { getMyVotes } from '../services/votes'
import { listNotifications, markAllRead, markRead } from '../services/notifications'
import { getSettings } from '../services/settings'
import { decodeCursor } from '../lib/cursor'
import { AppError } from '../services/errors'
import { ValidationError } from '../lib/validation'
import { relativeTime, formatDate } from '../views/helpers'
import { visibilityLabel } from '../i18n/tr'
import { type AppEnv, formData, setFlash, takeFlash, unread } from './helpers'

export function parseSort(raw: string | undefined): FeedSort {
  return raw === 'new' || raw === 'top' ? raw : 'hot'
}
export function parseWindow(raw: string | undefined): TopWindow {
  return raw === 'day' || raw === 'month' || raw === 'all' ? raw : 'week'
}

export function mainRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', (c) => {
    const viewer = c.get('viewer')
    const sort = parseSort(c.req.query('sort'))
    const window = parseWindow(c.req.query('t'))
    const cursor = decodeCursor(c.req.query('after'))
    const page = homeFeed(ctx, viewer, sort, window, cursor)
    const myVotes = getMyVotes(ctx, viewer, 'post', page.items.map((i) => i.id))
    const now = ctx.now()
    return c.html(
      <Layout viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)} og={{ title: t.siteTitle, description: t.ogDescription }}>
        <div class="layout with-sidebar">
          <section>
            <SortTabs basePath="/" sort={sort} window={window} />
            <div class="feed">
              {page.items.length === 0 && (
                <div class="card empty-state">
                  <div class="big">{t.feed.emptyHome}</div>
                  <a class="btn" href="/communities">{t.feed.browseCommunities}</a>
                </div>
              )}
              {page.items.map((item) => (
                <PostCard item={item} now={now} viewer={viewer} myVote={myVotes.get(item.id) ?? 0} />
              ))}
            </div>
            {page.nextCursor && (
              <p style="text-align:center;margin-top:1rem">
                <a class="btn secondary" href={`/?sort=${sort}&t=${window}&after=${page.nextCursor}`}>{t.feed.loadMore}</a>
              </p>
            )}
          </section>
          <aside class="sidebar">
            <div class="card">
              <h3>{t.siteName}</h3>
              <p>{t.tagline}</p>
              {viewer && !page.usedJoinedCommunities && <p>{t.feed.joinPrompt}</p>}
              <a class="btn secondary" href="/communities">{t.feed.browseCommunities}</a>
            </div>
          </aside>
        </div>
      </Layout>,
    )
  })

  app.get('/communities', (c) => {
    const viewer = c.get('viewer')
    const entries = listDirectory(ctx, viewer)
    const settings = getSettings(ctx)
    const canCreate = viewer && (settings.communityCreation === 'member' || viewer.is_admin === 1)
    return c.html(
      <Layout title={t.nav.communities} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card">
          <h2>{t.nav.communities}</h2>
          {canCreate && (
            <p>
              <a class="btn" href="/communities/new">{t.community.create}</a>
            </p>
          )}
          {entries.map((e) => (
            <div class="dir-item">
              <div>
                <a class="name" href={`/c/${e.name}`}>c/{e.name}</a>
                <p class="desc">{e.title}{e.description ? ` — ${e.description}` : ''}</p>
              </div>
              <span class="count">{e.member_count} {t.community.members}{e.visibility !== 'public' ? ` · ${visibilityLabel(e.visibility)}` : ''}</span>
            </div>
          ))}
          {entries.length === 0 && <p class="placeholder">{t.post.noCommunities}</p>}
        </div>
      </Layout>,
    )
  })

  app.get('/communities/new', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect(`/login?next=${encodeURIComponent('/communities/new')}`)
    return c.html(
      <Layout title={t.community.create} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.community.create}</h2>
          <form method="post" action="/communities/new">
            <div class="field">
              <label for="name">{t.community.name}</label>
              <input id="name" name="name" type="text" required minlength={3} maxlength={24} pattern="[a-z0-9_]+" />
              <div class="hint">{t.community.nameHint}</div>
            </div>
            <div class="field">
              <label for="title">{t.community.title}</label>
              <input id="title" name="title" type="text" maxlength={100} />
            </div>
            <div class="field">
              <label for="description">{t.community.description}</label>
              <textarea id="description" name="description" maxlength={1000}></textarea>
            </div>
            <div class="field">
              <label for="visibility">{t.community.visibility}</label>
              <select id="visibility" name="visibility">
                <option value="public">{t.community.public}</option>
                <option value="restricted">{t.community.restricted}</option>
                <option value="private">{t.community.private}</option>
              </select>
            </div>
            <button class="btn" type="submit">{t.community.create}</button>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/communities/new', async (c) => {
    const viewer = c.get('viewer')
    const body = await formData(c)
    try {
      const community = createCommunity(ctx, viewer, {
        name: body.name ?? '',
        title: body.title ?? '',
        description: body.description ?? '',
        visibility: body.visibility ?? 'public',
      })
      return c.redirect(`/c/${community.name}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect('/communities/new')
      }
      throw err
    }
  })

  app.get('/search', (c) => {
    const viewer = c.get('viewer')
    const query = (c.req.query('q') ?? '').trim()
    const communityName = c.req.query('community')
    let communityId: string | undefined
    if (communityName) {
      const row = ctx.db.prepare('SELECT id FROM communities WHERE name = ?').get(communityName.toLowerCase()) as { id: string } | undefined
      communityId = row?.id
    }
    const results = query ? search(ctx, viewer, query, communityId) : { posts: [], communities: [] }
    const now = ctx.now()
    return c.html(
      <Layout title={`${t.nav.search}: ${query}`} viewer={viewer} unread={unread(ctx, viewer)}>
        <div class="card">
          <h2>{t.nav.search}</h2>
          <form method="get" action="/search">
            <div class="field">
              <input type="search" name="q" value={query} placeholder={t.post.searchPlaceholder} />
              {communityName && <input type="hidden" name="community" value={communityName} />}
            </div>
            <button class="btn" type="submit">{t.nav.search}</button>
          </form>
          {communityName && (
            <p class="hint">
              {t.post.searchWithinPrefix} c/{communityName}.{' '}
              <a href={`/search?q=${encodeURIComponent(query)}`}>{t.post.searchEverywhere}</a>
            </p>
          )}
        </div>
        {query && results.communities.length > 0 && (
          <div class="card" style="margin-top:1rem">
            <h3>{t.nav.communities}</h3>
            {results.communities.map((cm) => (
              <div class="dir-item">
                <div>
                  <a class="name" href={`/c/${cm.name}`}>c/{cm.name}</a>
                  <p class="desc">{cm.title}</p>
                </div>
                <span class="count">{cm.member_count} {t.community.members}</span>
              </div>
            ))}
          </div>
        )}
        {query && (
          <div class="card" style="margin-top:1rem">
            <h3>{t.profile.posts}</h3>
            {results.posts.length === 0 && (
              <p class="placeholder">
                {t.post.noResults} <a href="/communities">{t.post.searchPostQuestion}</a>.
              </p>
            )}
            {results.posts.map((p) => (
              <div class="dir-item">
                <div>
                  <a class="name" href={`/c/${p.community_name}/comments/${p.id}`}>{p.title}</a>
                  <p class="desc">
                    c/{p.community_name} · {p.score} {t.common.points} · {p.comment_count} {t.feed.comments} ·{' '}
                    {relativeTime(p.created_at, now)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </Layout>,
    )
  })

  app.get('/u/:username', (c) => {
    const viewer = c.get('viewer')
    const profile = getProfile(ctx, viewer, c.req.param('username'))
    const now = ctx.now()
    if (!profile) {
      return c.html(
        <Layout title={t.profile.notAvailable} viewer={viewer} unread={unread(ctx, viewer)}>
          <div class="card empty-state">
            <div class="big">{t.profile.notAvailable}</div>
            <a class="btn" href="/">{t.errors.backHome}</a>
          </div>
        </Layout>,
        404,
      )
    }
    const isSelf = viewer?.id === profile.user.id
    return c.html(
      <Layout title={`u/${profile.user.username}`} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="layout with-sidebar">
          <section>
            <div class="card">
              <h2>u/{profile.user.username}</h2>
              {profile.user.display_name && <p><strong>{profile.user.display_name}</strong></p>}
              {profile.user.bio && <p>{profile.user.bio}</p>}
              <p class="meta">
                {t.profile.joined} {formatDate(profile.user.created_at)} · {t.profile.postKarma}: {profile.karma.postKarma} · {t.profile.commentKarma}: {profile.karma.commentKarma}
              </p>
              {isSelf && <a class="btn secondary small" href="/settings">{t.profile.editProfile}</a>}
            </div>
            <div class="card" style="margin-top:1rem">
              <h3>{t.profile.posts}</h3>
              {profile.posts.length === 0 && <p class="placeholder">{t.post.noPosts}</p>}
              {profile.posts.map((p) => (
                <div class="dir-item">
                  <div>
                    <a class="name" href={`/c/${p.community_name}/comments/${p.id}`}>{p.title}</a>
                    <p class="desc">
                      c/{p.community_name} · {p.score} {t.common.points} · {relativeTime(p.created_at, now)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <div class="card" style="margin-top:1rem">
              <h3>{t.profile.comments}</h3>
              {profile.comments.length === 0 && <p class="placeholder">{t.post.noComments}</p>}
              {profile.comments.map((cm) => (
                <div class="dir-item">
                  <div>
                    <a class="name" href={`/c/${cm.community_name}/comments/${cm.post_id}/comment/${cm.id}`}>{cm.post_title}</a>
                    <p class="desc">
                      {cm.body.slice(0, 160)} · {cm.score} {t.common.points} · {relativeTime(cm.created_at, now)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </Layout>,
    )
  })

  app.get('/settings', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login?next=%2Fsettings')
    return c.html(
      <Layout title={t.nav.settings} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.profile.editProfile}</h2>
          <form method="post" action="/settings">
            <div class="field">
              <label for="displayName">{t.profile.displayName}</label>
              <input id="displayName" name="displayName" type="text" maxlength={40} value={viewer.display_name ?? ''} />
            </div>
            <div class="field">
              <label for="bio">{t.profile.bio}</label>
              <textarea id="bio" name="bio" maxlength={200}>{viewer.bio ?? ''}</textarea>
            </div>
            <button class="btn" type="submit">{t.post.save}</button>
          </form>
          <hr />
          <p>
            <a href="/settings/delete-account" style="color:var(--danger)">{t.profile.deleteAccount}</a>
          </p>
        </div>
      </Layout>,
    )
  })

  app.post('/settings', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    const body = await formData(c)
    try {
      updateProfile(ctx, viewer, { displayName: body.displayName ?? '', bio: body.bio ?? '' })
      setFlash(c, 'ok', t.profile.updated)
    } catch (err) {
      if (err instanceof ValidationError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect('/settings')
  })

  app.get('/notifications', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login?next=%2Fnotifications')
    const items = listNotifications(ctx, viewer.id)
    const now = ctx.now()
    return c.html(
      <Layout title={t.notifications.title} viewer={viewer} unread={unread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card">
          <h2>{t.notifications.title}</h2>
          {items.length > 0 && (
            <form method="post" action="/notifications/read-all">
              <button class="btn secondary small" type="submit">{t.notifications.markAll}</button>
            </form>
          )}
          {items.length === 0 && <p class="placeholder">{t.notifications.empty}</p>}
          {items.map((n) => (
            <div class="dir-item" style={n.read ? 'opacity:0.6' : ''}>
              <div>
                <a class="name" href={`/notifications/open/${n.id}`}>{n.title}</a>
                <p class="desc">{relativeTime(n.created_at, now)}</p>
              </div>
            </div>
          ))}
        </div>
      </Layout>,
    )
  })

  app.get('/notifications/open/:id', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    const row = ctx.db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(c.req.param('id'), viewer.id) as
      | { id: string; link: string }
      | undefined
    if (!row) return c.redirect('/notifications')
    markRead(ctx, viewer.id, row.id)
    return c.redirect(row.link)
  })

  app.post('/notifications/read-all', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    markAllRead(ctx, viewer.id)
    return c.redirect('/notifications')
  })

  app.get('/privacy', (c) => {
    const viewer = c.get('viewer')
    return c.html(        <Layout title={t.footer.privacy} viewer={viewer} unread={unread(ctx, viewer)}>
        <div class="card">
          <h2>{t.footer.privacy}</h2>
          <p>{t.privacy.intro}</p>
          <ul>
            <li>
              <strong>{t.privacy.purpose}</strong> {t.privacy.purposeBody}
            </li>
            <li>
              <strong>{t.privacy.noSale}</strong> {t.privacy.noSaleBody}
            </li>
            <li>
              <strong>{t.privacy.ipAddresses}</strong> {t.privacy.ipAddressesBody}
            </li>
            <li>
              <strong>{t.privacy.accountDeletion}</strong> {t.privacy.accountDeletionBody}
            </li>
            <li>
              <strong>{t.privacy.images}</strong> {t.privacy.imagesBody}
            </li>
          </ul>
          <p>{t.privacy.questions}</p>
        </div>
      </Layout>,
    )
  })

  return app
}
