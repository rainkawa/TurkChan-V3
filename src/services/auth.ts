import type { Ctx } from '../context'
import type { UserRow } from '../types'
import { newId, newSecret, sha256 } from '../lib/ids'
import { hashPassword, verifyPassword } from '../lib/passwords'
import {
  validateUsername,
  validateEmail,
  validatePassword,
  ValidationError,
} from '../lib/validation'
import { getSettings } from './settings'
import { AppError, badRequest, conflict, forbidden, rateLimited, unauthorized } from './errors'
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
  input: { username: string; email: string; password: string; ip: string; inviteCode?: string },
): Promise<SessionResult> {
  const ipLimit = ctx.rateLimiter.check(`register:${input.ip}`, 5, 60 * 60 * 1000)
  if (!ipLimit.allowed) throw rateLimited(ipLimit.retryAfterMs)

  const settings = getSettings(ctx)
  if (settings.registrationMode === 'closed') {
    throw forbidden('Registration is currently closed. Contact your programme coordinator.')
  }
  let inviteCode: string | null = null
  if (settings.registrationMode === 'invite') {
    inviteCode = (input.inviteCode ?? '').trim()
    if (!inviteCode) throw badRequest('invite_required', 'Registration is invite-only. An invite link is required.')
    const invite = ctx.db.prepare('SELECT * FROM invites WHERE code = ?').get(inviteCode) as
      | { code: string; expires_at: number; max_uses: number; uses: number }
      | undefined
    if (!invite || invite.expires_at <= ctx.now() || invite.uses >= invite.max_uses) {
      throw badRequest('invite_invalid', 'This invite link is invalid or has expired.')
    }
  }

  const username = validateUsername(input.username)
  const email = validateEmail(input.email)
  const password = validatePassword(input.password)

  const usernameTaken = ctx.db
    .prepare('SELECT 1 FROM users WHERE username_lower = ?')
    .get(username.toLowerCase())
  if (usernameTaken) throw conflict('username_taken', 'That username is already taken.')

  const emailTaken = ctx.db.prepare('SELECT 1 FROM users WHERE email_lower = ?').get(email)
  if (emailTaken) {
    // Non-enumerating (US-001): the message never confirms the address exists.
    throw conflict(
      'email_unavailable',
      'If this email is already registered, log in instead or use password reset. Otherwise, use a different address.',
    )
  }

  const passwordHash = await hashPassword(password)
  const id = newId()
  const isFirstUser = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0

  const user = transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `INSERT INTO users (id, username, username_lower, email_lower, password_hash, is_admin, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, username, username.toLowerCase(), email, passwordHash, isFirstUser ? 1 : 0, ctx.now())
    if (inviteCode) {
      ctx.db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(inviteCode)
    }
    return getUserById(ctx, id) as UserRow
  })

  const sessionToken = createSession(ctx, user.id)
  return { user, sessionToken }
}

export function createSession(ctx: Ctx, userId: string): string {
  const token = newSecret()
  ctx.db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, ctx.now(), ctx.now() + ctx.config.sessionTtlMs)
  return token
}

export function getSessionUser(ctx: Ctx, token: string | undefined | null): UserRow | null {
  if (!token) return null
  const row = ctx.db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), ctx.now()) as UserRow | undefined
  if (!row || row.deleted) return null
  return row
}

export async function login(
  ctx: Ctx,
  input: { usernameOrEmail: string; password: string; ip: string },
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
    throw new AppError(
      429,
      'account_locked',
      'Too many failed login attempts. This account is temporarily locked — try again in 15 minutes or reset your password.',
    )
  }

  const valid = user ? await verifyPassword(user.password_hash, input.password) : false
  ctx.db
    .prepare('INSERT INTO login_attempts (username_lower, ip, success, created_at) VALUES (?, ?, ?, ?)')
    .run(attemptKey, input.ip, valid ? 1 : 0, ctx.now())

  if (!user || !valid) throw unauthorized('Incorrect username/email or password.')

  if (user.suspended_indefinitely || (user.suspended_until !== null && user.suspended_until > ctx.now())) {
    const until = user.suspended_indefinitely
      ? 'indefinitely'
      : `until ${new Date(user.suspended_until as number).toISOString()}`
    throw forbidden(`This account is suspended ${until}.${user.suspension_reason ? ` Reason: ${user.suspension_reason}` : ''}`)
  }

  const sessionToken = createSession(ctx, user.id)
  return { user, sessionToken }
}

export function logout(ctx: Ctx, token: string | undefined | null): void {
  if (!token) return
  ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
}

export function invalidateAllSessions(ctx: Ctx, userId: string): void {
  ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

export async function requestPasswordReset(ctx: Ctx, email: string, ip: string): Promise<void> {
  const ipLimit = ctx.rateLimiter.check(`pwreset:${ip}`, 5, 60 * 60 * 1000)
  if (!ipLimit.allowed) throw rateLimited(ipLimit.retryAfterMs)

  let normalized: string
  try {
    normalized = validateEmail(email)
  } catch {
    return // same outward behaviour regardless of input validity
  }
  const user = ctx.db
    .prepare('SELECT * FROM users WHERE email_lower = ? AND deleted = 0')
    .get(normalized) as UserRow | undefined
  if (!user) return // identical confirmation shown either way (US-003)

  const token = newSecret()
  ctx.db
    .prepare('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), user.id, ctx.now() + ctx.config.resetTokenTtlMs)
  await ctx.mailer.send({
    to: normalized,
    subject: 'Reset your password',
    text: `Hi ${user.username},\n\nReset your password using this link (valid for 60 minutes):\n${ctx.config.baseUrl}/reset-password/${token}\n\nIf you did not request this, you can ignore this email.`,
  })
}

export async function resetPassword(ctx: Ctx, token: string, newPassword: string): Promise<void> {
  const password = validatePassword(newPassword)
  const row = ctx.db
    .prepare('SELECT * FROM password_resets WHERE token_hash = ?')
    .get(sha256(token)) as { token_hash: string; user_id: string; expires_at: number; used: number } | undefined
  if (!row || row.used || row.expires_at <= ctx.now()) {
    throw badRequest('reset_invalid', 'This reset link is invalid or has expired. Request a new one.')
  }
  const passwordHash = await hashPassword(password)
  transaction(ctx.db, () => {
    ctx.db.prepare('UPDATE password_resets SET used = 1 WHERE token_hash = ?').run(row.token_hash)
    ctx.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, row.user_id)
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id)
  })
}

/** US-004: anonymise profile, purge credentials, keep content as "[deleted]". */
export async function deleteAccount(ctx: Ctx, user: UserRow, password: string): Promise<void> {
  const valid = await verifyPassword(user.password_hash, password)
  if (!valid) throw forbidden('Password is incorrect.')
  transaction(ctx.db, () => {
    ctx.db
      .prepare(
        `UPDATE users SET deleted = 1, email_lower = NULL, password_hash = '',
         display_name = NULL, bio = NULL WHERE id = ?`,
      )
      .run(user.id)
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id)
    ctx.db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id)
  })
}

export { ValidationError }
