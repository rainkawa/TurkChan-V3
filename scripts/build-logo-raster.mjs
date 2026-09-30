/**
 * Header logosunun raster sürümünü üretir.
 *
 * Neden: `public/logo.svg` bir VTracer çıktısı — 875 KB, 2.355 path,
 * 182 bin koordinat. Header'da 36 CSS px yükseklikte gösterilen bir görsel
 * için bu taşınamayacak kadar ağırdır (mobilde her sayfa yüklemesinde
 * indirilir). Oysa ekranda en fazla 2× yoğunlukta ~184 px genişlikte
 * görünüyor; 384 px'lik bir raster bu için fazlasıyla yeterli ve 23 kat
 * küçük.
 *
 * Kaynak SVG değişirse (örn. yeni logo yüklenir) bu betiği çalıştır:
 *   npm run logo:raster
 * ve `src/views/layout.tsx` içindeki LOGO_VERSION otomatik olarak yeni
 * dosyanın zaman damgasını alır (cache busting).
 *
 * Kullanım: node scripts/build-logo-raster.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const SOURCE = 'public/logo.svg'
const TARGET = 'public/logo-384.png'
/** 2× retina: 92 CSS px genişlik × 2 = 184 px; güvenlik payıyla 384 px. */
const WIDTH = 384
/** Kaynak logo oranı (2001×786); kaynak değişirse bu güncellenmelidir. */
const EXPECTED_RATIO = 2001 / 786

const svg = readFileSync(SOURCE, 'utf8')

// Çıktı yalnızca kaynak dosyadan türetilir: viewBox yoksa ölçekleme
// yanlış olur ve logo kırpılır.
const root = svg.match(/<svg[^>]*>/)?.[0] ?? ''
if (!/viewBox="/.test(root)) {
  throw new Error(`${SOURCE} kök <svg> öğesinde viewBox yok — ölçekleme yapılamaz`)
}
if (/\bwidth="/.test(root) || /\bheight="/.test(root)) {
  throw new Error(`${SOURCE} kök <svg> öğesinde sabit width/height var — CSS boyutu yönetmeli`)
}

const png = new Resvg(svg, { fitTo: { mode: 'width', value: WIDTH } }).render().asPng()

// PNG başlığından gerçek ölçüleri oku (yazmadan önce doğrula).
const w = png.readUInt32BE(16)
const h = png.readUInt32BE(20)
if (png.subarray(0, 8).compare(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) !== 0) {
  throw new Error('çıktı geçerli bir PNG değil')
}
if (Math.abs(w / h - EXPECTED_RATIO) > 0.05) {
  throw new Error(`oran kaydı: ${w}x${h} = ${(w / h).toFixed(3)}, beklenen ${EXPECTED_RATIO.toFixed(3)}`)
}

const LIMIT = 100_000
if (png.length > LIMIT) {
  throw new Error(`çıktı ${Math.round(png.length / 1024)} KB — ${Math.round(LIMIT / 1024)} KB sınırını aşıyor`)
}

writeFileSync(TARGET, png)
console.log(
  `${TARGET}: ${w}x${h}, ${(png.length / 1024).toFixed(1)} KB ` +
  `(kaynak ${(Buffer.byteLength(svg) / 1024).toFixed(0)} KB, ${(Buffer.byteLength(svg) / png.length).toFixed(0)}× küçük)`,
)
