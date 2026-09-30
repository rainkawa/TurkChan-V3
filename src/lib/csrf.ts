/**
 * CSRF koruması (senkronizasyon jetonu).
 *
 * Çerez tabanlı oturum kullanıldığı için tarayıcı, saldırganın sayfasından
 * gelen bir isteği "kullanıcının kendi isteği" gibi gönderir. Koruma iki
 * katmanlıdır:
 *
 *  1. **Senkronizasyon jetonu (birincil)**: her oturum için HMAC ile imzalanan
 *     bir jeton üretilir ve tüm HTML formlarına gizli alan olarak gömülür.
 *     Jeton oturumun kendisinden türetildiği için saldırgan onu tahmin edemez
 *     ve kendi oturumundaki jetonu başka bir kullanıcının formunda kullanamaz.
 *  2. **Origin/Referer denetimi (ikincil savunma hattı)**: Origin başlığı
 *     beklenen origin ile eşleşmiyorsa istek reddedilir.
 *
 * Jeton veritabanında tutulmaz (durumsuz); süreç yeniden başlayınca eski
 * formlar geçersizleşir, bu da gizli anahtarın sızmamasını sağlar.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Süreç başına rastgele üretilir; kaynak koda varsayılan anahtar gömülmez.
 * Üretimde `CSRF_SECRET` ile verilirse süreçler arasında ortak kullanılabilir.
 */
function loadSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.CSRF_SECRET
  if (fromEnv && fromEnv.length >= 32) return Buffer.from(fromEnv, 'utf8')
  // Ortam değişkeni yoksa güçlü rastgelelik kullanılır.
  return randomBytes(48)
}

let cachedSecret: { key: string; value: Buffer } | null = null

function secret(): Buffer {
  if (cachedSecret) return cachedSecret.value
  const value = loadSecret()
  cachedSecret = { key: value.toString('base64'), value }
  return value
}

/** Testlerin ayrı jeton üreticisi kullanabilsin diye. */
export function setCsrfSecretForTests(key: string): void {
  cachedSecret = { key, value: Buffer.from(key, 'utf8') }
}

export const CSRF_FIELD = '_csrf'
export const CSRF_HEADER = 'x-csrf-token'

/**
 * Oturum anahtarına bağlı jeton üretir.
 *
 * Oturumsuz sayfalar (giriş/kayıt formu) için anahtar `"anon"` kullanılır; bu
 * sayede "login CSRF" ( saldırganın kendi hesabıyla kurbanın tarayıcısını
 * giriş yaptırma) de engellenir.
 */
export function issueCsrfToken(sessionKey: string | undefined | null): string {
  return createHmac('sha256', secret()).update(sessionKey || 'anon').digest('base64url')
}

/** Zamanlama saldırısına dayanıklı sabit-uzunluklu karşılaştırma. */
export function verifyCsrfToken(expected: string, provided: string | null | undefined): boolean {
  if (!provided) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Bir isteğin CSRF jetonunu doğrular.
 *
 * Jeton form alanından (`_csrf`) veya `x-csrf-token` başlığından okunur.
 * `X-CSRF-Token` yerine standart `X-CSRF-Token`/`x-csrf-token` kullanılır.
 */
export function checkCsrf(
  sessionKey: string | undefined | null,
  submitted: string | null | undefined,
): boolean {
  return verifyCsrfToken(issueCsrfToken(sessionKey), submitted)
}

/**
 * Origin başlığını beklenen origin ile karşılaştırır (ikincil savunma hattı).
 * Origin yoksa (bazı eski istemciler) bu katman sessizce geçer sayılır; birincil
 * koruma olan senkronizasyon jetonu zaten sunucuda doğrulanır.
 */
export function isSameOrigin(origin: string | null | undefined, requestUrl: string): boolean {
  if (!origin) return true
  try {
    return new URL(origin).host === new URL(requestUrl).host
  } catch {
    return false
  }
}
