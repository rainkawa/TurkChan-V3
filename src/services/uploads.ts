import type { Ctx } from '../context'
import type { UploadRow, UserRow } from '../types'
import { newSecret, newUuid, sha256 } from '../lib/ids'
import { detectImageType, mimeForImageType, stripImageMetadata } from '../lib/images'
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

export async function receiveUpload(ctx: Ctx, key: string, token: string, bytes: Uint8Array): Promise<UploadRow> {
  const upload = ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as UploadRow | undefined
  if (!upload || upload.token_hash !== sha256(token)) throw notFound('Upload slot not found.')
  if (upload.status !== 'pending') throw badRequest('upload_used', 'This upload slot was already used.')
  if (bytes.length === 0) throw badRequest('empty', 'The uploaded file is empty.')
  if (bytes.length > ctx.config.maxImageBytes) {
    throw badRequest('too_large', 'Images must be 10 MB or smaller.')
  }
  const type = detectImageType(bytes)
  if (!type) throw badRequest('bad_type', 'Only JPEG, PNG, and WebP images are accepted.')

  const stripped = stripImageMetadata(bytes)
  await ctx.storage.put(key, stripped)
  ctx.db
    .prepare("UPDATE uploads SET status = 'uploaded', mime = ?, size = ? WHERE key = ?")
    .run(mimeForImageType(type), stripped.length, key)
  return ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as unknown as UploadRow
}

/** Claim an uploaded image for a post. Enforces ownership and single use. */
export function attachUpload(ctx: Ctx, viewer: UserRow, key: string): UploadRow {
  const upload = ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as UploadRow | undefined
  if (!upload) throw badRequest('upload_missing', 'Image upload not found — upload the image first.')
  if (upload.uploader_id !== viewer.id) throw forbidden('That upload belongs to another account.')
  if (upload.status !== 'uploaded') {
    throw badRequest('upload_incomplete', 'The image upload did not complete. Upload it again.')
  }
  ctx.db.prepare("UPDATE uploads SET status = 'attached' WHERE key = ?").run(key)
  return { ...upload, status: 'attached' }
}

export async function serveUpload(ctx: Ctx, key: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  const upload = ctx.db.prepare('SELECT * FROM uploads WHERE key = ?').get(key) as UploadRow | undefined
  if (!upload || upload.status === 'pending') return null
  const bytes = await ctx.storage.get(key)
  if (!bytes) return null
  return { bytes, mime: upload.mime ?? 'application/octet-stream' }
}
