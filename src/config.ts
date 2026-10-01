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
  /**
   * Metin üretimi: OpenAI uyumlu sohbet tamamlama ucu.
   * Anahtar boşsa motor hazır kalıplara (offline mod) düşer.
   * Başka bir sağlayıcıya geçmek için yalnızca base URL + model değişir.
   */
  aiLlmApiKey: string
  aiLlmBaseUrl: string
  aiLlmModel: string
  aiLlmTimeoutMs: number
  /** İnternet araştırması (grounding) — anahtar boşsa araştırma yapılmaz. */
  aiSearchApiKey: string
  aiSearchUrl: string
  aiSearchResults: number
  /** Bir turda en fazla kaç metin üretimi yapılsın (maliyet + süre sınırı). */
  aiMaxGenerationsPerTick: number
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
    aiLlmApiKey: env.AI_LLM_API_KEY ?? '',
    aiLlmBaseUrl: (env.AI_LLM_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/u, ''),
    aiLlmModel: env.AI_LLM_MODEL ?? 'gpt-4o-mini',
    aiLlmTimeoutMs: Math.max(2000, Number(env.AI_LLM_TIMEOUT_MS ?? 15000)),
    aiSearchApiKey: env.AI_SEARCH_API_KEY ?? '',
    aiSearchUrl: env.AI_SEARCH_URL ?? 'https://api.exa.ai/search',
    aiSearchResults: Math.min(5, Math.max(1, Number(env.AI_SEARCH_RESULTS ?? 3))),
    aiMaxGenerationsPerTick: Math.max(0, Number(env.AI_MAX_GENERATIONS ?? 6)),
  }
}
