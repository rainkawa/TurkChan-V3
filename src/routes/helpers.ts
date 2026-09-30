import type { Context } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { Ctx } from '../context'
import type { UserRow } from '../types'
import { unreadCount } from '../services/notifications'
import { dmUnreadCount } from '../services/dm'

export interface AppEnv {
  Variables: {
    viewer: UserRow | null
    sessionToken: string | undefined
  }
}

export type C = Context<AppEnv>

export const SESSION_COOKIE = 'sid'

export function clientIp(c: C): string {
  const forwarded = c.req.header('x-forwarded-for')
  if (forwarded) return (forwarded.split(',')[0] as string).trim()
  return c.req.header('x-real-ip') ?? '127.0.0.1'
}

export function setSessionCookie(ctx: Ctx, c: C, token: string): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: ctx.config.secureCookies,
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
