import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL, INDEX_SQL } from './schema'
import { hotRank, wilsonLowerBound } from '../lib/ranking'

export type DB = DatabaseSync

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // Bağlantı ayarları her açılışta uygulanır:
  //  - WAL: okuyucu/yazıcı birbirini bloklamaz (yazma sırasında akış okunabilir).
  //  - foreign_keys: uygulama şemada tanımlı referansları gerçekten uygular.
  //  - busy_timeout: eşzamanlı yazma girişimleri "database is locked" yerine bekler.
  //  - synchronous=NORMAL: WAL kipiyle birlikte güvenli ve belirgin şekilde hızlı.
  //    (FULL her commit'te fsync yapar; yedekleme stratejisi bunu telafi eder.)
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA temp_store = MEMORY')
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

  // Okundu işaretinin aynı milisaniyede gelen mesajları da ayırt edebilmesi
  // için son görülen mesajın rowid'i saklanır (rozet kaybı düzeltmesi).
  const sessionColumns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  if (!sessionColumns.has('last_seen_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0')
  }
  // Gizlilik: eski sürümlerde tutulan IP / User-Agent sütunları düşürülür.
  for (const column of ['ip', 'user_agent']) {
    if (sessionColumns.has(column)) dropColumnIfSupported(db, 'sessions', column)
  }

  const memberColumns = new Set(
    (db.prepare('PRAGMA table_info(conversation_members)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  if (!memberColumns.has('last_read_rowid')) {
    db.exec('ALTER TABLE conversation_members ADD COLUMN last_read_rowid INTEGER NOT NULL DEFAULT 0')
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

  const uploadColumns = new Set(
    (db.prepare('PRAGMA table_info(uploads)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  if (!uploadColumns.has('thumb_key')) {
    db.exec('ALTER TABLE uploads ADD COLUMN thumb_key TEXT')
  }

  // >>12345 referansları için topluluk içinde sıralı post numarası.
  const numbered = new Set(
    (db.prepare('PRAGMA table_info(posts)').all() as unknown as Array<{ name: string }>).map((c) => c.name),
  )
  if (!numbered.has('number')) {
    db.exec('ALTER TABLE posts ADD COLUMN number INTEGER')
    // Mevcut gönderilere oluşturulma sırasına göre numara verilir; böylece
    // eski içeriklerdeki referanslar yine doğru gönderiye bağlanır.
    const rows = db
      .prepare('SELECT rowid AS rid, community_id FROM posts ORDER BY community_id, created_at, rowid')
      .all() as unknown as Array<{ rid: number; community_id: string }>
    let seq = 0
    let current: string | null = null
    for (const row of rows) {
      if (row.community_id !== current) {
        current = row.community_id
        seq = 0
      }
      seq += 1
      db.prepare('UPDATE posts SET number = ? WHERE rowid = ?').run(seq, row.rid)
    }
  }

  // Gizlilik: başarısız giriş denemelerinde IP adresi saklanmaz. Kaba kuvvet
  // koruması kullanıcı adı üzerinden çalışır, IP bazlı sınır bellekte tutulur.
  const attemptColumns = new Set(
    (db.prepare('PRAGMA table_info(login_attempts)').all() as unknown as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  )
  if (attemptColumns.has('ip')) dropColumnIfSupported(db, 'login_attempts', 'ip')
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
