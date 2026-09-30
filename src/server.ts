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
import { purgeExpiredSessions } from './services/auth'
import { backupDatabase, backupMedia, pruneBackups, verifyBackup } from './lib/backup'
import { logError, logInfo } from './lib/logging'
import { join } from 'node:path'

const config = loadConfig()
const db = openDatabase(config.dbPath)
const backupDir = process.env.BACKUP_DIR ?? join('data', 'backups')
const backupKeep = Number(process.env.BACKUP_KEEP ?? 7)

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
// Statik varlıklar (CSS/JS/rank GIF'leri/sitelogo): sürüm damgası olmayan bir
// dosya adı kullanıldığı için uzun süreli önbellek + ETag ile 304 doğrulama
// yapılır. `immutable` yalnızca dosya adı hash'li olduğunda güvenlidir;
// burada içerik değişince dosya adı da değişecek şekilde sunulmalıdır, bu
// yüzden kısa bir max-age + must-revalidate tercih edilmiştir.
app.use(
  '/static/*',
  serveStatic({
    root: './public',
    rewriteRequestPath: (p) => p.replace(/^\/static/, ''),
    onFound: (_path, c) => {
      // serveStatic önbellek seçeneklerini desteklemese de ETag/Last-Modified
      // üretir; burada yalnızca süre eklenir. `must-revalidate` dosya
      // değiştiğinde eski sürümün bir süre daha kullanılmasını engeller.
      c.header('Cache-Control', 'public, max-age=3600, must-revalidate')
    },
  }),
)

/** Daily maintenance: purge soft-deleted communities + expired sessions. */
function runMaintenance(): void {
  purgeExpiredCommunities(ctx)
  purgeExpiredSessions(ctx)
}

/**
 * Günlük otomatik yedekleme.
 *
 * Açılışta bir kez ve sonra günde bir çalışır. Hata durumunda sunucu
 * etkilenmez; yedekleme en iyi ihtimalle başarısız olur.
 */
function runBackup(): void {
  try {
    const result = backupDatabase(ctx.db, config.dbPath, backupDir)
    const check = verifyBackup(result.path)
    if (!check.ok) {
      logError(new Error(`yedek doğrulanamadı: ${check.detail}`), { event: 'backup_failed', path: result.path })
      return
    }
    const media = backupMedia(config.uploadDir, backupDir)
    pruneBackups(backupDir, backupKeep)
    logInfo('backup_completed', {
      db: result.path,
      bytes: result.bytes,
      mediaFiles: media.files,
      mediaBytes: media.bytes,
    })
  } catch (err) {
    logError(err, { event: 'backup_failed' })
  }
}

runMaintenance()
setInterval(runMaintenance, 24 * 60 * 60 * 1000).unref()

setTimeout(() => {
  runBackup()
  setInterval(runBackup, 24 * 60 * 60 * 1000).unref()
}, 30_000).unref()

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Community platform listening on http://localhost:${info.port}`)
})
