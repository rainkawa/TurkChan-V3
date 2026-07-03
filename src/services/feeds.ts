import type { Ctx } from '../context'
import type { CommunityRow, PostRow, Viewer } from '../types'
import { type Cursor, cursorPredicate, encodeCursor } from '../lib/cursor'
import { getSettings } from './settings'
import { readableCommunitiesClause } from './access'

export type FeedSort = 'hot' | 'new' | 'top'
export type TopWindow = 'day' | 'week' | 'month' | 'all'

export interface FeedItem extends PostRow {
  community_name: string
  community_title: string
  author_username: string | null
  hot: number
}

export interface FeedPage {
  items: FeedItem[]
  nextCursor: string | null
  pinned: FeedItem[]
}

const WINDOW_MS: Record<TopWindow, number> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
}

interface FeedQueryOptions {
  communityId?: string
  joinedOnly?: Viewer
  sort: FeedSort
  window: TopWindow
  cursor: Cursor | null
  limit: number
  includePinnedHeader: boolean
}

function sortExprs(sort: FeedSort): { exprs: string[]; orderBy: string; values: (row: FeedItem) => number[] } {
  if (sort === 'new') {
    return {
      exprs: ['p.created_at'],
      orderBy: 'p.created_at DESC, p.id DESC',
      values: (row) => [row.created_at],
    }
  }
  if (sort === 'top') {
    return {
      exprs: ['p.score', 'p.created_at'],
      orderBy: 'p.score DESC, p.created_at DESC, p.id DESC',
      values: (row) => [row.score, row.created_at],
    }
  }
  return {
    exprs: ['hot_rank(p.score, p.created_at, $decay)'],
    orderBy: 'hot_rank(p.score, p.created_at, $decay) DESC, p.id DESC',
    values: (row) => [row.hot],
  }
}

function runFeedQuery(ctx: Ctx, viewer: Viewer, options: FeedQueryOptions): FeedPage {
  const settings = getSettings(ctx)
  const decay = settings.hotDecaySeconds
  const readable = readableCommunitiesClause(ctx, viewer, 'c')
  const { exprs, orderBy, values } = sortExprs(options.sort)

  const where: string[] = [
    'p.deleted = 0',
    'p.removed = 0',
    'p.auto_hidden = 0',
    readable.clause,
  ]
  const params: (string | number)[] = [...readable.params]

  if (options.communityId) {
    where.push('p.community_id = ?')
    params.push(options.communityId)
  }
  if (options.joinedOnly) {
    where.push(
      `p.community_id IN (SELECT community_id FROM memberships WHERE user_id = ? AND status = 'approved')`,
    )
    params.push(options.joinedOnly.id)
  }
  if (options.sort === 'top' && options.window !== 'all') {
    where.push('p.created_at > ?')
    params.push(ctx.now() - WINDOW_MS[options.window])
  }
  // Pinned posts render above the feed (community feed only); exclude them
  // from the flowing list there to avoid duplication.
  if (options.includePinnedHeader) {
    where.push('p.pinned_at IS NULL')
  }
  if (options.cursor) {
    const substituted = exprs.map((e) => e.replaceAll('$decay', String(decay)))
    const predicate = cursorPredicate(substituted, 'p.id', options.cursor)
    where.push(predicate.clause)
    params.push(...predicate.params)
  }

  const sql = `
    SELECT p.*, c.name AS community_name, c.title AS community_title,
           hot_rank(p.score, p.created_at, ${decay}) AS hot,
           CASE WHEN u.deleted = 1 THEN NULL ELSE u.username END AS author_username
    FROM posts p
    JOIN communities c ON c.id = p.community_id
    JOIN users u ON u.id = p.author_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${orderBy.replaceAll('$decay', String(decay))}
    LIMIT ?`
  const rows = ctx.db.prepare(sql).all(...params, options.limit + 1) as unknown as FeedItem[]

  const hasMore = rows.length > options.limit
  const items = hasMore ? rows.slice(0, options.limit) : rows
  const last = items[items.length - 1]
  const nextCursor = hasMore && last ? encodeCursor({ values: values(last), id: last.id }) : null

  let pinned: FeedItem[] = []
  if (options.includePinnedHeader && !options.cursor && options.communityId) {
    pinned = ctx.db
      .prepare(
        `SELECT p.*, c.name AS community_name, c.title AS community_title,
                hot_rank(p.score, p.created_at, ${decay}) AS hot,
                CASE WHEN u.deleted = 1 THEN NULL ELSE u.username END AS author_username
         FROM posts p
         JOIN communities c ON c.id = p.community_id
         JOIN users u ON u.id = p.author_id
         WHERE p.community_id = ? AND p.pinned_at IS NOT NULL
           AND p.deleted = 0 AND p.removed = 0 AND p.auto_hidden = 0
         ORDER BY p.pinned_at ASC LIMIT 2`,
      )
      .all(options.communityId) as unknown as FeedItem[]
  }

  return { items, nextCursor, pinned }
}

export function communityFeed(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  sort: FeedSort,
  window: TopWindow,
  cursor: Cursor | null,
  limit = 25,
): FeedPage {
  return runFeedQuery(ctx, viewer, {
    communityId: community.id,
    sort,
    window,
    cursor,
    limit,
    includePinnedHeader: true,
  })
}

/**
 * US-024: home feed of joined communities; members with no memberships and
 * guests fall back to all readable (public/restricted) posts. Pins do not
 * affect home feed order (US-025).
 */
export function homeFeed(
  ctx: Ctx,
  viewer: Viewer,
  sort: FeedSort,
  window: TopWindow,
  cursor: Cursor | null,
  limit = 25,
): FeedPage & { usedJoinedCommunities: boolean } {
  let joinedOnly: Viewer = null
  if (viewer) {
    const joined = (
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM memberships WHERE user_id = ? AND status = 'approved'")
        .get(viewer.id) as { n: number }
    ).n
    if (joined > 0) joinedOnly = viewer
  }
  const page = runFeedQuery(ctx, viewer, {
    joinedOnly,
    sort,
    window,
    cursor,
    limit,
    includePinnedHeader: false,
  })
  return { ...page, usedJoinedCommunities: joinedOnly !== null }
}
