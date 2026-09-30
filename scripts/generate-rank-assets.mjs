/**
 * TurkChan rank banner üreticisi — gerçek animasyonlu GIF dosyaları.
 *
 * Her rütbe/yetki için klasik forum rank bannerı çizilir: yatay yuvarlatılmış
 * dikdörtgen, metalik degrade + çapraz doku + bevel + kenar parlaması, solda
 * Lucide ikonu, sağda büyük harfli rank adı. Üzerinde soldan sağa geçen ışık
 * huzmesi ve nabız gibi bir kenar parlaması sürekli döngüde çalışır.
 *
 * Üretim iki aşamalıdır:
 *   1. @napi-rs/canvas ile her kare RGBA olarak çizilir (metin + ikon + doku).
 *   2. Kareler tek bir 64 renkli palete kuantize edilir ve omggif ile gerçek
 *      bir GIF olarak kodlanır ( sonsuz döngü, saydam köşeler, 100 ms adım).
 *
 * SVG veya CSS animasyonu yoktur; çıktı tamamen GIF'tir ve normal <img> ile
 * çalışır. Renk sayısı ve düz bantlar bilinçli olarak düşük tutulur: GIF'in
 * LZW sıkıştırması yumuşak degrade ve dithering'den çok iyi etkilenmez.
 *
 * Kullanım:  npm run rank:assets
 * Çıktı:     public/assets/ranks/*.gif  (11 dosya, depoda saklanır)
 */
import canvasPkg from '@napi-rs/canvas'
import { GifWriter } from 'omggif'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const { createCanvas, GlobalFonts, Path2D } = canvasPkg

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'assets', 'ranks')
const FONT_PATH = join(ROOT, 'assets', 'fonts', 'Inter_800ExtraBold.ttf')
const FONT_FAMILY = 'Inter'
const ICON_DIR = join(ROOT, 'node_modules', 'lucide-static', 'icons')

/* ------------------------------------------------------------------ */
/* Üretim sabitleri                                                     */
/* ------------------------------------------------------------------ */

/** Tasarım 30 mantıksal px yüksekliğinde çizilir, 2x rasterlanır (retina netliği). */
const LOGICAL_H = 30
const SCALE = 2
const CORNER = 7
/** İlk üç karma rütbesi ve banned yavaş/sakin, yönetim ve üst rütbeler belirgin döner. */
const FRAMES_ANIMATED = 10
const DELAY_ANIMATED = 9 // GIF kare süresi saniyenin 1/100'ü biriminde → 90 ms
const FRAMES_CALM = 6
const DELAY_CALM = 13 // 130 ms
/** 64 renk: LZW için ideal; fazlası dosyayı büyütür, gözle fark edilmez. */
const PALETTE_SIZE = 64
/** Kullanıcının istediği banner genişlik aralığı (mantıksal px). */
const MIN_WIDTH = 112
const MAX_WIDTH = 178
const BASE_FONT = 13
const MIN_FONT = 12
const MAX_FONT = 19
const LETTER_SPACING = 1.4
const ICON_SIZE = 17
const ICON_X = 8
const ICON_GAP = 7
const PAD_X = 9

/* ------------------------------------------------------------------ */
/* Renk yardımcıları                                                    */
/* ------------------------------------------------------------------ */

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]
const rgba = (hex, alpha) => `rgba(${hexToRgb(hex).join(',')},${alpha})`
const mix = (a, b, t) => `#${hexToRgb(a)
  .map((v, i) => Math.round(v + (hexToRgb(b)[i] - v) * t).toString(16).padStart(2, '0'))
  .join('')}`

/* ------------------------------------------------------------------ */
/* Rütbe tanımları                                                      */
/* ------------------------------------------------------------------ */

/**
 * type: 'animated' → belirgin ışık huzmesi + nabız; 'calm' → sakin hareket.
 * colors: bg/bg2 dikey degrade, accent kenar, glow kenar parlaması,
 *         text yazı, icon ikon, shadow yazı gölgesi.
 * motion: sweep huzme genişliği (mantıksal px), pulse nabız gücü, flare ek parıltı.
 */
const RANKS = [
  {
    file: 'new-user',
    label: 'NEW USER',
    type: 'calm',
    icon: 'sprout',
    colors: {
      bg: '#A7B0BD', bg2: '#5C6472', accent: '#D7DEE7', glow: '#E8EEF5',
      text: '#F7F9FC', icon: '#E8EEF5', shadow: '#2B313B',
    },
    motion: { sweep: 46, pulse: 0.18 },
  },
  {
    file: 'active-user',
    label: 'ACTIVE USER',
    type: 'calm',
    icon: 'zap',
    colors: {
      bg: '#8FB6C4', bg2: '#2F6474', accent: '#BFEFF6', glow: '#5FE3F0',
      text: '#F2FEFF', icon: '#9FF0FA', shadow: '#123845',
    },
    motion: { sweep: 50, pulse: 0.24 },
  },
  {
    file: 'super-user',
    label: 'SUPER USER',
    type: 'calm',
    icon: 'star',
    colors: {
      bg: '#3A4CA8', bg2: '#141B4E', accent: '#8FA6FF', glow: '#4C6BFF',
      text: '#E9EDFF', icon: '#A8B8FF', shadow: '#0A0E2B',
    },
    motion: { sweep: 52, pulse: 0.26 },
  },
  {
    file: 'angel',
    label: 'ANGEL',
    type: 'animated',
    icon: 'feather',
    colors: {
      bg: '#FFF8E4', bg2: '#DDA83F', accent: '#FFF0BE', glow: '#FFD35C',
      text: '#6B4708', icon: '#B07C10', shadow: '#FFF6D8',
    },
    motion: { sweep: 44, pulse: 0.3, flare: true },
  },
  {
    file: 'legend',
    label: 'LEGEND',
    type: 'animated',
    icon: 'trophy',
    colors: {
      bg: '#6B3BC0', bg2: '#1E1148', accent: '#C4B0FF', glow: '#8B5CF6',
      text: '#F0EAFF', icon: '#D9C9FF', shadow: '#150A33',
    },
    motion: { sweep: 46, pulse: 0.34, flare: true },
  },
  {
    file: 'god',
    label: 'GOD',
    type: 'animated',
    icon: 'gem',
    colors: {
      bg: '#8A1E9E', bg2: '#2A0A3F', accent: '#F2C755', glow: '#E879F9',
      text: '#FFE7A8', icon: '#FFD873', shadow: '#1B0526',
    },
    motion: { sweep: 42, pulse: 0.45, flare: true },
  },
  {
    file: 'moderator',
    label: 'MODERATOR',
    type: 'animated',
    icon: 'shield',
    colors: {
      bg: '#256A45', bg2: '#0A2717', accent: '#5FD79A', glow: '#34D399',
      text: '#E3FFF0', icon: '#8CE7B6', shadow: '#05170E',
    },
    motion: { sweep: 46, pulse: 0.3, flare: true },
  },
  {
    file: 'super-moderator',
    label: 'SUPER MODERATOR',
    type: 'animated',
    icon: 'shield-check',
    colors: {
      bg: '#12C99A', bg2: '#04543A', accent: '#A9F5D8', glow: '#2BF0C0',
      text: '#EDFFF8', icon: '#C6FBE8', shadow: '#023026',
    },
    motion: { sweep: 48, pulse: 0.4, flare: true },
  },
  {
    file: 'co-admin',
    label: 'CO-ADMIN',
    type: 'animated',
    icon: 'user-cog',
    colors: {
      bg: '#9E1739', bg2: '#33040F', accent: '#FF9BAE', glow: '#F43F5E',
      text: '#FFE8EC', icon: '#FFB7C6', shadow: '#1B0209',
    },
    motion: { sweep: 46, pulse: 0.34, flare: true },
  },
  {
    file: 'admin',
    label: 'ADMIN',
    type: 'animated',
    icon: 'crown',
    colors: {
      bg: '#C02020', bg2: '#3D0505', accent: '#FCD34D', glow: '#F59E0B',
      text: '#FFF3C9', icon: '#FFDD8A', shadow: '#1B0202',
    },
    motion: { sweep: 44, pulse: 0.46, flare: true },
  },
  {
    file: 'banned',
    label: 'BANNED',
    type: 'calm',
    icon: 'ban',
    colors: {
      bg: '#454B54', bg2: '#101317', accent: '#8A939F', glow: '#EF4444',
      text: '#F3F5F7', icon: '#B9C2CC', shadow: '#05070A',
    },
    motion: { sweep: 40, pulse: 0.22 },
  },
]

/* ------------------------------------------------------------------ */
/* Font + ikonlar                                                       */
/* ------------------------------------------------------------------ */

let fontReady = false

function ensureFont() {
  if (fontReady) return
  if (!GlobalFonts.registerFromPath(FONT_PATH)) {
    throw new Error(`Font yüklenemedi: ${FONT_PATH}`)
  }
  fontReady = true
}

const iconCache = new Map()

/** Lucide ikonunu Path2D listesine çevirir (24x24 çizgi ikonları). */
function iconPaths(name) {
  const cached = iconCache.get(name)
  if (cached) return cached
  const svg = readFileSync(join(ICON_DIR, `${name}.svg`), 'utf8')
  const body = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
  const paths = [...body.matchAll(/\sd="([^"]+)"/g)].map((m) => new Path2D(m[1]))
  iconCache.set(name, paths)
  return paths
}

/* ------------------------------------------------------------------ */
/* Yerleşim                                                             */
/* ------------------------------------------------------------------ */

/** Harf harf ölçüm: font metriklerine birebir güvenir, kaba tahmin yapmaz. */
function measure(ctx, label, fontSize) {
  ctx.font = `800 ${fontSize}px ${FONT_FAMILY}`
  let width = 0
  for (const ch of label) width += ctx.measureText(ch).width
  return width + LETTER_SPACING * (label.length - 1)
}

/** Her rozet için mantıksal genişlik + font boyutu. */
function layout(ctx, label) {
  const base = measure(ctx, label, BASE_FONT)
  const target = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, ICON_X + ICON_SIZE + ICON_GAP + base + PAD_X))
  // Kısa adlar (GOD, ADMIN) bannerı doldursun diye punto büyür, uzunlar sığdırılır.
  const fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, BASE_FONT * ((target - (ICON_X + ICON_SIZE + ICON_GAP + PAD_X)) / base)))
  const textWidth = measure(ctx, label, fontSize)
  const contentWidth = ICON_X + ICON_SIZE + ICON_GAP + textWidth + PAD_X
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.ceil(Math.max(target, contentWidth))))
  return { width, fontSize }
}

/* ------------------------------------------------------------------ */
/* Çizim                                                                */
/* ------------------------------------------------------------------ */

/**
 * Tek bir kareyi çizer. Tüm çizim mantıksal px ile yapılır (bağlam 2x ölçekli).
 * Düz renk bantları ve 3 kademeli ışık huzmesi bilinçli olarak seçilir: yumuşak
 * geçişler GIF sıkıştırmasını 3-4 kat şişirir.
 */
function drawFrame(rank, size, frameIndex, frameCount) {
  const { width, fontSize } = size
  const canvas = createCanvas(width * SCALE, LOGICAL_H * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  const phase = (frameIndex / frameCount) * Math.PI * 2
  const c = rank.colors
  const m = rank.motion

  ctx.clearRect(0, 0, width, LOGICAL_H)

  // --- gövde: dikey degrade (düz bantlar) + çapraz doku ---
  ctx.save()
  ctx.beginPath()
  ctx.roundRect(0, 0, width, LOGICAL_H, CORNER)
  ctx.clip()
  const bands = 6
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = mix(c.bg, c.bg2, i / (bands - 1))
    ctx.fillRect(0, (LOGICAL_H / bands) * i, width, LOGICAL_H / bands + 1)
  }
  // çapraz doku (metalik his) — tek set, düz renk: GIF sıkıştırmasını bozmaz
  ctx.strokeStyle = 'rgba(0,0,0,0.10)'
  ctx.lineWidth = 1
  for (let x = -LOGICAL_H; x < width + LOGICAL_H; x += 10) {
    ctx.beginPath()
    ctx.moveTo(x, LOGICAL_H)
    ctx.lineTo(x + LOGICAL_H, 0)
    ctx.stroke()
  }
  // üst ışık / alt gölge
  ctx.fillStyle = 'rgba(255,255,255,0.26)'
  ctx.fillRect(0, 0, width, LOGICAL_H * 0.16)
  ctx.fillStyle = 'rgba(255,255,255,0.12)'
  ctx.fillRect(0, LOGICAL_H * 0.16, width, LOGICAL_H * 0.1)
  ctx.fillStyle = 'rgba(0,0,0,0.20)'
  ctx.fillRect(0, LOGICAL_H * 0.78, width, LOGICAL_H * 0.22)
  ctx.fillStyle = 'rgba(0,0,0,0.12)'
  ctx.fillRect(0, LOGICAL_H * 0.68, width, LOGICAL_H * 0.1)

  // --- ışık huzmesi: soldan sağa, 3 kademe ---
  const band = m.sweep
  const travel = width + band
  const center = -band / 2 + (frameIndex / frameCount) * travel
  const steps = [
    [0.34, 0],
    [0.2, 6],
    [0.1, 12],
  ]
  ctx.fillStyle = '#ffffff'
  for (const [alpha, inset] of steps) {
    ctx.globalAlpha = alpha
    ctx.fillRect(center - band / 2 + inset, -2, band - inset * 2, LOGICAL_H + 4)
  }
  ctx.globalAlpha = 1

  // --- kenar parlaması (nabız) ---
  const pulse = m.pulse * (0.5 + 0.5 * Math.sin(phase))
  ctx.strokeStyle = rgba(c.glow, 0.3 + pulse * 0.7)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.roundRect(1.1, 1.1, width - 2.2, LOGICAL_H - 2.2, CORNER - 1)
  ctx.stroke()

  // --- güçlü rütbelerde enerji çizgileri (sert kenarlı, küçük alan) ---
  if (m.flare) {
    const lift = 0.5 + 0.5 * Math.sin(phase + 1)
    ctx.fillStyle = rgba(c.glow, 0.22 + 0.3 * lift)
    for (const [x0, dir] of [
      [ICON_X - 3, 1],
      [width - ICON_X + 1, -1],
    ]) {
      ctx.beginPath()
      ctx.moveTo(x0, LOGICAL_H * 0.2)
      ctx.lineTo(x0 + dir * 3, LOGICAL_H * 0.2)
      ctx.lineTo(x0 + dir * 3 - 1, LOGICAL_H * 0.8 - 2 * lift)
      ctx.lineTo(x0, LOGICAL_H * 0.8)
      ctx.closePath()
      ctx.fill()
    }
  }
  ctx.restore()

  // --- dış kenar + iç highlight ---
  ctx.strokeStyle = c.accent
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.roundRect(0.7, 0.7, width - 1.4, LOGICAL_H - 1.4, CORNER)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(255,255,255,0.28)'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(CORNER, 1.8)
  ctx.lineTo(width - CORNER, 1.8)
  ctx.stroke()

  // --- ikon ---
  const iconTop = (LOGICAL_H - ICON_SIZE) / 2
  ctx.save()
  ctx.translate(ICON_X, iconTop)
  ctx.scale(ICON_SIZE / 24, ICON_SIZE / 24)
  ctx.strokeStyle = c.icon
  ctx.lineWidth = 2.1
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const path of iconPaths(rank.icon)) ctx.stroke(path)
  ctx.restore()

  // --- ikon ile yazı arası ayırıcı ---
  const dividerX = ICON_X + ICON_SIZE + ICON_GAP / 2
  ctx.strokeStyle = rgba(c.accent, 0.55)
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(dividerX, LOGICAL_H * 0.28)
  ctx.lineTo(dividerX, LOGICAL_H * 0.72)
  ctx.stroke()

  // --- yazı: gölge + asıl metin ---
  const textX = ICON_X + ICON_SIZE + ICON_GAP
  const baseline = LOGICAL_H / 2 + fontSize * 0.35
  const drawText = (fill, dx, dy) => {
    ctx.font = `800 ${fontSize}px ${FONT_FAMILY}`
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = fill
    let x = textX + dx
    for (const ch of rank.label) {
      ctx.fillText(ch, x, baseline + dy)
      x += ctx.measureText(ch).width + LETTER_SPACING
    }
  }
  drawText(c.shadow, 0.8, 0.8)
  drawText(c.text, 0, 0)

  return Uint8Array.from(ctx.getImageData(0, 0, width * SCALE, LOGICAL_H * SCALE).data)
}

/* ------------------------------------------------------------------ */
/* Kuantizasyon                                                         */
/* ------------------------------------------------------------------ */

/** Median-cut ile verilen renkleri en fazla `max` tane kutuya indirger. */
function medianCut(pixels, max) {
  let boxes = [pixels]
  while (boxes.length < max) {
    let target = 0
    let largest = -1
    for (let i = 0; i < boxes.length; i++) {
      if (boxes[i].length > largest) {
        largest = boxes[i].length
        target = i
      }
    }
    if (largest < 2) break
    const box = boxes[target]
    let channel = 0
    let range = -1
    for (let ch = 0; ch < 3; ch++) {
      let min = 255
      let maxValue = 0
      for (const p of box) {
        if (p[ch] < min) min = p[ch]
        if (p[ch] > maxValue) maxValue = p[ch]
      }
      if (maxValue - min > range) {
        range = maxValue - min
        channel = ch
      }
    }
    if (range <= 0) break
    box.sort((a, b) => a[channel] - b[channel])
    const mid = box.length >> 1
    boxes.splice(target, 1, box.slice(0, mid), box.slice(mid))
  }
  return boxes.map((box) => {
    let r = 0
    let g = 0
    let b = 0
    for (const p of box) {
      r += p[0]
      g += p[1]
      b += p[2]
    }
    const n = box.length || 1
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
  })
}

/**
 * Tüm kareler tek bir palete kuantize edilir; böylece kareler arasında renk
 * kayması (palet titremesi) olmaz. 0. indeks saydam köşeler için ayrılır.
 */
function quantize(frames, width, height) {
  const seen = new Set()
  for (const frame of frames) {
    for (let i = 0; i < frame.length; i += 4) {
      if (frame[i + 3] < 128) continue
      seen.add((frame[i] << 16) | (frame[i + 1] << 8) | frame[i + 2])
    }
  }
  const unique = [...seen].map((k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255])
  // omggif paleti 0xRRGGBB tam sayıları ister; 0. indeks saydam köşeler için.
  const palette = [0, ...medianCut(unique, PALETTE_SIZE - 1).map(([r, g, b]) => (r << 16) | (g << 8) | b)]
  while (palette.length < 256) palette.push(0)

  const cache = new Int16Array(32768).fill(-1)
  const indexed = frames.map((frame) => {
    const out = new Uint8Array(width * height)
    for (let i = 0, p = 0; i < frame.length; i += 4, p++) {
      if (frame[i + 3] < 128) {
        out[p] = 0
        continue
      }
      const key = ((frame[i] >> 3) << 10) | ((frame[i + 1] >> 3) << 5) | (frame[i + 2] >> 3)
      let index = cache[key]
      if (index < 0) {
        let best = Infinity
        index = 1
        for (let k = 1; k < palette.length; k++) {
          const d =
            (frame[i] - ((palette[k] >> 16) & 255)) ** 2 +
            (frame[i + 1] - ((palette[k] >> 8) & 255)) ** 2 +
            (frame[i + 2] - (palette[k] & 255)) ** 2
          if (d < best) {
            best = d
            index = k
            if (d === 0) break
          }
        }
        cache[key] = index
      }
      out[p] = index
    }
    return out
  })
  return { palette, indexed }
}

/* ------------------------------------------------------------------ */
/* GIF kodlama                                                          */
/* ------------------------------------------------------------------ */

/**
 * Kareleri sonsuz döngüde, saydam köşeli gerçek bir GIF'e çevirir.
 * `delay` GIF'in kare süresi birimidir (saniyenin 1/100'ü).
 */
export function encodeGif({ width, height, palette, indexed, delay }) {
  const capacity = indexed.length * width * height + 4096
  const buf = new Uint8Array(capacity)
  const writer = new GifWriter(buf, width, height, { loop: 0, palette, transparent: 0 })
  for (const frame of indexed) {
    writer.addFrame(0, 0, width, height, frame, { delay, disposal: 2, transparent: 0, first: 0 })
  }
  return Buffer.from(buf.slice(0, writer.end()))
}

/* ------------------------------------------------------------------ */
/* Üretim                                                               */
/* ------------------------------------------------------------------ */

export const rankAssets = RANKS

export function renderRank(rank) {
  ensureFont()
  const measureCanvas = createCanvas(10, 10)
  const size = layout(measureCanvas.getContext('2d'), rank.label)
  const frames = rank.type === 'animated' ? FRAMES_ANIMATED : FRAMES_CALM
  const rgbaFrames = []
  for (let f = 0; f < frames; f++) rgbaFrames.push(drawFrame(rank, size, f, frames))
  const { palette, indexed } = quantize(rgbaFrames, size.width * SCALE, LOGICAL_H * SCALE)
  const delay = rank.type === 'animated' ? DELAY_ANIMATED : DELAY_CALM
  return {
    gif: encodeGif({ width: size.width * SCALE, height: LOGICAL_H * SCALE, palette, indexed, delay }),
    width: size.width * SCALE,
    height: LOGICAL_H * SCALE,
    frames,
  }
}

export function generateAll() {
  ensureFont()
  // Eski üretimden kalan PNG/GIF/SVG dosyaları temizle: klasörde sadece 11 GIF kalsın.
  mkdirSync(OUT_DIR, { recursive: true })
  for (const file of readdirSync(OUT_DIR)) {
    if (/\.(png|gif|svg|webp|jpg)$/i.test(file)) rmSync(join(OUT_DIR, file))
  }

  let total = 0
  for (const rank of RANKS) {
    const { gif, width, height, frames } = renderRank(rank)
    writeFileSync(join(OUT_DIR, `${rank.file}.gif`), gif)
    total += gif.length
    console.log(
      `${rank.file}.gif`.padEnd(22) +
        `${width}x${height}`.padStart(9) +
        `  ${frames} kare · ${(gif.length / 1024).toFixed(1).padStart(5)} KB` +
        `  ${rank.icon} · ${rank.type}`,
    )
  }
  console.log(`\n${RANKS.length} rank bannerı üretildi → ${OUT_DIR} (toplam ${(total / 1024).toFixed(0)} KB)`)
  if (total > 700 * 1024) console.warn('Uyarı: toplam GIF boyutu beklenenden büyük.')
}

// Doğrudan çalıştırıldığında üret; içe aktarıldığında yalnızca fonksiyonlar.
if (process.argv[1] && process.argv[1].endsWith('generate-rank-assets.mjs')) generateAll()
