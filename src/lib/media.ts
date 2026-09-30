/**
 * Gönderi önizlemesi: bir bağlantıdan ne tür bir medya çıkacağını tahmin eder.
 *
 * Görsel (jpg/png/webp), GIF, doğrudan video (mp4/webm/ogg/mov) ve gömülü
 * video (YouTube, Vimeo, X) ayrı ayrı ele alınır; böylece kart üzerinde
 * doğru önizleme bileşeni çizilebilir.
 */
import type { MediaKind } from '../types'

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|avif)(\?|#|$)/i
const GIF_EXT = /\.gif(\?|#|$)/i
const VIDEO_EXT = /\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i

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
  if (host === 'vimeo.com' && segments[0]) return { provider: 'vimeo', id: segments[0].replace(/^\d+$/, '') || segments[0] }
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
