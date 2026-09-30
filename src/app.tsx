import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Ctx } from './context'
import { getSessionUser } from './services/auth'
import { AppError } from './services/errors'
import { ValidationError } from './lib/validation'
import { ErrorPage } from './views/layout'
import { t } from './i18n/tr'
import { type AppEnv, SESSION_COOKIE } from './routes/helpers'
import { authRoutes } from './routes/auth'
import { mainRoutes } from './routes/main'
import { communityRoutes } from './routes/community'
import { postRoutes } from './routes/post'
import { modRoutes } from './routes/mod'
import { apiRoutes } from './routes/api'
import { adminRoutes } from './routes/admin'

export function createApp(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Session resolution + same-origin check for state-changing requests
  // (defence-in-depth alongside SameSite=Lax cookies).
  app.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    c.set('sessionToken', token)
    c.set('viewer', getSessionUser(ctx, token))

    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const origin = c.req.header('origin')
      if (origin) {
        const requestHost = new URL(c.req.url).host
        let originHost: string | null = null
        try {
          originHost = new URL(origin).host
        } catch {
          originHost = null
        }
        if (originHost !== requestHost) {
          throw new AppError(403, 'bad_origin', t.errors.crossOrigin)
        }
      }
    }
    await next()
  })

  app.route('/', authRoutes(ctx))
  app.route('/', mainRoutes(ctx))
  app.route('/', apiRoutes(ctx))
  app.route('/', postRoutes(ctx))
  app.route('/', modRoutes(ctx))
  app.route('/', adminRoutes(ctx))
  app.route('/', communityRoutes(ctx))

  app.notFound((c) => {
    const viewer = c.get('viewer') ?? null
    if (c.req.path.startsWith('/api/')) return c.json({ error: t.errors.notFoundBody }, 404)
    return c.html(
      <ErrorPage viewer={viewer} heading={t.errors.notFoundTitle} message={t.errors.notFoundBody} />,
      404,
    )
  })

  app.onError((err, c) => {
    const viewer = c.get('viewer') ?? null
    const wantsJson = c.req.path.startsWith('/api/') || (c.req.header('accept') ?? '').includes('application/json')

    if (err instanceof ValidationError) {
      if (wantsJson) return c.json({ error: err.message, field: err.field }, 400)
      return c.html(<ErrorPage viewer={viewer} heading={t.errors.genericTitle} message={err.message} />, 400)
    }
    if (err instanceof AppError) {
      if (wantsJson) {
        const headers: Record<string, string> = {}
        if (err.retryAfterMs) headers['Retry-After'] = String(Math.ceil(err.retryAfterMs / 1000))
        return c.json({ error: err.message, code: err.code }, err.status as 400, headers)
      }
      const heading =
        err.status === 404 ? t.errors.notFoundTitle : err.status === 403 ? t.errors.forbiddenTitle : t.errors.genericTitle
      return c.html(<ErrorPage viewer={viewer} heading={heading} message={err.message} />, err.status as 400)
    }
    console.error(err)
    if (wantsJson) return c.json({ error: t.errors.internalError }, 500)
    return c.html(
      <ErrorPage viewer={viewer} heading={t.errors.genericTitle} message={t.errors.genericBody} />,
      500,
    )
  })

  return app
}
