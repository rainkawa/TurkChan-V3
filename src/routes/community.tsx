import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t, visibilityLabel } from '../i18n/tr'
import { Layout } from '../views/layout'
import { PostCard, SortTabs } from '../views/components'
import { referenceMapsForFeed } from '../services/references'
import { authorRanksFor } from '../services/users'
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
import {  createTextPost,
  createMediaPost, createLinkPost, findDuplicateLinkPost } from '../services/posts'
import { requestUpload, receiveUpload } from '../services/uploads'
import { decodeCursor } from '../lib/cursor'
import { AppError } from '../services/errors'
import { ValidationError } from '../lib/validation'
import { parseSort, parseWindow } from './main'
import { FeedFilterBar } from '../views/components'
import { listFlairs, createFlair, deleteFlair, assertFlairCount } from '../services/flairs'
import { flairFilterOptions } from '../services/feeds'
import { profilePath } from '../views/helpers'
import { type AppEnv, dmUnread, formData, loginRedirect, setFlash, takeFlash, unread } from './helpers'
import type { CommunityRow, UserRow } from '../types'

/** Kompozitörde sunulan gönderi türleri. */
const POST_TYPES = ['text', 'link', 'image', 'gif', 'video'] as const
type PostType = (typeof POST_TYPES)[number]

const POST_TYPE_LABEL: Record<PostType, string> = {
  text: t.post.typeText,
  link: t.post.typeLink,
  image: t.post.typeImage,
  gif: t.post.typeGif,
  video: t.post.typeVideo,
}

/** accept özniteliği: her türün kabul ettiği MIME'ler. */
const POST_TYPE_ACCEPT: Record<PostType, string> = {
  text: '',
  link: '',
  image: 'image/jpeg,image/png,image/webp',
  gif: 'image/gif',
  video: 'video/mp4,video/webm',
}

function isPostType(raw: string | undefined | null): raw is PostType {
  return !!raw && (POST_TYPES as readonly string[]).includes(raw)
}

/** multipart gövdesindeki tek veya çoklu dosya alanını dosya listesine çevirir. */
function collectFiles(form: FormData, field: string): File[] {
  const out: File[] = []
  for (const value of form.getAll(field)) {
    if (value instanceof File && value.size > 0) out.push(value)
  }
  return out
}

const PostTypeTabs = ({ name, active }: { name: string; active: string }) => (
  <nav class="type-tabs">
    {POST_TYPES.map((type) => (
      <a href={`/c/${name}/submit?type=${type}`} class={active === type ? 'active' : ''}>
        {POST_TYPE_LABEL[type]}
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
        <Layout title={t.community.privateTitle} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
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
    const flairId = c.req.query('flair') ?? null
    const page = communityFeed(ctx, viewer, community, sort, window, cursor, 25, flairId)
    const allIds = [...page.pinned, ...page.items].map((i) => i.id)
    const myVotes = getMyVotes(ctx, viewer, 'post', allIds)
    const rules = listRules(ctx, community.id)
    const moderators = listModerators(ctx, community.id)
    const members = memberCount(ctx, community.id)
    const now = ctx.now()
    const authorRanks = authorRanksFor(ctx, [...page.pinned, ...page.items].map((i) => i.author_id))
    const flairs = listFlairs(ctx, community.id)
    const flairById = new Map(flairs.map((f) => [f.id, f]))
    const flairCounts = flairFilterOptions(ctx, [community.id])
    const extraQuery = flairId ? `&flair=${encodeURIComponent(flairId)}` : ''
    // `>>123` referansları tek sorguda çözülür (N+1 yok).
    const refsByPost = referenceMapsForFeed(ctx, community.id, [...page.pinned, ...page.items])

    // Sonsuz kaydırma için kart listesinin devamı.
    if (c.req.query('partial') === '1' && cursor) {
      return c.html(
        <div data-feed-page="board-feed">
          {page.items.map((item) => (
            <PostCard
              item={item}
              now={now}
              viewer={viewer}
              myVote={myVotes.get(item.id) ?? 0}
              showCommunity={false}
              authorRanks={authorRanks}
              flair={item.flair_id ? flairById.get(item.flair_id) ?? null : null}
              refs={refsByPost.get(item.id)}
            />
          ))}
        </div>,
      )
    }

    return c.html(
      <Layout
        title={community.title}
        viewer={viewer}
        unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)}
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
          /*
            * Tek, toplu yönetim alanı. Eskiden dört ayrı buton yatay dizi
            * hâlinde dağılıyordu; mobilde gereksiz boşluk bırakıyordu.
            * Yetki kontrolü aynı kalır: yalnızca `state.isMod` doğruysa
            * render edilir, her bağlantı sunucu tarafında da korunur.
            */
          <details class="mod-tools">
            <summary class="mod-tools-summary">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3 4 6.5v5c0 4.5 3.2 8.2 8 9.5 4.8-1.3 8-5 8-9.5v-5L12 3Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
                <path d="M9.2 12.2 11.2 14.2 15 10.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>{t.community.manage}</span>
              <svg class="mod-tools-caret" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </summary>
            <div class="mod-tools-menu">
              <a href={`/c/${community.name}/mod/queue`}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M5 21V4m0 0 7 4v13M5 4l13 7-3 3-10-7Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
                </svg>
                <span>{t.community.modQueue}</span>
              </a>
              <a href={`/c/${community.name}/mod/members`}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="1.8" />
                  <path d="M3.5 19c0-3 2.4-5 5.5-5s5.5 2 5.5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                <span>{t.community.approvals}</span>
              </a>
              <a href={`/c/${community.name}/mod/log`}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" />
                  <path d="M8 9h8M8 13h8M8 17h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                <span>{t.community.modLog}</span>
              </a>
              <a href={`/c/${community.name}/settings`}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8" />
                  <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
                <span>{t.community.settings}</span>
              </a>
            </div>
          </details>
        )}
        <div class="layout with-sidebar">
          <section>
            {/* Sıralama sekmeleri + Filtre aynı satırda. */}
            <div class="feed-head">
              <SortTabs basePath={`/c/${community.name}`} sort={sort} window={window} extraQuery={extraQuery} />
              <FeedFilterBar
                basePath={`/c/${community.name}`}
                sort={sort}
                window={window}
                flairId={flairId}
                communityId={null}
                flairs={flairCounts}
              />
            </div>

            {/* Boardda sabitlenmiş gönderiler akışın başında ayrı gösterilir. */}
            {page.pinned.length > 0 && (
              <section class="pinned-section" aria-label={t.feed.pinnedInBoard}>
                <h2 class="pinned-title">📌 {t.feed.pinnedInBoard}</h2>
                <div class="feed">
                  {page.pinned.map((item) => (
                    <PostCard
                      item={item}
                      now={now}
                      viewer={viewer}
                      myVote={myVotes.get(item.id) ?? 0}
                      showCommunity={false}
                      authorRanks={authorRanks}
                      flair={item.flair_id ? flairById.get(item.flair_id) ?? null : null}
              refs={refsByPost.get(item.id)}
                      pinned
                    />
                  ))}
                </div>
              </section>
            )}

            <div
              class="feed"
              id="board-feed"
              data-feed
              data-next-cursor={page.nextCursor ?? ''}
              data-feed-url={`/c/${community.name}?sort=${sort}&t=${window}${extraQuery}`}
            >
              {page.items.length === 0 && page.pinned.length === 0 && (
                <div class="card empty-state"><div class="big">{flairId ? t.feed.emptyFilters : t.feed.emptyCommunity}</div></div>
              )}
              {page.items.map((item) => (
                <PostCard
                  item={item}
                  now={now}
                  viewer={viewer}
                  myVote={myVotes.get(item.id) ?? 0}
                  showCommunity={false}
                  authorRanks={authorRanks}
                  flair={item.flair_id ? flairById.get(item.flair_id) ?? null : null}
              refs={refsByPost.get(item.id)}
                />
              ))}
            </div>
            <div class="feed-status" data-feed-status>
              {page.nextCursor ? (
                <>
                  <span class="feed-spinner" aria-hidden="true" />
                  <span class="feed-status-text">{t.feed.loading}</span>
                  <a
                    class="btn secondary small"
                    href={`/c/${community.name}?sort=${sort}&t=${window}${extraQuery}&after=${page.nextCursor}`}
                  >
                    {t.feed.loadMore}
                  </a>
                </>
              ) : (
                page.items.length + page.pinned.length > 0 && <span class="feed-status-text">{t.feed.allLoaded}</span>
              )}
            </div>
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
    const type = isPostType(c.req.query('type')) ? c.req.query('type') as PostType : 'text'
    const flairs = listFlairs(ctx, community.id)
    const isMedia = type === 'image' || type === 'gif' || type === 'video'
    const anonDefault = viewer.anon_by_default === 1
    return c.html(
      <Layout title={t.post.submit} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card submit-card">
          <h2 class="submit-card-title">{t.post.submit} <span class="submit-card-board">c/{community.name}</span></h2>
          <PostTypeTabs name={community.name} active={type} />
          <form
            method="post"
            action={`/c/${community.name}/submit?type=${type}`}
            enctype={isMedia ? 'multipart/form-data' : undefined}
            data-draft-key={`${community.name}:${type}`}
          >
            <div class="field">
              <label for="title">{t.post.title}</label>
              <input id="title" name="title" type="text" required maxlength={300} />
            </div>
            {type === 'link' && (
              <div class="field field-link">
                <label for="url">
                  <svg class="field-link-icon" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7l-1.3 1.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                    <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                  </svg>
                  <span>{t.post.url}</span>
                </label>
                <input id="url" name="url" type="url" required placeholder="https://" />
                <div class="hint">{t.post.urlHint}</div>
              </div>
            )}
            {isMedia && (
              <div class="field">
                {/*
                  Dosya girdisi `display:none` ile gizlenir ve `required`
                  KALDIRILIR: görünmez ama odaklanamayan bir required alan,
                  tarayıcının yerel doğrulamasını takılıp formu göndermeden
                  "erişim gerekli" uyarısı üretiyordu.
                  Alan gerçek bir <label for> ile tıklanabilir; dosya seçiciyi
                  JavaScript OLMADAN da açar. Zorunluluk sunucuda zaten var
                  (dosya yoksa 400).
                */}
                <input
                  class="media-input"
                  id="image"
                  name="image"
                  type="file"
                  accept={POST_TYPE_ACCEPT[type]}
                  multiple={type === 'image'}
                  data-media-input
                />
                <label class="media-drop" for="image" data-media-drop>
                  <span class="media-drop-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
                    </svg>
                  </span>
                  <span class="media-drop-text">
                    <span class="media-drop-title">{t.post.addMedia}</span>
                    <span class="media-drop-hint" id="media-hint">
                      {type === 'video' ? t.post.videoHint : type === 'gif' ? t.post.gifHint : t.post.imageHint}
                    </span>
                  </span>
                  <span class="media-drop-cta" data-media-cta>{t.post.chooseFile}</span>
                </label>
                {/* Seçilen dosyaların önizlemesi; JS ile doldurulur. */}
                <div class="media-preview" data-media-preview hidden></div>
              </div>
            )}
            <div class="field">
              <label for="body">{t.post.body}</label>
              <textarea id="body" name="body" maxlength={40000}></textarea>
              <button class="btn secondary small" type="button" data-md-preview="body" data-md-target="body-preview" style="margin-top:0.5rem">
                {t.post.preview}
              </button>
              <div id="body-preview" class="md card" style="display:none;margin-top:0.5rem"></div>
            </div>
            <div class="field post-extra-fields">
              <label class="checkbox">
                <input type="checkbox" name="spoiler" value="1" />
                <span>{t.feed.spoilerHidden}</span>
              </label>
              <label class="checkbox">
                <input type="checkbox" name="anonymous" value="1" checked={anonDefault} />
                <span>{t.post.anonymous}</span>
              </label>
              {flairs.length > 0 && (
                <div class="field">
                  <label for="flair">{t.feed.flairPick}</label>
                  <select id="flair" name="flairId">
                    <option value="">{t.feed.flairNone}</option>
                    {flairs.map((f) => (
                      <option value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
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
    const safeType: PostType = isPostType(type) ? type : 'text'
    try {
      if (safeType === 'link') {
        const body = await formData(c)
        const url = (body.url ?? '').trim()
        const duplicate = findDuplicateLinkPost(ctx, community, url)
        const { post } = await createLinkPost(ctx, viewer, community, {
          title: body.title ?? '',
          url,
          body: body.body ?? '',
          spoiler: body.spoiler === '1',
          flairId: body.flairId ?? null,
          anonymous: body.anonymous === '1',
        })
        if (duplicate) {
          // Non-blocking duplicate warning (US-014).
          setFlash(c, 'warn', `${t.post.duplicateWarning} /c/${community.name}/comments/${duplicate.id}`)
        }
        return c.redirect(`/c/${community.name}/comments/${post.id}`)
      }
      if (safeType === 'image' || safeType === 'gif' || safeType === 'video') {
        const allowed = safeType === 'gif' ? (['gif'] as const) : safeType === 'video' ? (['video'] as const) : (['image'] as const)
        const parsed = await c.req.formData()
        const files = collectFiles(parsed, 'image')
        if (files.length === 0) throw new AppError(400, 'image', t.post.pickFile)
        const keys: string[] = []
        for (const file of files) {
          const bytes = new Uint8Array(await file.arrayBuffer())
          const slot = requestUpload(ctx, viewer)
          await receiveUpload(ctx, slot.key, slot.token, bytes, [...allowed])
          keys.push(slot.key)
        }
        const post = createMediaPost(ctx, viewer, community, {
          title: (parsed.get('title') as string) ?? '',
          body: (parsed.get('body') as string) ?? '',
          keys,
          spoiler: parsed.get('spoiler') === '1',
          flairId: (parsed.get('flairId') as string) || null,
          anonymous: parsed.get('anonymous') === '1',
        })
        return c.redirect(`/c/${community.name}/comments/${post.id}`)
      }
      const body = await formData(c)
      const post = createTextPost(ctx, viewer, community, {
        title: body.title ?? '',
        body: body.body ?? '',
        spoiler: body.spoiler === '1',
        flairId: body.flairId ?? null,
        anonymous: body.anonymous === '1',
      })
      return c.redirect(`/c/${community.name}/comments/${post.id}`)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/c/${community.name}/submit?type=${safeType}`)
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
    const flairs = listFlairs(ctx, community.id)
    return c.html(
      <Layout title={t.community.settings} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
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

        <div class="card">
          <h2>{t.feed.flairManage} — c/{community.name}</h2>
          <p class="hint">{t.feed.flairLimit}</p>
          <ul class="flair-admin-list">
            {flairs.map((f) => (
              <li class="flair-admin-item">
                <span
                  class={`post-flair${f.color ? ' has-color' : ''}`}
                  style={f.color ? `--flair-bg:${f.color}` : undefined}
                >
                  {f.name}
                </span>
                <form method="post" action={`/c/${community.name}/flairs/${f.id}/delete`} style="display:inline">
                  <button class="btn danger small" type="submit">{t.common.delete}</button>
                </form>
              </li>
            ))}
            {flairs.length === 0 && <p class="placeholder">{t.feed.flairNone}</p>}
          </ul>
          <form method="post" action={`/c/${community.name}/flairs`} class="flair-create-form">
            <div class="field">
              <label for="flair-name">{t.feed.flairName}</label>
              <input id="flair-name" name="name" type="text" required maxlength={24} />
            </div>
            <div class="field">
              <label for="flair-color">{t.feed.flairColor}</label>
              <input id="flair-color" name="color" type="text" placeholder="#0f6b62" pattern="#[0-9a-fA-F]{6}" />
            </div>
            <button class="btn" type="submit">{t.feed.flairCreated}</button>
          </form>
        </div>
      </Layout>,
    )
  })

  /** Board etiketi oluştur (yalnızca moderatörler). */
  app.post('/c/:name/flairs', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    const body = await formData(c)
    try {
      assertFlairCount(ctx, community.id)
      createFlair(ctx, community.id, viewer, { name: body.name ?? '', color: body.color ?? '' })
      setFlash(c, 'ok', t.feed.flairCreated)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) setFlash(c, 'error', err.message)
      else throw err
    }
    return c.redirect(`/c/${community.name}/settings`)
  })

  app.post('/c/:name/flairs/:flairId/delete', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return loginRedirect(c)
    const community = requireVisibleCommunity(ctx, viewer, c.req.param('name'))
    try {
      deleteFlair(ctx, community.id, viewer, c.req.param('flairId'))
      setFlash(c, 'ok', t.feed.flairDeleted)
    } catch (err) {
      if (err instanceof AppError) setFlash(c, 'error', err.message)
    }
    return c.redirect(`/c/${community.name}/settings`)
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
