import type { Ctx } from '../context'
import type { PostRow, Viewer } from '../types'
import { readableCommunitiesClause } from './access'

export interface PostSearchResult extends PostRow {
  community_name: string
  author_username: string | null
  /** 1 = anonim gönderi. */
  anon?: number
}

export interface CommunitySearchResult {
  id: string
  name: string
  title: string
  description: string
  visibility: string
  member_count: number
}

export interface SearchResults {
  posts: PostSearchResult[]
  communities: CommunitySearchResult[]
}

/** Escape user input for FTS5 MATCH: quote each term, keep it simple and safe. */
function toFtsQuery(raw: string): string | null {
  const terms = raw
    .split(/\s+/)
    .map((t) => t.replaceAll('"', '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 8)
  if (terms.length === 0) return null
  return terms.map((t) => `"${t}"`).join(' ')
}

/** US-028: FTS over post titles/bodies + community names; visibility respected. */
export function search(ctx: Ctx, viewer: Viewer, rawQuery: string, communityId?: string): SearchResults {
  const ftsQuery = toFtsQuery(rawQuery)
  if (!ftsQuery) return { posts: [], communities: [] }

  const readable = readableCommunitiesClause(ctx, viewer, 'c')
  const communityFilter = communityId ? 'AND p.community_id = ?' : ''
  const posts = ctx.db
    .prepare(
      `SELECT p.*, c.name AS community_name,
              CASE WHEN u.deleted = 1 THEN NULL
                   WHEN p.is_anonymous = 1 THEN p.anon_name
                   ELSE u.username END AS author_username,
              p.is_anonymous AS anon
       FROM posts_fts f
       JOIN posts p ON p.id = f.post_id
       JOIN communities c ON c.id = p.community_id
       JOIN users u ON u.id = p.author_id
       WHERE posts_fts MATCH ? AND p.deleted = 0 AND p.removed = 0 AND p.auto_hidden = 0
         AND ${readable.clause} ${communityFilter}
       ORDER BY rank LIMIT 50`,
    )
    .all(ftsQuery, ...readable.params, ...(communityId ? [communityId] : [])) as unknown as PostSearchResult[]

  let communities: CommunitySearchResult[] = []
  if (!communityId) {
    communities = ctx.db
      .prepare(
        `SELECT c.id, c.name, c.title, c.description, c.visibility,
                (SELECT COUNT(*) FROM memberships m WHERE m.community_id = c.id AND m.status = 'approved') AS member_count
         FROM communities_fts f
         JOIN communities c ON c.id = f.community_id
         WHERE communities_fts MATCH ? AND ${readable.clause}
         ORDER BY rank LIMIT 20`,
      )
      .all(ftsQuery, ...readable.params) as unknown as CommunitySearchResult[]
    // Private communities never appear in search for non-members (US-009):
    // readableCommunitiesClause already restricts to member-visible ids.
  }
  return { posts, communities }
}
