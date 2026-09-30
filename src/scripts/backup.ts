/**
 * Yedekleme aracı.
 *
 *   npm run backup              → veritabanı + medya yedeği al, doğrula
 *   npm run backup -- verify    → mevcut yedekleri bütünlük açısından doğrula
 *   npm run backup -- restore <dosya>
 *                               → veritabanını yedeğinden geri yükle
 *
 * Yedekler `BACKUP_DIR` (varsayılan `data/backups`) altına yazılır; bu klasör
 * web üzerinden servis edilmez ve `.gitignore` içindedir.
 */
import { openDatabase } from '../db'
import { loadConfig } from '../config'
import {
  backupDatabase,
  backupMedia,
  pruneBackups,
  restoreDatabase,
  verifyBackup,
} from '../lib/backup'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const config = loadConfig()
const backupDir = process.env.BACKUP_DIR ?? join('data', 'backups')
const keep = Number(process.env.BACKUP_KEEP ?? 7)

const [command = 'run', argument] = process.argv.slice(2)

function run(): void {
  // VACUUM INTO aynı bağlantı üzerinde çalışır; bu yüzden veritabanı açılır.
  const db = openDatabase(config.dbPath)
  try {
    const dbBackup = backupDatabase(db, config.dbPath, backupDir)
    const check = verifyBackup(dbBackup.path)
    if (!check.ok) {
      console.error(`✗ Yedek doğrulanamadı: ${dbBackup.path} — ${check.detail}`)
      process.exitCode = 1
      return
    }
    const media = backupMedia(config.uploadDir, backupDir)
    pruneBackups(backupDir, keep)
    console.log(`✓ Veritabanı yedeği: ${dbBackup.path}`)
    console.log(`  ${(dbBackup.bytes / 1024).toFixed(1)} KB · sha256 ${dbBackup.sha256.slice(0, 16)}… · ${check.detail}`)
    console.log(`✓ Medya yedeği: ${media.path} (${media.files} dosya, ${(media.bytes / 1024).toFixed(1)} KB)`)
  } finally {
    db.close()
  }
}

function verify(): void {
  const files = readdirSync(backupDir).filter((f) => f.endsWith('.sqlite3'))
  if (files.length === 0) {
    console.log('Yedek bulunamadı.')
    return
  }
  let failed = 0
  for (const file of files) {
    const result = verifyBackup(join(backupDir, file))
    console.log(`${result.ok ? '✓' : '✗'} ${file} — ${result.detail}`)
    if (!result.ok) failed += 1
  }
  if (failed > 0) process.exitCode = 1
}

function restore(): void {
  if (!argument) {
    console.error('Geri yükleme için bir yedek dosyası belirtin: npm run backup -- restore <dosya>')
    process.exitCode = 1
    return
  }
  const previous = restoreDatabase(argument, config.dbPath)
  console.log(`✓ Geri yüklendi: ${argument}`)
  console.log(`  Önceki veritabanı: ${previous}`)
  console.log('  Sunucuyu yeniden başlatmayı unutmayın.')
}

switch (command) {
  case 'run':
    run()
    break
  case 'verify':
    verify()
    break
  case 'restore':
    restore()
    break
  default:
    console.error(`Bilinmeyen komut: ${command}`)
    process.exitCode = 1
}