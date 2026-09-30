/**
 * Android varlık üreticisi — TurkChan.
 *
 * Launcher ikonlarını, adaptive icon katmanlarını ve splash ekran görselini
 * TurkChan markasından üretir. Çıktılar `android/app/src/main/res/` altına
 * yazılır; APK boyutunu düşük tutmak için her katman ayrı PNG'dir (WebView
 * tabanlı kabukta SVG desteği yok).
 *
 * Kullanım: npm run android:assets
 */
import { createCanvas } from '@napi-rs/canvas'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RES = join(ROOT, 'android', 'app', 'src', 'main', 'res')
const STORE = join(ROOT, 'android', 'store')

const BLACK = '#000000'
const RED = '#ff1233'
const WHITE = '#ffffff'
const MASTER = 1024

/**
 * Markayı 1024x1024 referans tuvale çizer.
 *
 * Uyarlanabilir ikon güvenli alanı (merkezdeki 66/108) dar olduğu için
 * çağıranlar `pad` ile işareti küçültebilir.
 *
 * @param {number} size Tuvale kenarı
 * @param {{ pad?: number, transparent?: boolean }} options
 */
function drawMark(size, { pad = 0, transparent = false } = {}) {
  const canvas = createCanvas(size, size)
  const ctx = canvas.getContext('2d')
  const k = (size / MASTER) * (1 - pad)

  if (!transparent) {
    ctx.fillStyle = BLACK
    ctx.fillRect(0, 0, size, size)
  }
  ctx.save()
  ctx.translate((size - MASTER * k) / 2, (size - MASTER * k) / 2)
  ctx.scale(k, k)

  const cx = 512
  const cy = 512

  // Halka: sol-üst beyazdan sağ-alt kırmızıya konik geçiş. Kalınlıklı halka
  // dış daire + iç daire (clockWise=false) ile tek yolda çizilir.
  const gradient = ctx.createLinearGradient(70, 70, 954, 954)
  gradient.addColorStop(0, WHITE)
  gradient.addColorStop(0.45, '#ff4a6b')
  gradient.addColorStop(1, RED)
  ctx.fillStyle = gradient
  ctx.beginPath()
  ctx.arc(cx, cy, 452, 0, Math.PI * 2)
  ctx.arc(cx, cy, 424, 0, Math.PI * 2, true)
  ctx.fill()

  // "T" — beyaz, keskin köşeli.
  ctx.fillStyle = WHITE
  ctx.beginPath()
  ctx.moveTo(250, 296)
  ctx.lineTo(500, 296)
  ctx.lineTo(500, 372)
  ctx.lineTo(394, 372)
  ctx.lineTo(394, 724)
  ctx.lineTo(250, 724)
  ctx.closePath()
  ctx.fill()
  // Sol üstteki eğik kenar (markanın keskin T köşesi)
  ctx.beginPath()
  ctx.moveTo(250, 296)
  ctx.lineTo(352, 258)
  ctx.lineTo(250, 352)
  ctx.closePath()
  ctx.fill()

  // "C" — kırmızı, kalın, sağa açık yay.
  ctx.strokeStyle = RED
  ctx.lineWidth = 94
  ctx.lineCap = 'butt'
  ctx.beginPath()
  ctx.arc(600, 512, 150, -Math.PI * 0.40, Math.PI * 0.40)
  ctx.stroke()

  ctx.restore()
  return canvas.toBuffer('image/png')
}

function ensure(dir) {
  mkdirSync(dir, { recursive: true })
}

let written = 0
function write(relDir, name, buffer) {
  const target = join(RES, relDir, name)
  ensure(dirname(target))
  writeFileSync(target, buffer)
  written += 1
}

const LAUNCHER = [
  ['mipmap-mdpi', 48],
  ['mipmap-hdpi', 72],
  ['mipmap-xhdpi', 96],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xxxhdpi', 192],
]

const ADAPTIVE = [
  ['mipmap-mdpi', 108],
  ['mipmap-hdpi', 162],
  ['mipmap-xhdpi', 216],
  ['mipmap-xxhdpi', 324],
  ['mipmap-xxxhdpi', 432],
]

const SPLASH = [
  ['drawable-mdpi', 192],
  ['drawable-hdpi', 288],
  ['drawable-xhdpi', 432],
  ['drawable-xxhdpi', 576],
  ['drawable-xxxhdpi', 768],
]

// Klasik (adaptive olmayan) launcher ikonu — Android 7 ve üzeri eski cihazlar.
for (const [dir, size] of LAUNCHER) {
  write(dir, 'ic_launcher.png', drawMark(size))
  write(dir, 'ic_launcher_round.png', drawMark(size, { pad: 0.04 }))
}

// Uyarlanabilir ikon katmanları: arka plan düz siyah, önek güvenli alanda.
for (const [dir, size] of ADAPTIVE) {
  const bg = createCanvas(size, size)
  bg.getContext('2d').fillStyle = BLACK
  bg.getContext('2d').fillRect(0, 0, size, size)
  write(dir, 'ic_launcher_background.png', bg.toBuffer('image/png'))
  write(dir, 'ic_launcher_foreground.png', drawMark(size, { pad: 0.22, transparent: true }))
}

// Splash logosu: şeffaf, arka plan rengi tema tarafından verilir.
for (const [dir, size] of SPLASH) {
  write(dir, 'splash_logo.png', drawMark(size, { pad: 0.06, transparent: true }))
}

// Mağaza vitrini (adaptive icon önizlemesi için 512 px kare).
ensure(STORE)
writeFileSync(join(STORE, 'icon-512.png'), drawMark(512))

console.log(`✓ ${written} Android varlığı üretildi → android/app/src/main/res/`)