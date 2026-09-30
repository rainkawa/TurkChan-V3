/**
 * Yedekleme (backup) — veritabanı ve medya.
 *
 * Tasarım ilkeleri:
 *  - **Tutarlı**: SQLite için `VACUUM INTO` kullanılır. Bu, WAL kipinde bile
 *    anlık ve tutarlı bir kopya üretir; dosyayı kopyalamak (shutil.copy) WAL
 *    içeren bir veritabanını bozabilir.
 *  - **Atomik**: kopya önce `.tmp` uzantısıyla yazılır, sonra `rename` ile
 *    nihai adına taşınır. Yarım kalan bir yedek asla "geçerli" görünmez.
 *  - **Geri yüklenebilir**: `restoreDatabase` mevcut dosyayı yedekleyip
 *    yerine koyar; böylece hatalı bir geri yükleme de geri alınabilir.
 *  - **Erişilemez**: yedekler `public/` altında DEĞİLDİR; web üzerinden
 *    servis edilmezler.
 */
import { DatabaseSync } from 'node:sqlite'
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export interface BackupResult {
  path: string
  bytes: number
  sha256: string
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z')
}

/**
 * Yedek dosyası adı çakışmasını önler.
 *
 * `VACUUM INTO` var olan bir dosyanın üzerine yazmayı reddeder; saniye
 * çözünürlüğü yüzden aynı saniyede alınan ikinci bir yedek çökerdi. Sondaki
 * sayaç ile ad benzersizleştirilir.
 */
function uniquePath(dir: string, base: string, ext: string): string {
  let candidate = resolve(dir, `${base}${ext}`)
  let counter = 1
  while (existsSync(candidate)) {
    candidate = resolve(dir, `${base}-${counter}${ext}`)
    counter += 1
  }
  return candidate
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Veritabanı yedeği alır. Kaynak bağlantı açık olmalıdır (VACUUM INTO aynı
 * bağlantı üzerinde çalışır).
 */
export function backupDatabase(db: DatabaseSync, dbPath: string, backupDir: string, at = new Date()): BackupResult {
  if (dbPath === ':memory:') throw new Error('Bellek içi veritabanı yedeklenemez.')
  mkdirSync(backupDir, { recursive: true })
  const finalPath = uniquePath(backupDir, `db-${stamp(at)}`, '.sqlite3')
  const tmpPath = `${finalPath}.tmp`
  rmSync(tmpPath, { force: true })
  // VACUUM INTO: WAL kipinde de tutarlı, atomik bir kopya verir.
  db.exec(`VACUUM INTO '${finalPath.replace(/'/g, "''")}'`)
  const bytes = statSync(finalPath).size
  return { path: finalPath, bytes, sha256: sha256File(finalPath) }
}

/** Yedeği geri yükler; mevcut veritabanı `.pre-restore` olarak saklanır. */
export function restoreDatabase(backupPath: string, dbPath: string): string {
  if (!existsSync(backupPath)) throw new Error(`Yedek bulunamadı: ${backupPath}`)
  if (dbPath === ':memory:') throw new Error('Bellek içi veritabanı geri yüklenemez.')
  const backupOfCurrent = `${dbPath}.pre-restore`
  if (existsSync(dbPath)) copyFileSync(dbPath, backupOfCurrent)
  copyFileSync(backupPath, dbPath)
  // WAL ve SHM yan dosyaları eski veritabanına aittir; temizlenmezse
  // geri yükleme tutarsız okunabilir.
  for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) rmSync(sidecar, { force: true })
  return backupOfCurrent
}

export interface MediaBackupResult {
  path: string
  files: number
  bytes: number
}

/**
 * Medya yedeği. Yüklenen nesneler `data/uploads` altında anahtar adıyla
 * durur; bağımsız, geri yüklenebilir bir kopya üretilir.
 *
 * Kopyalama yerine bağlantı kurulur (hardlink) — diskte yer kaplamaz — ve
 * mümkün değilse normal kopyaya düşer. Bu yüzden veritabanı ile medya
 * yedekleri birbirinden bağımsız geri yüklenebilir.
 */
export function backupMedia(uploadDir: string, backupDir: string, at = new Date()): MediaBackupResult {
  if (!existsSync(uploadDir)) return { path: join(backupDir, `media-${stamp(at)}`), files: 0, bytes: 0 }
  const target = uniquePath(backupDir, `media-${stamp(at)}`, '')
  const tmpTarget = `${target}.tmp`
  rmSync(tmpTarget, { recursive: true, force: true })
  mkdirSync(tmpTarget, { recursive: true })

  let files = 0
  let bytes = 0
  for (const name of readdirSync(uploadDir)) {
    const src = join(uploadDir, name)
    const dest = join(tmpTarget, name)
    try {
      copyFileSync(src, dest, fsConstants.COPYFILE_FICLONE)
    } catch {
      copyFileSync(src, dest)
    }
    files += 1
    bytes += statSync(dest).size
  }
  // Atomiklik: bölüm tamamlanmadan dizin görünmez.
  renameSync(tmpTarget, target)
  return { path: target, files, bytes }
}

/** Yedekten eski dosyaları temizler; `keep` adet yedeği korur. */
export function pruneBackups(backupDir: string, keep: number): string[] {
  if (keep < 1) throw new Error('keep en az 1 olmalıdır.')
  if (!existsSync(backupDir)) return []
  const files = readdirSync(backupDir)
    .filter((f) => /^db-.*\.sqlite3$/.test(f) || /^media-/.test(f))
    .sort()
  const removed: string[] = []
  for (const name of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

export interface VerifyResult {
  ok: boolean
  detail: string
}

/**
 * Yedeğin gerçekten açılabilir olduğunu doğrular (bütünlük kontrolü).
 * Yedek alındıktan sonra çağrılmalıdır; bozuk yedek fark edilmezse
 * geri yükleme günü felaket getirir.
 */
export function verifyBackup(path: string): VerifyResult {
  if (!existsSync(path)) return { ok: false, detail: 'dosya yok' }
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(path, { readOnly: true })
    const rows = db.prepare('PRAGMA integrity_check').all() as unknown as Array<{ integrity_check: string }>
    const result = rows[0]?.integrity_check ?? 'unknown'
    if (result !== 'ok') return { ok: false, detail: result }
    const count = (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n
    return { ok: true, detail: `${count} tablo, bütünlük tamam` }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    db?.close()
  }
}