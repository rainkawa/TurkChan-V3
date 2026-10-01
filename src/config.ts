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
  /** Hangi hazır sağlayıcı profili çözüldü (yönetim panelinde gösterilir). */
  aiLlmProviderId: string
  /** İnternet araştırması (grounding) — anahtar boşsa araştırma yapılmaz. */
  aiSearchApiKey: string
  aiSearchUrl: string
  aiSearchResults: number
  /** Bir turda en fazla kaç metin üretimi yapılsın (maliyet + süre sınırı). */
  aiMaxGenerationsPerTick: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/** Hazır metin motoru sağlayıcı profili. */
export interface LlmProvider {
  /** Kimlik (AI_LLM_PROVIDER değeri). */
  id: string
  /** Panelde gösterilen ad. */
  label: string
  /** OpenAI uyumlu ucun kökü. */
  baseUrl: string
  /** Önerilen model. */
  model: string
  /** Bu sağlayıcının anahtarını taşıyan ortam değişkenleri (ilk bulunan kullanılır). */
  keyEnvs: string[]
  /** Kısa not: ücretsiz mi, ücretli mi, günlük limit var mı. */
  note: string
  /** Anahtarın alınacağı adres. */
  docsUrl: string
}

/**
 * Metin motoru sağlayıcı profilleri.
 *
 * Tümü OpenAI uyumlu `/chat/completions` ucu konuşur; fark yalnızca adres,
 * model adı ve anahtar değişkeninde. Kullanıcı yalnızca `GROQ_API_KEY`
 * gibi sağlayıcıya ait tek bir değişken ekleyip çalıştırabilsin diye
 * anahtar adları da eşleştirilir.
 */
export const LLM_PROVIDERS: LlmProvider[] = [
  {
    id: 'groq',
    label: 'Groq (ücretsiz kota, önerilen)',
    baseUrl: 'https://api.groq.com/openai/v1',
    // Not: Groq'un ücretsiz kotasında bulunan çok dilli model. Model
    // adı sık değişir; `node scripts/list-llm-models.mjs` ile anlık liste.
    model: 'qwen/qwen3.8-27b',
    keyEnvs: ['GROQ_API_KEY'],
    note: 'Kredi kartı istemeyen ücretsiz günlük kota; karta da kartı da sınırsız değil, kota bitince motor şablona düşer.',
    docsUrl: 'https://console.groq.com/keys',
  },
  {
    id: 'gemini',
    label: 'Google AI Studio / Gemini (ücretsiz kota)',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    model: 'gemini-2.5-flash',
    keyEnvs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    note: 'Ücretsiz kota, güçlü Türkçe desteği; kota dakikada birkaç istekle sınırlıdır.',
    docsUrl: 'https://aistudio.google.com/app/apikey',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (ücretsiz modeller var)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'meta-llama/llama-3.1-8b-instruct:free',
    keyEnvs: ['OPENROUTER_API_KEY'],
    note: '`:free` sonekli modeller ücretsizdir; ücretli modeller de aynı anahtarla kullanılabilir.',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI (ücretli)',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyEnvs: ['OPENAI_API_KEY'],
    note: 'Ücretlidir; ücretsiz kredi verilmez. Karşılaştırma için listede tutulur.',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'custom',
    label: 'Özel uç nokta',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    keyEnvs: ['AI_LLM_API_KEY'],
    note: 'AI_LLM_BASE_URL ve AI_LLM_MODEL elle verilir.',
    docsUrl: '',
  },
]

/** Kimliğe göre hazır sağlayıcı profili. */
export function llmProvider(id: string): LlmProvider | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id)
}

/**
 * Hangi sağlayıcının kullanılacağını belirler:
 *   1. AI_LLM_PROVIDER varsa o,
 *   2. yoksa AI_LLM_BASE_URL verilmişse 'custom',
 *   3. yoksa anahtarı bulunan ilk ücretsiz profil (sırayla),
 *   4. o da yoksa varsayılan 'groq'.
 */
function resolveProviderId(env: NodeJS.ProcessEnv): string {
  const explicit = env.AI_LLM_PROVIDER?.trim().toLowerCase()
  if (explicit && llmProvider(explicit)) return explicit
  if (env.AI_LLM_BASE_URL) return 'custom'
  const withKey = LLM_PROVIDERS.filter((p) => p.id !== 'custom' && p.id !== 'openai').find((p) =>
    p.keyEnvs.some((name) => (env[name] ?? '') !== ''),
  )
  return withKey?.id ?? 'groq'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const providerId = resolveProviderId(env)
  const provider = llmProvider(providerId) ?? LLM_PROVIDERS[0]!
  const providerKey = provider.keyEnvs.map((name) => env[name] ?? '').find((v) => v !== '') ?? ''
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
    // Anahtar önce genel değişkende, yoksa seçili sağlayıcının kendi
    // değişkeninde aranır: kullanıcı yalnızca GROQ_API_KEY ekleyebilsin.
    aiLlmApiKey: env.AI_LLM_API_KEY ?? providerKey,
    aiLlmBaseUrl: (env.AI_LLM_BASE_URL ?? provider.baseUrl).replace(/\/+$/u, ''),
    aiLlmModel: env.AI_LLM_MODEL ?? provider.model,
    aiLlmTimeoutMs: Math.max(2000, Number(env.AI_LLM_TIMEOUT_MS ?? 15000)),
    aiLlmProviderId: provider.id,
    aiSearchApiKey: env.AI_SEARCH_API_KEY ?? env.EXA_API_KEY ?? '',
    aiSearchUrl: env.AI_SEARCH_URL ?? 'https://api.exa.ai/search',
    aiSearchResults: Math.min(5, Math.max(1, Number(env.AI_SEARCH_RESULTS ?? 3))),
    aiMaxGenerationsPerTick: Math.max(0, Number(env.AI_MAX_GENERATIONS ?? 6)),
  }
}
