import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t } from '../i18n/tr'
import type { UserRow } from '../types'
import { Layout } from '../views/layout'
import { AffinityPanel, FeedFilterBar, PostCard, SortTabs, SocialCard } from '../views/components'
import { ProfileView_, type ProfileTab } from '../views/profile'
import { homeFeed, parseFeedSort, type FeedSort, type TopWindow } from '../services/feeds'
import { dismissAffinity, flairFilterOptions } from '../services/feeds'
import { flairMap, listFlairs } from '../services/flairs'
import type { FeedItem } from '../services/feeds'
import { listDirectory, createCommunity, membershipStates } from '../services/communities'
import { getCommunityByName } from '../services/access'
import { search } from '../services/search'
import {
  getProfile,
  updateProfile,
  moderatesAnyCommunity,
  changeUsername,
  changePassword,
  setProfileImage,
  authorRanksFor,
  getUserById,
  usersByIds,
} from '../services/users'
import { isAdminPower, userRankInfo } from '../services/ranks'
import { requestUpload, receiveUpload } from '../services/uploads'
import { getMyVotes } from '../services/votes'
import { listNotifications, markAllRead, markRead } from '../services/notifications'
import { markAllConversationsRead, unreadConversations } from '../services/dm'
import { Avatar } from '../views/dm'
import { rankInfoFor } from '../services/ranks'
import { UserByline } from '../views/rank'
import { getSettings } from '../services/settings'
import { decodeCursor } from '../lib/cursor'
import { AppError } from '../services/errors'
import { ValidationError } from '../lib/validation'
import { relativeTime, formatDate, communityColor, communityInitials, profilePath } from '../views/helpers'
import { visibilityLabel } from '../i18n/tr'
import { type AppEnv, dmUnread, formData, safeNext, setFlash, takeFlash, unread } from './helpers'

export function parseSort(raw: string | undefined): FeedSort {
  return parseFeedSort(raw)
}
export function parseWindow(raw: string | undefined): TopWindow {
  return raw === 'day' || raw === 'month' || raw === 'all' ? raw : 'week'
}

/** Sorgu dizesi yardımcısı: boş değerler atlanır. */
function buildQuery(values: Record<string, string | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return query ? `&${query}` : ''
}

/** Kullanıcının görebildiği board kimlikleri (filtre menüsü için). */
function readableBoardIds(ctx: Ctx, viewer: UserRow): string[] {
  return (
    ctx.db
      .prepare(
        `SELECT c.id FROM communities c
          WHERE c.deleted_at IS NULL AND c.visibility != 'private'
             OR c.id IN (SELECT community_id FROM memberships WHERE user_id = ? AND status = 'approved')`,
      )
      .all(viewer.id) as unknown as Array<{ id: string }>
  ).map((r) => r.id)
}

/** Kullanıcının en çok ilgilendiği boardlar (kişiselleştirme paneli). */
function topAffinityBoards(ctx: Ctx, viewer: UserRow, limit = 5) {
  return (
    ctx.db
      .prepare(
        `SELECT c.name, c.title,
                COALESCE(ca.affinity, CASE WHEN m.status = 'approved' THEN 1.4 ELSE 1 END) AS affinity
           FROM community_affinity ca
           JOIN communities c ON c.id = ca.community_id
           LEFT JOIN memberships m ON m.community_id = c.id AND m.user_id = ca.user_id
          WHERE ca.user_id = ? AND c.deleted_at IS NULL
          ORDER BY affinity DESC, c.name ASC
          LIMIT ?`,
      )
      .all(viewer.id, limit) as unknown as Array<{ name: string; title: string; affinity: number }>
  )
}

export function mainRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/', (c) => {
    const viewer = c.get('viewer')
    const sort = parseSort(c.req.query('sort'))
    const window = parseWindow(c.req.query('t'))
    const cursor = decodeCursor(c.req.query('after'))
    const flairId = c.req.query('flair') ?? null
    const communityName = c.req.query('c') ?? null
    // Akış sorgusu board kimliğiyle filtreler; ?c= ise board adıdır.
    const communityFilter = communityName ? getCommunityByName(ctx, communityName)?.id ?? null : null
    const now = ctx.now()

    const page = homeFeed(ctx, viewer, sort, window, cursor, 25, {
      flairId,
      communityId: communityFilter,
    })
    const myVotes = getMyVotes(ctx, viewer, 'post', page.items.map((i) => i.id))
    const all = [...page.pinned, ...page.items]
    const membership = membershipStates(ctx, viewer, all.map((i) => i.community_id))
    const authorRanks = authorRanksFor(ctx, all.map((i) => i.author_id))
    const flairs = flairMap(ctx, all.map((i) => i.community_id))
    const cards = (items: FeedItem[], pinned = false) =>
      items.map((item) => (
        <SocialCard
          item={item}
          now={now}
          viewer={viewer}
          myVote={myVotes.get(item.id) ?? 0}
          membership={membership.get(item.community_id)}
          authorRanks={authorRanks}
          flair={item.flair_id ? flairs.get(item.flair_id) ?? null : null}
          pinned={pinned}
        />
      ))

    // Sonsuz kaydırma: JS yalnızca kart listesinin devamını ister.
    if (c.req.query('partial') === '1' && cursor) {
      const container = c.get('viewer') !== null ? 'home-feed' : 'home-feed'
      return c.html(
        <div data-feed-page={container} data-next-cursor={page.nextCursor ?? ''}>
          {cards(all)}
        </div>,
      )
    }

    // Filtre menüsü: kullanıcının görebildiği boardlardaki etiketler.
    const filterFlairs = viewer ? flairFilterOptions(ctx, readableBoardIds(ctx, viewer)) : []

    const extraQuery = buildQuery({ flair: flairId, c: communityName })

    return c.html(
      <Layout viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)} active="home" og={{ title: t.siteTitle, description: t.ogDescription }}>
        <div class="home-layout">
          <div class="home-main">
            <div class="feed-head">
              <SortTabs basePath="/" sort={sort} window={window} extraQuery={extraQuery} />
              {viewer && (
                <span class="for-you-chip" title={t.feed.forYouHint}>
                  ✨ {t.feed.forYou}
                </span>
              )}
            </div>
            <FeedFilterBar
              basePath="/"
              sort={sort}
              window={window}
              flairId={flairId}
              communityId={communityName}
              flairs={filterFlairs}
              boards={viewer ? listDirectory(ctx, viewer).map((e: { name: string; title: string }) => ({ name: e.name, title: e.title })) : []}
            />
            <div class="social-feed" id="home-feed" data-feed data-next-cursor={page.nextCursor ?? ''} data-feed-url={`/?sort=${sort}&t=${window}${extraQuery}`}>
              {all.length === 0 && (
                <div class="card empty-state">
                  <div class="big">{flairId || communityName ? t.feed.emptyFilters : t.feed.emptyHome}</div>
                  <a class="btn" href="/communities">{t.feed.browseCommunities}</a>
                </div>
              )}
              {cards(page.pinned, true)}
              {cards(page.items)}
            </div>
            <div class="feed-status" data-feed-status>
              {page.nextCursor ? (
                <>
                  <span class="feed-spinner" aria-hidden="true" />
                  <span class="feed-status-text">{t.feed.loading}</span>
                  <a class="btn secondary small" href={`/?sort=${sort}&t=${window}${extraQuery}&after=${page.nextCursor}`}>
                    {t.feed.loadMore}
                  </a>
                </>
              ) : (
                all.length > 0 && <span class="feed-status-text">{t.feed.allLoaded}</span>
              )}
            </div>
          </div>
          <aside class="sidebar home-side">
            <div class="card">
              <h3>{t.siteName}</h3>
              <p>{t.tagline}</p>
              {viewer && <p class="hint">{t.feed.forYouHint}</p>}
              {viewer && !page.usedJoinedCommunities && <p>{t.feed.joinPrompt}</p>}
              <a class="btn secondary" href="/communities">{t.feed.browseCommunities}</a>
            </div>
            <AffinityPanel viewer={viewer} sort={sort} window={window} boards={viewer ? topAffinityBoards(ctx, viewer) : []} />
          </aside>
        </div>
      </Layout>,
    )
  })

  /** "Bu boardu daha az gör" — ana sayfa akışındaki ilgi puanını düşürür. */
  app.post('/feed/dismiss', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    const body = await formData(c)
    const boardName = (body.board ?? '').trim()
    const board = getCommunityByName(ctx, boardName)
    if (!board) {
      setFlash(c, 'error', t.errors.genericBody)
      return c.redirect('/')
    }
    dismissAffinity(ctx, viewer.id, board.id)
    setFlash(c, 'ok', t.feed.interestUpdated)
    return c.redirect(body.next ? safeNext(body.next) : '/')
  })

  app.get('/communities', (c) => {
    const viewer = c.get('viewer')
    const entries = listDirectory(ctx, viewer)
    // Board oluşturma yalnızca yönetim panelinde; burada bağlantı yöneticilere gösterilir.
    const canCreate = viewer !== null && isAdminPower(viewer)
    return c.html(
      <Layout title={t.nav.communities} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)} active="communities">
        <div class="card">
          <h2>{t.nav.communities}</h2>
          {canCreate && (
            <p>
              <a class="btn" href="/admin?tab=communities">{t.community.create}</a>
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

  /**
   * Alt navigasyondaki "Oluştur" için topluluk seçici. Yeni bir endpoint değil:
   * yalnızca var olan gönderi formuna yönlendirir, yazma yetkisi yine
   * community.tsx içindeki requireParticipant tarafından denetlenir.
   */
  app.get('/submit', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login?next=%2Fsubmit')
    const entries = listDirectory(ctx, viewer).filter((e) => !e.archived)
    return c.html(
      <Layout
        title={t.nav.createPost}
        viewer={viewer}
        unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)}
        flash={takeFlash(c)}
        active="create"
      >
        <div class="card form-narrow">
          <h2>{t.nav.createPost}</h2>
          <p class="hint">{t.post.createWhere}</p>
          <div class="community-picker">
            {entries.map((e) => (
              <a class="community-picker-item" href={`/c/${e.name}/submit`}>
                <span class="picker-avatar" style={`--c-bg:${communityColor(e.name)}`} aria-hidden="true">
                  {communityInitials(e.name)}
                </span>
                <span class="picker-meta">
                  <span class="picker-name">c/{e.name}</span>
                  <span class="picker-title">{e.title}</span>
                </span>
                <span class="picker-count">
                  {e.member_count} {t.community.members}
                </span>
              </a>
            ))}
            {entries.length === 0 && <p class="placeholder">{t.post.noCommunities}</p>}
          </div>
        </div>
      </Layout>,
    )
  })

  app.get('/communities/new', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect(`/login?next=${encodeURIComponent('/communities/new')}`)
    // Board açmak yalnızca yönetim panelinden yapılır.
    if (!isAdminPower(viewer)) {
      setFlash(c, 'error', t.admin.boardCreateOnly)
      return c.redirect('/communities')
    }
    return c.html(
      <Layout title={t.community.create} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
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
    if (!viewer) return c.redirect('/login')
    // Yetki denetimi sunucu tarafında yapılır; formu doğrudan gönselen de engellenir.
    if (!isAdminPower(viewer)) {
      setFlash(c, 'error', t.admin.boardCreateOnly)
      return c.redirect('/communities')
    }
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
    const searchRanks = authorRanksFor(ctx, results.posts.map((p) => p.author_id))
    return c.html(
      <Layout title={`${t.nav.search}: ${query}`} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)}>
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
                  {p.author_username && (
                    <p class="desc">
                      <UserByline username={p.author_username} info={searchRanks.get(p.author_id) ?? null} />
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Layout>,
    )
  })

  /** Eski /u/ adresleri: içerik bozulmasın diye kalıcı olarak yeni adrese gider. */
  app.get('/u/:username', (c) => c.redirect(`/tc/${encodeURIComponent(c.req.param('username'))}`, 301))

  app.get('/tc/:username', (c) => {
    const viewer = c.get('viewer')
    const profile = getProfile(ctx, viewer, c.req.param('username'))
    const now = ctx.now()
    if (!profile) {
      return c.html(
        <Layout title={t.profile.notAvailable} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)}>
          <div class="card empty-state">
            <div class="big">{t.profile.notAvailable}</div>
            <a class="btn" href="/">{t.errors.backHome}</a>
          </div>
        </Layout>,
        404,
      )
    }
    const isSelf = viewer?.id === profile.user.id
    const rawTab = c.req.query('tab')
    const tab: ProfileTab =
      rawTab === 'comments' || rawTab === 'saved' || rawTab === 'about' ? rawTab : 'posts'
    const isModerator = moderatesAnyCommunity(ctx, profile.user.id)
    void isSelf
    const rank = userRankInfo(ctx, getUserById(ctx, profile.user.id) as UserRow)
    return c.html(
      <Layout
        title={`/tc/${profile.user.username}`}
        viewer={viewer}
        unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)}
        flash={takeFlash(c)}
        active="me"
        og={{ title: `/tc/${profile.user.username}`, description: profile.user.bio ?? t.ogDescription }}
      >
        <ProfileView_
          ctx={ctx}
          profile={profile}
          viewer={viewer}
          isModerator={isModerator}
          tab={tab}
          now={now}
          rank={rank}
        />
      </Layout>,
    )
  })

  app.get('/settings', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login?next=%2Fsettings')
    return c.html(
      <Layout title={t.nav.settings} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)} active="me">
        <div class="settings-page">
          <h1 class="settings-title">{t.settings.title}</h1>

          <form class="settings-card" method="post" action="/settings" enctype="multipart/form-data">
            {/* Profil resmi */}
            <div class="settings-row">
              <span class="settings-label">{t.settings.avatar}</span>
              <div class="settings-media">
                {viewer.avatar_key ? (
                  <img class="settings-avatar" src={`/media/${viewer.avatar_key}`} alt={t.profile.avatarAlt} />
                ) : (
                  <span class="settings-avatar" style={`--c-bg:${communityColor(viewer.username)}`}>
                    {communityInitials(viewer.username)}
                  </span>
                )}
                <div class="settings-media-actions">
                  <input
                    class="visually-hidden"
                    id="avatar"
                    name="avatar"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                  />
                  <label class="btn secondary small" for="avatar">{t.settings.changeAvatar}</label>
                  {viewer.avatar_key && (
                    <button class="btn ghost small" type="submit" name="removeAvatar" value="1">
                      {t.settings.remove}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Kapak görseli */}
            <div class="settings-row">
              <span class="settings-label">{t.settings.cover}</span>
              <div class="settings-media">
                {viewer.cover_key ? (
                  <img class="settings-cover" src={`/media/${viewer.cover_key}`} alt={t.profile.coverAlt} />
                ) : (
                  <span class="settings-cover empty">{t.settings.noCover}</span>
                )}
                <div class="settings-media-actions">
                  <input
                    class="visually-hidden"
                    id="cover"
                    name="cover"
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                  />
                  <label class="btn secondary small" for="cover">{t.settings.changeCover}</label>
                  {viewer.cover_key && (
                    <button class="btn ghost small" type="submit" name="removeCover" value="1">
                      {t.settings.remove}
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div class="field">
              <label for="username">{t.settings.username}</label>
              <input id="username" name="username" type="text" minlength={4} maxlength={20} value={viewer.username} required />
              <div class="hint">{t.auth.usernameHint}</div>
            </div>

            <div class="field">
              <label for="displayName">{t.settings.displayName}</label>
              <input id="displayName" name="displayName" type="text" maxlength={40} value={viewer.display_name ?? ''} />
            </div>

            <div class="field">
              <label for="bio">{t.settings.bio}</label>
              <textarea id="bio" name="bio" maxlength={200} rows={4}>{viewer.bio ?? ''}</textarea>
            </div>

            <button class="btn block" type="submit">{t.settings.saveChanges}</button>
          </form>

          {/* Şifre değiştirme ayrı form: mevcut parola doğrulanır. */}
          <form class="settings-card" method="post" action="/settings/password">
            <h2 class="settings-card-title">{t.settings.changePassword}</h2>
            <div class="field">
              <label for="currentPassword">{t.settings.currentPassword}</label>
              <input
                id="currentPassword"
                name="currentPassword"
                type="password"
                required
                autocomplete="current-password"
              />
            </div>
            <div class="field">
              <label for="newPassword">{t.settings.newPassword}</label>
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                required
                minlength={6}
                autocomplete="new-password"
              />
              <div class="hint">{t.auth.passwordHint}</div>
            </div>
            <button class="btn secondary block" type="submit">{t.settings.changePassword}</button>
          </form>

          <p class="settings-danger">
            <a href="/settings/delete-account">{t.profile.deleteAccount}</a>
          </p>
        </div>
      </Layout>,
    )
  })

  /** Profil resmi / kapak yükleme + kullanıcı adı, görünen ad ve biyografi güncellemesi. */
  app.post('/settings', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    let user = viewer
    try {
      const parsed = await c.req.parseBody()
      const text = (key: string): string => (typeof parsed[key] === 'string' ? (parsed[key] as string) : '')

      if (parsed.removeAvatar) {
        user = setProfileImage(ctx, viewer, 'avatar', null)
      }
      if (parsed.removeCover) {
        user = setProfileImage(ctx, viewer, 'cover', null)
      }

      for (const field of ['avatar', 'cover'] as const) {
        const file = parsed[field]
        if (file instanceof File && file.size > 0) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const slot = requestUpload(ctx, viewer)
          await receiveUpload(ctx, slot.key, slot.token, bytes)
          user = setProfileImage(ctx, viewer, field, slot.key)
        }
      }

      if (text('username') && text('username') !== user.username) {
        user = changeUsername(ctx, user, text('username'))
      }
      updateProfile(ctx, user, { displayName: text('displayName'), bio: text('bio') })
      setFlash(c, 'ok', t.settings.saved)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect('/settings')
  })

  app.post('/settings/password', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    const body = await formData(c)
    try {
      await changePassword(
        ctx,
        viewer,
        body.currentPassword ?? '',
        body.newPassword ?? '',
        c.get('sessionToken'),
      )
      setFlash(c, 'ok', t.settings.passwordChanged)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect('/settings')
  })

  app.get('/notifications', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login?next=%2Fnotifications')
    const items = listNotifications(ctx, viewer.id)
    const now = ctx.now()
    // Bildirimi tetikleyen kullanıcının rozetleri yanıt satırında görünür.
    const actors = usersByIds(ctx, items.map((n) => n.actor_id).filter((id): id is string => Boolean(id)))
    const notificationActors = new Map(actors.map((u) => [u.id, u.username]))
    const notificationRanks = rankInfoFor(ctx, actors)
    // Rozet bildirim + DM toplamını gösterdiği için okunmamış sohbetler de
    // burada listelenir; aksi halde "2" rozetine rağmen sayfa boş görünürdü.
    const unreadChats = unreadConversations(ctx, viewer.id)
    const chatRanks = authorRanksFor(ctx, unreadChats.map((chat) => chat.peer.id))
    return c.html(
      <Layout title={t.notifications.title} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)} active="messages">
        <div class="card">
          <h2>{t.notifications.title}</h2>
          {items.length > 0 && (
            <form method="post" action="/notifications/read-all">
              <button class="btn secondary small" type="submit">{t.notifications.markAll}</button>
            </form>
          )}
          {/* Placeholder only when there is truly nothing: no notifications and no unread messages. */}
          {items.length === 0 && unreadChats.length === 0 && <p class="placeholder">{t.notifications.empty}</p>}
          {items.map((n) => (
            <div class={`dir-item${n.read ? ' is-read' : ''}`}>
              <div>
                <a class="name" href={`/notifications/open/${n.id}`}>{n.title}</a>
                <p class="desc">
                  {(n.actor_id && notificationActors.get(n.actor_id)) && (
                    <>
                      <UserByline
                        username={notificationActors.get(n.actor_id as string) as string}
                        info={notificationRanks.get(n.actor_id) ?? null}
                      />{' · '}
                    </>
                  )}
                  {relativeTime(n.created_at, now)}
                </p>
              </div>
            </div>
          ))}
        </div>

        {unreadChats.length > 0 && (
          <div class="card">
            <h2>{t.dm.title}</h2>
            <form method="post" action="/messages/read-all" class="notif-readall">
              <button class="btn secondary small" type="submit">{t.dm.markReadAll}</button>
            </form>
            <ul class="dm-list">
              {unreadChats.map((chat) => (
                <li class="dm-row is-unread" data-unread="1">
                  <Avatar user={chat.peer} size={40} />
                  <span class="dm-row-main">
                    <span class="dm-row-head">
                      <UserByline
                        username={chat.peer.username}
                        info={chatRanks.get(chat.peer.id) ?? null}
                        class="dm-row-name"
                      />
                      <time class="dm-row-time">{relativeTime(chat.lastMessageAt, now)}</time>
                    </span>
                    <span class="dm-row-sub">
                      <a class="dm-row-username" href={profilePath(chat.peer.username)}>
                        @{chat.peer.username}
                      </a>
                      <span class="dm-row-preview">
                        {chat.lastMessageFromMe ? `${t.dm.you}: ` : ''}
                        {chat.lastMessageDeleted ? t.dm.deletedPlaceholder : chat.lastMessage}
                      </span>
                    </span>
                  </span>
                  <a class="dm-row-open" href={`/messages/${chat.id}`} aria-label={t.dm.openChat}>
                    <span class="visually-hidden">{t.dm.openChat}</span>
                  </a>
                  <span class="dm-row-badge">{chat.unread > 99 ? '99+' : chat.unread}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Layout>,
    )
  })

  app.post('/messages/read-all', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    markAllConversationsRead(ctx, viewer.id)
    return c.redirect('/notifications')
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
    return c.html(        <Layout title={t.footer.privacy} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)}>
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
