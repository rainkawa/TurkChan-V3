import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { createApp } from './app'
import type { Ctx } from './context'
import { ConsoleMailer } from './lib/mailer'
import { RateLimiter } from './lib/ratelimit'
import { LocalObjectStorage } from './services/storage'
import { purgeExpiredCommunities } from './services/admin'

const config = loadConfig()
const db = openDatabase(config.dbPath)

const ctx: Ctx = {
  db,
  config,
  mailer: new ConsoleMailer(),
  storage: new LocalObjectStorage(config.uploadDir),
  rateLimiter: new RateLimiter(),
  now: () => Date.now(),
  fetchFn: fetch,
}

const app = createApp(ctx)
app.use('/static/*', serveStatic({ root: './public', rewriteRequestPath: (p) => p.replace(/^\/static/, '') }))

// Daily maintenance: purge communities soft-deleted more than 30 days ago.
purgeExpiredCommunities(ctx)
setInterval(() => purgeExpiredCommunities(ctx), 24 * 60 * 60 * 1000).unref()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Community platform listening on http://localhost:${info.port}`)
})
