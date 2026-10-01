/**
 * AI karakter seed'i — 50 NPC hesabını oluşturur.
 *
 * Kullanım: npm run seed:ai
 *
 * idempotent: kullanıcı adı zaten varsa atlanır, betik tekrar
 * çalıştırılabilir. Gerçek kullanıcı hesaplarına dokunulmaz.
 *
 * GÜVENLİK: AI hesapları parola hash'i OLMAZAN ve oturum açamayan
 * hesaplardır (bkz. services/auth.ts). Bu yüzden üretim ortamında da
 * çalıştırılabilir — kaynak kodda hiçbir parola yoktur.
 */
import { loadConfig } from '../config'
import { openDatabase } from '../db'
import type { Ctx } from '../context'
import { ConsoleMailer } from '../lib/mailer'
import { RateLimiter } from '../lib/ratelimit'
import { LocalObjectStorage } from '../services/storage'
import { createAiAgents, listAiAgents } from '../services/ai/agents'

function main(): void {
  const config = loadConfig()
  const ctx: Ctx = {
    db: openDatabase(config.dbPath),
    config,
    mailer: new ConsoleMailer(),
    storage: new LocalObjectStorage(config.uploadDir),
    rateLimiter: new RateLimiter(),
    now: () => Date.now(),
    fetchFn: fetch,
  }

  const created = createAiAgents(ctx)
  const all = listAiAgents(ctx)

  console.log(`${created} yeni AI karakter oluşturuldu (toplam ${all.length}).`)
  if (created === 0) {
    console.log('Tüm karakterler zaten var — hiçbiri değiştirilmedi.')
  }

  const enabled = all.filter((a) => a.enabled === 1).length
  console.log(`Aktif karakter: ${enabled} · pasif: ${all.length - enabled}`)
  console.log('Davranış motoru sunucu çalışırken otomatik devreye girer.')
}

main()
