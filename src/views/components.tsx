import type { FC } from 'hono/jsx'
import { t, relativeTime } from '../i18n/tr'
import { previewText, communityColor, communityInitials, profilePath } from './helpers'
import type { FeedItem } from '../services/feeds'
import type { CommunityMembershipState } from '../services/communities'
import type { CommentNode } from '../services/comments'
import type { UserRank } from '../services/ranks'
import { RankBadges } from './rank'
import { renderMarkdown } from '../lib/markdown'
import type { UserRow } from '../types'

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
  /** Yazarın rütbesi / yetkisi (author_id ile eşleşir). */
  authorRanks?: Map<string, UserRank>
}> = ({ item, now, myVote, viewer, showCommunity = true, pinned = false, authorRanks }) => {
  const isOwn = viewer?.id === item.author_id
  const authorRank = authorRanks?.get(item.author_id) ?? null
  const thumb =
    item.type === 'image' && item.image_key
      ? `/media/${item.image_key}`
      : item.type === 'link'
        ? item.link_preview_image
        : null
  return (
    <article class={`post-card${pinned ? ' pinned' : ''}`}>
      <VoteRail targetType="post" targetId={item.id} score={item.score} myVote={myVote} guest={!viewer} disabled={isOwn} />
      <div>
        {pinned && <span class="pin-tag">📌 {t.feed.pinned}</span>}
        <div class="meta">
          {showCommunity && <a href={`/c/${item.community_name}`}>c/{item.community_name}</a>}
          <span class="user-byline">
            {item.author_username ? (
              <>
                <a href={profilePath(item.author_username)}>/tc/{item.author_username}</a>
                <RankBadges info={authorRank} />
              </>
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
                ({new URL(item.url).hostname})
              </a>
            </>
          )}
        </h3>
        {thumb && (
          <a href={`/c/${item.community_name}/comments/${item.id}`}>
            <img class="post-thumb" src={thumb} alt="" loading="lazy" />
          </a>
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

/**
 * Mobil öncelikli sosyal gönderi kartı. Gerçek veriyi gösterir; kaydetme ve
 * paylaşma tarayıcı tarafında çalışır (public/app.js).
 */
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
}> = ({ item, now, myVote, viewer, membership = 'none', showCommunity = true, pinned = false, authorRanks }) => {
  const isOwn = viewer?.id === item.author_id
  const authorRank = authorRanks?.get(item.author_id) ?? null
  const href = `/c/${item.community_name}/comments/${item.id}`
  const preview = previewText(item.body)
  const media =
    item.type === 'image' && item.image_key
      ? `/media/${item.image_key}`
      : item.type === 'link'
        ? item.link_preview_image
        : null

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

      {preview && <p class="social-card-preview">{preview}</p>}

      {item.type === 'link' && item.url && (
        <a class="social-card-link" href={item.url} rel="nofollow noopener" target="_blank">
          {item.link_preview_title ?? item.url}
          <span class="social-card-link-host">{new URL(item.url).hostname}</span>
        </a>
      )}

      {media && (
        <a class="social-card-media" href={href}>
          <img src={media} alt={item.title} loading="lazy" />
        </a>
      )}

      <div class="social-card-author">
        {item.author_username ? (
          <span class="user-byline">
            <a href={profilePath(item.author_username)}>/tc/{item.author_username}</a>
            <RankBadges info={authorRank} />
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

export const SortTabs: FC<{ basePath: string; sort: string; window?: string; extraQuery?: string }> = ({
  basePath,
  sort,
  window: topWindow = 'week',
  extraQuery = '',
}) => (
  <nav class="sort-tabs" aria-label={t.feed.sortLabel}>
    {(['hot', 'new', 'top'] as const).map((s) => (
      <a href={`${basePath}?sort=${s}${extraQuery}`} class={sort === s ? 'active' : ''}>
        {t.feed[s]}
      </a>
    ))}
    {sort === 'top' &&
      (['day', 'week', 'month', 'all'] as const).map((w) => (
        <a
          href={`${basePath}?sort=top&t=${w}${extraQuery}`}
          class={`sort-sub${topWindow === w ? ' active' : ''}`}
        >
          {t.feed[w]}
        </a>
      ))}
  </nav>
)

export const Markdown: FC<{ source: string }> = ({ source }) => (
  <div class="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(source) }} />
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

    return (
      <div class={`comment${props.highlightId === c.id ? ' highlight' : ''}`} data-depth={String(Math.min(c.depth, 8))} id={`comment-${c.id}`}>
        <details class="subtree" open={!collapsed}>
          <summary>
            {node.authorUsername ? (
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
              ) : (
                <div class="body">
                  <Markdown source={c.body} />
                </div>
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
