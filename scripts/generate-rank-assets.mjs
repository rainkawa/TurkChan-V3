/**
 * TurkChan rütbe görselleri üreticisi.
 *
 * Statik PNG'ler (new/active/super user, banned) ve animasyonlu GIF'ler
 * (angel, legend, god, moderator, super-moderator, co-admin, admin) üretilir.
 * PNG sıkıştırması node:zlib ile, GIF kodlaması ise tarayıcı uyumluğu için
 * omggif ile yapılır (devDependency).
 *
 * Kullanım:  node scripts/generate-rank-assets.mjs
 * Çıktı:     public/assets/ranks/*.png | *.gif  (depoda saklanır)
 *
 * Görseller 64x64 üretilir; arayüzde 18–30px arası gösterildiği için yüksek
 * DPI ekranlarda net kalır. GIF'ler sonsuz döngüde ve saydam kenarlıdır.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GifWriter } from 'omggif'

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets', 'ranks')
const SIZE = 64
const FRAMES = 8
const DELAY_MS = 80 // kare başına ~0.64 sn'lik döngü

/* ------------------------------------------------------------------ */
/* PNG yazıcı (yalnızca node:zlib)                                       */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * Palet indeksli tuvalden RGBA PNG üretir.
 * İndeks 0 saydamdır; diğerleri `palette` renkleridir.
 */
export function encodePng(palette, indices) {
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  let o = 0
  for (let y = 0; y < SIZE; y += 1) {
    raw[o] = 0 // filtre: none
    o += 1
    for (let x = 0; x < SIZE; x += 1) {
      const idx = indices[y * SIZE + x]
      const c = idx === 0 ? [0, 0, 0, 0] : [...palette[idx - 1], 255]
      raw[o] = c[0]
      raw[o + 1] = c[1]
      raw[o + 2] = c[2]
      raw[o + 3] = c[3]
      o += 4
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** Karelerden sonsuz döngülü GIF üretir (omggif). */
/**
 * Karelerden sonsuz döngülü GIF üretir.
 * `palette` omggif'in beklediği biçimde 0xRRGGBB tamsayı dizisidir ve
 * uzunluğu 2'nin kuvveti olmalıdır; 0. indeks saydam renk içindir.
 */
export function encodeGif(palette, frames) {
  // omggif önceden ayrılmış bir arabelleğe yazar; üst sınır güvenli olsun.
  const capacity = 8 * 1024 + frames.length * SIZE * SIZE * 2
  const buf = new Uint8Array(capacity)
  const writer = new GifWriter(buf, SIZE, SIZE, { loop: 0 })
  for (const frame of frames) {
    writer.addFrame(0, 0, SIZE, SIZE, frame, {
      palette,
      delay: DELAY_MS,
      disposal: 2, // her kare arka plana döner: kareler üst üste binmez
      transparent: 0, // saydam palet indeksi (omggif'te alan adı bu)
    })
  }
  const length = writer.end()
  return Buffer.from(buf.slice(0, length))
}

/* ------------------------------------------------------------------ */
/* Çizim yardımcıları (palet indeksi üzerinde çalışır)                  */
/* ------------------------------------------------------------------ */

function canvas() {
  return new Uint8Array(SIZE * SIZE)
}

function plot(buf, x, y, idx) {
  const px = Math.round(x)
  const py = Math.round(y)
  if (px < 0 || py < 0 || px >= SIZE || py >= SIZE) return
  buf[py * SIZE + px] = idx
}

function disc(buf, cx, cy, r, idx) {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 1) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 1) {
      const dx = x - cx
      const dy = y - cy
      if (dx * dx + dy * dy <= r * r) plot(buf, x, y, idx)
    }
  }
}

function ring(buf, cx, cy, rOuter, rInner, idx) {
  for (let y = Math.floor(cy - rOuter); y <= Math.ceil(cy + rOuter); y += 1) {
    for (let x = Math.floor(cx - rOuter); x <= Math.ceil(cx + rOuter); x += 1) {
      const dx = x - cx
      const dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d <= rOuter && d >= rInner) plot(buf, x, y, idx)
    }
  }
}

function star(buf, cx, cy, rOuter, rInner, points, rotation, idx) {
  for (let y = Math.floor(cy - rOuter) - 1; y <= Math.ceil(cy + rOuter) + 1; y += 1) {
    for (let x = Math.floor(cx - rOuter) - 1; x <= Math.ceil(cx + rOuter) + 1; x += 1) {
      const dx = x - cx
      const dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d > rOuter) continue
      const a = Math.atan2(dy, dx) - rotation
      const seg = (Math.PI * 2) / points
      const local = ((a % seg) + seg) % seg
      const r = rInner + (rOuter - rInner) * Math.abs(Math.cos((local / seg) * Math.PI))
      if (d <= r) plot(buf, x, y, idx)
    }
  }
}

function sparkle(buf, cx, cy, vertical, horizontal, idx) {
  for (let y = Math.floor(cy - vertical); y <= Math.ceil(cy + vertical); y += 1) {
    for (let x = Math.floor(cx - horizontal); x <= Math.ceil(cx + horizontal); x += 1) {
      const dx = (x - cx) / horizontal
      const dy = (y - cy) / vertical
      if (dx * dx + dy * dy <= 1) plot(buf, x, y, idx)
    }
  }
}

function line(buf, x0, y0, x1, y1, width, idx) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) * 2
  for (let i = 0; i <= steps; i += 1) {
    plot(buf, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, width, idx)
    disc(buf, x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, width, idx)
  }
}

/** Kalkan silueti: üst geniş, alt sivri. */
function shield(buf, cx, cy, scale, width, idx) {
  for (let y = -20; y <= 20; y += 1) {
    const halfWidth = y < 2 ? 15 : 15 * Math.sqrt(Math.max(0, 1 - ((y - 2) / 18) ** 2))
    for (let x = -halfWidth; x <= halfWidth; x += 1) {
      if (Math.abs(x) <= halfWidth - width) plot(buf, cx + x, cy + y * scale, idx)
    }
  }
}

/* ------------------------------------------------------------------ */
/* Rütbe tanımları                                                      */
/* ------------------------------------------------------------------ */

/**
 * Her rütbe için palet ve kare çizimi. Palet sırası: 0 saydam, ardından 1..n
 * renkler (omggif paletin tamamını ister; eksikler siyah olur).
 */
const RANKS = [
  {
    file: 'new-user',
    type: 'png',
    label: 'New User',
    colors: ['#f4f1e8', '#ddd5c2', '#4f4a3b', '#b7ac93'],
    draw(buf) {
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      disc(buf, 32, 32, 11, 2)
      disc(buf, 32, 32, 6, 3)
    },
  },
  {
    file: 'active-user',
    type: 'png',
    label: 'Active User',
    colors: ['#efeade', '#d6cdb6', '#494536', '#a79b80'],
    draw(buf) {
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      disc(buf, 32, 26, 5, 3)
      disc(buf, 32, 38, 5, 3)
      disc(buf, 22, 32, 4, 2)
      disc(buf, 42, 32, 4, 2)
    },
  },
  {
    file: 'super-user',
    type: 'png',
    label: 'Super User',
    colors: ['#ebe3cf', '#cfc4a5', '#443f2c', '#9c916f'],
    draw(buf) {
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      star(buf, 32, 32, 17, 7, 3, -Math.PI / 2, 2)
      disc(buf, 32, 32, 4, 3)
    },
  },
  {
    file: 'angel',
    type: 'gif',
    label: 'Angel',
    colors: ['#ffffff', '#e3e3e3', '#f7d774', '#fff6d6', '#cfcfcf'],
    draw(buf, frame) {
      const t = (frame / FRAMES) * Math.PI * 2
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      sparkle(buf, 20, 32, 15, 10, 4) // kanat izleri
      sparkle(buf, 44, 32, 15, 10, 4)
      star(buf, 32, 32, 14 + Math.sin(t) * 1.5, 5, 4, t / 4, 3) // nabız parıltısı
      sparkle(buf, 32, 32, 4, 22, 4, 4)
    },
  },
  {
    file: 'legend',
    type: 'gif',
    label: 'Legend',
    colors: ['#dceafd', '#a9c9f3', '#12448f', '#6ea6ee', '#0b3a70'],
    draw(buf, frame) {
      const t = (frame / FRAMES) * Math.PI * 2
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      for (let i = 0; i < 3; i += 1) {
        const a = t + (i * Math.PI * 2) / 3
        sparkle(buf, 32 + Math.cos(a) * 21, 32 + Math.sin(a) * 21, 5, 5, 4)
      }
      star(buf, 32, 32, 15, 6, 5, -Math.PI / 2, 2)
      star(buf, 32, 32, 15 - Math.abs(Math.sin(t)) * 2, 6, 5, -Math.PI / 2, 3)
    },
  },
  {
    file: 'god',
    type: 'gif',
    label: 'God',
    colors: ['#ecdefc', '#c9aef6', '#5b21b6', '#a678f0', '#3b0f80'],
    draw(buf, frame) {
      const t = (frame / FRAMES) * Math.PI * 2
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      for (let i = 0; i < 8; i += 1) {
        const a = t + (i * Math.PI * 2) / 8
        line(buf, 32 + Math.cos(a) * 19, 32 + Math.sin(a) * 19, 32 + Math.cos(a) * 25, 32 + Math.sin(a) * 25, 1.2, 3)
      }
      star(buf, 32, 32, 16, 7, 6, t / 6, 2)
      star(buf, 32, 32, 12, 5, 6, t / 6, 4)
    },
  },
  {
    file: 'moderator',
    type: 'gif',
    label: 'Moderator',
    colors: ['#cfe4d8', '#94c3aa', '#14532d', '#4f8f68'],
    draw(buf) {
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      shield(buf, 32, 32, 1.6, 2, 3)
      line(buf, 32, 22, 32, 42, 1.4, 2)
      line(buf, 24, 32, 40, 32, 1.4, 2)
      disc(buf, 32, 32, 3, 2)
    },
  },
  {
    file: 'super-moderator',
    type: 'gif',
    label: 'Super Moderator',
    colors: ['#d7f7e4', '#7fd8a4', '#166534', '#3fbe74'],
    draw(buf, frame) {
      const t = (frame / FRAMES) * Math.PI * 2
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      shield(buf, 32, 32, 1.6, 2, 3)
      star(buf, 32, 31, 11, 4.5, 5, -Math.PI / 2 + t / 10, 2)
      disc(buf, 32, 31, 2.5, 3)
    },
  },
  {
    file: 'co-admin',
    type: 'gif',
    label: 'Co-Admin',
    colors: ['#f6dde1', '#dda9b4', '#7b1d2c', '#c4737f'],
    draw(buf, frame) {
      const t = (frame / FRAMES) * Math.PI * 2
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      shield(buf, 32, 32, 1.6, 2, 3)
      star(buf, 32, 31, 12, 5, 4, t / 4, 2)
      star(buf, 32, 31, 8, 3, 4, t / 4, 3)
    },
  },
  {
    file: 'admin',
    type: 'gif',
    label: 'Admin',
    colors: ['#fbdedc', '#f0aaa5', '#991b1b', '#dd6b63'],
    draw(buf, frame) {
      const t = (frame / FRAMES) * Math.PI * 2
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      shield(buf, 32, 32, 1.6, 2, 3)
      line(buf, 21, 24, 21, 34, 1.6, 2)
      line(buf, 32, 21, 32, 31, 1.6, 2)
      line(buf, 43, 24, 43, 34, 1.6, 2)
      line(buf, 20, 33, 44, 33, 1.8, 2)
      disc(buf, 21, 23, 2.2, 2)
      disc(buf, 32, 20, 2.2, 2)
      disc(buf, 43, 23, 2.2, 2)
      disc(buf, 32, 38, 3 + Math.sin(t) * 0.8, 3)
    },
  },
  {
    file: 'banned',
    type: 'png',
    label: 'Yasaklı',
    colors: ['#43484f', '#7c828b', '#f4f5f6', '#2b2f35'],
    draw(buf) {
      disc(buf, 32, 32, 29, 1)
      ring(buf, 32, 32, 29, 26, 2)
      ring(buf, 32, 32, 20, 17, 3)
      line(buf, 19, 19, 45, 45, 2.6, 4)
    },
  },
]

/* ------------------------------------------------------------------ */
/* Üretim                                                                */
/* ------------------------------------------------------------------ */

const hexToRgb = (hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

/**
 * Kodlayıcı palet uzunluğının 2'nin kuvveti olmasını ister.
 * 0. indeks saydam olduğundan paletin başına ölü bir renk eklenir.
 */
function gifPalette(rank) {
  // omggif paleti 0xRRGGBB tam sayı dizisi ister; 0. indeks saydam.
  const full = [0, ...rank.colors.map((hex) => parseInt(hex.slice(1), 16))]
  let size = 4
  while (size < full.length) size *= 2
  while (full.length < size) full.push(0)
  return full
}

/** Doğrulama araçları için dışa açılanlar. */
export const rankAssets = RANKS
export const FRAME_COUNT = FRAMES

export function buildFrame(rank, index) {
  const buf = canvas()
  rank.draw(buf, index)
  return buf
}

export function generateAll() {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const rank of RANKS) {
    if (rank.type === 'png') {
      const palette = rank.colors.map(hexToRgb)
      writeFileSync(join(OUT_DIR, `${rank.file}.png`), encodePng(palette, buildFrame(rank, 0)))
      console.log(`${rank.file}.png  (${rank.label})`)
    } else {
      const frames = []
      for (let f = 0; f < FRAMES; f += 1) frames.push(buildFrame(rank, f))
      writeFileSync(join(OUT_DIR, `${rank.file}.gif`), encodeGif(gifPalette(rank), frames))
      console.log(`${rank.file}.gif  (${rank.label}, ${FRAMES} kare)`)
    }
  }
  console.log(`\n${RANKS.length} rütbe görseli üretildi → ${OUT_DIR}`)
}

// Doğrudan çalıştırıldığında üret; içe aktarıldığında yalnızca fonksiyonlar.
if (process.argv[1] && process.argv[1].endsWith('generate-rank-assets.mjs')) generateAll()
