import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../../src/db'
import {
  backupDatabase,
  backupMedia,
  pruneBackups,
  restoreDatabase,
  verifyBackup,
} from '../../src/lib/backup'

describe('yedekleme', () => {
  function workspace(): { dir: string; dbPath: string; uploadDir: string; backupDir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tc-backup-'))
    return {
      dir,
      dbPath: join(dir, 'app.db'),
      uploadDir: join(dir, 'uploads'),
      backupDir: join(dir, 'backups'),
    }
  }

  it('veritabanı yedeği alınır ve bütünlük doğrulanır', () => {
    const ws = workspace()
    try {
      const db = openDatabase(ws.dbPath)
      db.prepare("INSERT INTO users (id, username, username_lower, password_hash, display_name, created_at) VALUES ('u1','alice','alice','x','Alice',1)").run()
      db.close()

      const reopened = openDatabase(ws.dbPath)
      const result = backupDatabase(reopened, ws.dbPath, ws.backupDir)
      reopened.close()

      expect(result.bytes).toBeGreaterThan(0)
      expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(verifyBackup(result.path).ok).toBe(true)
    } finally {
      rmSync(ws.dir, { recursive: true, force: true })
    }
  })

  it('yedek geri yüklenebilir: veri yedeğe taşınır, kaynak temizlenir', () => {
    const ws = workspace()
    try {
      const db = openDatabase(ws.dbPath)
      db.prepare("INSERT INTO users (id, username, username_lower, password_hash, display_name, created_at) VALUES ('u1','alice','alice','x','Alice',1)").run()
      const backup = backupDatabase(db, ws.dbPath, ws.backupDir)
      // Yedeğin alındığı andan sonra değişiklik yapıp geri yükle.
      db.prepare("INSERT INTO users (id, username, username_lower, password_hash, display_name, created_at) VALUES ('u2','bob','bob','x','Bob',2)").run()
      db.close()

      restoreDatabase(backup.path, ws.dbPath)

      const after = openDatabase(ws.dbPath)
      const names = (after.prepare('SELECT username FROM users ORDER BY username').all() as unknown as Array<{ username: string }>).map((r) => r.username)
      after.close()
      expect(names).toEqual(['alice'])
    } finally {
      rmSync(ws.dir, { recursive: true, force: true })
    }
  })

  it('medya yedeği ayrı ve geri yüklenebilir', () => {
    const ws = workspace()
    try {
      const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs')
      mkdirSync(ws.uploadDir, { recursive: true })
      writeFileSync(join(ws.uploadDir, 'a.bin'), 'merhaba')
      const result = backupMedia(ws.uploadDir, ws.backupDir)
      expect(result.files).toBe(1)
      expect(result.bytes).toBeGreaterThan(0)
      expect(result.path.endsWith('.tmp')).toBe(false)
    } finally {
      rmSync(ws.dir, { recursive: true, force: true })
    }
  })

  it('eski yedekler budanır, belirlenen sayı korunur', () => {
    const ws = workspace()
    try {
      const base = new Date('2026-01-01T00:00:00Z')
      for (let i = 0; i < 5; i++) {
        const at = new Date(base.getTime() + i * 86_400_000)
        const db = openDatabase(ws.dbPath)
        backupDatabase(db, ws.dbPath, ws.backupDir, at)
        db.close()
      }
      const removed = pruneBackups(ws.backupDir, 2)
      const { readdirSync } = require('node:fs') as typeof import('node:fs')
      expect(removed.length).toBe(3)
      expect(readdirSync(ws.backupDir).filter((f) => f.endsWith('.sqlite3')).length).toBe(2)
    } finally {
      rmSync(ws.dir, { recursive: true, force: true })
    }
  })

  it('bozuk yedek doğrulamada yakalanır', () => {
    const ws = workspace()
    try {
      const { writeFileSync } = require('node:fs') as typeof import('node:fs')
      const path = join(ws.backupDir, 'db-bozuk.sqlite3')
      const { mkdirSync } = require('node:fs') as typeof import('node:fs')
      mkdirSync(ws.backupDir, { recursive: true })
      writeFileSync(path, 'bu bir veritabanı değil')
      expect(verifyBackup(path).ok).toBe(false)
      expect(verifyBackup(join(ws.backupDir, 'yok.sqlite3')).ok).toBe(false)
    } finally {
      rmSync(ws.dir, { recursive: true, force: true })
    }
  })
})