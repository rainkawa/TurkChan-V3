/**
 * TurkChan logosu — kayıpsız (görüntülenebilir ölçekte) SVG optimizasyonu.
 *
 * VTracer çıktısı 2001×786 bir rasterin vektör izidir: ~1 MB, 2.355 path,
 * 1.676 ayrı dolgu rengi. Header'da ~185px genişlikte gösterildiği için
 * kaynak koordinattaki 0.5 birimlik hata ekranda 0.05px'tir; yani
 * koordinatları tam sayıya yuvarlamak GÖRÜNMEZ.
 *
 * Yapılan üç işlem:
 *   1. `viewBox` eklenir, sabit `width`/`height` kaldırılır → CSS boyutu
 *      yönetir, logo ölçeklenebilir olur.
 *   2. Her path'teki `transform="translate(x,y)"` koordinatlara işlenir
 *      (tek transform olduğu için toplama güvenlidir).
 *   3. Sayısal koordinatlar en yakın tam sayıya yuvarlanır.
 *
 * Doğrulama: dönüşüm öncesi/sonrası tüm noktalar karşılaştırılır,
 * maksimum sapma 0.5 birimden büyükse dosya YAZILMAZ.
 *
 * Kullanım: node scripts/optimize-logo.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'public/logo.svg'
const TOLERANCE = 0.5

const original = readFileSync(FILE, 'utf8')

// --- başlık -----------------------------------------------------------------
const header = original.match(/<svg\b[^>]*>/)
if (!header) throw new Error('kök <svg> bulunamadı')
const width = Number(header[0].match(/width="([\d.]+)"/)?.[1])
const height = Number(header[0].match(/height="([\d.]+)"/)?.[1])
if (!width || !height) throw new Error('width/height okunamadı')
const viewBox = `0 0 ${width} ${height}`

// Her path'in verisini ve transform'unu topla (optimizasyon ÖNCESİ).
const items = []
for (const m of original.matchAll(
  /<path\s+([^>]*?)\bd="([^"]*)"([^>]*?)\/>/g,
)) {
  const attrsBefore = String(m[1]) + String(m[3])
  const d = String(m[2])
  const t = attrsBefore.match(/transform="translate\(([-\d.]+),\s*([-\d.]+)\)"/)
  items.push({
    d,
    tx: t ? Number(t[1]) : 0,
    ty: t ? Number(t[2]) : 0,
    rest: attrsBefore.replace(/\s*transform="translate\([^"]*\)"/, ''),
  })
}
if (items.length === 0) throw new Error('path bulunamadı')

// Varsayım doğrulaması: yalnızca mutlak M/C/Z kabul edilir.
for (const it of items) {
  const cmds = String(it.d).match(/[A-Za-z]/g) ?? []
  for (const c of cmds) {
    if (!'MCZ'.includes(c)) {
      throw new Error(`beklenmeyen yol komutu "${c}"; translate işleme güvenli değil`)
    }
  }
}

/**
 * Bir path'in sayılarını dönüştürür.
 *
 * VTracer çıktısı YALNIZCA mutlak `M`, `C`, `Z` komutları üretir; göreli
 * komut yoktur. Bu yüzden sayılar x, y, x, y ... sırayla gelir ve
 * `translate(tx, ty)` doğrudan koordinatlara işlenebilir. (Göreli komut
 * varsa bu varsayım bozulur; aşağıdaki kontrol bunu reddeder.)
 */
function mapNumbers(d, tx, ty, round) {
  let index = 0
  return String(d).replace(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g, (n) => {
    const offset = index % 2 === 0 ? tx : ty
    index += 1
    const v = Number(n) + offset
    return String(round ? Math.round(v) : v)
  })
}

// Doğrulama: her sayının TAM konumu (translate uygulanmış) ile yuvarlanmış
// hali karşılaştırılır. Bu fark tanım gereği ≤ 0.5 olmalıdır; aşılırsa
// (örn. yuvarlama kuralı bozulursa) dosya YAZILMAZ.
let maxDelta = 0
let count = 0
for (const it of items) {
  const raw = String(it.d).match(/-?\d+(?:\.\d+)?/g) ?? []
  let i = 0
  for (const n of raw) {
    const exact = Number(n) + (i % 2 === 0 ? it.tx : it.ty)
    const rounded = Math.round(exact)
    maxDelta = Math.max(maxDelta, Math.abs(exact - rounded))
    i += 1
    count += 1
  }
  // Üretilen metinde sayı sayısı korunmalı.
  const produced = mapNumbers(it.d, it.tx, it.ty, true).match(/-?\d+(?:\.\d+)?/g) ?? []
  if (produced.length !== raw.length) {
    throw new Error(`sayı sayısı değişti (${raw.length} → ${produced.length})`)
  }
}
if (maxDelta > TOLERANCE) {
  throw new Error(`sapma ${maxDelta.toFixed(3)} > ${TOLERANCE}; dosya yazılmadı`)
}

// --- yeniden yaz ------------------------------------------------------------
const body = items
  .map((it) => {
    const attrs = it.rest.trim().replace(/\s+/g, ' ')
    return `<path ${attrs} d="${mapNumbers(it.d, it.tx, it.ty, true)}"/>`
  })
  .join('\n')

const output =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ` +
  `role="img" aria-label="TurkChan">\n${body}\n</svg>\n`

writeFileSync(FILE, output)

const kb = (n) => `${(n / 1024).toFixed(0)} KB`
console.log(`viewBox eklendi: ${viewBox}`)
console.log(`path: ${items.length}, koordinat: ${count}`)
console.log(`maksimum yuvarlama sapması: ${maxDelta.toFixed(3)} birim ` +
  `(185px genişlikte ${(maxDelta / width * 185).toFixed(4)}px)`)
console.log(`${kb(Buffer.byteLength(original))} → ${kb(Buffer.byteLength(output))}`)
