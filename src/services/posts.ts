import type { Ctx } from '../context'
import type { CommunityRow, PostRow, UserRow, Viewer } from '../types'
import { newId } from '../lib/ids'
import { validatePostTitle, validatePostBody } from '../lib/validation'
import { isValidPublicUrlSyntax } from '../lib/urlguard'
import { getSettings } from './settings'
import { badRequest, forbidden, notFound, rateLimited, unauthorized } from './errors'
import { canReadCommunity, getCommunityById, isModerator, requireParticipant } from './access'
import { AFFINITY_STEP, bumpAffinity } from './feeds'
import { getFlair } from './flairs'
import { mediaKindForUrl } from '../lib/media'
import { joinCommunity } from './communities'
import { fetchLinkPreview } from './linkpreview'
import { attachUpload } from './uploads'
import { isAdminPower } from './ranks'
import { transaction } from '../db'

const TEN_MINUTES_MS = 10 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function checkPostRateLimit(ctx: Ctx, user: UserRow): void {
  const settings = getSettings(ctx)
  const limit = ctx.rateLimiter.check(`post:${user.id}`, settings.postsPer10Min, TEN_MINUTES_MS)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)
}

/**
 * Membership gate for posting. Public communities auto-join the author
 * ("joining is one tap in the composer", US-013); restricted/private require
 * prior approved membership.
 */
function ensureCanPost(ctx: Ctx, viewer: Viewer, community: CommunityRow): UserRow {
  if (community.visibility === 'public' && viewer && !viewer.deleted) {
    const user = requireParticipant(ctx, viewer, community, { requireMembership: false })
    joinCommunity(ctx, user, community)
    return user
  }
  return requireParticipant(ctx, viewer, community, { requireMembership: true })
}

export function getPost(ctx: Ctx, id: string): PostRow | null {
  return (ctx.db.prepare('SELECT * FROM posts WHERE id = ?').get(id) as PostRow | undefined) ?? null
}

export function syncPostFts(ctx: Ctx, post: PostRow): void {
  ctx.db.prepare('DELETE FROM posts_fts WHERE post_id = ?').run(post.id)
  if (post.deleted || post.removed || post.auto_hidden) return
  ctx.db
    .prepare('INSERT INTO posts_fts (title, body, post_id) VALUES (?, ?, ?)')
    .run(post.title, post.body ?? '', post.id)
}

export function createTextPost(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  input: { title: string; body: string; spoiler?: boolean; flairId?: string | null },
): PostRow {
  const user = ensureCanPost(ctx, viewer, community)
  checkPostRateLimit(ctx, user)
  const title = validatePostTitle(input.title)
  const body = validatePostBody(input.body)
  const flairId = resolveFlair(ctx, community, user, input.flairId)
  const id = newId()
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO posts (id, community_id, author_id, type, title, body, spoiler, flair_id, created_at)
         VALUES (?, ?, ?, 'text', ?, ?, ?, ?, ?)`,
      )
      .run(id, community.id, user.id, title, body, input.spoiler ? 1 : 0, flairId, ctx.now())
    syncPostFts(ctx, getPost(ctx, id) as PostRow)
  })
  bumpAffinity(ctx, user.id, community.id, AFFINITY_STEP.post)
  return getPost(ctx, id) as PostRow
}

/** Gönderi etiketi: varlığını doğrular, yoksa null. */
function resolveFlair(ctx: Ctx, community: CommunityRow, _user: UserRow, raw: string | null | undefined): string | null {
  if (!raw) return null
  const flair = getFlair(ctx, community.id, raw)
  if (!flair) throw badRequest('flair', 'Etiket bulunamadı.')
  return flair.id
}

/** US-014: earlier post with the same URL in this community in the last 30 days. */
export function findDuplicateLinkPost(ctx: Ctx, community: CommunityRow, url: string): PostRow | null {
  const row = ctx.db
    .prepare(
      `SELECT * FROM posts WHERE community_id = ? AND url = ? AND deleted = 0 AND removed = 0
       AND created_at > ? ORDER BY created_at ASC LIMIT 1`,
    )
    .get(community.id, url, ctx.now() - THIRTY_DAYS_MS) as PostRow | undefined
  return row ?? null
}

export async function createLinkPost(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  input: { title: string; url: string; spoiler?: boolean; flairId?: string | null },
): Promise<{ post: PostRow; duplicateOf: PostRow | null }> {
  const user = ensureCanPost(ctx, viewer, community)
  checkPostRateLimit(ctx, user)
  const title = validatePostTitle(input.title)
  const url = input.url.trim()
  if (!isValidPublicUrlSyntax(url)) {
    throw badRequest('url', 'Geçerli herkese açık bir http(s) bağlantısı girin.')
  }
  const duplicateOf = findDuplicateLinkPost(ctx, community, url)
  // Preview fetch is best-effort and never blocks creation (US-014).
  const preview = await fetchLinkPreview(ctx, url)
  const flairId = resolveFlair(ctx, community, user, input.flairId)
  // Bağlantı türüne göre önizleme çeşidi: görsel, GIF, video veya gömülü.
  const mediaKind = mediaKindForUrl(url)

  const id = newId()
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO posts (id, community_id, author_id, type, title, url, link_preview_title, link_preview_image,
                            media_kind, spoiler, flair_id, created_at)
         VALUES (?, ?, ?, 'link', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        community.id,
        user.id,
        title,
        url,
        preview?.title ?? null,
        preview?.image ?? null,
        mediaKind,
        input.spoiler ? 1 : 0,
        flairId,
        ctx.now(),
      )
    syncPostFts(ctx, getPost(ctx, id) as PostRow)
  })
  bumpAffinity(ctx, user.id, community.id, AFFINITY_STEP.post)
  return { post: getPost(ctx, id) as PostRow, duplicateOf }
}

export function createImagePost(
  ctx: Ctx,
  viewer: Viewer,
  community: CommunityRow,
  input: { title: string; imageKey: string; spoiler?: boolean; flairId?: string | null },
): PostRow {
  const user = ensureCanPost(ctx, viewer, community)
  checkPostRateLimit(ctx, user)
  const title = validatePostTitle(input.title)
  const flairId = resolveFlair(ctx, community, user, input.flairId)
  const id = newId()
  transaction(ctx.db, () => {
    // attachUpload throws if the upload never completed → no orphaned post.
    attachUpload(ctx, user, input.imageKey)
    ctx.db
      .prepare(
        `INSERT INTO posts (id, community_id, author_id, type, title, image_key, media_kind, spoiler, flair_id, created_at)
         VALUES (?, ?, ?, 'image', ?, ?, 'image', ?, ?, ?)`,
      )
      .run(id, community.id, user.id, title, input.imageKey, input.spoiler ? 1 : 0, flairId, ctx.now())
    syncPostFts(ctx, getPost(ctx, id) as PostRow)
  })
  bumpAffinity(ctx, user.id, community.id, AFFINITY_STEP.post)
  return getPost(ctx, id) as PostRow
}

/** Gönderinin spoiler ve etiketini yazarı/moderaörü günceller. */
export function updatePostMeta(
  ctx: Ctx,
  viewer: Viewer,
  postId: string,
  input: { spoiler?: boolean; flairId?: string | null },
): PostRow {
  if (!viewer) throw unauthorized()
  const post = getPost(ctx, postId)
  if (!post || post.deleted === 1) throw notFound()
  if (post.author_id !== viewer.id && !isModerator(ctx, viewer, post.community_id)) {
    throw forbidden('Yalnızca yazar veya moderatör bunu değiştirebilir.')
  }
  if (input.spoiler !== undefined) {
    ctx.db.prepare('UPDATE posts SET spoiler = ? WHERE id = ?').run(input.spoiler ? 1 : 0, postId)
  }
  if (input.flairId !== undefined) {
    const flairId = resolveFlair(ctx, { id: post.community_id } as CommunityRow, viewer as UserRow, input.flairId)
    ctx.db.prepare('UPDATE posts SET flair_id = ? WHERE id = ?').run(flairId, postId)
  }
  return getPost(ctx, postId) as PostRow
}

/** US-016: titles immutable; only text bodies editable, with edited indicator. */
export function editPostBody(ctx: Ctx, viewer: Viewer, postId: string, body: string): PostRow {
  const post = getPost(ctx, postId)
  if (!post || post.deleted) throw notFound('Gönderi bulunamadı.')
  if (!viewer || viewer.id !== post.author_id) throw forbidden('Bu gönderiyi yalnızca yazarı düzenleyebilir.')
  if (post.type !== 'text') throw badRequest('not_editable', 'Bağlantı ve görseller düzenlenemez — silip yeniden paylaşın.')
  if (post.removed) throw forbidden('Bu gönderi bir moderatör tarafından kaldırıldı ve düzenlenemez.')
  const community = getCommunityById(ctx, post.community_id)
  if (!community || community.archived || community.deleted_at !== null) {
    throw badRequest('archived', 'Bu topluluk arşivlenmiş ve salt okunur durumdadır.')
  }
  const validBody = validatePostBody(body)
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?').run(validBody, ctx.now(), postId)
    syncPostFts(ctx, getPost(ctx, postId) as PostRow)
  })
  return getPost(ctx, postId) as PostRow
}

export function deletePost(ctx: Ctx, viewer: Viewer, postId: string): void {
  const post = getPost(ctx, postId)
  if (!post || post.deleted) throw notFound('Gönderi bulunamadı.')
  if (!viewer || viewer.id !== post.author_id) throw forbidden('Bu gönderiyi yalnızca yazarı silebilir.')
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?').run(postId)
    syncPostFts(ctx, getPost(ctx, postId) as PostRow)
  })
}

export interface PostView {
  post: PostRow
  community: CommunityRow
  authorUsername: string | null // null when hidden (deleted/removed)
  contentHidden: 'deleted' | 'removed' | 'pending_review' | null
}

/**
 * Post for display with all access rules applied (US-017, US-043).
 * Throws 403 for private communities (zero content leakage), 404 for
 * genuinely missing posts; returns placeholder shapes for deleted/removed.
 */
export function getPostForViewer(ctx: Ctx, viewer: Viewer, postId: string): PostView {
  const post = getPost(ctx, postId)
  if (!post) throw notFound('Bu içerik artık mevcut değil.')
  const community = getCommunityById(ctx, post.community_id)
  if (!community) throw notFound('Bu içerik artık mevcut değil.')
    if (community.deleted_at !== null && !isAdminPower(viewer)) throw notFound('Bu içerik artık mevcut değil.')
  if (!canReadCommunity(ctx, viewer, community)) {
    throw forbidden('Bu topluluk gizli. Görüntülemek için onaylı üye olmalısınız.')
  }

  const isModOrAdmin = isAdminPower(viewer)
  let contentHidden: PostView['contentHidden'] = null
  if (post.deleted) contentHidden = 'deleted'
  else if (post.removed) contentHidden = 'removed'
  else if (post.auto_hidden) contentHidden = 'pending_review'

  // Deleted post with zero comments is gone entirely (US-016).
  if (post.deleted && post.comment_count === 0 && !isModOrAdmin) {
    throw notFound('Bu içerik artık mevcut değil.')
  }

  const author = ctx.db.prepare('SELECT username, deleted FROM users WHERE id = ?').get(post.author_id) as
    | { username: string; deleted: number }
    | undefined
  const authorUsername = !author || author.deleted || post.deleted || post.removed ? null : author.username

  return { post, community, authorUsername, contentHidden }
}
