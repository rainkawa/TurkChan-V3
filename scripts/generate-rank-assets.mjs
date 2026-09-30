/**
 * TurkChan rank banner üreticisi — gerçek animasyonlu GIF dosyaları.
 *
 * Her rütbe/yetki, klasik forum rank bannerı ailesinden bir yatay plakadır.
 * Katmanlar (biri diğerinin üstüne, hepsi düz renkli kipler):
 *
 *   1. BASE      dikey degrade + sağ ucu kırık "chevron" etiket formu
 *   2. TEXTURE   fırçalanmış metal (ince yatay çizgiler) + diyagonal dekor çizgiler
 *   3. INLAY     iç gölge, ikon levhası, sağ şerit, üçgen köşe süsleri
 *   4. ICON      metalik amblem: dış glow + dolgu + açık kontur + üst highlight
 *   5. TEXT      kabartma tipografi: alt gölge, üst highlight, asıl harfler
 *   6. FRAME     1px dış çerçeve + 1px iç highlight çerçeve (koyu/altın)
 *   7. SWEEP     soldan sağa geçen yumuşak ışık huzmesi (kareler halinde)
 *
 * Rütbeler güçlendikçe `tier` artar ve katmanlar zenginleşir: köşe perçinleri,
 * sağ şerit, çift çerçeve, enerji çizgileri. Hepsi aynı aileye aittir.
 *
 * Üretim iki aşamalıdır:
 *   1. @napi-rs/canvas ile her kare RGBA olarak çizilir (metin + ikon + doku).
 *   2. Kareler tek bir 64 renkli palete kuantize edilir ve omggif ile gerçek
 *      bir GIF olarak kodlanır (sonsuz döngü, saydam köşeler, 90 ms adım).
 *
 * SVG veya CSS animasyonu yoktur; çıktı tamamen GIF'tir ve normal <img> ile
 * çalışır. Düz renkli bantlar/çizgiler bilinçli olarak seçilir: yumuşak degrade
 * ve dithering GIF sıkıştırmasını 3-4 kat şişirir.
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
/** Kullanıcının istediği banner genişlik aralığı (mantıksal px). */
const MIN_WIDTH = 104
const MAX_WIDTH = 180
/** Sağ uçtaki kırık chevron payı. */
const CHEVRON = 7
const PAD = 3
const PLATE_W = 22 // ikon levhası genişliği
const TEXT_GAP = 4
const RIBBON = 7 // metnin sağındaki dekoratif şerit
const BASE_FONT = 13
const MIN_FONT = 11.5
const MAX_FONT = 18
const LETTER_SPACING = 1.5
const ICON_BOX = 17
const ICON_PAD = 2.5 // levha içindeki ikon kutusu
/** Üst rütbeler belirgin, alt rütbeler sakin döner. */
const FRAMES_ANIMATED = 10
const DELAY_ANIMATED = 10 // GIF kare süresi = saniyenin 1/100'ü → 100 ms
const FRAMES_CALM = 8
const DELAY_CALM = 12 // 120 ms
/** 64 renk: LZW için ideal; fazlası dosyayı büyütür, gözle fark edilmez. */
const PALETTE_SIZE = 64

/* ------------------------------------------------------------------ */
/* Renk yardımcıları                                                    */
/* ------------------------------------------------------------------ */

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]
const rgba = (hex, alpha) => `rgba(${hexToRgb(hex).join(',')},${alpha})`
const mix = (a, b, t) =>
  `#${hexToRgb(a)
    .map((v, i) => Math.round(v + (hexToRgb(b)[i] - v) * t).toString(16).padStart(2, '0'))
    .join('')}`
const shade = (hex, amount) => mix(hex, amount < 0 ? '#000000' : '#ffffff', Math.abs(amount))

/* ------------------------------------------------------------------ */
/* Rütbe tanımları                                                      */
/* ------------------------------------------------------------------ */

/**
 * tier  1 sade · 3 teknolojik · 4 parlak · 5 yönetim · 6 en güçlü
 * base/base2 gövde degrade · panel ikon levhası · frame dış çerçeve
 * frameIn iç highlight · accent vurgu · glow ışık · text yazı · icon ikon
 */
const RANKS = [
  {
    file: 'new-user',
    label: 'NEW USER',
    type: 'calm',
    tier: 1,
    icon: 'sprout',
    colors: {
      base: '#4A525E', base2: '#20252C', panel: '#2C323A', frame: '#7C8794', frameIn: '#B6C1CD',
      accent: '#9AA6B4', glow: '#C3CEDA', text: '#EAF0F7', icon: '#C9D5E2',
    },
    motion: { sweep: 0.34, pulse: 0.16 },
  },
  {
    file: 'active-user',
    label: 'ACTIVE USER',
    type: 'calm',
    tier: 2,
    icon: 'zap',
    colors: {
      base: '#12525F', base2: '#062029', panel: '#0A303A', frame: '#2E8C9E', frameIn: '#7FE3F2',
      accent: '#4FD6E8', glow: '#22D3EE', text: '#E2FAFF', icon: '#8CEBFA',
    },
    motion: { sweep: 0.36, pulse: 0.22 },
  },
  {
    file: 'super-user',
    label: 'SUPER USER',
    type: 'calm',
    tier: 3,
    icon: 'star',
    colors: {
      base: '#1E2F6E', base2: '#080E28', panel: '#101B45', frame: '#3A55B8', frameIn: '#7E96FF',
      accent: '#5B7BFF', glow: '#4C6BFF', text: '#DFE6FF', icon: '#9DB0FF',
    },
    motion: { sweep: 0.38, pulse: 0.26 },
  },
  {
    file: 'angel',
    label: 'ANGEL',
    type: 'animated',
    tier: 4,
    icon: 'feather',
    colors: {
      base: '#FFFBEA', base2: '#D9B44E', panel: '#F3E2AC', frame: '#C79A28', frameIn: '#FFFBE4',
      accent: '#FFD35C', glow: '#FFE9A0', text: '#4A3708', icon: '#A9750B',
    },
    motion: { sweep: 0.34, pulse: 0.3 },
  },
  {
    file: 'legend',
    label: 'LEGEND',
    type: 'animated',
    tier: 4,
    icon: 'trophy',
    colors: {
      base: '#3A2280', base2: '#0E0726', panel: '#1C1148', frame: '#6D4BC7', frameIn: '#B79CFF',
      accent: '#A78BFA', glow: '#8B5CF6', text: '#F1E9FF', icon: '#C9B6FF',
    },
    motion: { sweep: 0.38, pulse: 0.34 },
  },
  {
    file: 'god',
    label: 'GOD',
    type: 'animated',
    tier: 6,
    icon: 'gem',
    colors: {
      base: '#4A0F63', base2: '#150222', panel: '#2A0739', frame: '#B98A22', frameIn: '#F2C755',
      accent: '#E879F9', glow: '#E879F9', text: '#FFE7A8', icon: '#FFD873',
    },
    motion: { sweep: 0.4, pulse: 0.44 },
  },
  {
    file: 'moderator',
    label: 'MODERATOR',
    type: 'animated',
    tier: 5,
    icon: 'shield',
    colors: {
      base: '#0F4A2E', base2: '#03150C', panel: '#06251A', frame: '#2C8B5C', frameIn: '#7BE8B4',
      accent: '#34D399', glow: '#22C55E', text: '#DCFCEB', icon: '#7FE9B8',
    },
    motion: { sweep: 0.38, pulse: 0.32 },
  },
  {
    file: 'super-moderator',
    label: 'SUPER MODERATOR',
    type: 'animated',
    tier: 5,
    icon: 'shield-check',
    colors: {
      base: '#0A6B4E', base2: '#02231A', panel: '#053A2A', frame: '#22A67C', frameIn: '#8DF5D8',
      accent: '#5EEAD4', glow: '#2BF0C0', text: '#E6FFF7', icon: '#B4F7DF',
    },
    motion: { sweep: 0.4, pulse: 0.4 },
  },
  {
    file: 'co-admin',
    label: 'CO-ADMIN',
    type: 'animated',
    tier: 5,
    icon: 'user-cog',
    colors: {
      base: '#5C0C2C', base2: '#1B0310', panel: '#33061A', frame: '#A32047', frameIn: '#FF9DB4',
      accent: '#FB7185', glow: '#E11D48', text: '#FFE6EC', icon: '#FFAEBE',
    },
    motion: { sweep: 0.38, pulse: 0.34 },
  },
  {
    file: 'admin',
    label: 'ADMIN',
    type: 'animated',
    tier: 6,
    icon: 'crown',
    colors: {
      base: '#5E0B0B', base2: '#180202', panel: '#370505', frame: '#C9932B', frameIn: '#FFE08A',
      accent: '#FCD34D', glow: '#EF4444', text: '#FFF0C2', icon: '#FFD873',
    },
    motion: { sweep: 0.4, pulse: 0.46 },
  },
  {
    file: 'banned',
    label: 'BANNED',
    type: 'calm',
    tier: 2,
    icon: 'ban',
    colors: {
      base: '#22262C', base2: '#060709', panel: '#14171B', frame: '#4A515A', frameIn: '#8A939F',
      accent: '#9AA3AE', glow: '#DC2626', text: '#FCA5A5', icon: '#C0C6CE',
    },
    motion: { sweep: 0.3, pulse: 0.2 },
  },
]

/* ------------------------------------------------------------------ */
/* Font + ikonlar                                                       */
/* ------------------------------------------------------------------ */

let fontReady = false

function ensureFont() {
  if (fontReady) return
  if (!GlobalFonts.registerFromPath(FONT_PATH)) throw new Error(`Font yüklenemedi: ${FONT_PATH}`)
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

const TEXT_X = PAD + PLATE_W + TEXT_GAP
const TRAIL = PAD + RIBBON + 3

/** Her rozet için mantıksal genişlik + font boyutu (ada göre otomatik). */
function layout(ctx, label) {
  const base = measure(ctx, label, BASE_FONT)
  const chrome = TEXT_X + TRAIL
  const target = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, chrome + base))
  // Kısa adlar (GOD, ADMIN) bannerı doldursun diye punto büyür, uzunlar sığdırılır.
  const fontSize = Math.max(MIN_FONT, Math.min(MAX_FONT, BASE_FONT * ((target - chrome) / base)))
  const textWidth = measure(ctx, label, fontSize)
  const width = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.ceil(chrome + textWidth)))
  return { width, fontSize }
}

/* ------------------------------------------------------------------ */
/* Çizim — katmanlar                                                    */
/* ------------------------------------------------------------------ */

/** Etiket formu: sol kenar düz, sağ uç chevron. Tüm katmanlar buna göre kırpılır. */
function platePath(ctx, w) {
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(w - CHEVRON, 0)
  ctx.lineTo(w, LOGICAL_H / 2)
  ctx.lineTo(w - CHEVRON, LOGICAL_H)
  ctx.lineTo(0, LOGICAL_H)
  ctx.closePath()
}

/** 1. BASE — dikey degrade (düz bantlar) + üst ışık / alt gölge. */
function drawBase(ctx, w, c) {
  const bands = 7
  for (let i = 0; i < bands; i++) {
    ctx.fillStyle = mix(c.base, c.base2, i / (bands - 1))
    ctx.fillRect(0, (LOGICAL_H / bands) * i, w, LOGICAL_H / bands + 1)
  }
  // dikey ışık geçişi: sol üstte açık, sağ altta koyu (metal yüzey hissi)
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = rgba('#ffffff', 0.07 - i * 0.022)
    ctx.fillRect(0, 1 + i, w, 1)
  }
}

/** 2. TEXTURE — fırçalanmış metal yatay çizgiler + diyagonal dekor çizgiler. */
function drawTexture(ctx, w, c) {
  ctx.fillStyle = rgba('#000000', 0.09)
  for (let y = 2; y < LOGICAL_H; y += 3) ctx.fillRect(0, y, w, 1)
  ctx.fillStyle = rgba('#ffffff', 0.045)
  for (let y = 3; y < LOGICAL_H; y += 6) ctx.fillRect(0, y, w, 1)
  // dekoratif diyagonal çizgiler (sağ tarafa doğru yoğunlaşan hız çizgileri)
  ctx.strokeStyle = rgba(c.accent, 0.16)
  ctx.lineWidth = 1
  for (let i = 0; i < 7; i++) {
    const x = w - CHEVRON - 8 - i * 9
    ctx.beginPath()
    ctx.moveTo(x, LOGICAL_H)
    ctx.lineTo(x + LOGICAL_H, 0)
    ctx.stroke()
  }
}

/** 3. INLAY — iç gölge, ikon levhası, sağ şerit, köşe süsleri. */
function drawInlay(ctx, w, c, tier) {
  // iç gölge: üstte ve altta koyu şeritler
  ctx.fillStyle = rgba('#000000', 0.22)
  ctx.fillRect(0, 0, w, 2)
  ctx.fillRect(0, LOGICAL_H - 3, w, 3)

  // ikon levhası: kendi zemin + çerçevesi olan küçük panel
  ctx.fillStyle = c.panel
  ctx.fillRect(PAD, PAD + 1, PLATE_W, LOGICAL_H - (PAD + 1) * 2)
  ctx.fillStyle = rgba('#ffffff', 0.10)
  ctx.fillRect(PAD, PAD + 1, PLATE_W, 1)
  ctx.fillStyle = rgba('#000000', 0.35)
  ctx.fillRect(PAD, LOGICAL_H - PAD - 2, PLATE_W, 1)

  // sağ dekoratif şerit
  const ribbonX = w - CHEVRON - PAD - RIBBON
  ctx.fillStyle = rgba(c.accent, 0.22)
  ctx.fillRect(ribbonX, PAD + 2, RIBBON - 2, LOGICAL_H - (PAD + 2) * 2)
  ctx.fillStyle = rgba(c.frameIn, 0.55)
  ctx.fillRect(ribbonX, PAD + 2, 1, LOGICAL_H - (PAD + 2) * 2)
  ctx.fillRect(ribbonX + RIBBON - 3, PAD + 2, 1, LOGICAL_H - (PAD + 2) * 2)
  if (tier >= 4) {
    ctx.fillStyle = rgba(c.accent, 0.8)
    ctx.fillRect(ribbonX + 2, LOGICAL_H / 2 - 1, RIBBON - 6, 2)
  }

  // tier 3+: iki köşe perçini
  if (tier >= 3) {
    ctx.fillStyle = rgba(c.frameIn, 0.75)
    ctx.fillRect(1, 1, 2, 2)
    ctx.fillRect(1, LOGICAL_H - 3, 2, 2)
  }
  // tier 5+: levha yanında enerji çizgileri
  if (tier >= 5) {
    ctx.fillStyle = rgba(c.accent, 0.5)
    for (let i = 0; i < 2; i++) {
      ctx.fillRect(PAD + PLATE_W + 1 + i * 2, 6, 1, LOGICAL_H - 12)
    }
  }
}

/** 4. ICON — metalik amblem: glow + dolgu + kontur + üst highlight. */
function drawIcon(ctx, rank) {
  const box = PLATE_W - ICON_PAD * 2
  const ox = PAD + ICON_PAD
  const oy = (LOGICAL_H - box) / 2
  const paths = iconPaths(rank.icon)
  const c = rank.colors

  ctx.save()
  ctx.translate(ox, oy)
  ctx.scale(box / 24, box / 24)
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  // dış glow (sabit: her karede değişmesi kareleri gereksiz büyütüyordu)
  for (const [wMul, alpha] of [
    [3.6, 0.12],
    [2.8, 0.2],
  ]) {
    ctx.lineWidth = wMul
    ctx.strokeStyle = rgba(c.glow, alpha)
    for (const p of paths) ctx.stroke(p)
  }
  // gövde dolgusu + kontur
  ctx.fillStyle = shade(c.icon, -0.42)
  for (const p of paths) ctx.fill(p)
  ctx.lineWidth = 1.7
  ctx.strokeStyle = c.icon
  for (const p of paths) ctx.stroke(p)
  // üst highlight
  ctx.save()
  ctx.translate(0, -0.9)
  ctx.lineWidth = 0.9
  ctx.strokeStyle = rgba('#ffffff', 0.55)
  for (const p of paths) ctx.stroke(p)
  ctx.restore()
  ctx.restore()
}

/** 5. TEXT — kabartma tipografi: alt gölge, üst highlight, asıl harfler. */
function drawText(ctx, rank, fontSize) {
  const c = rank.colors
  const baseline = LOGICAL_H / 2 + fontSize * 0.35
  const draw = (fill, dy) => {
    ctx.font = `800 ${fontSize}px ${FONT_FAMILY}`
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = fill
    let x = TEXT_X
    for (const ch of rank.label) {
      ctx.fillText(ch, x, baseline + dy)
      x += ctx.measureText(ch).width + LETTER_SPACING
    }
  }
  draw(rgba('#000000', 0.55), 1) // gölge
  draw(rgba('#ffffff', 0.32), -1) // üst highlight
  draw(c.text, 0) // asıl metin
}

/** 6. FRAME — dış çerçeve + iç highlight çerçeve. */
function drawBorder(ctx, w, c, tier, glowAlpha) {
  platePath(ctx, w)
  ctx.lineWidth = 1.6
  ctx.strokeStyle = glowAlpha > 0.02 ? mix(c.frame, c.glow, glowAlpha * 0.5) : c.frame
  ctx.stroke()
  // iç highlight çerçeve
  ctx.save()
  ctx.translate(0, 0)
  platePath(ctx, w - 3)
  ctx.translate(1.5, 1.5)
  ctx.lineWidth = 1
  ctx.strokeStyle = rgba(c.frameIn, tier >= 4 ? 0.85 : 0.5)
  ctx.stroke()
  ctx.restore()
  // sol/sağ kenar parıltısı (tier 6: çift çerçeve)
  if (tier >= 6) {
    ctx.save()
    ctx.translate(2.5, 2.5)
    platePath(ctx, w - 5)
    ctx.lineWidth = 1
    ctx.strokeStyle = rgba(c.frameIn, 0.35)
    ctx.stroke()
    ctx.restore()
  }
}

/** 7. SWEEP — soldan sağa yumuşak ışık huzmesi + öndeki parlama çizgisi. */
function drawSweep(ctx, w, frameIndex, frameCount, strength) {
  const bandW = w * 0.4
  const travel = w + bandW
  const center = -bandW / 2 + (frameIndex / frameCount) * travel
  // 4 basamaklı yumuşak kenar: reklam gibi yanıp sönmesin diye düşük opaklık
  const steps = [
    [0.04, 0],
    [0.09, 12],
    [0.16, 24],
    [0.24, 36],
  ]
  for (const [alpha, inset] of steps) {
    ctx.globalAlpha = alpha * strength
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(center - bandW / 2 + inset, 0, bandW - inset * 2, LOGICAL_H)
  }
  // öndeki parlama çizgisi
  ctx.globalAlpha = 0.28 * strength
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(center + bandW / 2 - 1.5, 1, 1.5, LOGICAL_H - 2)
  ctx.globalAlpha = 1
}

/** Tek bir kareyi tüm katmanlarla çizer (mantıksal px, bağlam 2x ölçekli). */
function drawFrame(rank, size, frameIndex, frameCount) {
  const { width, fontSize } = size
  const canvas = createCanvas(width * SCALE, LOGICAL_H * SCALE)
  const ctx = canvas.getContext('2d')
  ctx.scale(SCALE, SCALE)
  const c = rank.colors
  const m = rank.motion
  const phase = (frameIndex / frameCount) * Math.PI * 2
  // ışık ikon levhasından geçerken kenar parlaması tepe yapar
  const sweepT = (frameIndex / frameCount) * (width + width * 0.4) - width * 0.2
  const near = Math.max(0, 1 - Math.abs(sweepT - (PAD + PLATE_W / 2)) / (width * 0.3))
  const glowAlpha = Math.min(1, m.pulse * (0.5 + 0.5 * Math.sin(phase)) + near * 0.45)

  ctx.clearRect(0, 0, width, LOGICAL_H)
  ctx.save()
  platePath(ctx, width)
  ctx.clip()

  drawBase(ctx, width, c)
  drawTexture(ctx, width, c)
  drawInlay(ctx, width, c, rank.tier)
  drawIcon(ctx, rank)
  drawText(ctx, rank, fontSize)
  drawSweep(ctx, width, frameIndex, frameCount, 1)
  ctx.restore()

  drawBorder(ctx, width, c, rank.tier, glowAlpha)

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
 * kayması (palet titremesi) olmaz. 0. indeks saydam dış köşeler için ayrılır.
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
  const size = layout(createCanvas(10, 10).getContext('2d'), rank.label)
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
        `  ${String(frames).padStart(2)} kare · ${(gif.length / 1024).toFixed(1).padStart(5)} KB` +
        `  ${rank.icon} · tier ${rank.tier} · ${rank.type}`,
    )
  }
  console.log(`\n${RANKS.length} rank bannerı üretildi → ${OUT_DIR} (toplam ${(total / 1024).toFixed(0)} KB)`)
  if (total > 900 * 1024) console.warn('Uyarı: toplam GIF boyutu beklenenden büyük.')
}

// Doğrudan çalıştırıldığında üret; içe aktarıldığında yalnızca fonksiyonlar.
if (process.argv[1] && process.argv[1].endsWith('generate-rank-assets.mjs')) generateAll()
