import type { FC } from 'hono/jsx'
import { t, relativeTime } from '../i18n/tr'
import type { FeedItem } from '../services/feeds'
import type { CommentNode } from '../services/comments'
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
}> = ({ targetType, targetId, score, myVote, disabled = false, guest = false, scoreHidden = false }) => (
  <div
    class="vote-rail"
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
}> = ({ item, now, myVote, viewer, showCommunity = true, pinned = false }) => {
  const isOwn = viewer?.id === item.author_id
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
          <span>{item.author_username ? <a href={`/u/${item.author_username}`}>u/{item.author_username}</a> : t.post.deletedBody}</span>
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
        <a href={`${basePath}?sort=top&t=${w}${extraQuery}`} class={topWindow === w ? 'active' : ''} style="font-size:0.75rem">
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
            {node.authorUsername ? `u/${node.authorUsername}` : t.comment.deleted} ·{' '}
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
