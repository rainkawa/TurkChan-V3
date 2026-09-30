import type { Ctx } from '../context'
import type { UploadKind, UploadRow, UserRow } from '../types'
import { newSecret, newUuid, sha256 } from '../lib/ids'
import {
  MAX_IMAGE_EDGE,
  MAX_IMAGE_PIXELS,
  detectImageType,
  gifStats,
  imageDimensions,
  mimeForImageType,
  stripImageMetadata,
} from '../lib/images'
import { MAX_GIF_FRAMES, UPLOAD_LIMITS, detectUploadKind, mimeForUploadKind } from '../lib/media'
import { makeThumbnail } from '../lib/thumbnails'
import { badRequest, forbidden, notFound, rateLimited, unauthorized } from './errors'

/**
 * Pre-signed-style upload flow (US-015): the client asks for an upload slot,
 * receives an unguessable key + one-time token, PUTs bytes, and only then can
 * a post reference the key. A failed upload leaves no orphaned post because
 * post creation requires status='uploaded'.
 */

export function requestUpload(ctx: Ctx, viewer: UserRow | null): { key: string; token: string } {
  if (!viewer) throw unauthorized()
  const limit = ctx.rateLimiter.check(`upload:${viewer.id}`, 20, 10 * 60 * 1000)
  if (!limit.allowed) throw rateLimited(limit.retryAfterMs)
  const key = newUuid()
  const token = newSecret()
  ctx.db
    .prepare('INSERT INTO uploads (key, uploader_id, token_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(key, viewer.id, sha256(token), ctx.now())
  return { key, token }
}

export async function receiveUpload(
  ctx: Ctx,
  key: string,
  token: string,
  bytes: Uint8Array,
  /** Bu alanın kabul ettiği türler; verilmezse hepsi kabul edilir. */
  allowed?: UploadKind[],
): Promise<UploadRow> {
  const upload = ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as UploadRow | undefined
  if (!upload || upload.token_hash !== sha256(token)) throw notFound('Yükleme alanı bulunamadı.')
  if (upload.status !== 'pending') throw badRequest('upload_used', 'Bu yükleme alanı zaten kullanılmış.')
  if (bytes.length === 0) throw badRequest('empty', 'Yüklenen dosya boş.')

  const kind = detectUploadKind(bytes)
  if (!kind) {
    throw badRequest('bad_type', 'Yalnızca JPEG, PNG, WebP, GIF, MP4 ve WebM dosyaları kabul edilir.')
  }
  if (allowed && !allowed.includes(kind)) {
    throw badRequest('bad_type', `Bu alan yalnızca ${allowed.map((k) => (k === 'image' ? 'görsel' : k === 'gif' ? 'GIF' : 'video')).join(', ')} kabul eder.`)
  }
  const limit = UPLOAD_LIMITS[kind]
  if (bytes.length > limit) {
    const mb = Math.round(limit / (1024 * 1024))
    const label = kind === 'video' ? 'Videolar' : kind === 'gif' ? 'GIFler' : 'Görseller'
    throw badRequest('too_large', `${label} en fazla ${mb} MB olabilir.`)
  }
  assertSaneDimensions(kind, bytes)

  // Yalnızca görsellerin metadata'sı soyulur; GIF/video başlıkları bozulur.
  const stored = kind === 'image' ? stripImageMetadata(bytes) : bytes
  // MIME yalnızca imzadan türetilir; istemcinin beyanı güvenilmez.
  const mime = kind === 'image' ? mimeForImageType(detectImageType(bytes) as 'jpeg') : mimeForUploadKind(kind, bytes)
  await ctx.storage.put(key, stored)
  // Küçük resim: akış bunu kullanır, tam boyut yalnızca tıklanınca indirilir.
  // Üretilemezse orijinal sunulur (zarif düşüş).
  let thumbKey: string | null = null
  if (kind === 'image') {
    const thumb = await makeThumbnail(stored)
    if (thumb) {
      thumbKey = `${key}t`
      await ctx.storage.put(thumbKey, thumb.bytes)
    }
  }
  ctx.db
    .prepare("UPDATE uploads SET status = 'uploaded', mime = ?, size = ?, thumb_key = ? WHERE key = ?")
    .run(mime, stored.length, thumbKey, key)
  return ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as unknown as UploadRow
}


/**
 * Boyut/kare sınırları — decompression bomb ve aşırı kareli GIF koruması.
 *
 * Dosya bayt sayısı küçük olsa bile piksel sayısı devasa olabilir; sunucuda
 * çözüldüğünde bellek ve CPU tüketir. Bu yüzden başlıktan okunan piksel
 * boyutu da sınırlanır (piksel verisi çözülmez).
 */
function assertSaneDimensions(kind: UploadKind, bytes: Uint8Array): void {
  if (kind === 'video') return
  if (kind === 'gif') {
    const stats = gifStats(bytes)
    if (!stats) return
    if (stats.frames > MAX_GIF_FRAMES) {
      throw badRequest('too_many_frames', `GIF en fazla ${MAX_GIF_FRAMES} kare içerebilir.`)
    }
    assertPixels(stats.width, stats.height, 'GIF')
    return
  }
  const size = imageDimensions(bytes)
  if (size) assertPixels(size.width, size.height, 'Görsel')
}

function assertPixels(width: number, height: number, label: string): void {
  if (width <= 0 || height <= 0) throw badRequest('bad_dimensions', `${label} boyutları geçersiz.`)
  if (width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) {
    throw badRequest('too_large', `${label} en fazla ${MAX_IMAGE_EDGE} piksel genişlik/yükseklikte olabilir.`)
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw badRequest('too_large', `${label} çok fazla piksel içeriyor (en fazla ${MAX_IMAGE_PIXELS}).`)
  }
}

/** Claim an uploaded image for a post. Enforces ownership and single use. */
export function attachUpload(ctx: Ctx, viewer: UserRow, key: string): UploadRow {
  const upload = ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as UploadRow | undefined
  if (!upload)    throw badRequest('upload_missing', 'Görsel yüklemesi bulunamadı — önce görseli yükleyin.')
  if (upload.uploader_id !== viewer.id) throw forbidden('Bu yükleme başka bir hesaba ait.')
  if (upload.status !== 'uploaded') {
    throw badRequest('upload_incomplete', 'Görsel yüklemesi tamamlanmadı. Tekrar yükleyin.')
  }
  ctx.db.prepare("UPDATE uploads SET status = 'attached' WHERE key = ?").run(key)
  return { ...upload, status: 'attached' }
}

export async function serveUpload(
  ctx: Ctx,
  key: string,
  variant: 'full' | 'thumb' = 'full',
): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const upload = ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as UploadRow | undefined
  if (!upload || upload.status === 'pending') return null
  // Küçük resim isteniyorsa ve üretilmişse o sunulur.
  if (variant === 'thumb' && upload.thumb_key) {
    const thumb = await ctx.storage.get(upload.thumb_key)
    if (thumb) return { bytes: thumb, mime: 'image/jpeg' }
  }
  const bytes = await ctx.storage.get(key)
  if (!bytes) return null
  return { bytes, mime: upload.mime ?? 'application/octet-stream' }
}
