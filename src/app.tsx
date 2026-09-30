import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCookie } from 'hono/cookie'
import type { Ctx } from './context'
import { getSessionUser } from './services/auth'
import { AppError } from './services/errors'
import { ValidationError } from './lib/validation'
import { ErrorPage } from './views/layout'
import { t } from './i18n/tr'
import { CSRF_FIELD, checkCsrf, isSameOrigin, issueCsrfToken } from './lib/csrf'
import { logError, logSecurity, maskIp } from './lib/logging'
import { logAction } from './services/modlog'
import { type AppEnv, SESSION_COOKIE, clientIp } from './routes/helpers'
import { authRoutes } from './routes/auth'
import { mainRoutes } from './routes/main'
import { dmRoutes } from './routes/dm'
import { communityRoutes } from './routes/community'
import { postRoutes } from './routes/post'
import { modRoutes } from './routes/mod'
import { apiRoutes } from './routes/api'
import { adminRoutes } from './routes/admin'

/**
 * Giriş yapılmadan erişilebilen yollar. Site tamamen kapalıdır: üye olmayan
 * bir ziyaretçi önce giriş yapar, ancak ondan sonra gezinir.
 */
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/logout',
  '/static',
  '/media',
  '/favicon.ico',
  '/robots.txt',
]

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

function isHtml(contentType: string | null): boolean {
  return Boolean(contentType && contentType.includes('text/html'))
}

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Güvenlik baþlıkları.
 *
 * - `script-src 'self'` : satır içi script olmadığı için katı politika uygulanabilir;
 *   kullanıcı içeriği HTML'e basıldığı için bu en kritik satırdır.
 * - `object-src 'none'` / `base-uri 'none'` : eklenti ve base etiketi enjeksiyonu.
 * - `frame-ancestors 'none'` + X-Frame-Options : clickjacking.
 * - `img-src`/`media-src` dışarı açık: bağlantı önizlemeleri dış görseller gösterebilir.
 * - HSTS yalnızca üretimde (HTTPS) eklenir; localhost geliştirmeyi bozmaz.
 */
function securityHeaders(ctx: Ctx): Record<string, string> {
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "script-src 'self'",
    // Satır içi `style=` kullanımı var (küçük düzen düzeltmeleri); script'e
    // izin verilmediği için script enjeksiyonu için risk oluşturmaz.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ]
  if (ctx.config.secureCookies) directives.push('upgrade-insecure-requests')
  return {
    'Content-Security-Policy': directives.join('; '),
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Gizlilik: dış sitelere yönlendirmede yol bilgisi sızdırılmaz.
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Uygulama hiçbir kamera/mikrofon/konum API'si kullanmıyor.
    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-DNS-Prefetch-Control': 'off',
    // Yalnızca üretimde (HTTPS) HSTS; localhost geliştirmeyi bozmaz.
    ...(ctx.config.secureCookies
      ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
      : {}),
  }
}

/**
 * Gövdeden CSRF jetonunu okur.
 *
 * `parseBody()` multipart gövdelerde dosyaları da ayriştirdiği için yalnızca
 * URL-encoded ve JSON gövdelerde kullanılır; multipart formlarda jeton
 * `x-csrf-token` başlığından gelir (bkz. public/app.js).
 */
async function readCsrfFromBody(c: Context<AppEnv>): Promise<string | null> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase()
  try {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      const parsed = await c.req.parseBody()
      const value = parsed[CSRF_FIELD]
      return typeof value === 'string' ? value : null
    }
    if (contentType.includes('application/json')) {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>
      const value = body[CSRF_FIELD]
      return typeof value === 'string' ? value : null
    }
  } catch {
    // Bozuk gövde: jeton doğrulanamaz → istek reddedilir.
    return null
  }
  return null
}

/**
 * HTML içindeki her `<form>` açılışına gizli CSRF alanı ekler.
 *
 * Böylece sunucu tarafında üretilen bütün formlar (giriş, arama, moderasyon,
 * yönetim, DM…) otomatik olarak korunur; tek bir formun atlanma riski kalmaz.
 * GET formları da eklenir (zararsız, ama arama gibi eylemler de tutarlı olur).
 */
async function injectCsrfIntoHtml(c: Context<AppEnv>, sessionToken: string | undefined): Promise<void> {
  const token = issueCsrfToken(sessionToken)
  const type = c.res.headers.get('content-type') ?? ''
  // HTML olmayan gövdeler (dosya, API, 304, boş gövde) hiç okunmaz.
  if (!type.includes('text/html')) return
  if (c.res.status === 204 || c.res.status === 304) return
  // Gövde okunduğu için yanıt her hâlükârda yeniden kurulur; aksi halde
  // tükettiğimiz gövde aşağı akışta "okunmuş" sayılır.
  const body = await c.res.text()
  const escapedToken = token.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const injected = body.replace(
    /<form\b([^>]*)>/gi,
    (match, attrs: string) =>
      new RegExp(`${CSRF_FIELD}=`, 'i').test(attrs)
        ? match
        : `<form${attrs}><input type="hidden" name="${CSRF_FIELD}" value="${escapedToken}" />`,
  )
  // fetch() ile giden istekler de sunucuda doğrulanabilsin diye jeton meta
  // etiketi olarak da yayımlanır (çerez HttpOnly olduğu için JS oradan okuyamaz).
  const withMeta = /<meta name="csrf-token"/.test(body)
    ? injected
    : injected.replace(
        /(<meta charset="utf-8"\s*\/>)/i,
        `$1<meta name="csrf-token" content="${escapedToken}" />`,
      )
  c.res = new Response(withMeta, {
    status: c.res.status,
    statusText: c.res.statusText,
    headers: c.res.headers,
  })
}

export function createApp(ctx: Ctx): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Genel istek sınırı (IP başına). Servis katmanındaki ince ayarlı limitler
  // (gönderme/vote/upload vb.) bunun üstüne biner; buradaki amaç tek bir
  // uç noktaya binlerce istek yığılmasını ve kaba kuvvet taramasını kesmek.
  app.use('*', async (c, next) => {
    for (const [key, value] of Object.entries(securityHeaders(ctx))) c.header(key, value)
    const limit = ctx.rateLimiter.check(
      `global:${clientIp(c, ctx)}`,
      ctx.config.globalRequestsPerMinute,
      60_000,
    )
    if (!limit.allowed) {
      c.header('Retry-After', String(Math.ceil(limit.retryAfterMs / 1000)))
      logSecurity('rate_limited', {
        path: c.req.path,
        method: c.req.method,
        ip: maskIp(clientIp(c, ctx)),
        userId: c.get('viewer')?.id ?? null,
        scope: 'global',
      })
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: t.errors.tooManyRequests }, 429)
      }
      return c.text(t.errors.tooManyRequests, 429)
    }
    await next()
  })

  // Session resolution + CSRF defence for state-changing requests.
  app.use('*', async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE)
    c.set('sessionToken', token)
    c.set('viewer', getSessionUser(ctx, token))
    const method = c.req.method.toUpperCase()

    // Kapı: giriş yoksa hiçbir sayfa ve uç nokta erişilemez.
    if (!c.get('viewer') && !isPublicPath(c.req.path)) {
      if (c.req.path.startsWith('/api/')) {
        return c.json({ error: t.errors.loginRequired }, 401)
      }
      const next = encodeURIComponent(c.req.path + (c.req.url.includes('?') ? `?${c.req.url.split('?')[1]}` : ''))
      return c.redirect(`/login?next=${next}`)
    }

    // Durum değiştiren istekler: origin denetimi + senkronizasyon jetonu.
    // GET/HEAD hiçbir durumu değiştirmemeli ve koruma dışıdır.
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      if (!isSameOrigin(c.req.header('origin'), c.req.url)) {
        logSecurity('csrf_origin_rejected', {
          path: c.req.path,
          method,
          ip: maskIp(clientIp(c, ctx)),
          userId: c.get('viewer')?.id ?? null,
        })
        throw new AppError(403, 'bad_origin', t.errors.crossOrigin)
      }
      const submitted =
        c.req.header('x-csrf-token') ?? (await readCsrfFromBody(c)) ?? undefined
      if (!checkCsrf(token, submitted)) {
        logSecurity('csrf_token_rejected', {
          path: c.req.path,
          method,
          ip: maskIp(clientIp(c, ctx)),
          userId: c.get('viewer')?.id ?? null,
          hadToken: Boolean(submitted),
        })
        throw new AppError(403, 'bad_csrf', t.errors.csrfInvalid)
      }
    }

    await next()

    // Denetim günlüğü: yönetici/moderatör işlemleri otomatik kaydedilir. Rota
    // bazında yapılsa bir rota unutabilirdi; burada tek noktadan garanti edilir.
    // Yalnızca BAŞARILI (4xx altı) durum değiştiren istekler yazılır.
    if (
      STATE_CHANGING.has(method) &&
      c.res.status < 400 &&
      (c.req.path.startsWith('/admin/') || c.req.path.startsWith('/mod/'))
    ) {
      const actor = c.get('viewer')
      if (actor) {
        try {
          logAction(ctx, {
            communityId: null,
            actorId: actor.id,
            action: `${method} ${c.req.path}`,
            detail: JSON.stringify({ status: c.res.status }),
          })
        } catch (err) {
          logError(err, { path: c.req.path, event: 'audit_log_failed' })
        }
      }
    }

    // HTML yanıtlarına gizli jeton alanı enjekte edilir: 50+ formun her birine
    // elle eklemek yerine tek bir yerde, kaçırılması imkânsız hâle getirilir.
    if (isHtml(c.res.headers.get('content-type'))) {
      await injectCsrfIntoHtml(c, token)
    }
  })

  app.route('/', authRoutes(ctx))
  app.route('/', mainRoutes(ctx))
  app.route('/', dmRoutes(ctx))
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
      if (err.status === 401 || err.status === 403) {
        logSecurity('access_denied', {
          path: c.req.path,
          method: c.req.method,
          code: err.code,
          userId: viewer?.id ?? null,
        })
      }
      if (err.status === 429) {
        logSecurity('rate_limited', {
          path: c.req.path,
          method: c.req.method,
          code: err.code,
          userId: viewer?.id ?? null,
          scope: 'service',
        })
      }
      if (wantsJson) {
        const headers: Record<string, string> = {}
        if (err.retryAfterMs) headers['Retry-After'] = String(Math.ceil(err.retryAfterMs / 1000))
        return c.json({ error: err.message, code: err.code }, err.status as 400, headers)
      }
      const heading =
        err.status === 404 ? t.errors.notFoundTitle : err.status === 403 ? t.errors.forbiddenTitle : t.errors.genericTitle
      return c.html(<ErrorPage viewer={viewer} heading={heading} message={err.message} />, err.status as 400)
    }
    logError(err, { path: c.req.path, method: c.req.method })
    if (wantsJson) return c.json({ error: t.errors.internalError }, 500)
    return c.html(
      <ErrorPage viewer={viewer} heading={t.errors.genericTitle} message={t.errors.genericBody} />,
      500,
    )
  })

  return app
}
