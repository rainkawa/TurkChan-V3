import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * SSRF guard for link posts (US-014): only well-formed http/https URLs, and
 * the resolved address must not be in a private/reserved range.
 */

export function isValidPublicUrlSyntax(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (!url.hostname) return false
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal) && isPrivateAddress(literal)) return false
  if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local')) {
    return false
  }
  return true
}

export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateV4(address)
  if (isIP(address) === 6) return isPrivateV6(address)
  return true // unresolvable → treat as unsafe
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number)
  const [a = 0, b = 0] = parts
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a === 169 && b === 254) return true // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  if (a >= 224) return true // multicast + reserved
  return false
}

function isPrivateV6(address: string): boolean {
  const lower = address.toLowerCase()
  if (lower === '::' || lower === '::1') return true
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local
  if (lower.startsWith('::ffff:')) return isPrivateAddress(lower.slice(7))
  return false
}

/** Resolve the hostname and reject URLs that land on private ranges. */
export async function assertPublicDestination(raw: string): Promise<void> {
  const url = new URL(raw)
  const literal = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(literal)) {
    if (isPrivateAddress(literal)) throw new Error('Hedef adrese izin verilmiyor')
    return
  }
  const { address } = await lookup(url.hostname)
  if (isPrivateAddress(address)) throw new Error('Hedef adrese izin verilmiyor')
}
