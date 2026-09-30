import type { FC } from 'hono/jsx'
import { t, relativeTime } from '../i18n/tr'
import { previewText, communityColor, communityInitials, profilePath } from './helpers'
import type { FeedItem } from '../services/feeds'
import type { CommunityMembershipState } from '../services/communities'
import type { CommentNode } from '../services/comments'
import type { UserRank } from '../services/ranks'
import { RankBadges } from './rank'
import { renderMarkdown } from '../lib/markdown'
import type { UserRow, FlairRow } from '../types'
import { embedSrcFor, mediaKindForUrl } from '../lib/media'

export const VoteRail: FC<{
  targetType: 'post' | 'comment'
  targetId: string
  score: number
  myVote: number
  disabled?: boolean
  guest?: boolean
  scoreHidden?: boolean
  /** 'vertical' (yorum ağacı) veya 'horizontal' (kart aksiyon çubuğu). */
  layout?: 'vertical' | 'horizontal'
}> = ({
  targetType,
  targetId,
  score,
  myVote,
  disabled = false,
  guest = false,
  scoreHidden = false,
  layout = 'vertical',
}) => (
  <div
    class={`vote-rail ${layout}`}
    data-target-type={targetType}
    data-target-id={targetId}
    data-my-vote={String(myVote)}
    data-guest={guest ? '1' : '0'}
  >
    <button class="vote-btn up" type="button" data-value="1" data-active={myVote === 1 ? '1' : '0'} disabled={disabled} aria-label="Beğen">
      ▲
    </button>
    <span class="vote-score" data-score={String(score)} data-hidden={scoreHidden ? '1' : '0'}>
      {scoreHidden ? '·' : score}
    </span>
    <button class="vote-btn down" type="button" data-value="-1" data-active={myVote === -1 ? '1' : '0'} disabled={disabled} aria-label="Beğenme">
      ▼
    </button>
  </div>
)

export const PostCard: FC<{
  item: FeedItem
  now: number
  myVote: number
  viewer: UserRow | null
  showCommunity?: boolean
  pinned?: boolean
  /** Bu gönderinin çözülmüş `>>123` referansları (numara → gönderi kimliği). */
  refs?: Map<number, string>
  /** Yazarın rütbesi / yetkisi (author_id ile eşleşir). */
  authorRanks?: Map<string, UserRank>
  /** Gönderinin board etiketi. */
  flair?: FlairRow | null
  /** Gönderinin ekli medya dosyaları (çoklu görsel/GIF/video). */
  media?: Array<{ key: string; kind: 'image' | 'gif' | 'video'; mime: string | null }>
}> = ({ item, now, myVote, viewer, showCommunity = true, pinned = false, authorRanks, flair, media, refs }) => {
  const isOwn = viewer?.id === item.author_id
  const authorRank = authorRanks?.get(item.author_id) ?? null
  const thumb =
    item.type === 'image' && item.image_key
      ? `/media/${item.image_key}`
      : item.type === 'link'
        ? item.link_preview_image
        : null
  // Board kartında doğrudan medya bağlantıları da oynatılır.
  const cardKind = item.media_kind && item.media_kind !== 'none' ? item.media_kind : item.type === 'link' ? mediaKindForUrl(item.url) : 'none'
  const cardSrc = (cardKind === 'video' || cardKind === 'gif') && !thumb && item.type === 'link' ? item.url : thumb
  return (
    <article class={`post-card${pinned ? ' pinned' : ''}`}>
      <VoteRail targetType="post" targetId={item.id} score={item.score} myVote={myVote} guest={!viewer} disabled={isOwn} />
      <div>      {pinned && <span class="pin-tag">📌 {t.feed.pinned}</span>}

        {flair && (
          <a
            class={`post-flair${flair.color ? ' has-color' : ''}`}
            href={`/c/${item.community_name}?flair=${encodeURIComponent(flair.id)}`}
            style={flair.color ? `--flair-bg:${flair.color}` : undefined}
          >
            {flair.name}
          </a>
        )}

        {item.spoiler === 1 && (
          <div class="social-card-spoiler" data-spoiler="1">
            <button class="spoiler-reveal" type="button" data-spoiler-toggle aria-expanded="false">
              <span class="spoiler-hint">{t.feed.spoilerHidden}</span>
              <span class="spoiler-cta">{t.feed.spoilerReveal}</span>
            </button>
            <div class="spoiler-body" hidden>
              <CardBodyPreview item={item} refs={refs} />
            <MediaPreview
              kind={cardKind}
              src={cardSrc}
              embed={embedSrcFor(item.url)}
                poster={item.link_preview_image}
                title={item.title}
                href={`/c/${item.community_name}/comments/${item.id}`}
              />
            </div>
          </div>
        )}

        <div class="meta">
          {showCommunity && <a href={`/c/${item.community_name}`}>c/{item.community_name}</a>}
          <span class="user-byline">
            {item.author_username ? (
              item.anon === 1 ? (
                <span class="anon-author" title={t.post.anonBylineHint}>
                  {t.post.anonByline} · <b>{item.author_username}</b>
                </span>
              ) : (
                <>
                  <a href={profilePath(item.author_username)}>/tc/{item.author_username}</a>
                  <RankBadges info={authorRank} />
                </>
              )
            ) : (
              t.post.deletedBody
            )}
          </span>
          <span>{relativeTime(item.created_at, now)}</span>
          {item.edited_at !== null && <span>({t.post.edited})</span>}
        </div>
        <h3 class="post-title">
          <a href={`/c/${item.community_name}/comments/${item.id}`}>{item.title}</a>
          {item.type === 'link' && item.url && (
            <>
              {' '}
              <a href={item.url} rel="nofollow noopener" style="font-size:0.75rem;font-weight:400">
                ({safeHost(item.url)})
              </a>
            </>
          )}
        </h3>
        {item.spoiler !== 1 && (
          <>
            {media && media.length > 0 ? (
              <MediaGallery items={media.slice(0, 4)} title={item.title} compact />
            ) : (
              <MediaPreview
                kind={cardKind}
                src={cardSrc}
                embed={embedSrcFor(item.url)}
                poster={item.link_preview_image}
                title={item.title}
                href={`/c/${item.community_name}/comments/${item.id}`}
              />
            )}
          </>
        )}
        <div class="post-actions">
          <a href={`/c/${item.community_name}/comments/${item.id}`}>
            💬 {item.comment_count} {t.feed.comments}
          </a>
        </div>
      </div>
    </article>
  )
}

export const CommunityAvatar: FC<{ name: string; size?: number }> = ({ name, size = 36 }) => (
  <span
    class="c-avatar"
    style={`--c-size:${String(size)}px;--c-bg:${communityColor(name)}`}
    aria-hidden="true"
  >
    {communityInitials(name)}
  </span>
)

/** Topluluk adına göre Katıl / İstek gönderildi düğmesi (yalnızca üye değilse). */
const JoinButton: FC<{ community: string; state: CommunityMembershipState; compact?: boolean }> = ({
  community,
  state,
  compact = false,
}) => {
  if (state === 'approved') return null
  if (state === 'pending') {
    return <span class={`join-pill pending${compact ? ' small' : ''}`}>{t.card.requested}</span>
  }
  return (
    <form method="post" action={`/c/${community}/join`} class="join-form">
      <button class={`join-pill${compact ? ' small' : ''}`} type="submit">{t.card.join}</button>
    </form>
  )
}

/** Kırık/şüpheli bağlantılarda kartın patlamaması için güvenli alan adı. */
function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}

/**
 * Gönderi önizlemesi: görsel, GIF, doğrudan video ve gömülü video
 * (YouTube/Vimeo/X) ayrı ayrı çizilir. Hiçbir medya yoksa hiçbir şey
 * basılmaz.
 */
/** Bir gönderinin çoklu medya listesi (galeri düzeni). */
export const MediaGallery: FC<{
  items: Array<{ key: string; kind: 'image' | 'gif' | 'video'; mime: string | null }>
  title: string
  compact?: boolean
}> = ({ items, title, compact = false }) => {
  if (items.length === 0) return null
  return (
    <div class={`media-gallery${compact ? ' compact' : ''}`} data-gallery={String(items.length)}>
      {items.map((m) => {
        const src = `/media/${m.key}`
        if (m.kind === 'video') {
          return (
            <div class="media-item is-video">
              <video src={src} controls preload="none" playsinline poster={undefined} />
            </div>
          )
        }
        return (
          <a class={`media-item${m.kind === 'gif' ? ' is-gif' : ''}`} href={src} target="_blank" rel="noopener">
            {/* Akışta küçük resim yüklenir; tam boyut yalnızca tıklanınca. */}
            <img src={m.kind === 'image' ? `${src}?variant=thumb` : src} alt={title} loading="lazy" decoding="async" />
            {m.kind === 'gif' && <span class="media-badge">{t.feed.previewGif}</span>}
          </a>
        )
      })}
    </div>
  )
}

/** Bir medya öğesi (detay sayfasında spoiler'ın altında). */
export const SingleMedia: FC<{ key: string; kind: 'image' | 'gif' | 'video' }> = ({ key, kind }) => {
  const src = `/media/${key}`
  if (kind === 'video') {
    return <video class="post-media-video" src={src} controls preload="metadata" playsinline />
  }
  return (
    <div class={`post-media${kind === 'gif' ? ' is-gif' : ''}`}>
      <img src={src} alt="" />
      {kind === 'gif' && <span class="media-badge">{t.feed.previewGif}</span>}
    </div>
  )
}

const MediaPreview: FC<{
  kind: 'none' | 'image' | 'gif' | 'video' | 'embed'
  src: string | null
  embed: string | null
  poster: string | null
  title: string
  href: string
}> = ({ kind, src, embed, poster, title, href }) => {
  if (kind === 'embed' && embed) {
    return (
      <div class="social-card-media is-embed">
        <iframe
          src={embed}
          title={title}
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        />
      </div>
    )
  }
  if (kind === 'video' && src) {
    return (
      <div class="social-card-media is-video">
        <video src={src} poster={poster ?? undefined} controls preload="none" playsinline>
          Tarayıcınız video etiketini desteklemiyor.
        </video>
        <a class="media-fallback" href={href}>
          {t.feed.previewVideo}
        </a>
      </div>
    )
  }
  if (src) {
    return (
      <a class={`social-card-media${kind === 'gif' ? ' is-gif' : ''}`} href={href}>
        {/* Akış kartı küçük resim kullanır; bağlantı tam boyuta gider. */}
        <img src={kind === 'image' ? `${src}?variant=thumb` : src} alt={title} loading="lazy" decoding="async" />
        {kind === 'gif' && <span class="media-badge">{t.feed.previewGif}</span>}
      </a>
    )
  }
  return null
}

/**
 * Mobil öncelikli sosyal gönderi kartı. Gerçek veriyi gösterir; kaydetme ve
 * paylaşma tarayıcı tarafında çalışır (public/app.js).
 */
/**
 * Gövde önizlemesi. `>>123` referansı çözülmüşse markdown olarak bağlantıya
 * dönüşür; çözülmemişse güvenli düz metin olarak gösterilir.
 */
const CardBodyPreview: FC<{ item: FeedItem; refs?: Map<number, string> }> = ({ item, refs }) => {
  if (refs && refs.size > 0) return <Markdown source={item.body ?? ''} refs={refs} />
  return <p class="social-card-preview">{previewText(item.body)}</p>
}

export const SocialCard: FC<{
  item: FeedItem
  now: number
  myVote: number
  viewer: UserRow | null
  membership?: CommunityMembershipState
  showCommunity?: boolean
  pinned?: boolean
  /** Yazarın rütbesi / yetkisi (author_id ile eşleşir). */
  authorRanks?: Map<string, UserRank>
  /** Gönderinin board etiketi. */
  flair?: FlairRow | null
  /** Gönderinin ekli medya dosyaları (çoklu görsel/GIF/video). */
  media?: Array<{ key: string; kind: 'image' | 'gif' | 'video'; mime: string | null }>
  /** Bu gönderinin çözülmüş `>>123` referansları (numara → gönderi kimliği). */
  refs?: Map<number, string>
}> = ({ item, now, myVote, viewer, membership = 'none', showCommunity = true, pinned = false, authorRanks, flair, media, refs }) => {
  const isOwn = viewer?.id === item.author_id
  const authorRank = authorRanks?.get(item.author_id) ?? null
  const href = `/c/${item.community_name}/comments/${item.id}`
  const preview = previewText(item.body)
  const spoiler = item.spoiler === 1
  const mediaSrc =
    item.type === 'image' && item.image_key
      ? `/media/${item.image_key}`
      : item.type === 'link'
        ? item.link_preview_image
        : null
  // Link gönderilerinde bağlantının türüne göre GIF / video / gömülü oynatıcı
  // gösterilir; görsel gönderilerde yüklenen dosya doğrudan oynatılır.
  const linkKind = item.type === 'link' ? mediaKindForUrl(item.url) : 'none'
  const kind = item.media_kind && item.media_kind !== 'none' ? item.media_kind : linkKind
  const embedSrc = spoiler ? null : embedSrcFor(item.url)
  // Doğrudan video/GIF bağlantılarında önizleme görseli yoktur; dosyanın
  // kendisi oynatıcıya kaynak olur.
  const playableSrc =
    (kind === 'video' || kind === 'gif') && !mediaSrc && item.type === 'link' ? item.url : mediaSrc

  return (
    <article class={`social-card${pinned ? ' pinned' : ''}`} data-post-id={item.id}>
      <header class="social-card-head">
        <a class="social-card-community" href={`/c/${item.community_name}`}>
          <CommunityAvatar name={item.community_name} />
          <span class="social-card-community-meta">
            <span class="social-card-community-name">c/{item.community_name}</span>
            <span class="social-card-time">
              {relativeTime(item.created_at, now)}
              {item.edited_at !== null && ` · (${t.post.edited})`}
            </span>
          </span>
        </a>
        <div class="social-card-head-actions">
          {showCommunity && viewer && !isOwn && <JoinButton community={item.community_name} state={membership} compact />}
          <details class="overflow-menu">
            <summary aria-label={t.card.more} title={t.card.more}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="12" r="2" fill="currentColor" />
                <circle cx="12" cy="12" r="2" fill="currentColor" />
                <circle cx="19" cy="12" r="2" fill="currentColor" />
              </svg>
            </summary>
            <div class="overflow-panel">
              <a href={href}>{t.card.goToPost}</a>
              <a href={`/c/${item.community_name}`}>{t.card.openCommunity}</a>
              <button type="button" data-share={href}>{t.card.share}</button>
              <button type="button" data-save-post={item.id} data-save-title={item.title}>
                {t.card.save}
              </button>
              {viewer && !isOwn && <a href={`/report/post/${item.id}`}>{t.card.report}</a>}
            </div>
          </details>
        </div>
      </header>

      {pinned && <span class="pin-tag">📌 {t.feed.pinned}</span>}

      <h3 class="social-card-title">
        <a href={href}>{item.title}</a>
      </h3>

      {/* Etiket (flair) rozeti */}
      {flair && (
        <a
          class={`post-flair${flair.color ? ' has-color' : ''}`}
          href={`/c/${item.community_name}?flair=${encodeURIComponent(flair.id)}`}
          style={flair.color ? `--flair-bg:${flair.color}` : undefined}
        >
          {flair.name}
        </a>
      )}

      {spoiler ? (
        <div class="social-card-spoiler" data-spoiler="1">
          <button class="spoiler-reveal" type="button" data-spoiler-toggle aria-expanded="false">
            <span class="spoiler-hint">{t.feed.spoilerHidden}</span>
            <span class="spoiler-cta">{t.feed.spoilerReveal}</span>
          </button>
          <div class="spoiler-body" hidden>
            {preview && <CardBodyPreview item={item} refs={refs} />}
            {item.type === 'link' && item.url && (
              <a class="social-card-link" href={item.url} rel="nofollow noopener" target="_blank">
                {item.link_preview_title ?? item.url}
                <span class="social-card-link-host">{safeHost(item.url)}</span>
              </a>
            )}
            <MediaPreview kind={kind} src={playableSrc} embed={embedSrc} poster={mediaSrc} title={item.title} href={href} />
          </div>
        </div>
      ) : media && media.length > 0 ? (
        <MediaGallery items={media} title={item.title} />
      ) : (
        <>
          {preview && <CardBodyPreview item={item} refs={refs} />}

          {item.type === 'link' && item.url && (
            <a class="social-card-link" href={item.url} rel="nofollow noopener" target="_blank">
              {item.link_preview_title ?? item.url}
              <span class="social-card-link-host">{safeHost(item.url)}</span>
            </a>
          )}

          <MediaPreview kind={kind} src={playableSrc} embed={embedSrc} poster={mediaSrc} title={item.title} href={href} />
        </>
      )}

      <div class="social-card-author">
        {item.author_username ? (
          <span class="user-byline">
            {item.anon === 1 ? (
              // Anonim gönderilerde gerçek hesaba link verilmez, rütbe gizlenir.
              <span class="anon-author" title={t.post.anonBylineHint}>
                {t.post.anonByline} · <b>{item.author_username}</b>
              </span>
            ) : (
              <>
                <a href={profilePath(item.author_username)}>/tc/{item.author_username}</a>
                <RankBadges info={authorRank} />
              </>
            )}
          </span>
        ) : (
          <span class="placeholder">{t.post.deletedBody}</span>
        )}
      </div>

      <div class="social-card-actions">
        <VoteRail
          targetType="post"
          targetId={item.id}
          score={item.score}
          myVote={myVote}
          guest={!viewer}
          disabled={isOwn}
          scoreHidden={false}
          layout="horizontal"
        />
        <a class="action-btn" href={href}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a7.5 7.5 0 0 1-11 6.6L4 20l1.4-4.6A7.5 7.5 0 1 1 20 12Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          </svg>
          <span>{item.comment_count} {t.feed.comments}</span>
        </a>
        <button class="action-btn" type="button" data-share={href}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15V4m0 0L8 8m4-4 4 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <span>{t.card.share}</span>
        </button>
        <button
          class="action-btn"
          type="button"
          data-save-post={item.id}
          data-save-title={item.title}
          data-save-href={href}
          data-save-community={item.community_name}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M7 4h10v16l-5-4-5 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" />
          </svg>
          <span data-save-label>{t.card.save}</span>
        </button>
      </div>
    </article>
  )
}

/**
 * Akış filtre çubuğu: board ve etiket seçimi, sıralamayı koruyarak
 * bağlantı olarak sunar (JS gerekmez).
 */
export const FeedFilterBar: FC<{
  basePath: string
  sort: string
  window: string
  flairId: string | null
  communityId: string | null
  flairs: Array<{ id: string; name: string; count: number }>
  boards?: Array<{ name: string; title: string }>
}> = ({ basePath, sort, window: topWindow, flairId, communityId, flairs, boards = [] }) => {
  const link = (patch: { flair?: string | null; c?: string | null }) => {
    const params = new URLSearchParams({ sort, t: topWindow })
    const nextFlair = patch.flair === undefined ? flairId : patch.flair
    const nextBoard = patch.c === undefined ? communityId : patch.c
    if (nextFlair) params.set('flair', nextFlair)
    if (nextBoard) params.set('c', nextBoard)
    return `${basePath}?${params.toString()}`
  }
  const active = Boolean(flairId || communityId)
  return (
    <div class="feed-filters" data-feed-filters>
      <details class="feed-filter-details">
        <summary class="feed-filter-summary">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 6h16M7 12h10M10 18h4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <span>{t.feed.filterLabel}</span>
          {active && <span class="filter-dot" aria-hidden="true" />}
        </summary>
        <div class="feed-filter-panel">
          <div class="feed-filter-group">
            <span class="feed-filter-label">{t.feed.filterBoard}</span>
            <div class="filter-chips">
              <a class={`filter-chip${communityId ? '' : ' active'}`} href={link({ c: null })}>
                {t.feed.allBoards}
              </a>
              {boards.map((b) => (
                <a class={`filter-chip${communityId === b.name ? ' active' : ''}`} href={link({ c: b.name })}>
                  b/{b.name}
                </a>
              ))}
            </div>
          </div>
          {flairs.length > 0 && (
            <div class="feed-filter-group">
              <span class="feed-filter-label">{t.feed.filterFlair}</span>
              <div class="filter-chips">
                <a class={`filter-chip${flairId ? '' : ' active'}`} href={link({ flair: null })}>
                  {t.feed.allFlairs}
                </a>
                {flairs.map((f) => (
                  <a class={`filter-chip${flairId === f.id ? ' active' : ''}`} href={link({ flair: f.id })}>
                    {f.name} <span class="chip-count">{f.count}</span>
                  </a>
                ))}
              </div>
            </div>
          )}
          {active && (
            <a class="btn secondary small" href={`${basePath}?sort=${sort}&t=${topWindow}`}>
              {t.feed.clearFilters}
            </a>
          )}
        </div>
      </details>
    </div>
  )
}

/** Kişiselleştirilmiş akışta "ilgimi azalt" kontrolleri. */
export const AffinityPanel: FC<{
  viewer: UserRow | null
  sort: string
  window: string
  boards: Array<{ name: string; title: string; affinity: number }>
}> = ({ viewer, sort, window: topWindow, boards }) => {
  if (!viewer || boards.length === 0) return null
  return (
    <div class="card">
      <h3>{t.feed.customize}</h3>
      <p class="hint">{t.feed.forYouHint}</p>
      <ul class="affinity-list">
        {boards.map((b) => (
          <li class="affinity-item">
            <a class="affinity-name" href={`/c/${b.name}`}>
              b/{b.name}
            </a>
            <span class="affinity-score" title={t.feed.forYouHint}>
              {'▮'.repeat(Math.max(1, Math.min(5, Math.round(b.affinity * 2))))}
            </span>
            <form method="post" action="/feed/dismiss">
              <input type="hidden" name="board" value={b.name} />
              <input type="hidden" name="next" value={`/?sort=${sort}&t=${topWindow}`} />
              <button class="btn ghost small" type="submit" title={t.feed.dismissTitle}>
                {t.feed.notInterested}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const SortTabs: FC<{ basePath: string; sort: string; window?: string; extraQuery?: string }> = ({
  basePath,
  sort,
  window: topWindow = 'week',
  extraQuery = '',
}) => (
  <nav class="sort-tabs" aria-label={t.feed.sortLabel}>
    {(['hot', 'new', 'best'] as const).map((s) => (
      <a href={`${basePath}?sort=${s}${extraQuery}`} class={sort === s ? 'active' : ''}>
        {t.feed[s]}
      </a>
    ))}
    {sort === 'best' &&
      (['day', 'week', 'month', 'all'] as const).map((w) => (
        <a
          href={`${basePath}?sort=best&t=${w}${extraQuery}`}
          class={`sort-sub${topWindow === w ? ' active' : ''}`}
        >
          {t.feed[w]}
        </a>
      ))}
  </nav>
)

export const Markdown: FC<{ source: string; mentions?: string[]; refs?: Map<number, string> }> = ({
  source,
  mentions,
  refs,
}) => (
  <div
    class="md"
    dangerouslySetInnerHTML={{
      __html: renderMarkdown(
        source,
        mentions && mentions.length > 0 ? mentions : undefined,
        refs && refs.size > 0 ? refs : undefined,
      ),
    }}
  />
)

const countReplies = (node: CommentNode): number =>
  node.children.reduce((sum, child) => sum + 1 + countReplies(child), 0)

export const CommentTreeView: FC<{
  nodes: CommentNode[]
  now: number
  viewer: UserRow | null
  myVotes: Map<string, number>
  communityName: string
  postId: string
  canReply: boolean
  isMod: boolean
  scoreHidden: (createdAt: number) => boolean
  highlightId?: string | null
  maxRendered?: number
  /** Yazar rütbeleri (author_id ile eşleşir). */
  authorRanks?: Map<string, UserRank>
  /** Yorumlara eklenmiş medya (yorum kimliğiyle eşleşir). */
  mediaByComment?: Map<string, Array<{ key: string; kind: 'image' | 'gif' | 'video'; mime: string | null }>>
  /** Yorumda geçen @bahisler (yorum kimliğiyle eşleşir). */
  mentionsByComment?: Map<string, string[]>
}> = (props) => {
  let rendered = 0
  const limit = props.maxRendered ?? 50

  const renderNode = (node: CommentNode): unknown => {
    rendered += 1
    const c = node.comment
    const beyondLimit = rendered > limit
    const replyCount = countReplies(node)
    const myVote = props.myVotes.get(c.id) ?? 0
    const isOwn = props.viewer?.id === c.author_id
    const hiddenBody =
      node.hidden === 'deleted' ? t.comment.deleted : node.hidden ? t.comment.removed : null
    const collapsed = node.hidden === 'removed' || node.hidden === 'pending_review'

    if (beyondLimit) {
      return (
        <div class="comment" data-depth={String(Math.min(c.depth, 8))}>
          <a href={`/c/${props.communityName}/comments/${props.postId}/comment/${c.id}`} class="placeholder">
            {t.comment.loadMoreReplies} ({1 + replyCount})
          </a>
        </div>
      )
    }

    const media = props.mediaByComment?.get(c.id) ?? []
    const mentions = props.mentionsByComment?.get(c.id) ?? []
    const commentPermalink = `/c/${props.communityName}/comments/${props.postId}/comment/${c.id}`

    return (
      <div
        class={`comment${props.highlightId === c.id ? ' highlight' : ''}${c.is_anonymous === 1 ? ' is-anonymous' : ''}`}
        data-depth={String(Math.min(c.depth, 8))}
        id={`comment-${c.id}`}
      >
        <details class="subtree" open={!collapsed}>
          <summary>
            {c.is_anonymous === 1 && node.hidden === null ? (
              <span class="user-byline">
                <span class="anon-author" title={t.post.anonBylineHint}>
                  {t.post.anonByline} · <b>{c.anon_name}</b>
                </span>
              </span>
            ) : node.authorUsername ? (
              <span class="user-byline">
                <a href={profilePath(node.authorUsername)}>/tc/{node.authorUsername}</a>
                <RankBadges info={props.authorRanks?.get(c.author_id) ?? null} />
              </span>
            ) : (
              t.comment.deleted
            )}{' '}·{' '}
            {props.scoreHidden(c.created_at) && !node.hidden ? `· ${t.common.points}` : `${c.score} ${t.common.points}`} ·{' '}
            {relativeTime(c.created_at, props.now)}
            {c.edited_at !== null && ` (${t.post.edited})`}
            {c.spoiler === 1 && node.hidden === null && ` · ${t.comment.spoilerLabel}`}
            {replyCount > 0 && ` · ${replyCount} ${t.comment.replies}`}
          </summary>
          <div class="comment-main">
            <VoteRail
              targetType="comment"
              targetId={c.id}
              score={c.score}
              myVote={myVote}
              guest={!props.viewer}
              disabled={isOwn || node.hidden !== null}
              scoreHidden={props.scoreHidden(c.created_at) && !node.hidden}
            />
            <div>
              {hiddenBody ? (
                <p class="placeholder">{hiddenBody}</p>
              ) : c.spoiler === 1 ? (
                // Spoiler: gövde ve ekler "Göster"e kadar gizlenir.
                <div class="social-card-spoiler comment-spoiler" data-spoiler="1">
                  <button class="spoiler-reveal" type="button" data-spoiler-toggle aria-expanded="false">
                    <span class="spoiler-hint">{t.feed.spoilerHidden}</span>
                    <span class="spoiler-cta">{t.feed.spoilerReveal}</span>
                  </button>
                  <div class="spoiler-body" hidden>
                    {c.body ? <div class="body"><Markdown source={c.body} mentions={mentions} /></div> : null}
                    {media.length > 0 && <MediaGallery items={media} title={c.body || t.post.image} compact />}
                  </div>
                </div>
              ) : (
                <>
                  {c.body ? <div class="body"><Markdown source={c.body} mentions={mentions} /></div> : null}
                  {media.length > 0 && <MediaGallery items={media} title={c.body || t.post.image} compact />}
                </>
              )}
              <div class="comment-actions">
                {props.canReply && node.hidden === null && (
                  <a href={`/c/${props.communityName}/comments/${props.postId}/comment/${c.id}#reply`}>{t.post.reply}</a>
                )}
                <a href={`/c/${props.communityName}/comments/${props.postId}/comment/${c.id}`}>{t.common.permalink}</a>
                {props.viewer && !isOwn && node.hidden === null && (
                  <a href={`/report/comment/${c.id}`}>{t.post.report}</a>
                )}
                {isOwn && node.hidden === null && (
                  <>
                    <a href={`/comments/${c.id}/edit`}>{t.post.edit}</a>
                    <form method="post" action={`/comments/${c.id}/meta`} style="display:inline">
                      <input type="hidden" name="spoiler" value={c.spoiler === 1 ? '0' : '1'} />
                      <input type="hidden" name="back" value={commentPermalink} />
                      <button class="linklike" type="submit">
                        {c.spoiler === 1 ? `🔓 ${t.comment.spoilerLabel}` : `🔒 ${t.comment.spoilerLabel}`}
                      </button>
                    </form>
                    <form method="post" action={`/comments/${c.id}/meta`} style="display:inline">
                      <input type="hidden" name="anonymous" value={c.is_anonymous === 1 ? '0' : '1'} />
                      <input type="hidden" name="back" value={commentPermalink} />
                      <button class="linklike" type="submit">
                        {c.is_anonymous === 1 ? `👤 ${t.comment.anonymousLabel} ✓` : `👤 ${t.comment.anonymousLabel}`}
                      </button>
                    </form>
                    <form method="post" action={`/comments/${c.id}/delete`} style="display:inline" data-confirm={t.post.deleteCommentConfirm}>
                      <button class="linklike" type="submit">
                        {t.post.delete}
                      </button>
                    </form>
                  </>
                )}
                {props.isMod && node.hidden === null && (
                  <form method="post" action={`/mod/remove/comment/${c.id}`} style="display:inline" data-confirm={t.post.removeCommentConfirm}>
                    <button class="linklike" type="submit">
                      {t.common.remove}
                    </button>
                  </form>
                )}
                {props.isMod && node.hidden === 'removed' && (
                  <span class="placeholder">{t.common.remove}</span>
                )}
              </div>
            </div>
          </div>
          {node.children.length > 0 && <div>{node.children.map((child) => renderNode(child))}</div>}
        </details>
      </div>
    )
  }

  return <div class="comment-tree">{props.nodes.map((node) => renderNode(node))}</div>
}
