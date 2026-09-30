import type { Ctx } from '../context'
import { assertPublicDestination } from '../lib/urlguard'

export interface LinkPreview {
  title: string | null
  image: string | null
}

const MAX_PREVIEW_BYTES = 512 * 1024

/**
 * Best-effort OG preview fetch at post time (US-014). Guards SSRF by resolving
 * the destination first, times out at 5s, and only reads HTML. Failure never
 * blocks post creation — callers get null.
 */
export async function fetchLinkPreview(ctx: Ctx, url: string): Promise<LinkPreview | null> {
  try {
    await assertPublicDestination(url)
    const response = await ctx.fetchFn(url, {
      signal: AbortSignal.timeout(ctx.config.linkPreviewTimeoutMs),
      redirect: 'follow',
      headers: { accept: 'text/html', 'user-agent': 'TurkChanBot/0.1 (+link-preview)' },
    })
    const contentType = response.headers.get('content-type') ?? ''
    if (!response.ok || !contentType.includes('text/html')) return null
    const html = (await response.text()).slice(0, MAX_PREVIEW_BYTES)
    return {
      title: extractMeta(html, 'og:title') ?? extractTitle(html),
      image: sanitizeImageUrl(extractMeta(html, 'og:image')),
    }
  } catch {
    return null
  }
}

function extractMeta(html: string, property: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match?.[1]) return decodeEntities(match[1]).slice(0, 300)
  }
  return null
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return match?.[1] ? decodeEntities(match[1].trim()).slice(0, 300) : null
}

function sanitizeImageUrl(raw: string | null): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.toString().slice(0, 1000)
  } catch {
    return null
  }
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
}
