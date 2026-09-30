import { Hono } from 'hono'
import type { Ctx } from '../context'
import { t } from '../i18n/tr'
import { Layout } from '../views/layout'
import {
  register,
  login,
  logout,
  requestPasswordReset,
  resetPassword,
  deleteAccount,
} from '../services/auth'
import { getSettings } from './../services/settings'
import { AppError } from '../services/errors'
import { ValidationError } from '../lib/validation'
import {
  type AppEnv,
  clientIp,
  clearSessionCookie,
  dmUnread,
  formData,
  safeNext,
  setFlash,
  setSessionCookie,
  takeFlash,
  unread,
} from './helpers'

export function authRoutes(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/login', (c) => {
    const viewer = c.get('viewer')
    if (viewer) return c.redirect('/')
    const next = safeNext(c.req.query('next'))
    return c.html(
      <Layout title={t.auth.loginTitle} viewer={null} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.auth.loginTitle}</h2>
          <form method="post" action={`/login?next=${encodeURIComponent(next)}`}>
            <div class="field">
              <label for="identifier">{t.auth.usernameOrEmail}</label>
              <input id="identifier" name="identifier" type="text" required autocomplete="username" />
            </div>
            <div class="field">
              <label for="password">{t.auth.password}</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" />
            </div>
            <button class="btn" type="submit">{t.auth.loginCta}</button>
          </form>
          <p>
            <a href={`/register?next=${encodeURIComponent(next)}`}>{t.auth.needAccount}</a>
            {' · '}
            <a href="/forgot-password">{t.auth.forgot}</a>
          </p>
        </div>
      </Layout>,
    )
  })

  app.post('/login', async (c) => {
    const body = await formData(c)
    const next = safeNext(c.req.query('next'))
    try {
      const { sessionToken } = await login(ctx, {
        usernameOrEmail: body.identifier ?? '',
        password: body.password ?? '',
        ip: clientIp(c),
      })
      setSessionCookie(ctx, c, sessionToken)
      return c.redirect(next)
    } catch (err) {
      if (err instanceof AppError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/login?next=${encodeURIComponent(next)}`)
      }
      throw err
    }
  })

  app.get('/register', (c) => {
    const viewer = c.get('viewer')
    if (viewer) return c.redirect('/')
    const settings = getSettings(ctx)
    const next = safeNext(c.req.query('next'))
    if (settings.registrationMode === 'closed') {
      return c.html(
        <Layout title={t.auth.registerTitle} viewer={null}>
          <div class="card form-narrow">
            <h2>{t.auth.registerTitle}</h2>
            <div class="flash warn">{t.auth.registrationClosed}</div>
          </div>
        </Layout>,
      )
    }
    const inviteCode = c.req.query('invite') ?? ''
    return c.html(
      <Layout title={t.auth.registerTitle} viewer={null} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.auth.registerTitle}</h2>
          <form method="post" action={`/register?next=${encodeURIComponent(next)}`}>
            <div class="field">
              <label for="displayName">{t.settings.displayName}</label>
              <input
                id="displayName"
                name="displayName"
                type="text"
                required
                maxlength={40}
                autocomplete="name"
                placeholder={t.profile.displayNamePlaceholder}
              />
            </div>
            <div class="field">
              <label for="username">{t.auth.username}</label>
              <input id="username" name="username" type="text" required minlength={4} maxlength={20} pattern="[A-Za-z0-9_]+" autocomplete="username" />
              <div class="hint">{t.auth.usernameHint}</div>
            </div>
            <div class="field">
              <label for="password">{t.auth.password}</label>
              <input id="password" name="password" type="password" required minlength={6} autocomplete="new-password" />
              <div class="hint">{t.auth.passwordHint}</div>
            </div>
            {settings.registrationMode === 'invite' && (
              <div class="field">
                <label for="inviteCode">{t.auth.inviteCode}</label>
                <input id="inviteCode" name="inviteCode" type="text" required value={inviteCode} />
              </div>
            )}
            <button class="btn" type="submit">{t.auth.registerCta}</button>
          </form>
          <p>
            <a href={`/login?next=${encodeURIComponent(next)}`}>{t.auth.haveAccount}</a>
          </p>
        </div>
      </Layout>,
    )
  })

  app.post('/register', async (c) => {
    const body = await formData(c)
    const next = safeNext(c.req.query('next'))
    try {
      const { sessionToken } = await register(ctx, {
        username: body.username ?? '',
        password: body.password ?? '',
        displayName: body.displayName ?? '',
        // Formda e-posta alanı yok; sunucu tarafı yine de kabul eder, böylece
        // e-posta ile giriş ve parola sıfırlama mevcut hesaplar için çalışır.
        email: body.email ?? '',
        inviteCode: body.inviteCode,
        ip: clientIp(c),
      })
      setSessionCookie(ctx, c, sessionToken)
      // US-001: returned to the page/action that triggered registration.
      return c.redirect(next)
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/register?next=${encodeURIComponent(next)}`)
      }
      throw err
    }
  })

  app.post('/logout', (c) => {
    logout(ctx, c.get('sessionToken'))
    clearSessionCookie(c)
    return c.redirect('/')
  })

  app.get('/forgot-password', (c) =>
    c.html(
      <Layout title={t.auth.resetTitle} viewer={c.get('viewer')} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.auth.resetTitle}</h2>
          <form method="post" action="/forgot-password">
            <div class="field">
              <label for="email">{t.auth.email}</label>
              <input id="email" name="email" type="email" required />
            </div>
            <button class="btn" type="submit">{t.auth.sendResetLink}</button>
          </form>
        </div>
      </Layout>,
    ),
  )

  app.post('/forgot-password', async (c) => {
    const body = await formData(c)
    try {
      await requestPasswordReset(ctx, body.email ?? '', clientIp(c))
    } catch (err) {
      if (!(err instanceof AppError && err.code === 'rate_limited')) throw err
    }
    // Identical confirmation regardless of whether the email exists (US-003).
    setFlash(c, 'ok', t.auth.resetSent)
    return c.redirect('/forgot-password')
  })

  app.get('/reset-password/:token', (c) =>
    c.html(
      <Layout title={t.auth.resetTitle} viewer={null} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.auth.resetTitle}</h2>
          <form method="post" action={`/reset-password/${c.req.param('token')}`}>
            <div class="field">
              <label for="password">{t.auth.resetNew}</label>
              <input id="password" name="password" type="password" required minlength={6} autocomplete="new-password" />
              <div class="hint">{t.auth.passwordHint}</div>
            </div>
            <button class="btn" type="submit">{t.auth.resetPassword}</button>
          </form>
        </div>
      </Layout>,
    ),
  )

  app.post('/reset-password/:token', async (c) => {
    const body = await formData(c)
    try {
      await resetPassword(ctx, c.req.param('token'), body.password ?? '')
      setFlash(c, 'ok', t.auth.resetDone)
      return c.redirect('/login')
    } catch (err) {
      if (err instanceof AppError || err instanceof ValidationError) {
        setFlash(c, 'error', err.message)
        return c.redirect(`/reset-password/${c.req.param('token')}`)
      }
      throw err
    }
  })

  app.get('/settings/delete-account', (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    return c.html(
      <Layout title={t.profile.deleteAccount} viewer={viewer} unread={unread(ctx, viewer)} dmUnread={dmUnread(ctx, viewer)} flash={takeFlash(c)}>
        <div class="card form-narrow">
          <h2>{t.profile.deleteAccount}</h2>
          <div class="flash warn">{t.profile.deleteWarning}</div>
          <form method="post" action="/settings/delete-account" data-confirm={t.profile.deleteWarning}>
            <div class="field">
              <label for="password">{t.auth.password}</label>
              <input id="password" name="password" type="password" required autocomplete="current-password" />
            </div>
            <button class="btn danger" type="submit">{t.profile.deleteAccount}</button>
          </form>
        </div>
      </Layout>,
    )
  })

  app.post('/settings/delete-account', async (c) => {
    const viewer = c.get('viewer')
    if (!viewer) return c.redirect('/login')
    const body = await formData(c)
    try {
      await deleteAccount(ctx, viewer, body.password ?? '')
      clearSessionCookie(c)
      setFlash(c, 'ok', t.auth.accountDeleted)
      return c.redirect('/')
    } catch (err) {
      if (err instanceof AppError) {
        setFlash(c, 'error', err.message)
        return c.redirect('/settings/delete-account')
      }
      throw err
    }
  })

  return app
}
