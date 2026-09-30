import type { Ctx } from '../context'
import type { CommentRow, PostRow, UploadKind, UserRow, Viewer } from '../types'
import { newId } from '../lib/ids'
import { validateCommentBody } from '../lib/validation'
import { wilsonLowerBound } from '../lib/ranking'
import { MAX_VIDEOS_PER_POST, uploadKindFromMime } from '../lib/media'
import { getSettings } from './settings'
import { badRequest, forbidden, notFound, rateLimited } from './errors'
import { getCommunityById, requireParticipant } from './access'
import { getPost, getPostForViewer, resolveAnonymous } from './posts'
import { AFFINITY_STEP, bumpAffinity } from './feeds'
import { attachUpload } from './uploads'
import { notify, withdrawForComment } from './notifications'
import { transaction } from '../db'

/** Visual nesting cap (FR-6): depth is 1-based; replies beyond 8 flatten to 8. */
export const MAX_COMMENT_DEPTH = 8
const TEN_MINUTES_MS = 10 * 60 * 1000

/** Bir yoruma eklenebilecek azami video sayısı. */
const MAX_VIDEOS_PER_COMMENT = 1

export interface CommentMediaItem {
  key: string
  mime: string | null
  kind: UploadKind
}

/** Yorum gövdesindeki @kullanıcı bahislerini çıkarır (benzersiz, sıra korunur). */
function parseMentions(body: string): string[] {
  const out: string[] = []
  // Kullanıcı adları yalnızca harf, rakam ve alt çizgi içerir.
  for (const match of body.matchAll(/(^|[^\w])@([A-Za-z0-9_]{2,20})/g)) {
    const username = (match[2] ?? '').toLowerCase()
    if (username && !out.includes(username)) out.push(username)
  }
  return out
}

export function getComment(ctx: Ctx, id: string): CommentRow | null {
  return (ctx.db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow | undefined) ?? null
}

/** Bir gönderinin tüm yorumlarına eklenmiş medya (yorum kimliğiyle eşleşir). */
export function commentMediaByPost(ctx: Ctx, postId: string): Map<string, CommentMediaItem[]> {
  const rows = ctx.db
    .prepare(
      `SELECT m.comment_id, m.media_key, m.mime, m.kind
         FROM comment_media m JOIN comments c ON c.id = m.comment_id
        WHERE c.post_id = ?
        ORDER BY m.comment_id ASC, m.position ASC`,
    )
    .all(postId) as unknown as Array<{ comment_id: string; media_key: string; mime: string | null; kind: UploadKind }>
  const out = new Map<string, CommentMediaItem[]>()
  for (const row of rows) {
    const list = out.get(row.comment_id) ?? []
    list.push({ key: row.media_key, mime: row.mime, kind: row.kind })
    out.set(row.comment_id, list)
  }
  return out
}

/**
 * Anonim yorum kararı. Gönderilerdeki `resolveAnonymous` ile aynı desen:
 * form kutusu işaretli geldiği için, kaldırmak o yorum için anonimliği kapatır.
 */
function resolveCommentAnonymous(ctx: Ctx, user: UserRow, requested: boolean | undefined): string | null {
  return resolveAnonymous(ctx, user, requested)
}

/**
 * Yüklenmiş dosyaları doğrular ve tek kullanımlık olarak yoruma bağlar.
 *
 * Doğrulama yorum yazılmadan önce, `attachUpload` çağrısı ise işlem (transaction)
 * içinde yapılır: yorum oluşturulup geri alınırsa yükleme alanı boşa çıkmaz.
 */
function claimCommentUploads(ctx: Ctx, user: UserRow, keys: string[]): CommentMediaItem[] {
  const settings = getSettings(ctx)
  if (keys.length > settings.mediaPerComment) {
    throw badRequest('too_many_media', `Bir yoruma en fazla ${settings.mediaPerComment} dosya eklenebilir.`)
  }
  let videoCount = 0
  return keys.map((key) => {
    const upload = ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as
      | { uploader_id: string; status: string; mime: string | null }
      | undefined
    if (!upload) throw badRequest('upload_missing', 'Dosya yüklemesi bulunamadı.')
    if (upload.uploader_id !== user.id) throw forbidden('Bu dosya başka bir hesaba ait.')
    if (upload.status !== 'uploaded') throw badRequest('upload_incomplete', 'Dosya yüklemesi tamamlanmadı.')
    const kind = uploadKindFromMime(upload.mime)
    if (!kind) throw badRequest('bad_type', 'Desteklenmeyen dosya türü.')
    if (kind === 'video') {
      videoCount += 1
      if (videoCount > MAX_VIDEOS_PER_COMMENT) {
        throw badRequest('too_many_videos', `Bir yoruma en fazla ${MAX_VIDEOS_PER_POST} video eklenebilir.`)
      }
    }
    return { key, kind, mime: upload.mime }
  })
}

export function createComment(
  ctx: Ctx,
  viewer: Viewer,
  postId: string,
  input: {
    body: string
    parentId?: string | null
    mediaKeys?: string[]
    spoiler?: boolean
    anonymous?: boolean
  },
): CommentRow {
  const post = getPost(ctx, postId)
  if (!post || post.deleted) throw notFound('Gönderi bulunamadı.')

  if (post.removed || post.auto_hidden) {
    throw forbidden('Kaldırılan içeriklere yorum yapılamaz.')
  }
  const community = getCommunityById(ctx, post.community_id)
  if (!community) throw notFound('Gönderi bulunamadı.')
  const user = requireParticipant(ctx, viewer, community, {
    requireMembership: community.visibility !== 'public',
  })

  const settings = getSettings(ctx)
  const limit = ctx.rateLimiter.check(`comment:${user.id}`, settings.commentsPer10Min, TEN_MINUTES_MS)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)

  const keys = input.mediaKeys ?? []
  // Medya varsa gövde boş olabilir; ikisi de yoksa yorum yazılmış sayılır.
  const rawBody = (input.body ?? '').trim()
  if (keys.length === 0 && rawBody.length === 0) throw badRequest('body', 'Yorum boş olamaz.')
  const body = keys.length > 0 && rawBody.length === 0 ? '' : validateCommentBody(rawBody)

  let parent: CommentRow | null = null
  if (input.parentId) {
    parent = getComment(ctx, input.parentId)
    if (!parent || parent.post_id !== postId) throw notFound('Üst yorum bulunamadı.')
    if (parent.deleted && !hasVisibleContent(parent)) {
      // Replying to a [deleted] placeholder is allowed (the nesting stays intact).
    }
  }

  const now = ctx.now()
  const anonName = resolveCommentAnonymous(ctx, user, input.anonymous)
  const media = claimCommentUploads(ctx, user, keys)
  const id = newId()
  const depth = parent ? Math.min(parent.depth + 1, MAX_COMMENT_DEPTH) : 1
  const path = parent ? `${parent.path}/${id}` : id
  // Kişiselleştirilmiş akış: yorum yazmak boarda ilgiyi artırır.
  bumpAffinity(ctx, user.id, community.id, AFFINITY_STEP.comment)
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO comments (id, post_id, parent_id, path, depth, author_id, body, spoiler,
                               is_anonymous, anon_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, postId, parent?.id ?? null, path, depth, user.id, body, input.spoiler ? 1 : 0,
        anonName ? 1 : 0, anonName, now)
    ctx.db.prepare('UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?').run(postId)
    if (media.length > 0) {
      const ins = ctx.db.prepare(
        'INSERT INTO comment_media (id, comment_id, position, media_key, mime, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      media.forEach((item, index) => {
        // Tek kullanımlık: yükleme bu yoruma bağlanır.
        attachUpload(ctx, user, item.key)
        ins.run(newId(), id, index, item.key, item.mime, item.kind, now)
      })
    }

    // @bahis: etiketlenen kullanıcıya bildirim (kendine bahis vermez).
    recordMentions(ctx, {
      commentId: id,
      postId,
      communityName: community.name,
      actor: user,
      body,
      createdAt: now,
    })

    // Direct-reply notification (US-040): parent comment author, or post author
    // for top-level comments. Never for self-replies.
    const recipientId = parent ? parent.author_id : post.author_id
    const recipientVisible = parent ? !parent.deleted && !parent.removed : !post.deleted && !post.removed
    if (recipientId !== user.id && recipientVisible) {
      notify(ctx, {
        userId: recipientId,
        actorId: user.id,
        type: 'reply',
        title: `/tc/${user.username}, c/${community.name} topluluğundaki ${parent ? 'yorumunuza' : 'gönderinize'} yanıt verdi`,
        link: `/c/${community.name}/comments/${postId}/comment/${id}`,
        sourceCommentId: id,
      })
    }
  })
  return getComment(ctx, id) as CommentRow
}

/** Yorumdaki @kullanıcı bahislerini kaydeder ve ilgili kullanıcıları bilgilendirir. */
function recordMentions(
  ctx: Ctx,
  input: {
    commentId: string
    postId: string
    communityName: string
    actor: UserRow
    body: string
    createdAt: number
  },
): void {
  const usernames = parseMentions(input.body)
  if (usernames.length === 0) return
  const placeholders = usernames.map(() => '?').join(',')
  const users = ctx.db
    .prepare(`SELECT id, username FROM users WHERE deleted = 0 AND username_lower IN (${placeholders})`)
    .all(...usernames) as unknown as Array<{ id: string; username: string }>
  const ins = ctx.db.prepare(
    'INSERT OR IGNORE INTO comment_mentions (comment_id, user_id, created_at) VALUES (?, ?, ?)',
  )
  for (const target of users) {
    if (target.id === input.actor.id) continue
    ins.run(input.commentId, target.id, input.createdAt)
    notify(ctx, {
      userId: target.id,
      actorId: input.actor.id,
      type: 'mention',
      title: `/tc/${input.actor.username}, bir yorumda seni etiketledi: @${target.username}`,
      link: `/c/${input.communityName}/comments/${input.postId}/comment/${input.commentId}`,
      sourceCommentId: input.commentId,
    })
  }
}

function hasVisibleContent(comment: CommentRow): boolean {
  return !comment.deleted && !comment.removed
}

export function editComment(ctx: Ctx, viewer: Viewer, commentId: string, body: string): CommentRow {
  const comment = getComment(ctx, commentId)
  if (!comment || comment.deleted) throw notFound('Yorum bulunamadı.')
  if (!viewer || viewer.id !== comment.author_id) throw forbidden('Bu yorumu yalnızca yazarı düzenleyebilir.')
  if (comment.removed) throw forbidden('Bu yorum bir moderatör tarafından kaldırıldı ve düzenlenemez.')
  const community = getCommunityById(ctx, (getPost(ctx, comment.post_id) as PostRow).community_id)
  if (!community || community.archived || community.deleted_at !== null) {
    throw badRequest('archived', 'Bu topluluk arşivlenmiş ve salt okunur durumdadır.')
  }
  const validBody = validateCommentBody(body)
  const now = ctx.now()
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE comments SET body = ?, edited_at = ? WHERE id = ?').run(validBody, now, commentId)
    // Bahisler yeniden hesaplanır: kaldırılan @ad artık bildirim üretmez.
    ctx.db.prepare('DELETE FROM comment_mentions WHERE comment_id = ?').run(commentId)
    recordMentions(ctx, {
      commentId,
      postId: comment.post_id,
      communityName: community.name,
      actor: viewer,
      body: validBody,
      createdAt: now,
    })
  })
  return getComment(ctx, commentId) as CommentRow
}

/**
 * Yazarın kendi yorumunun spoiler ve anonim bilgisini günceller.
 * `anonymous` verilmezse mevcut durum korunur; `false` anonimliği kapatır ve
 * gerçek yazar byline'ına döner.
 */
export function updateCommentMeta(
  ctx: Ctx,
  viewer: Viewer,
  commentId: string,
  patch: { spoiler?: boolean; anonymous?: boolean },
): CommentRow {
  const comment = getComment(ctx, commentId)
  if (!comment || comment.deleted) throw notFound('Yorum bulunamadı.')
  if (!viewer || viewer.id !== comment.author_id) {
    throw forbidden('Bu yorumun ayarlarını yalnızca yazarı değiştirebilir.')
  }
  const spoiler = patch.spoiler === undefined ? comment.spoiler === 1 : patch.spoiler
  let anonName = comment.anon_name
  let isAnon = comment.is_anonymous === 1
  if (patch.anonymous !== undefined) {
    isAnon = patch.anonymous
    anonName = patch.anonymous ? (comment.anon_name ?? resolveAnonymous(ctx, viewer, true)) : null
  }
  ctx.db
    .prepare('UPDATE comments SET spoiler = ?, is_anonymous = ?, anon_name = ? WHERE id = ?')
    .run(spoiler ? 1 : 0, isAnon ? 1 : 0, anonName, commentId)
  return getComment(ctx, commentId) as CommentRow
}

/**
 * US-020: deleting a leaf removes the row and decrements the count; deleting a
 * comment with replies leaves a "[deleted]" placeholder preserving structure.
 */
export function deleteComment(ctx: Ctx, viewer: Viewer, commentId: string): { placeholder: boolean } {
  const comment = getComment(ctx, commentId)
  if (!comment || comment.deleted) throw notFound('Yorum bulunamadı.')
  if (!viewer || viewer.id !== comment.author_id) throw forbidden('Bu yorumu yalnızca yazarı silebilir.')

  const childCount = (
    ctx.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE parent_id = ?').get(commentId) as { n: number }
  ).n

  return transaction(ctx.db, () => {
    withdrawForComment(ctx, commentId)
    if (childCount > 0) {
      // Yer tutucu: içerik ve ekler görünmez olur.
      ctx.db
        .prepare("UPDATE comments SET deleted = 1, body = '', spoiler = 0 WHERE id = ?")
        .run(commentId)
      ctx.db.prepare('DELETE FROM comment_media WHERE comment_id = ?').run(commentId)
      ctx.db.prepare('DELETE FROM comment_mentions WHERE comment_id = ?').run(commentId)
      return { placeholder: true }
    }
    ctx.db.prepare('DELETE FROM votes WHERE target_type = ? AND target_id = ?').run('comment', commentId)
    ctx.db.prepare('DELETE FROM comment_media WHERE comment_id = ?').run(commentId)
    ctx.db.prepare('DELETE FROM comment_mentions WHERE comment_id = ?').run(commentId)
    ctx.db.prepare('DELETE FROM comments WHERE id = ?').run(commentId)
    ctx.db.prepare('UPDATE posts SET comment_count = comment_count - 1 WHERE id = ?').run(comment.post_id)
    return { placeholder: false }
  })
}

export type CommentSort = 'best' | 'new' | 'top'

/**
 * Yorum sıralaması: `best` Wilson alt sınırı (güvenilirlik), `top` ham puan
 * (popüler), `new` kronolojik. Arayüzde "En iyi / Popüler / Yeni" olarak
 * gösterilir.
 */
export function parseCommentSort(raw: string | undefined): CommentSort {
  if (raw === 'new') return 'new'
  if (raw === 'top' || raw === 'hot' || raw === 'popular') return 'top'
  return 'best'
}

export interface CommentNode {
  comment: CommentRow
  authorUsername: string | null
  children: CommentNode[]
  hidden: 'deleted' | 'removed' | 'pending_review' | null
}

/** Bir gönderinin yorumlarında geçen @bahisler (yorum kimliğiyle eşleşir). */
export function commentMentionNamesByPost(ctx: Ctx, postId: string): Map<string, string[]> {
  const rows = ctx.db
    .prepare(
      `SELECT m.comment_id, u.username
         FROM comment_mentions m
         JOIN comments c ON c.id = m.comment_id
         JOIN users u ON u.id = m.user_id
        WHERE c.post_id = ? AND u.deleted = 0`,
    )
    .all(postId) as unknown as Array<{ comment_id: string; username: string }>
  const out = new Map<string, string[]>()
  for (const row of rows) {
    const list = out.get(row.comment_id) ?? []
    if (!list.includes(row.username)) list.push(row.username)
    out.set(row.comment_id, list)
  }
  return out
}

/**
 * Full comment tree for a post, siblings ordered by the chosen sort at every
 * level. Placeholders preserve structure for deleted/removed comments.
 */
export function getCommentTree(ctx: Ctx, viewer: Viewer, postId: string, sort: CommentSort): CommentNode[] {
  // Access is enforced by the same gate the post page uses.
  getPostForViewer(ctx, viewer, postId)

  const rows = ctx.db
    .prepare(
      `SELECT c.*, u.username AS author_username, u.deleted AS author_deleted
       FROM comments c JOIN users u ON u.id = c.author_id
       WHERE c.post_id = ?`,
    )
    .all(postId) as unknown as Array<CommentRow & { author_username: string; author_deleted: number }>

  const nodes = new Map<string, CommentNode>()
  for (const row of rows) {
    const hidden = row.deleted
      ? 'deleted'
      : row.removed
        ? 'removed'
        : row.auto_hidden
          ? 'pending_review'
          : null
    nodes.set(row.id, {
      comment: row,
      // Anonim yorumlarda gerçek hesap adı hiçbir koşulda sızmaz; gerçek yazar
      // yalnızca yönetim panelinden görülebilir.
      authorUsername: hidden || row.author_deleted || row.is_anonymous === 1 ? null : row.author_username,
      children: [],
      hidden,
    })
  }

  const roots: CommentNode[] = []
  for (const row of rows) {
    const node = nodes.get(row.id) as CommentNode
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const compare = comparatorFor(sort)
  const sortTree = (list: CommentNode[]) => {
    list.sort(compare)
    for (const node of list) sortTree(node.children)
  }
  sortTree(roots)
  return roots
}

function comparatorFor(sort: CommentSort): (a: CommentNode, b: CommentNode) => number {
  if (sort === 'new') {
    return (a, b) => b.comment.created_at - a.comment.created_at || (a.comment.id < b.comment.id ? 1 : -1)
  }
  if (sort === 'top') {
    // Popüler: ham puan, eşitlikte yeni olan öne geçer.
    return (a, b) => b.comment.score - a.comment.score || b.comment.created_at - a.comment.created_at
  }
  // En iyi: Wilson alt sınırı — az oyla gelen yorumlar tırmanmaya karşı geri kalır.
  return (a, b) => {
    const wa = wilsonLowerBound(a.comment.upvotes, a.comment.downvotes)
    const wb = wilsonLowerBound(b.comment.upvotes, b.comment.downvotes)
    return wb - wa || b.comment.created_at - a.comment.created_at
  }
}

/** Ancestor chain for a permalinked comment (US-019). */
export function getCommentAncestors(ctx: Ctx, comment: CommentRow): CommentRow[] {
  const ids = comment.path.split('/').slice(0, -1)
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = ctx.db
    .prepare(`SELECT * FROM comments WHERE id IN (${placeholders})`)
    .all(...ids) as unknown as CommentRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))
  return ids.map((id) => byId.get(id)).filter((r): r is CommentRow => Boolean(r))
}
