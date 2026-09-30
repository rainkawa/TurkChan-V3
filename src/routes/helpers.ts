import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { getConnInfo } from '@hono/node-server/conninfo'
import type { Ctx } from '../context'
import type { UserRow } from '../types'
import { unreadCount } from '../services/notifications'
import { AppError } from '../services/errors'
import { dmUnreadCount } from '../services/dm'

export interface AppEnv {
  Variables: {
    viewer: UserRow | null
    sessionToken: string | undefined
  }
}

export type C = Context<AppEnv>

export const SESSION_COOKIE = 'sid'

/**
 * İstemci IP adresi.
 *
 * `X-Forwarded-For` istemci tarafından taklit edilebildiği için YALNIZCA
 * güvenilir bir ters vekilin arkasında (TRUST_PROXY=1) okunur; aksi hâlde
 * sadece gerçek soket adresi kullanılır. Rate limitler bu değere dayandığı
 * için sahte başlıkla atlatılabilmesi önemlidir.
 */
export function clientIp(c: C, ctx: Ctx): string {
  const direct = remoteAddress(c)
  if (!ctx.config.trustProxy) return direct
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return (forwarded.split(',')[0] as string).trim() || direct
  return c.req.header('x-real-ip') ?? direct
}

/** @hono/node-server bağlantı bilgisi; test/Workers ortamında yoksa null. */
function remoteAddress(c: C): string {
  try {
    const info = getConnInfo(c)
    return info.remote.address ?? '127.0.0.1'
  } catch {
    return '127.0.0.1'
  }
}

export function setSessionCookie(ctx: Ctx, c: C, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    // JavaScript erişimi kapalı: XSS ile çerez okunamaz.
    httpOnly: true,
    // Üretimde yalnızca HTTPS.
    secure: ctx.config.secureCookies,
    // Aynı site içi tüm isteklerde gönderilir; siteler arası POST'lara gönderilmez.
    // Strict seçilemez çünkü giden bağlantılarda (e-posta doğrulama dönüşü gibi)
    // tarayıcı çerezi düşürebilir. CSRF koruması yine de server-side doğrulanır.
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(ctx.config.sessionTtlMs / 1000),
  })
}

export function clearSessionCookie(c: C): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export type FlashKind = 'ok' | 'error' | 'warn'

export function setFlash(c: C, kind: FlashKind, message: string): void {
  setCookie(c, 'flash', encodeURIComponent(`${kind}:${message}`), {
    httpOnly: true,
    sameSite: 'Lax',
    path: '/',
    maxAge: 60,
  })
}

export function takeFlash(c: C): { kind: FlashKind; message: string } | null {
  const raw = getCookie(c, 'flash')
  if (!raw) return null
  deleteCookie(c, 'flash', { path: '/' })
  try {
    const decoded = decodeURIComponent(raw)
    const sep = decoded.indexOf(':')
    if (sep === -1) return null
    const kind = decoded.slice(0, sep) as FlashKind
    if (!['ok', 'error', 'warn'].includes(kind)) return null
    return { kind, message: decoded.slice(sep + 1) }
  } catch {
    return null
  }
}

/** Only allow same-site relative redirect targets (no open redirects). */
export function safeNext(raw: string | undefined, fallback = '/'): string {
  if (!raw) return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback
  return raw
}

export function unread(ctxApp: Ctx, viewer: UserRow | null): number {
  if (!viewer) return 0
  return unreadCount(ctxApp, viewer.id)
}

/** Alt bardaki kırmızı rozet için okunmamış DM sayısı (bildirimlerle birlikte). */
export function dmUnread(ctxApp: Ctx, viewer: UserRow | null): number {
  if (!viewer) return 0
  try {
    return dmUnreadCount(ctxApp, viewer.id)
  } catch {
    return 0
  }
}

export function loginRedirect(c: C): Response {
  const next = encodeURIComponent(new URL(c.req.url).pathname)
  return c.redirect(`/login?next=${next}`)
}

export async function formData(c: C): Promise<Record<string, string>> {
  const contentType = c.req.header('content-type') ?? ''
  if (contentType.includes('application/json')) {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, String(v ?? '')]))
  }
  const parsed = await c.req.parseBody()
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/**
 * multipart gövdesindeki tek veya çoklu dosya alanını dosya listesine çevirir.
 * `parseBody()` birden çok dosyada yalnızca ilkini döndürdüğü için `formData()`
 * üzerinden `getAll()` kullanılır.
 */
export function collectFiles(form: FormData, field: string): File[] {
  const out: File[] = []
  for (const value of form.getAll(field)) {
    if (value instanceof File && value.size > 0) out.push(value)
  }
  return out
}

/**
 * Toplam istek gövdesi sınırı.
 *
 * `Content-Length` başlığına güvenilmez (sonda olabilir ya da hiç gelmeyebilir),
 * bu yüzden hem başlık hem de gerçek bayt sayımı denetlenir. Sınır aşımında
 * bağlantı düşürülür; bellek tükenmesi (OOM) saldırıları böylece engellenir.
 */
export const MAX_BODY_BYTES = 80 * 1024 * 1024

/** Akıştan en fazla `max` bayt okur; aşarsa 413 fırlatır. */
export async function readBodyWithLimit(c: C, max: number): Promise<Uint8Array> {
  const declared = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(declared) && declared > max) {
    throw new AppError(413, 'body_too_large', 'Gönderilen veri çok büyük.')
  }
  const declaredStream = c.req.raw.body
  if (!declaredStream) return new Uint8Array(await c.req.arrayBuffer())
  const reader = declaredStream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.byteLength
      if (total > max) {
        await reader.cancel().catch(() => {})
        throw new AppError(413, 'body_too_large', 'Gönderilen veri çok büyük.')
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
