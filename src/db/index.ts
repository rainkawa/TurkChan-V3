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
  // CHECK kısıtı ALTER ile değiştirilemez; yeni bildirim türü eklenince tablo
  // yeniden kurulur (veriler kopyalanır).
  ensureNotificationTypes(db)

  // Board etiketleri ve medya/spoiler alanları sonraki sürümlerde eklendi.
  const postColumns = new Set(
    (db.prepare('PRAGMA table_info(posts)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  for (const [column, ddl] of [
    ['media_kind', "ALTER TABLE posts ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'none'"],
    ['spoiler', 'ALTER TABLE posts ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0'],
    ['flair_id', 'ALTER TABLE posts ADD COLUMN flair_id TEXT'],
    // Anonim paylaşım ve istatistik alanları.
    ['is_anonymous', 'ALTER TABLE posts ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0'],
    ['anon_name', 'ALTER TABLE posts ADD COLUMN anon_name TEXT'],
    ['view_count', 'ALTER TABLE posts ADD COLUMN view_count INTEGER NOT NULL DEFAULT 0'],
  ] as const) {
    if (!postColumns.has(column)) db.exec(ddl)
  }

  const commentColumns = new Set(
    (db.prepare('PRAGMA table_info(comments)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  for (const [column, ddl] of [
    ['spoiler', 'ALTER TABLE comments ADD COLUMN spoiler INTEGER NOT NULL DEFAULT 0'],
    ['is_anonymous', 'ALTER TABLE comments ADD COLUMN is_anonymous INTEGER NOT NULL DEFAULT 0'],
    ['anon_name', 'ALTER TABLE comments ADD COLUMN anon_name TEXT'],
  ] as const) {
    if (!commentColumns.has(column)) db.exec(ddl)
  }

  // Kullanımdan kalkan thread modu sütunları: eski kurulumlarda kalmış olabilir.
  // SQLite 3.35+ DROP COLUMN destekler; desteklenmese yoksayılır.
  for (const column of ['is_thread', 'thread_sticky', 'thread_locked', 'thread_archived', 'bumped_at', 'bump_count', 'reply_count']) {
    if (postColumns.has(column)) dropColumnIfSupported(db, 'posts', column)
  }
  for (const column of ['thread_no', 'reply_to_comment_id']) {
    if (commentColumns.has(column)) dropColumnIfSupported(db, 'comments', column)
  }

  const userColumns = new Set(
    (db.prepare('PRAGMA table_info(users)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  if (!userColumns.has('anon_by_default')) {
    db.exec('ALTER TABLE users ADD COLUMN anon_by_default INTEGER NOT NULL DEFAULT 0')
  }
}

/**
 * `notifications.type` CHECK kısıtı yeni bir tür içermiyorsa tabloyu yeniden
 * kurar. SQLite CHECK'i ALTER ile değiştiremez; standart güvenli yol: yeni
 * tablo kur → verileri kopyala → eskiyi düşür → yeniden adlandır.
 */
function ensureNotificationTypes(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'")
    .get() as { sql: string } | undefined
  if (!row) return
  const types = new Set(
    (row.sql.match(/type IN \(([^)]*)\)/)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim().replace(/^'|'$/g, ''))
      .filter(Boolean),
  )
  if (types.has('mention')) return

  db.exec('PRAGMA foreign_keys = OFF')
  transaction(db, () => {
    db.exec(`CREATE TABLE notifications_migrated (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      actor_id TEXT,
      type TEXT NOT NULL CHECK (type IN ('reply','mention','mod_removal','mod_ban','membership')),
      actor_hidden INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      source_comment_id TEXT,
      read INTEGER NOT NULL DEFAULT 0,
      withdrawn INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`)
    db.exec(
      `INSERT INTO notifications_migrated
         (id, user_id, actor_id, type, actor_hidden, title, link, source_comment_id, read, withdrawn, created_at)
       SELECT id, user_id, actor_id, type, actor_hidden, title, link, source_comment_id, read, withdrawn, created_at
         FROM notifications`,
    )
    db.exec('DROP TABLE notifications')
    db.exec('ALTER TABLE notifications_migrated RENAME TO notifications')
  })
  db.exec('PRAGMA foreign_keys = ON')
}

/** SQLite DROP COLUMN desteklemiyorsa göç yine de engellenmemeli. */
function dropColumnIfSupported(db: DatabaseSync, table: string, column: string): void {
  try {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
  } catch {
    // Eski SQLite: sütun kalır ama kullanılmaz; uygulama yine açılır.
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
