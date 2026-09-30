/**
 * TurkChan rank rozet seti üreticisi.
 *
 * Her rütbe / yetki için tek tip bir rozet çizilir: yuvarlatılmış dikdörtgen
 * zemin (dikey degrade + üst parlaklık), solda Lucide ikonu, sağda rütbe adı.
 * Statik olanlar düz SVG, animasyonlu olanlar (Angel, Legend, God ve dört yönetim
 * yetkisi) SVG içinde kendi CSS animasyonunu taşır: yavaş bir ışık huzmesi ve
 * nabız gibi bir kenarlık. SVG olduğu için her DPI'da net, dosyalar da ~2 KB.
 *
 * İkonlar: Lucide (ISC) — `npm run rank:assets` ile yeniden üretilebilir.
 *
 * Kullanım:  npm run rank:assets
 * Çıktı:     public/assets/ranks/*.svg  (depoda saklanır)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'public', 'assets', 'ranks')
const ICON_DIR = join(ROOT, 'node_modules', 'lucide-static', 'icons')

/* ------------------------------------------------------------------ */
/* Rozet geometrisi (mantıksal px = ekranda 1 birim)                  */
/* ------------------------------------------------------------------ */

const HEIGHT = 24 // rozet yüksekliği
const RADIUS = 7 // köşe yarıçapı
const ICON_BOX = 13 // ikon kutusu kenarı
const ICON_X = 4.5
const ICON_Y = (HEIGHT - ICON_BOX) / 2
const GAP = 4.5 // ikon ile yazı arası
const PAD_X = 5 // sol/sağ iç boşluk
const FONT_SIZE = 10.5
const BASELINE = 16 // dikey optik ortalama
const FONT_STACK = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"

/* ------------------------------------------------------------------ */
/* Yazı genişliği tahmini (Helvetica-Bold AFM genişlikleri)            */
/* ------------------------------------------------------------------ */

const GLYPH_WIDTHS = {
  ' ': 278, '-': 333, '.': 333, "'": 238, ',': 278,
  A: 722, B: 722, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 556, K: 722, L: 611,
  M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611, U: 722, V: 667, W: 944, X: 667,
  Y: 667, Z: 611,
  a: 556, b: 611, c: 556, d: 611, e: 556, f: 333, g: 611, h: 611, i: 278, j: 278, k: 556, l: 278,
  m: 889, n: 611, o: 611, p: 611, q: 611, r: 389, s: 556, t: 333, u: 611, v: 556, w: 778, x: 556,
  y: 556, z: 500,
  0: 556, 1: 556, 2: 556, 3: 556, 4: 556, 5: 556, 6: 556, 7: 556, 8: 556, 9: 556,
}

/** Harf aralığı dahil yaklaşık metin genişliği (viewBox'ı buna göre kurarız). */
function textWidth(label) {
  let units = 0
  for (const ch of label) units += GLYPH_WIDTHS[ch] ?? 600
  return (units / 1000) * FONT_SIZE + label.length * FONT_SIZE * 0.01
}

const round = (n) => Math.round(n * 100) / 100

/* ------------------------------------------------------------------ */
/* İkonlar (Lucide, 24x24 çizgi ikonları)                             */
/* ------------------------------------------------------------------ */

/** SVG içinden sadece çizim elemanlarını çıkarır (lisans yorumu atlanır). */
function iconBody(name) {
  const svg = readFileSync(join(ICON_DIR, `${name}.svg`), 'utf8')
  const body = svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'))
  return body.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ */
/* Rütbe tanımları                                                      */
/* ------------------------------------------------------------------ */

/**
 * `type: 'static'` → düz rozet, `type: 'animated'` → ışık huzmesi + nabız.
 * Renkler: zemin degrade (from/to), kenarlık, yazı, ikon ve nabız rengi.
 */
const RANKS = [
  {
    file: 'new-user',
    type: 'static',
    label: 'New User',
    icon: 'sprout',
    colors: { from: '#EEF1F6', to: '#E1E7F0', border: '#C7D1E0', text: '#46536A', icon: '#64748B', glow: '#94A3B8' },
  },
  {
    file: 'active-user',
    type: 'static',
    label: 'Active User',
    icon: 'zap',
    colors: { from: '#E0F5F2', to: '#C9E9E5', border: '#95D5CD', text: '#0F5B54', icon: '#0F766E', glow: '#14B8A6' },
  },
  {
    file: 'super-user',
    type: 'static',
    label: 'Super User',
    icon: 'star',
    colors: { from: '#E9EBFD', to: '#D7DCFB', border: '#AEB5F0', text: '#332C9E', icon: '#4F46E5', glow: '#6366F1' },
  },
  {
    file: 'angel',
    type: 'animated',
    label: 'Angel',
    icon: 'feather',
    colors: { from: '#FEF4DA', to: '#FBE5AF', border: '#EDC877', text: '#8A5B06', icon: '#C2740A', glow: '#F59E0B' },
  },
  {
    file: 'legend',
    type: 'animated',
    label: 'Legend',
    icon: 'trophy',
    colors: { from: '#F1E8FE', to: '#E1D1FC', border: '#C3A2F3', text: '#631DA0', icon: '#8B2FD0', glow: '#A855F7' },
  },
  {
    file: 'god',
    type: 'animated',
    label: 'God',
    icon: 'gem',
    colors: { from: '#FDE5EA', to: '#F8C8D3', border: '#EE9DB0', text: '#981036', icon: '#D31146', glow: '#F43F5E' },
  },
  {
    file: 'moderator',
    type: 'animated',
    label: 'Moderator',
    icon: 'shield',
    colors: { from: '#E6EDF7', to: '#D1DEEF', border: '#A5BAD8', text: '#1C3A61', icon: '#2559AE', glow: '#3B82F6' },
  },
  {
    file: 'super-moderator',
    type: 'animated',
    label: 'Super Moderator',
    icon: 'shield-check',
    colors: { from: '#DBF8E9', to: '#BDEED4', border: '#7CD6A4', text: '#05543D', icon: '#047857', glow: '#10B981' },
  },
  {
    file: 'co-admin',
    type: 'animated',
    label: 'Co-Admin',
    icon: 'user-cog',
    colors: { from: '#FCE4EB', to: '#F7C8D7', border: '#EC9FB7', text: '#981036', icon: '#BE123C', glow: '#F43F5E' },
  },
  {
    file: 'admin',
    type: 'animated',
    label: 'Admin',
    icon: 'crown',
    colors: { from: '#FDE2DE', to: '#F7C0B8', border: '#EB9082', text: '#7A1A17', icon: '#B91C1C', glow: '#EF4444' },
  },
  {
    file: 'banned',
    type: 'static',
    label: 'Yasaklı',
    icon: 'ban',
    colors: { from: '#3C434C', to: '#262B32', border: '#5A636E', text: '#E9ECF0', icon: '#C7CED7', glow: '#6B7280' },
  },
]

/* ------------------------------------------------------------------ */
/* SVG üretimi                                                          */
/* ------------------------------------------------------------------ */

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Rütlere göre üretilen SVG metni. */
export function renderBadge(rank) {
  const animated = rank.type === 'animated'
  const c = rank.colors
  const text = textWidth(rank.label)
  const width = round(PAD_X * 2 + ICON_BOX + GAP + text * 1.02)
  const inner = round(width - 1)
  const iconScale = round((ICON_BOX / 24) * 100000) / 100000
  const sheenTravel = round(width + 34)

  // Animasyon kapalı kaldığında (reduced motion / eski tarayıcı) hiçbir şey
  // görünmesin diye parlama ve nabız öğeleri opaklık 0 ile başlar; anahtar
  // kareleri sadece animasyon sırasında değerleri değiştirir.
  const style = animated
    ? `  <style>
    .sheen { animation: sheen 2.8s linear infinite; }
    .pulse { animation: pulse 2.8s ease-in-out infinite; }
    @keyframes sheen {
      0% { transform: translateX(-20px); opacity: 0 }
      20%, 80% { opacity: .55 }
      100% { transform: translateX(${sheenTravel}px); opacity: 0 }
    }
    @keyframes pulse { 0%, 100% { opacity: 0 } 50% { opacity: .55 } }
    @media (prefers-reduced-motion: reduce) { .sheen, .pulse { animation: none } }
  </style>
`
    : ''

  const sheen = animated
    ? `<g class="sheen" opacity="0"><rect x="-10" y="-8" width="12" height="${HEIGHT + 16}" fill="url(#sheen)" transform="skewX(-18)"/></g>`
    : ''

  const pulse = animated
    ? `<rect class="pulse" x=".8" y=".8" width="${round(inner - 1.6)}" height="${HEIGHT - 1.6}" rx="${round(RADIUS - 0.8)}" fill="none" stroke="${c.glow}" stroke-width="1.4" opacity="0"/>`
    : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${HEIGHT}" viewBox="0 0 ${width} ${HEIGHT}" role="img" aria-label="${esc(rank.label)}">
  <title>${esc(rank.label)}</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${c.from}"/>
      <stop offset="1" stop-color="${c.to}"/>
    </linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity=".55"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="sheen" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
      <stop offset=".5" stop-color="#ffffff" stop-opacity=".9"/>
      <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="chip"><rect x=".5" y=".5" width="${inner}" height="${HEIGHT - 1}" rx="${RADIUS}"/></clipPath>
  </defs>
${style}  <g clip-path="url(#chip)">
    <rect x=".5" y=".5" width="${inner}" height="${HEIGHT - 1}" rx="${RADIUS}" fill="url(#bg)"/>
    <rect x=".5" y=".5" width="${inner}" height="${HEIGHT / 2 - 0.5}" fill="url(#gloss)"/>
    ${sheen}
  </g>
  <rect x=".5" y=".5" width="${inner}" height="${HEIGHT - 1}" rx="${RADIUS}" fill="none" stroke="${c.border}" stroke-width="1"/>
  ${pulse}
  <g transform="translate(${ICON_X} ${ICON_Y}) scale(${iconScale})" fill="none" stroke="${c.icon}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    ${iconBody(rank.icon)}
  </g>
  <text x="${round(ICON_X + ICON_BOX + GAP)}" y="${BASELINE}" font-family="${FONT_STACK}" font-size="${FONT_SIZE}" font-weight="700" letter-spacing=".01em" fill="${c.text}" textLength="${round(text * 1.02)}" lengthAdjust="spacingAndGlyphs">${esc(rank.label)}</text>
</svg>
`
}

export const rankAssets = RANKS

export function generateAll() {
  mkdirSync(OUT_DIR, { recursive: true })
  for (const rank of RANKS) {
    const file = join(OUT_DIR, `${rank.file}.svg`)
    const svg = renderBadge(rank)
    writeFileSync(file, svg, 'utf8')
    const kb = (Buffer.byteLength(svg) / 1024).toFixed(1)
    console.log(`${rank.file}.svg  (${rank.label} · ${rank.icon} · ${rank.type} · ${kb} KB)`)
  }
  console.log(`\n${RANKS.length} rozet üretildi → ${OUT_DIR}`)
}

// Doğrudan çalıştırıldığında üret; içe aktarıldığında yalnızca fonksiyonlar.
if (process.argv[1] && process.argv[1].endsWith('generate-rank-assets.mjs')) generateAll()
