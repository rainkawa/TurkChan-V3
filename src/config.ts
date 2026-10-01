/** Static process configuration. Runtime-editable policies live in site_settings (see services/settings.ts). */
export interface AppConfig {
  port: number
  dbPath: string
  uploadDir: string
  exportDir: string
  baseUrl: string
  secureCookies: boolean
  /** Mutlak oturum ömrü: bu süreden sonra token kesin olarak geçersizdir. */
  sessionTtlMs: number
  /** Idle (boşta) zaman aşımı: bu kadar süredir etkinlik yoksa oturum biter. */
  sessionIdleMs: number
  /** Oturum token'ı her girişte yenilenir (session fixation koruması). */
  sessionRotateOnLogin: boolean
  exportLinkTtlMs: number
  maxImageBytes: number
  linkPreviewTimeoutMs: number
  communityPurgeAfterMs: number
  /**
   * Ters vekil (nginx/CDN) arkasında çalışıldığında `X-Forwarded-For`
   * başlığına güvenilir. Kapalıyken istemcinin kendi gönderdiği başlık
   * yok sayılır; aksi hâlde rate limitler sahte IP ile atlatılabilirdi.
   */
  trustProxy: boolean
  /** Genel istek sınırı: IP başına dakikada izin verilen istek sayısı. */
  globalRequestsPerMinute: number
  /**
   * AI karakter davranış motoru (v2.1.2). Varsayılan olarak AÇIKTIR;
   * AI_ENABLED=0 ile tamamen kapatılabilir (örn. gerçek kullanıcı trafiği
   * olan bir kurulumda). Kapatmak mevcut içeriği silmez, sadece yeni
   * aktivite üretmez.
   */
  aiEnabled: boolean
  /** Davranış motorunun kaç dakikada bir çalışacağı. */
  aiTickMinutes: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    dbPath: env.DB_PATH ?? 'data/app.db',
    uploadDir: env.UPLOAD_DIR ?? 'data/uploads',
    exportDir: env.EXPORT_DIR ?? 'data/exports',
    baseUrl: env.BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`,
    secureCookies: env.NODE_ENV === 'production',
    sessionTtlMs: Number(env.SESSION_TTL_MS ?? 30 * DAY_MS),
    sessionIdleMs: Number(env.SESSION_IDLE_MS ?? 7 * DAY_MS),
    sessionRotateOnLogin: true,
    exportLinkTtlMs: DAY_MS,
    maxImageBytes: 10 * 1024 * 1024,
    linkPreviewTimeoutMs: 5000,
    communityPurgeAfterMs: 30 * DAY_MS,
    trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
    globalRequestsPerMinute: Number(env.GLOBAL_RATE_PER_MIN ?? 600),
    aiEnabled: env.AI_ENABLED !== '0' && env.AI_ENABLED !== 'false',
    aiTickMinutes: Math.max(1, Number(env.AI_TICK_MINUTES ?? 5)),
  }
}
