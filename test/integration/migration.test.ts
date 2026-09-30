/**
 * Şema geçişleri (migration).
 *
 * Önemli senaryo: özellikten ÖNCE kurulmuş bir veritabanı yeni kodla açılır.
 * CREATE TABLE IF NOT EXISTS mevcut tabloya yeni kolon eklemediği için,
 * kolonları ekleyen migrate() ve yeni kolonlara bağlı indexler doğru sırada
 * çalışmalıdır. Aksi halde uygulama açılışta çöker.
 */
import { describe, expect, test } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db'
import { SCHEMA_SQL } from '../../src/db/schema'

/** Sonradan eklenen kolonlar: özellik öncesi sürümlerde yoktur. */
const LATE_COLUMNS = [
  'is_anonymous',
  'anon_name',
  'is_thread',
  'thread_sticky',
  'thread_locked',
  'thread_archived',
  'bumped_at',
  'bump_count',
  'reply_count',
  'view_count',
  'thread_no',
  'reply_to_comment_id',
  'anon_by_default',
]

/**
 * Mevcut sürümün tabloları; yalnızca index'ler ve sonradan eklenen kolonlar
 * çıkarılmış hâli (yani özellik öncesi bir kurulum).
 */
function legacyTablesSql(): string {
  const kept = SCHEMA_SQL.split('\n').filter((line) => {
    if (/CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(line)) return false
    const m = line.match(/^\s{2}([a-z_]+)\s+[A-Z]/)
    if (m && LATE_COLUMNS.includes(m[1] as string)) return false
    // Yalnızca yeni kolonları açıklayan yorum satırları.
    if (/^\s*-- (Anonim paylaşım|Thread modu|İstatistik)/.test(line)) return false
    return true
  })
  // Son kolonun sondaki virgülü kalmasın.
  const out: string[] = []
  for (let i = 0; i < kept.length; i++) {
    const line = kept[i] as string
    if (line.trim() === ');' && out.length > 0) {
      const prev = (out[out.length - 1] as string).replace(/,\s*$/, '')
      out[out.length - 1] = prev
    }
    out.push(line)
  }
  return out.join('\n')
}

function buildLegacyDatabase(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(legacyTablesSql())
  // Doğrulama: yeni kolonlar gerçekten yok.
  const cols = (table: string) =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name),
    )
  expect(cols('posts').has('is_thread')).toBe(false)
  expect(cols('posts').has('view_count')).toBe(false)
  expect(cols('users').has('anon_by_default')).toBe(false)

  // Eski sürümde veri de olabilir; göçün veriyi koruması gerekir.
  db.prepare(
    `INSERT INTO users (id, username, username_lower, password_hash, created_at)
     VALUES ('u1', 'eski', 'eski', 'x', 1000)`,
  ).run()
  db.prepare(
    `INSERT INTO communities (id, name, title, description, visibility, creator_id, created_at)
     VALUES ('c1', 'eski_board', 'Eski', 'd', 'public', 'u1', 1000)`,
  ).run()
  db.prepare(
    `INSERT INTO posts (id, community_id, author_id, type, title, created_at)
     VALUES ('p1', 'c1', 'u1', 'text', 'ESKI-POST', 1000)`,
  ).run()
  db.close()
}

describe('şema göçü', () => {
  test('özellik öncesi veritabanı yeni kodla sorunsuz açılır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turkchan-migrate-'))
    const path = join(dir, 'app.db')
    try {
      buildLegacyDatabase(path)
      // Kullanıcının yaşadığı çökme tam olarak burada oluyordu.
      const db = openDatabase(path)

      const cols = (table: string) =>
        new Set(
          (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name),
        )
      // Yeni kolonlar eklendi.
      for (const c of ['is_thread', 'bumped_at', 'view_count', 'is_anonymous', 'anon_name']) {
        expect(cols('posts').has(c), `posts.${c} eksik`).toBe(true)
      }
      expect(cols('users').has('anon_by_default')).toBe(true)
      expect(cols('comments').has('thread_no')).toBe(true)

      // Yeni tablolar kuruldu.
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as Array<{ name: string }>).map(
          (t) => t.name,
        ),
      )
      expect(tables.has('post_media')).toBe(true)
      expect(tables.has('post_views')).toBe(true)

      // Index'ler de kuruldu (migrate sonrası çalışmalıydı).
      const indexes = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as unknown as Array<{ name: string }>).map(
          (i) => i.name,
        ),
      )
      expect(indexes.has('idx_posts_thread')).toBe(true)
      expect(indexes.has('idx_comments_thread')).toBe(true)

      // Mevcut veri korundu.
      const post = db.prepare('SELECT title FROM posts WHERE id = ?').get('p1') as { title: string }
      expect(post.title).toBe('ESKI-POST')
      // Yeni kolonlar makul varsayılanlarla doldu.
      const full = db.prepare('SELECT is_thread, view_count, reply_count FROM posts WHERE id = ?').get('p1') as {
        is_thread: number
        view_count: number
        reply_count: number
      }
      expect(full).toEqual({ is_thread: 0, view_count: 0, reply_count: 0 })
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('açılış iki kez çalıştırılsa da göç idempotent kalır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turkchan-migrate2-'))
    const path = join(dir, 'app.db')
    try {
      const first = openDatabase(path)
      first.close()
      const second = openDatabase(path)
      second.close()
      expect(true).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
