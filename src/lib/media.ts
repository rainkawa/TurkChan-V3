/**
 * Medya türü tespiti.
 *
 * Dosya türü asla uzantıya değil, imza baytlarına (magic bytes) bakar.
 * Görseller (JPEG/PNG/WebP) metadata'sı soyulur; GIF ve video bayt bayt
 * saklanır çünkü başlıkları bozma riski taşır.
 */
import type { MediaKind, UploadKind } from '../types'

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|avif)(\?|#|$)/i
const GIF_EXT = /\.gif(\?|#|$)/i
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i

/** Yüklenebilen türler ve boyut sınırları. */
export const MAX_VIDEOS_PER_POST = 1
export const UPLOAD_LIMITS = {
  image: 10 * 1024 * 1024,
  gif: 15 * 1024 * 1024,
  video: 60 * 1024 * 1024,
} as const

/**
 * Yüklenen baytların türü; tanınmayan dosyalar için null.
 * Uzantıya veya istemcinin beyanına değil, yalnızca imzaya bakar.
 */
export function detectUploadKind(bytes: Uint8Array): UploadKind | null {
  // GIF87a / GIF89a
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const sig = String.fromCharCode(bytes[3] as number, bytes[4] as number, bytes[5] as number)
    if (sig === '87a' || sig === '89a') return 'gif'
  }
  // ISO BMFF (mp4/m4v/mov): 4..8 == "ftyp"
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  ) {
    return 'video'
  }
  // Matroska / WebM: 1A 45 DF A3
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  ) {
    return 'video'
  }
  // JPEG / PNG / WebP görselleri
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image'
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image'
  }
  return null
}

/**
 * İçerik tipi YALNIZCA imzadan türetilir.
 *
 * İstemcinin bildirdiği MIME'e asla güvenilmez: aksi halde bir dosya
 * `text/html` beyan edilip aynı origin'de çalıştırılabilir (depolanmış XSS).
 */
export function mimeForUploadKind(kind: UploadKind, bytes?: Uint8Array): string {
  if (kind === 'gif') return 'image/gif'
  if (kind === 'video') return isWebm(bytes) ? 'video/webm' : 'video/mp4'
  return 'image/jpeg'
}

/** Matroska/WebM kapsayıcısı mı? */
function isWebm(bytes: Uint8Array | undefined): boolean {
  if (!bytes || bytes.length < 4) return false
  return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
}

/** Yüklemelerde kaydedilen MIME değerinden medya türü. */
export function uploadKindFromMime(mime: string | null): UploadKind | null {
  if (!mime) return null
  if (mime.startsWith('image/gif')) return 'gif'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  return null
}

/** Doğrudan medya bağlantısı oynatılabilir bir dosya mı? */
export function mediaKindForUrl(rawUrl: string | null | undefined): MediaKind {
  if (!rawUrl) return 'none'
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return 'none'
  }
  if (!['http:', 'https:'].includes(url.protocol)) return 'none'
  if (GIF_EXT.test(url.pathname + url.search)) return 'gif'
  if (VIDEO_EXT.test(url.pathname + url.search)) return 'video'
  if (IMAGE_EXT.test(url.pathname + url.search)) return 'image'
  return embedIdForUrl(rawUrl) ? 'embed' : 'none'
}

/** Gömülü video sağlayıcısının video kimliğini döndürür (YouTube, Vimeo, X). */
export function embedIdForUrl(rawUrl: string | null | undefined): { provider: 'youtube' | 'vimeo' | 'x'; id: string } | null {
  if (!rawUrl) return null
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '')
  const segments = url.pathname.split('/').filter(Boolean)

  if (host === 'youtu.be' && segments[0]) return { provider: 'youtube', id: segments[0] }
  if (host.endsWith('youtube.com') || host === 'm.youtube.com') {
    const fromQuery = url.searchParams.get('v')
    if (fromQuery) return { provider: 'youtube', id: fromQuery }
    if (segments[0] === 'embed' || segments[0] === 'shorts' || segments[0] === 'live') {
      const id = segments[1]
      if (id) return { provider: 'youtube', id }
    }
  }
  if (host === 'vimeo.com' && segments[0]) return { provider: 'vimeo', id: segments[0] }
  if (host === 'player.vimeo.com' && segments[0]) return { provider: 'vimeo', id: segments[0] }
  if ((host === 'x.com' || host === 'twitter.com') && segments[0] && segments[1]) {
    return { provider: 'x', id: `${segments[0]}/${segments[1]}` }
  }
  return null
}

/** Gömülü oynatıcının kaynak adresi. */
export function embedSrcFor(rawUrl: string | null | undefined): string | null {
  const embed = embedIdForUrl(rawUrl)
  if (!embed) return null
  if (embed.provider === 'youtube') return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(embed.id)}`
  if (embed.provider === 'vimeo') return `https://player.vimeo.com/video/${encodeURIComponent(embed.id)}`
  return `https://platform.twitter.com/embed/Tweet.html?id=${encodeURIComponent(embed.id)}`
}
