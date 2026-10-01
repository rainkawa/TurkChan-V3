/**
 * Statik süreç yapılandırması.
 *
 * NOT: Bu dosya artık hiçbir LLM / API / anahtar içermez. NPC simülasyonu
 * tamamen yereldir: harici servis, internet çağrısı veya gizli anahtar
 * gerekmez. Çalışma zamanında değiştirilebilen politikalar `site_settings`
 * tablosundadır (bkz. services/settings.ts).
 */
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
   * NPC simülasyon motoru (v2.2). Varsayılan olarak AÇIKTIR;
   * NPC_ENABLED=0 (veya geriye uyum için AI_ENABLED=0) ile kapatılabilir.
   * Kapatmak mevcut içeriği silmez, sadece yeni aktivite üretmez.
   *
   * Tamamen yerel çalışır: API anahtarı, LLM veya internet gerekmez.
   */
  npcEnabled: boolean
  /** Davranış motorunun kaç dakikada bir çalışacağı. */
  npcTickMinutes: number
  /**
   * Bir turda en fazla kaç NPC işlemi yapılsın. Performans sınırıdır;
   * tek scheduler tüm NPC'leri sırayla çalıştırır.
   */
  npcMaxActionsPerTick: number
  /**
   * Bir turda okunacak gönderi sayısı (NPC başına). Daha büyük değerler
   * daha "canlı" hissettirir ama daha fazla SQLite sorgusu demektir.
   */
  npcPostsScannedPerTick: number
}

const DAY_MS = 24 * 60 * 60 * 1000

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const disabled = env.NPC_ENABLED === '0' || env.NPC_ENABLED === 'false' ||
    env.AI_ENABLED === '0' || env.AI_ENABLED === 'false'
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
    npcEnabled: !disabled,
    npcTickMinutes: Math.max(1, Number(env.NPC_TICK_MINUTES ?? env.AI_TICK_MINUTES ?? 5)),
    npcMaxActionsPerTick: Math.max(1, Number(env.NPC_MAX_ACTIONS ?? 12)),
    npcPostsScannedPerTick: Math.max(5, Number(env.NPC_POSTS_SCANNED ?? 40)),
  }
}
