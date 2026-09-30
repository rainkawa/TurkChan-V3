import type { Hono } from 'hono'
import { openDatabase } from '../src/db'
import { loadConfig } from '../src/config'
import type { Ctx } from '../src/context'
import { createApp } from '../src/app'
import { MemoryMailer } from '../src/lib/mailer'
import { RateLimiter } from '../src/lib/ratelimit'
import { MemoryObjectStorage } from '../src/services/storage'
import { insertCommunity } from '../src/services/communities'
import { sha256 } from '../src/lib/ids'
import { issueCsrfToken } from '../src/lib/csrf'
import type { AppEnv } from '../src/routes/helpers'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface TestWorld {
  app: Hono<AppEnv>
  ctx: Ctx
  mailer: MemoryMailer
  storage: MemoryObjectStorage
  /** Advance the injected clock. */
  tick(ms: number): void
  setNow(ms: number): void
}

const BASE_TIME = Date.UTC(2026, 6, 1, 12, 0, 0) // fixed, deterministic

/** Son oluşturulan dünya; test yardımcılarının veritabanına ulaşması için. */
let activeWorld: TestWorld | null = null

export function createTestWorld(): TestWorld {
  let currentTime = BASE_TIME
  const now = () => currentTime
  const mailer = new MemoryMailer()
  const storage = new MemoryObjectStorage()
  const config = {
    ...loadConfig({}),
    dbPath: ':memory:',
    exportDir: mkdtempSync(join(tmpdir(), 'cp-exports-')),
    baseUrl: 'http://localhost:3000',
    // Testler bağlantı soketi olmadan x-forwarded-for gönderir.
    trustProxy: true,
  }
  const ctx: Ctx = {
    db: openDatabase(':memory:'),
    config,
    mailer,
    storage,
    rateLimiter: new RateLimiter(now),
    now,
    fetchFn: (() => Promise.reject(new Error('network disabled in tests'))) as unknown as typeof fetch,
  }
  const app = createApp(ctx)
  const world: TestWorld = {
    app,
    ctx,
    mailer,
    storage,
    tick: (ms) => {
      currentTime += ms
    },
    setNow: (ms) => {
      currentTime = ms
    },
  }
  activeWorld = world
  return world
}

/** HTTP agent with a cookie jar, driving the app like a browser would. */
export class Agent {
  private cookies = new Map<string, string>()

  constructor(private app: Hono<AppEnv>) {}

  cookieHeader(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  private storeCookies(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const [pair, ...attrs] = raw.split(';')
      const eq = (pair as string).indexOf('=')
      const name = (pair as string).slice(0, eq).trim()
      const value = (pair as string).slice(eq + 1).trim()
      const maxAgeAttr = attrs.map((a) => a.trim().toLowerCase()).find((a) => a.startsWith('max-age='))
      if (value === '' || maxAgeAttr === 'max-age=0') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
  }

  /**
   * Bu oturuma ait CSRF jetonu. Sunucunun çerez değerinden türettiği jetonla
   * birebir aynıdır; testler de "doğru jeton gönderilirse kabul edilir,
   * yanlış/eksik jeton reddedilir" davranışını gerçekten sınar.
   */
  /** Bu oturuma ait CSRF jetonu (multipart isteklerde de kullanılır). */
  csrfToken(): string {
    return issueCsrfToken(this.cookies.get('sid'))
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.cookies.size > 0) headers.set('cookie', this.cookieHeader())
    // Gerçek tarayıcı gizli form alanını / başlığı otomatik gönderir; test
    // agent'ı da öyle davranır. Güvenlik testleri `x-csrf-token: none` ile
    // bunu bilerek bozabilir.
    const method = (init.method ?? 'GET').toUpperCase()
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers.has('x-csrf-token')) {
      headers.set('x-csrf-token', this.csrfToken())
    }
    const res = await this.app.request(path, { ...init, headers })
    this.storeCookies(res)
    return res
  }

  async get(path: string): Promise<Response> {
    return this.request(path)
  }

  /** POST as an HTML form (application/x-www-form-urlencoded). */
  async post(path: string, form: Record<string, string> = {}): Promise<Response> {
    const body = new URLSearchParams(form).toString()
    return this.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
  }

  /** JSON API request. */
  async json(path: string, body: unknown, method = 'POST'): Promise<Response> {
    return this.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /**
   * Jetonu BILEREK bozuk/eksik gönderir. Yalnızca CSRF testleri içindir:
   * sunucunun isteği gerçekten reddettiğini kanıtlamak için kullanılır.
   */
  async postWithoutCsrf(path: string, form: Record<string, string> = {}): Promise<Response> {
    return this.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-csrf-token': 'none',
      },
      body: new URLSearchParams(form).toString(),
    })
  }

  loggedIn(): boolean {
    return this.cookies.has('sid')
  }

  /** Çerezdeki flash mesajının çözülmüş hâli (hata mesajı testleri için). */
  cookieHeaderFlash(): string | null {
    const raw = this.cookies.get('flash')
    if (!raw) return null
    // Flash çerezi iki kez URL-kodlanır (çerez değeri + içerik).
    return decodeURIComponent(decodeURIComponent(raw))
  }
}

let userCounter = 0

/** Register a fresh user and return their agent (logged in). */
export async function registerUser(
  world: TestWorld,
  username?: string,
  opts: { ip?: string; email?: string; password?: string } = {},
): Promise<{ agent: Agent; username: string; email: string; password: string }> {
  userCounter += 1
  const name = username ?? `user${userCounter}`
  const email = opts.email ?? `${name}@example.test`
  const password = opts.password ?? 'password12345'
  const agent = new Agent(world.app)
  const res = await agent.request('/register', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': opts.ip ?? `10.1.${(userCounter >> 8) & 255}.${userCounter & 255}`,
    },
    body: new URLSearchParams({ username: name, email, password }).toString(),
  })
  if (res.status !== 302) {
    throw new Error(`registration of ${name} failed: ${res.status}`)
  }
  if (!agent.loggedIn()) throw new Error(`registration of ${name} did not create a session`)
  return { agent, username: name, email, password }
}

/** First registered user is the site admin. */
export async function registerAdmin(world: TestWorld): Promise<{ agent: Agent; username: string }> {
  const count = (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  if (count > 0) throw new Error('registerAdmin must be called on a fresh world')
  const { agent, username } = await registerUser(world, `admin${++userCounter}`)
  return { agent, username }
}

/**
 * Yeni bir agent ile giriş yapar.
 *
 * Testler saatleri ileri attığında oturumun idle/mutlak ömrü bilinçli olarak
 * dolmuş olur (sunucu tarafı davranışı). Gerçek hayatta kullanıcı yeniden
 * giriş yapar; testler de aynısını yapar.
 */
export async function relogin(
  world: TestWorld,
  username: string,
  password = 'password12345',
): Promise<Agent> {
  const agent = new Agent(world.app)
  await agent.post('/login', { identifier: username, password })
  return agent
}

/**
 * Board kurar. Board açmak artık yalnızca site yöneticilerine açık olduğu
 * için testler doğrudan servisi çağırır; yetki denetiminin kendisi
 * `boards.test.ts` içinde HTTP üzerinden sınanır.
 */
export async function createCommunityVia(
  agent: Agent,
  name: string,
  visibility: 'public' | 'restricted' | 'private' = 'public',
): Promise<void> {
  if (!activeWorld) throw new Error('createTestWorld() must run before createCommunityVia()')
  insertCommunity(activeWorld.ctx, agentUserId(agent, activeWorld), {
    name,
    title: `Board ${name}`,
    description: `About ${name}`,
    visibility,
  })
}

/** Ajanın oturumundaki kullanıcı kimliği. */
function agentUserId(agent: Agent, world: TestWorld): string {
  const sid = agent.cookieHeader().match(/sid=([^;]+)/)?.[1]
  if (!sid) throw new Error('agent is not logged in')
  const row = world.ctx.db
    .prepare('SELECT user_id FROM sessions WHERE token_hash = ?')
    .get(sha256(sid)) as { user_id: string } | undefined
  if (!row) throw new Error('session not found for agent')
  return row.user_id
}

/** Create a text post via the form; returns the post id from the redirect. */
export async function createPostVia(
  agent: Agent,
  community: string,
  title: string,
  body = '',
): Promise<string> {
  const res = await agent.post(`/c/${community}/submit?type=text`, { title, body })
  const location = res.headers.get('location') ?? ''
  const match = location.match(/comments\/([a-z0-9]+)/)
  if (res.status !== 302 || !match) throw new Error(`post creation failed: ${res.status} → ${location}`)
  return match[1] as string
}

/** Create a comment via the form; returns comment id from the redirect. */
export async function createCommentVia(
  agent: Agent,
  community: string,
  postId: string,
  body: string,
  parentId?: string | null,
  extra?: Record<string, string>,
): Promise<string> {
  const form: Record<string, string> = { body, ...(extra ?? {}) }
  if (parentId) form.parentId = parentId
  const res = await agent.post(`/c/${community}/comments/${postId}/comment`, form)
  const location = res.headers.get('location') ?? ''
  const match = location.match(/comment\/([a-z0-9]+)/)
  if (res.status !== 302 || !match) throw new Error(`comment creation failed: ${res.status} → ${location}`)
  return match[1] as string
}

/** multipart yorum gönderisi: gövde + dosyalar (görsel/GIF/video). */
export async function createCommentWithFilesVia(
  agent: Agent,
  community: string,
  postId: string,
  body: string,
  files: Array<{ field?: string; filename: string; contentType: string; data: Uint8Array }>,
  extra?: Record<string, string>,
): Promise<Response> {
  const form = new FormData()
  form.set('body', body)
  for (const [key, value] of Object.entries(extra ?? {})) form.set(key, value)
  for (const file of files) {
    form.append(file.field ?? 'media', new File([file.data], file.filename, { type: file.contentType }))
  }
  return agent.request(`/c/${community}/comments/${postId}/comment`, {
    method: 'POST',
    body: form,
  })
}

export async function bodyText(res: Response): Promise<string> {
  return await res.text()
}
