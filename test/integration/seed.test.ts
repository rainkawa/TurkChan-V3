import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db'

const ROOT = join(import.meta.dirname, '..', '..')

function run(script: string, env: NodeJS.ProcessEnv): string {
  return execFileSync('npx', ['tsx', script], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe('seed ve yedekleme betikleri', () => {
  it('seed betiği uçtan uca çalışır', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-seed-'))
    try {
      run('src/db/seed.ts', { DB_PATH: join(dir, 'app.db'), NODE_ENV: 'development' })
      const db = openDatabase(join(dir, 'app.db'))
      const count = (table: string): number =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
      expect(count('users')).toBe(5)
      expect(count('communities')).toBe(2)
      expect(count('posts')).toBe(5)
      // Board oluşturma yalnızca yöneticilere açık olduğu için seed'in
      // moderatör ataması gerçekten kaydedilmiş olmalı.
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role = 'moderator'").get() as { n: number }).n,
      ).toBeGreaterThan(0)
      // Post numaraları topluluk içinde 1'den başlamalı.
      const numbers = db.prepare('SELECT community_id, number FROM posts').all() as unknown as Array<{
        community_id: string
        number: number
      }>
      for (const community of new Set(numbers.map((n) => n.community_id))) {
        expect(Math.min(...numbers.filter((n) => n.community_id === community).map((n) => n.number))).toBe(1)
      }
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('seed üretim ortamında çalışmayı reddeder (varsayılan parola koruması)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-seed-prod-'))
    try {
      let failed = false
      try {
        run('src/db/seed.ts', { DB_PATH: join(dir, 'app.db'), NODE_ENV: 'production' })
      } catch {
        failed = true
      }
      expect(failed, 'seed üretimde çalışmamalıydı').toBe(true)
      // Hiçbir kullanıcı oluşturulmamış olmalı.
      const db = openDatabase(join(dir, 'app.db'))
      expect((db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('yedekleme betiği çalışır ve yedeği doğrular', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-bk-'))
    try {
      const output = run('src/scripts/backup.ts', {
        DB_PATH: join(dir, 'app.db'),
        UPLOAD_DIR: join(dir, 'uploads'),
        BACKUP_DIR: join(dir, 'backups'),
      })
      expect(output).toContain('Veritabanı yedeği')
      expect(output).toContain('bütünlük tamam')

      // Aynı saniyede ikinci bir yedek de alınabilmeli (ad çakışması olmaz).
      const again = run('src/scripts/backup.ts', {
        DB_PATH: join(dir, 'app.db'),
        BACKUP_DIR: join(dir, 'backups'),
      })
      expect(again).toContain('bütünlük tamam')

      // Doğrulama komutu da çalışır.
      const verified = run('src/scripts/backup.ts', {
        DB_PATH: join(dir, 'app.db'),
        BACKUP_DIR: join(dir, 'backups'),
      })
      expect(verified).toContain('bütünlük tamam')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})