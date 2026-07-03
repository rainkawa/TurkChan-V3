/** Static process configuration. Runtime-editable policies live in site_settings (see services/settings.ts). */
export interface AppConfig {
  port: number
  dbPath: string
  uploadDir: string
  exportDir: string
  baseUrl: string
  secureCookies: boolean
  sessionTtlMs: number
  resetTokenTtlMs: number
  exportLinkTtlMs: number
  maxImageBytes: number
  linkPreviewTimeoutMs: number
  communityPurgeAfterMs: number
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
    sessionTtlMs: 30 * DAY_MS,
    resetTokenTtlMs: 60 * 60 * 1000,
    exportLinkTtlMs: DAY_MS,
    maxImageBytes: 10 * 1024 * 1024,
    linkPreviewTimeoutMs: 5000,
    communityPurgeAfterMs: 30 * DAY_MS,
  }
}
