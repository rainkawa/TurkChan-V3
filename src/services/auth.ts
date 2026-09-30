import type { Ctx } from '../context'
import type { UserRow } from '../types'
import { newId, newSecret, sha256 } from '../lib/ids'
import { hashPassword, verifyPassword } from '../lib/passwords'
import {
  validateUsername,
  validateEmail,
  validatePassword,
  validateDisplayName,
  ValidationError,
} from '../lib/validation'
import { getSettings } from './settings'
import { AppError, badRequest, conflict, forbidden, rateLimited, unauthorized } from './errors'
import { logSecurity, maskIp } from '../lib/logging'
import { transaction } from '../db'

const LOCKOUT_WINDOW_MS = 15 * 60 * 1000
const LOCKOUT_THRESHOLD = 5

export interface SessionResult {
  user: UserRow
  sessionToken: string
}

export function getUserById(ctx: Ctx, id: string): UserRow | null {
  return (ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined) ?? null
}

export function getUserByUsername(ctx: Ctx, username: string): UserRow | null {
  return (
    (ctx.db
      .prepare('SELECT * FROM users WHERE username_lower = ? AND deleted = 0')
      .get(username.toLowerCase()) as UserRow | undefined) ?? null
  )
}

export async function register(
  ctx: Ctx,
  input: { username: string; password: string; displayName?: string; email?: string; ip: string; inviteCode?: string },
): Promise<SessionResult> {
  const ipLimit = ctx.rateLimiter.check(`register:${input.ip}`, 5, 60 * 60 * 1000)
  if (!ipLimit.allowed) throw rateLimited(ipLimit.retryAfterMs)

  const settings = getSettings(ctx)
  if (settings.registrationMode === 'closed') {
    throw forbidden('Kayıtlar şu anda kapalı. Program koordinatörünüzle iletişime geçin.')
  }
  let inviteCode: string | null = null
  if (settings.registrationMode === 'invite') {
    inviteCode = (input.inviteCode ?? '').trim()
    if (!inviteCode) throw badRequest('invite_required', 'Kayıt yalnızca davetle yapılabilir. Davet bağlantısı gerekiyor.')
    const invite = ctx.db.prepare('SELECT * FROM invites WHERE code = ?').get(inviteCode) as
      | { code: string; expires_at: number; max_uses: number; uses: number }
      | undefined
    if (!invite || invite.expires_at <= ctx.now() || invite.uses >= invite.max_uses) {
      throw badRequest('invite_invalid', 'Bu davet bağlantısı geçersiz ya da süresi dolmuş.')
    }
  }

  const username = validateUsername(input.username)
  const password = validatePassword(input.password)
  // E-posta kayıtta istenmez; yalnızca sonradan (ayarlardan veya yönetimden)
  // eklenirse doğrulanır. Boş bırakılırsa NULL olarak saklanır.
  const rawEmail = (input.email ?? '').trim()
  const email = rawEmail ? validateEmail(rawEmail) : null
  // Görünen ad verilmezse kullanıcı adı varsayılan olur.
  const displayName = validateDisplayName(input.displayName?.trim() || username)

  const usernameTaken = ctx.db
    .prepare('SELECT 1 FROM users WHERE username_lower = ?')
    .get(username.toLowerCase())
  if (usernameTaken) throw conflict('username_taken', 'Bu kullanıcı adı zaten alınmış.')

  if (email) {
    const emailTaken = ctx.db.prepare('SELECT 1 FROM users WHERE email_lower = ?').get(email)
    if (emailTaken) {
      // Non-enumerating (US-001): the message never confirms the address exists.
      throw conflict(
        'email_unavailable',
        'Bu e-posta zaten kayıtlıysa giriş yapın ya da parola sıfırlama kullanın. Değilse farklı bir adres deneyin.',
      )
    }
  }

  const passwordHash = await hashPassword(password)
  const id = newId()
  const isFirstUser = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0

  const user = transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO users (id, username, username_lower, email_lower, password_hash, display_name, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, username, username.toLowerCase(), email, passwordHash, displayName, isFirstUser ? 1 : 0, ctx.now())
    if (inviteCode) {
      ctx.db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(inviteCode)
    }
    return getUserById(ctx, id) as UserRow
  })

  const sessionToken = createSession(ctx, user.id)
  return { user, sessionToken }
}

export interface SessionMeta {
  /** Geriye dönük imza; gizlilik gereği oturum tablosuna yazılmaz. */
  readonly ip?: string
}

/**
 * Yeni oturum açar.
 *
 * Token 256-bit kriptografik rastgelelikten üretilir ve veritabanında YALNIZCA
 * SHA-256 karması tutulur; böylece veritabanı okuyan biri oturumu ele geçiremez.
 * IP adresi / User-Agent bilerek saklanmaz (gizlilik ilkesi).
 */
export function createSession(ctx: Ctx, userId: string, _meta?: SessionMeta): string {
  const token = newSecret()
  const now = ctx.now()
  ctx.db
    .prepare(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sha256(token), userId, now, now + ctx.config.sessionTtlMs, now)
  return token
}

/**
 * Oturumu çözer ve iki zaman aşımını da sunucu tarafında uygular:
 *
 *  - **Mutlak ömür**: `expires_at` geçmişse token her koşulda reddedilir.
 *  - **Idle (boşta) ömür**: `last_seen_at`'ten bu yana `sessionIdleMs` geçtiyse
 *    oturum biter; oturum açıkken kullanıcı "sonsuza kadar" bağlı kalmaz.
 *
 * Kısa aralıklarla yazıp yokuş bağlantıyı (WAL) şişirmemek için `last_seen_at`
 * yalnızca bir dakikadan eskiyse güncellenir. Süresi dolan satırlar burada
 * temizlenir, böylece geçersiz token veritabanında birikmez.
 */
export function getSessionUser(ctx: Ctx, token: string | undefined | null): UserRow | null {
  if (!token) return null
  const now = ctx.now()
  const hash = sha256(token)
  const row = ctx.db
    .prepare(
      `SELECT u.*, s.expires_at AS session_expires_at, s.last_seen_at AS session_last_seen_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hash) as (UserRow & { session_expires_at: number; session_last_seen_at: number }) | undefined

  if (!row) return null

  if (row.session_expires_at <= now) {
    // Mutlak ömür doldu: kalıcı olarak düşür.
    ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash)
    return null
  }
  if (now - row.session_last_seen_at > ctx.config.sessionIdleMs) {
    ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash)
    return null
  }
  if (row.deleted) return null
  // Askıya alınan hesap mevcut oturumla da erişemez: oturum silinse bile
  // istek anında yeniden denetlenir (savunma derinliği).
  if (row.suspended_indefinitely || (row.suspended_until !== null && row.suspended_until > now)) {
    return null
  }

  if (now - row.session_last_seen_at >= 60_000) {
    ctx.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash)
  }
  return row
}

/**
 * Login/logout sırasında eski token'ı geçersiz kılıp yenisini verir.
 *
 * Session fixation'a karşı: giriş anında çerezdeki token ile veritabanındaki
 * satır eşleşmiyorsa yeni bir çerez yazılır.
 */
export function rotateSession(ctx: Ctx, userId: string, currentToken: string | undefined): string {
  if (currentToken) {
    ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(currentToken))
  }
  return createSession(ctx, userId)
}

export async function login(
  ctx: Ctx,
  input: { usernameOrEmail: string; password: string; ip: string; currentToken?: string },
): Promise<SessionResult> {
  const ipLimit = ctx.rateLimiter.check(`login:${input.ip}`, 20, LOCKOUT_WINDOW_MS)
  if (!ipLimit.allowed) throw rateLimited(ipLimit.retryAfterMs)

  const identifier = input.usernameOrEmail.trim().toLowerCase()
  const user = ctx.db
    .prepare('SELECT * FROM users WHERE (username_lower = ? OR email_lower = ?) AND deleted = 0')
    .get(identifier, identifier) as UserRow | undefined

  const attemptKey = user ? user.username_lower : identifier
  const recentFailures = (
    ctx.db
      .prepare(
        'SELECT COUNT(*) AS n FROM login_attempts WHERE username_lower = ? AND success = 0 AND created_at > ?',
      )
      .get(attemptKey, ctx.now() - LOCKOUT_WINDOW_MS) as { n: number }
  ).n
  if (recentFailures >= LOCKOUT_THRESHOLD) {
    logSecurity('login_locked', { account: attemptKey, ip: maskIp(input.ip) })
    throw new AppError(
      429,
      'account_locked',
      'Çok fazla başarısız giriş denemesi. Bu hesap geçici olarak kilitlendi — 15 dakika sonra tekrar deneyin.',
    )
  }

  const valid = user ? await verifyPassword(user.password_hash, input.password) : false
  ctx.db
    .prepare('INSERT INTO login_attempts (username_lower, success, created_at) VALUES (?, ?, ?)')
    .run(attemptKey, valid ? 1 : 0, ctx.now())

  if (!user || !valid) {
    // Hesabın var olup olmadığını ayırt etmeden loglanır; yanıt da aynıdır.
    logSecurity('login_failed', { account: attemptKey, ip: maskIp(input.ip) })
    throw unauthorized('Kullanıcı adı/e-posta veya parola hatalı.')
  }

  if (user.suspended_indefinitely || (user.suspended_until !== null && user.suspended_until > ctx.now())) {
    const until = user.suspended_indefinitely
      ? 'süresiz olarak'
      : `${new Date(user.suspended_until as number).toISOString().slice(0, 10)} tarihine kadar`
    throw forbidden(`Bu hesap ${until} askıya alınmış.${user.suspension_reason ? ` Sebep: ${user.suspension_reason}` : ''}`)
  }

  // Girişte token yenilenir (session fixation koruması): giriş öncesi çerezde
  // olan geçici oturum düşürülür ve yeni bir çerez yazılır.
  const sessionToken = ctx.config.sessionRotateOnLogin
    ? rotateSession(ctx, user.id, input.currentToken)
    : createSession(ctx, user.id)
  logSecurity('login_success', { userId: user.id, ip: maskIp(input.ip) })
  return { user, sessionToken }
}

export function logout(ctx: Ctx, token: string | undefined | null): void {
  if (!token) return
  // Sunucuda geçersiz kılma: yalnızca çerezi silmek yeterli değildir.
  ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

/** Süresi dolmuş oturumları temizler (bakım görevi). */
export function purgeExpiredSessions(ctx: Ctx): number {
  const result = ctx.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(ctx.now())
  return Number(result.changes)
}

export function invalidateAllSessions(ctx: Ctx, userId: string): void {
  ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** US-004: anonymise profile, purge credentials, keep content as "[deleted]". */
export async function deleteAccount(ctx: Ctx, user: UserRow, password: string): Promise<void> {
  const valid = await verifyPassword(user.password_hash, password)
  if (!valid) throw forbidden('Parola hatalı.')
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE users SET deleted = 1, email_lower = NULL, password_hash = '',
         display_name = NULL, bio = NULL WHERE id = ?`,
      )
      .run(user.id)
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
  })
}

export { ValidationError }
