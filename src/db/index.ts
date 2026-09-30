import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL, INDEX_SQL } from './schema'
import { hotRank, wilsonLowerBound } from '../lib/ranking'

export type DB = DatabaseSync

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // Sıra önemlidir:
  //  1) tablolar oluşturulur — mevcut bir veritabanında CREATE TABLE IF NOT EXISTS
  //     yeni kolonları EKLEMEZ, yalnızca eksik tabloyu kurar,
  //  2) migrate() sonradan gelen kolonları ekler,
  //  3) indexler en sona bırakılır; çünkü bazıları yeni kolonlara bağlıdır ve
  //     kolonlar eklenmeden önce çalıştırılırsa "no such column" ile çöker.
  db.exec(SCHEMA_SQL)
  migrate(db)
  db.exec(INDEX_SQL)
  registerFunctions(db)
  return db
}

/**
 * Add columns introduced after the initial release. CREATE TABLE IF NOT EXISTS
 * silently skips them on an existing database, so we inspect and ALTER.
 * Idempotent, and a no-op on a fresh install.
 */
function migrate(db: DatabaseSync): void {
  const have = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  for (const [column, ddl] of [
    ['avatar_key', 'ALTER TABLE users ADD COLUMN avatar_key TEXT'],
    ['cover_key', 'ALTER TABLE users ADD COLUMN cover_key TEXT'],
    ['rank_mode', "ALTER TABLE users ADD COLUMN rank_mode TEXT NOT NULL DEFAULT 'auto'"],
    ['rank_override', 'ALTER TABLE users ADD COLUMN rank_override TEXT'],
    ['staff_role', "ALTER TABLE users ADD COLUMN staff_role TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    if (!have.has(column)) db.exec(ddl)
  }

  const notificationColumns = new Set(
    (db.prepare('PRAGMA table_info(notifications)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  if (!notificationColumns.has('actor_id')) {
    db.exec('ALTER TABLE notifications ADD COLUMN actor_id TEXT')
  }

  // Board etiketleri ve medya/spoiler alanları sonraki sürümlerde eklendi.
  const postColumns = new Set(
    (db.prepare('PRAGMA table_info(posts)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  for (const [column, ddl] of [
    ['media_kind', "ALTER TABLE posts ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'none'"],
    ['spoiler', 'ALTER TABLE posts ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0'],
    ['flair_id', 'ALTER TABLE posts ADD COLUMN flair_id TEXT'],
    // Anonim paylaşım, thread modu ve istatistik alanları.
    ['is_anonymous', 'ALTER TABLE posts ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0'],
    ['anon_name', 'ALTER TABLE posts ADD COLUMN anon_name TEXT'],
    ['is_thread', 'ALTER TABLE posts ADD COLUMN is_thread INTEGER NOT NULL DEFAULT 0'],
    ['thread_sticky', 'ALTER TABLE posts ADD COLUMN thread_sticky INTEGER NOT NULL DEFAULT 0'],
    ['thread_locked', 'ALTER TABLE posts ADD COLUMN thread_locked INTEGER NOT NULL DEFAULT 0'],
    ['thread_archived', 'ALTER TABLE posts ADD COLUMN thread_archived INTEGER NOT NULL DEFAULT 0'],
    ['bumped_at', 'ALTER TABLE posts ADD COLUMN bumped_at INTEGER'],
    ['bump_count', 'ALTER TABLE posts ADD COLUMN bump_count INTEGER NOT NULL DEFAULT 0'],
    ['reply_count', 'ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0'],
    ['view_count', 'ALTER TABLE posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!postColumns.has(column)) db.exec(ddl)
  }

  const commentColumns = new Set(
    (db.prepare('PRAGMA table_info(comments)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  for (const [column, ddl] of [
    ['thread_no', 'ALTER TABLE comments ADD COLUMN thread_no INTEGER'],
    ['reply_to_comment_id', 'ALTER TABLE comments ADD COLUMN reply_to_comment_id TEXT'],
  ] as const) {
    if (!commentColumns.has(column)) db.exec(ddl)
  }

  const userColumns = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  if (!userColumns.has('anon_by_default')) {
    db.exec('ALTER TABLE users ADD COLUMN anon_by_default INTEGER NOT NULL DEFAULT 0')
  }
}

function registerFunctions(db: DatabaseSync) {
  db.function('hot_rank', { deterministic: true }, (score: unknown, createdAtMs: unknown, decay: unknown) =>
    hotRank(Number(score), Number(createdAtMs), Number(decay)),
  )
  db.function('wilson', { deterministic: true }, (up: unknown, down: unknown) =>
    wilsonLowerBound(Number(up), Number(down)),
  )
}

/** Run fn inside a transaction; rolls back on throw. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
