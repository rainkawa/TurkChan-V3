/**
 * NPC seed'i — 50 simülasyon karakteri oluşturur.
 *
 * Kullanım: npm run seed:npc
 *
 * Idempotent: kullanıcı adı zaten varsa atlanır, betik tekrar
 * çalıştırılabilir. Gerçek kullanıcı hesaplarına dokunulmaz.
 *
 * GÜVENLİK: NPC hesapları parola hash'i OLMAZAN ve oturum açamayan
 * hesaplardır (bkz. services/auth.ts). Kaynak kodda hiçbir parola yoktur.
 *
 * Tamamen yerel çalışır: API anahtarı veya internet bağlantısı gerekmez.
 */
import { loadConfig } from '../config'
import { openDatabase } from '../db'
import type { Ctx } from '../context'
import { ConsoleMailer } from '../lib/mailer'
import { RateLimiter } from '../lib/ratelimit'
import { LocalObjectStorage } from '../services/storage'
import { createNpcAgents, listNpcAgents } from '../services/npc/agents'

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

  const created = createNpcAgents(ctx)
  const all = listNpcAgents(ctx)

  console.log(`${created} yeni NPC oluşturuldu (toplam ${all.length}).`)
  if (created === 0) {
    console.log('Tüm NPC\'ler zaten var — hiçbiri değiştirilmedi.')
  }

  const enabled = all.filter((a) => a.enabled === 1).length
  console.log(`Aktif NPC: ${enabled} · pasif: ${all.length - enabled}`)
  console.log('Simülasyon motoru sunucu çalışırken otomatik devreye girer.')
}

main()
