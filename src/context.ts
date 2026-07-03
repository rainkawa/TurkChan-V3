import type { DB } from './db'
import type { AppConfig } from './config'
import type { Mailer } from './lib/mailer'
import { RateLimiter } from './lib/ratelimit'
import type { ObjectStorage } from './services/storage'

/** Everything services need, injected so tests control clock, mail, storage, and fetch. */
export interface Ctx {
  db: DB
  config: AppConfig
  mailer: Mailer
  storage: ObjectStorage
  rateLimiter: RateLimiter
  now: () => number
  fetchFn: typeof fetch
}
