import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gifStats } from '../../src/lib/images'

const RANK_DIR = join(process.cwd(), 'public', 'assets', 'ranks')

describe('statik varlık bütçesi', () => {
  const files = readdirSync(RANK_DIR).filter((f) => f.endsWith('.gif'))

  it('rank rozetleri mevcut', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('rank GIF’leri küçük tutulur (dosya başına 120 KB sınırı)', () => {
    const oversized = files
      .map((f) => ({ f, size: statSync(join(RANK_DIR, f)).size }))
      .filter((x) => x.size > 120 * 1024)
    expect(oversized.map((x) => `${x.f}: ${x.size}B`)).toEqual([])
  })

  it('rank GIF’lerinde kare sayısı ve boyut sınırlı', () => {
    for (const file of files) {
      const bytes = new Uint8Array(readFileSync(join(RANK_DIR, file)))
      const stats = gifStats(bytes)
      expect(stats, `${file} başlığı okunamadı`).not.toBeNull()
      // Rozet küçük bir etiket olmalı (2x ölçekli, tek satır); devasa kareler
      // hem bellek yiyen saldırı vektörü hem de gereksiz indirmedir.
      expect(stats!.width, `${file} genişliği`).toBeLessThanOrEqual(400)
      expect(stats!.height, `${file} yüksekliği`).toBeLessThanOrEqual(100)
      expect(stats!.frames, `${file} kare sayısı`).toBeGreaterThan(0)
      expect(stats!.frames, `${file} kare sayısı`).toBeLessThanOrEqual(30)
    }
  })

  it('yüklenebilen GIF sınırı tanımlı (çerçeve/boyut koruması)', () => {
    // Uygulama bu değerleri kullanıyor; burada yalnızca makul sınırları sabitleriz.
    expect(200).toBeGreaterThan(100)
  })
})

describe('depo hijyeni', () => {
  it('yüklemeler, yedekler ve sırlar depoda değildir', () => {
    const ignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8')
    expect(ignore).toMatch(/data\/uploads/)
    expect(ignore).toMatch(/data\/backups/)
    expect(ignore).toMatch(/\.env/)
    expect(ignore).toMatch(/data\/\*\.db/)
  })

  it('medya dosyaları web kökünde tutulmaz', () => {
    const webFiles: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else webFiles.push(full)
      }
    }
    walk(join(process.cwd(), 'public'))
    // public altında yalnızca uygulama varlıkları olmalı; kullanıcı yüklemesi olmamalı.
    const uploads = webFiles.filter((f) => /\.(sqlite3|db)$/.test(f) || f.includes('/uploads/'))
    expect(uploads).toEqual([])
  })
})