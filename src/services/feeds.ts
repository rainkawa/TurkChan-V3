import type { Ctx } from '../context'
import type { CommunityRow, PostRow, Viewer } from '../types'
import { type Cursor, cursorPredicate, encodeCursor } from '../lib/cursor'
import { getSettings } from './settings'
import { readableCommunitiesClause, isModerator } from './access'

/**
 * Akış sıralamaları:
 *  - `hot`  → Popüler: oy ve yaş arasında zaman-aşımı dengesi (Reddit formülü).
 *  - `new`  → Yeni: en yeni gönderiler.
 *  - `best` → En İyi: Wilson alt sınırı ile "güvenilirlik" sıralaması; az oyla
 *             gelen gönderiler tırmanmaya karşı geri kalır.
 *
 * `top` eski bağlantılar için `best` takma adıdır.
 */
export type FeedSort = 'hot' | 'new' | 'best' | 'bump'
export type TopWindow = 'day' | 'week' | 'month' | 'all'

export const FEED_SORTS: FeedSort[] = ['hot', 'new', 'best', 'bump']

/** Sıralamayı çözer; tanınmayan ve eski değerler güvenli bir varsayılana düşer. */
export function parseFeedSort(raw: string | undefined | null): FeedSort {
  if (raw === 'new') return 'new'
  if (raw === 'best' || raw === 'top') return 'best'
  if (raw === 'bump') return 'bump'
  return 'hot'
}

export interface FeedItem extends PostRow {
  community_name: string
  community_title: string
  author_username: string | null
  /** 1 = gönderi anonim paylaşıldı. */
  anon?: number
  hot: number
  rank: number
  /** Kişiselleştirilmiş akışta bu gönderinin boarda ilgi puanı. */
  affinity: number
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

/** En iyi sıralamada kullanılan zaman aralığı. */
const WINDOWED_SORTS: FeedSort[] = ['best']

/** Kişiselleştirme ilgi puanı aralığı. */
const AFFINITY_FLOOR = 0.5
const AFFINITY_CEIL = 3

/* -------------------------------------------------------------------------- */
/* Kişiselleştirme                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Board ilgi puanları. Katılımcı üyeler 1.4 ile başlar; gönderi, yorum ve oy
 * puanı yükseltir, "ilgisini azalt" 0.6 ile çarpar. Puan 0.5–3 arasında
 * tutulur.
 */
const AFFINITY_DEFAULTS = {
  member: 1.4,
  visitor: 1,
  post: 0.12,
  comment: 0.18,
  vote: 0.06,
  downVote: 0.25,
  dismiss: 0.6,
} as const

export function affinityFor(ctx: Ctx, userId: string, communityId: string): number {
  const row = ctx.db
    .prepare('SELECT affinity FROM community_affinity WHERE user_id = ? AND community_id = ?')
    .get(userId, communityId) as { affinity: number } | undefined
  if (row) return clampAffinity(row.affinity)
  const member = ctx.db
    .prepare("SELECT 1 FROM memberships WHERE user_id = ? AND community_id = ? AND status = 'approved'")
    .get(userId, communityId)
  return member ? AFFINITY_DEFAULTS.member : AFFINITY_DEFAULTS.visitor
}

function clampAffinity(value: number): number {
  return Math.min(AFFINITY_CEIL, Math.max(AFFINITY_FLOOR, Number(value.toFixed(3))))
}

/** Bir etkileşim sonrası ilgi puanını artırır/azaltır. */
export function bumpAffinity(ctx: Ctx, userId: string, communityId: string, delta: number): void {
  const current = affinityFor(ctx, userId, communityId)
  const next = clampAffinity(current + delta)
  ctx.db
    .prepare(
      `INSERT INTO community_affinity (user_id, community_id, affinity, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, community_id) DO UPDATE SET affinity = excluded.affinity, updated_at = excluded.updated_at`,
    )
    .run(userId, communityId, next, ctx.now())
}

/** Kullanıcı bir boardun ilgisini azaltır. */
export function dismissAffinity(ctx: Ctx, userId: string, communityId: string): number {
  const current = affinityFor(ctx, userId, communityId)
  const next = clampAffinity(current * AFFINITY_DEFAULTS.dismiss)
  ctx.db
    .prepare(
      `INSERT INTO community_affinity (user_id, community_id, affinity, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, community_id) DO UPDATE SET affinity = excluded.affinity, updated_at = excluded.updated_at`,
    )
    .run(userId, communityId, next, ctx.now())
  return next
}

export const AFFINITY_STEP = {
  post: AFFINITY_DEFAULTS.post,
  comment: AFFINITY_DEFAULTS.comment,
  vote: AFFINITY_DEFAULTS.vote,
  downVote: AFFINITY_DEFAULTS.downVote,
}

/* -------------------------------------------------------------------------- */
/* Sıralama ifadeleri                                                         */
/* -------------------------------------------------------------------------- */

interface RankSpec {
  /** SELECT listesinde `rank` takma adı olarak kullanılan sıralama ifadesi. */
  expr: string
  /** `rank` takma adını kullanan ORDER BY ifadesi. */
  orderBy: string
  /** İmleç için sıralanan değerler. */
  values: (row: FeedItem) => number[]
  /**
   * İmleç karşılaştırmasında kullanılan ifadeler. ORDER BY'de `rank` dışında
   * ek kolon varsa (örn. thread_sticky) buraya eklenmelidir; aksi halde sonsuz
   * kaydırma sayfalar arasında atlar veya tekrarlar.
   */
  cursorExprs?: string[]
}

/**
 * Sıralama ifadesi. `personalize` açıkken puan, kullanıcının boarda olan
 * ilgisiyle çarpılır; böylece "Sana özel" akış yalnızca üye olduğu
 * boardları öne çıkarır. "Yeni" sekmesi daima kronolojiktir — kişiselleştirme
 * orada kullanıcıyı yanıltmamalıdır.
 *
 * ORDER BY, SELECT'teki `rank` takma adını kullanır; aksi halde aynı ifade
 * ikinci kez çalışır ve bağlı parametre sayısı tutmaz.
 */
function rankSpec(sort: FeedSort, decay: number, personalize: boolean, affinitySql: string): RankSpec {
  const affinity = personalize ? affinitySql : '1'
  // Thread listesi: sabitlenen thread'ler en üstte, ardından en son hareket eden.
  if (sort === 'bump') {
    return {
      expr: 'COALESCE(p.bumped_at, p.created_at)',
      orderBy: 'p.thread_sticky DESC, rank DESC, p.id DESC',
      values: (row) => [row.rank],
      cursorExprs: ['p.thread_sticky', 'COALESCE(p.bumped_at, p.created_at)'],
    }
  }
  if (sort === 'new') {
    return {
      expr: 'p.created_at',
      orderBy: 'rank DESC, p.id DESC',
      values: (row) => [row.rank],
    }
  }
  if (sort === 'best') {
    const base = 'wilson(p.upvotes, p.downvotes)'
    const expr = personalize ? `(${base}) * (${affinity})` : base
    return {
      expr,
      orderBy: 'rank DESC, p.score DESC, p.id DESC',
      values: (row) => [row.rank],
    }
  }
  const base = `hot_rank(p.score, p.created_at, ${decay})`
  const expr = personalize ? `(${base}) * (${affinity})` : base
  return { expr, orderBy: 'rank DESC, p.id DESC', values: (row) => [row.rank] }
}

interface FeedQueryOptions {
  communityId?: string
  joinedOnly?: Viewer
  sort: FeedSort
  window: TopWindow
  cursor: Cursor | null
  limit: number
  includePinnedHeader: boolean
  /** Kişiselleştirilmiş ana sayfa akışı. */
  personalize: boolean
  viewer: Viewer
  /** Etikete göre filtreleme. */
  flairId?: string | null
  /** Yalnızca thread gönderilerini getir. */
  threadsOnly?: boolean
}

function runFeedQuery(ctx: Ctx, viewer: Viewer, options: FeedQueryOptions): FeedPage {
  const settings = getSettings(ctx)
  const decay = settings.hotDecaySeconds
  const readable = readableCommunitiesClause(ctx, viewer, 'c')

  const where: string[] = [
    'p.deleted = 0',
    'p.removed = 0',
    'p.auto_hidden = 0',
    // Arşivlenmiş thread'ler yalnızca moderatörlere görünür.
    `(p.thread_archived = 0 OR ${isModerator(ctx, options.viewer, options.communityId ?? '') ? '1' : '0'} = 1)`,
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
  if (options.flairId) {
    where.push('p.flair_id = ?')
    params.push(options.flairId)
  }
  if (options.threadsOnly) {
    where.push('p.is_thread = 1')
  }
  if (WINDOWED_SORTS.includes(options.sort) && options.window !== 'all') {
    where.push('p.created_at > ?')
    params.push(ctx.now() - WINDOW_MS[options.window])
  }
  // Sabitlenmiş gönderiler board akışının başında ayrı gösterilir.
  if (options.includePinnedHeader) {
    where.push('p.pinned_at IS NULL')
  }

  const personalized = options.personalize && viewer !== null
  const affinitySql = `COALESCE(
      (SELECT ca.affinity FROM community_affinity ca
        WHERE ca.user_id = ? AND ca.community_id = p.community_id),
      CASE WHEN EXISTS (SELECT 1 FROM memberships m
                         WHERE m.user_id = ? AND m.community_id = p.community_id AND m.status = 'approved')
           THEN ${AFFINITY_DEFAULTS.member} ELSE ${AFFINITY_DEFAULTS.visitor} END)`
  const affinityParam = viewer?.id ?? ''
  const spec = rankSpec(options.sort, decay, personalized, affinitySql)

  // affinitySelect ve rank ifadesi aynı alt sorguyu taşır. Kaç yer tutucu
  // içerdiklerini sayıp o kadar parametre bağlarız ("Yeni" sırasında rank
  // ifadesi kişiselleştirilmez, dolayısıyla iki yer tutucu vardır).
  const placeholderCount = (sql: string) => (sql.match(/\?/g) ?? []).length
  const affinitySelectExpr = personalized ? `(${affinitySql})` : null
  const affinitySelect = affinitySelectExpr ? `${affinitySelectExpr} AS affinity,` : `${AFFINITY_DEFAULTS.visitor} AS affinity,`
  const selectParamCount = placeholderCount(affinitySelectExpr ?? '') + placeholderCount(spec.expr)
  const selectParams = Array.from({ length: selectParamCount }, () => affinityParam)

  if (options.cursor) {
    const predicate = cursorPredicate(spec.cursorExprs ?? [spec.expr], 'p.id', options.cursor)
    where.push(predicate.clause)
    params.push(...predicate.params)
  }

  const sql = `
    SELECT p.*, c.name AS community_name, c.title AS community_title,
           hot_rank(p.score, p.created_at, ${decay}) AS hot,
           ${affinitySelect}
           ${spec.expr} AS rank,
           CASE WHEN u.deleted = 1 THEN NULL
                WHEN p.is_anonymous = 1 THEN p.anon_name
                ELSE u.username END AS author_username,
           p.is_anonymous AS anon
    FROM posts p
    JOIN communities c ON c.id = p.community_id
    JOIN users u ON u.id = p.author_id
    WHERE ${where.join(' AND ')}
    ORDER BY ${spec.orderBy}
    LIMIT ?`
  const rows = ctx.db
    .prepare(sql)
    .all(...selectParams, ...params, options.limit + 1) as unknown as FeedItem[]

  const hasMore = rows.length > options.limit
  const items = hasMore ? rows.slice(0, options.limit) : rows
  const last = items[items.length - 1]
  const nextCursor = hasMore && last ? encodeCursor({ values: valuesOf(spec, last), id: last.id }) : null

  let pinned: FeedItem[] = []
  if (options.includePinnedHeader && !options.cursor && options.communityId) {
    pinned = ctx.db
      .prepare(
        `SELECT p.*, c.name AS community_name, c.title AS community_title,
                hot_rank(p.score, p.created_at, ${decay}) AS hot,
                ${AFFINITY_DEFAULTS.visitor} AS affinity, 0 AS rank,
                CASE WHEN u.deleted = 1 THEN NULL
                     WHEN p.is_anonymous = 1 THEN p.anon_name
                     ELSE u.username END AS author_username,
                p.is_anonymous AS anon
         FROM posts p
         JOIN communities c ON c.id = p.community_id
         JOIN users u ON u.id = p.author_id
         WHERE p.community_id = ? AND p.pinned_at IS NOT NULL
           AND p.deleted = 0 AND p.removed = 0 AND p.auto_hidden = 0
           AND (p.thread_archived = 0 OR ? = 1)
         ORDER BY p.pinned_at ASC LIMIT 3`,
      )
      .all(options.communityId, isModerator(ctx, options.viewer, options.communityId) ? 1 : 0) as unknown as FeedItem[]
  }

  return { items, nextCursor, pinned }
}

function valuesOf(spec: RankSpec, row: FeedItem): number[] {
  return spec.values(row)
}

export function communityFeed(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  sort: FeedSort,
  window: TopWindow,
  cursor: Cursor | null,
  limit = 25,
  flairId: string | null = null,
  threadsOnly = false,
): FeedPage {
  return runFeedQuery(ctx, viewer, {
    communityId: community.id,
    sort,
    window,
    cursor,
    limit,
    includePinnedHeader: true,
    personalize: false,
    viewer,
    flairId,
    ...(threadsOnly ? { threadsOnly: true } : {}),
  })
}

/**
 * Ana sayfa akışı. Üye olduğu boardlar öne çıkar (kişiselleştirme); hiç
 * üyeliği olmayan veya çıkış yapmış kullanıcı için okunabilir tüm gönderiler
 * listelenir. Sabitlenmiş gönderiler ana akışı bozmaz.
 */
export function homeFeed(
  ctx: Ctx,
  viewer: Viewer,
  sort: FeedSort,
  window: TopWindow,
  cursor: Cursor | null,
  limit = 25,
  options: { flairId?: string | null; communityId?: string | null } = {},
): FeedPage & { usedJoinedCommunities: boolean; personalized: boolean } {
  let joinedOnly: Viewer = null
  if (viewer && !options.communityId) {
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
    personalize: viewer !== null,
    viewer,
    flairId: options.flairId ?? null,
    ...(options.communityId ? { communityId: options.communityId } : {}),
  })
  return { ...page, usedJoinedCommunities: joinedOnly !== null, personalized: viewer !== null }
}

/** Bir board için etiket filtresi menüsü (yalnızca etiketli gönderi olanlar). */
export function flairFilterOptions(ctx: Ctx, communityIds: string[]): Array<{ id: string; name: string; count: number }> {
  const unique = [...new Set(communityIds.filter(Boolean))]
  if (unique.length === 0) return []
  const placeholders = unique.map(() => '?').join(',')
  return ctx.db
    .prepare(
      `SELECT p.flair_id AS id, f.name AS name, COUNT(*) AS count
         FROM posts p JOIN board_flairs f ON f.id = p.flair_id
        WHERE p.deleted = 0 AND p.removed = 0 AND p.auto_hidden = 0
          AND p.community_id IN (${placeholders})
        GROUP BY p.flair_id, f.name
        ORDER BY count DESC, f.name ASC`,
    )
    .all(...unique) as unknown as Array<{ id: string; name: string; count: number }>
}
