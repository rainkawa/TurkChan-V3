/**
 * Production-safe günlükleme.
 *
 * Kurallar:
 *  - **Asla** parola, parola karması, session/CSRF jetonu veya özel mesaj
 *    gövdesi yazılmaz.
 *  - Kullanıcı girdisi (IP, User-Agent, hata mesajı) loglanmadan önce
 *    redakte edilir ve kısaltılır; log şişmesi ve veri sızıntısı engellenir.
 *  - Tarayıcıya stack trace gösterilmez; yalnızca koruyucu bir mesaj döner.
 *  - Olaylar yapılandırılmış (JSON) olarak yazılır, böylece toplayıcılar
 *    ayrıştırabilir.
 */
import { randomUUID } from 'node:crypto'

/** Loglarda asla görünmemesi gereken alan adları ve desenleri. */
const REDACTED_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'csrf',
  'authorization',
  'cookie',
  'session',
  'sid',
  'password_hash',
  'passwordhash',
  'api_key',
  'apikey',
  'body',
  'message_body',
  'detail',
]

/** Değeri içinde geçen anahtar kalıpları (öneki olmayan serbest metinler için). */
const REDACTED_SUBSTRINGS = [
  'password',
  'parola',
  'token',
  'secret',
  'csrf',
  'authorization',
  'password_hash',
]

const IP_RE = /\b\d{1,3}(\.\d{1,3}){3}\b/g

/** Tek bir değeri loglanabilir hâle getirir. */
function redactValue(key: string, value: unknown, depth = 0): unknown {
  const lower = key.toLowerCase()
  if (REDACTED_KEYS.some((k) => lower.includes(k))) return '[redacted]'
  if (typeof value === 'string') {
    if (REDACTED_SUBSTRINGS.some((s) => lower.includes(s))) return '[redacted]'
    // Serbest metinde gömülü jeton/parola kalıplarını temizle.
    return value.replace(/(password|parola|token|secret|csrf)["'\s:=]+[^\s"',}]{4,}/gi, '$1=[redacted]')
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value
  if (depth > 4) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactValue('item', v, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      out[k] = redactValue(k, v, depth + 1)
    }
    return out
  }
  return '[unserialisable]'
}

/** IP adresini kısmen maskeler (tam IP kaydı gerekli değil, korelasyon yeterli). */
export function maskIp(ip: string | null | undefined): string {
  if (!ip) return 'unknown'
  // IPv6 ve port biçimlerini de kapsar.
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}:*`
  return IP_RE.test(ip) ? ip.replace(IP_RE, (m) => m.split('.').slice(0, 2).join('.') + '.x.x') : 'masked'
}

export type LogLevel = 'info' | 'warn' | 'error' | 'security'

function emit(level: LogLevel, event: string, context: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(context)) safe[k] = redactValue(k, v)
  const entry = {
    ts: new Date().toISOString(),
    level,
    event,
    req: randomUUID().slice(0, 8),
    ...safe,
  }
  const line = JSON.stringify(entry)
  if (level === 'error' || level === 'security') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** Genel bilgi olayı. */
export function logInfo(event: string, context: Record<string, unknown> = {}): void {
  emit('info', event, context)
}

/** Uyarı olayı. */
export function logWarn(event: string, context: Record<string, unknown> = {}): void {
  emit('warn', event, context)
}

/**
 * Sunucu hatası. Stack trace yalnızca sunucu günlüğüne yazılır, tarayıcıya
 * sızdırılmaz; ayrıca olası sırlar redakte edilir.
 */
export function logError(err: unknown, context: Record<string, unknown> = {}): void {
  const error = err instanceof Error ? err : new Error(String(err))
  emit('error', 'server_error', {
    ...context,
    message: error.message,
    // Yalnızca uygulama yığını; sorgu parametreleri loglanmaz.
    stack: (error.stack ?? '').split('\n').slice(0, 6).join(' | '),
  })
}

/**
 * Güvenlik olayı: yetkisiz erişim, CSRF reddi, rate limit aşımı, şüpheli
 * yükleme, yönetici işlemi. Gerekçesi olmayan "sessiz" reddetme bırakılmaz.
 */
export function logSecurity(event: string, context: Record<string, unknown> = {}): void {
  emit('security', event, context)
}
