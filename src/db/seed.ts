/**
 * Demo seed: an admin, a moderator, members, two communities with pinned
 * schedule/FAQ posts, threads, and votes — the "seeded content" launch gate.
 *
 * Usage: npm run seed  (safe to re-run; skips if users already exist)
 * Default accounts (change in production!):
 *   admin / seed-admin-pass-1, ustazah_f / seed-mod-pass-1, aisyah / seed-user-pass-1 ...
 */
import { loadConfig } from '../config'
import { openDatabase } from '../db'
import type { Ctx } from '../context'
import { ConsoleMailer } from '../lib/mailer'
import { RateLimiter } from '../lib/ratelimit'
import { LocalObjectStorage } from '../services/storage'
import { register } from '../services/auth'
import { createCommunity, joinCommunity, replaceRules } from '../services/communities'
import { createTextPost, createLinkPost } from '../services/posts'
import { createComment } from '../services/comments'
import { castVote } from '../services/votes'
import { pinPost } from '../services/moderation'
import type { UserRow } from '../types'

async function main() {
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

  const existing = (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
  if (existing > 0) {
    console.log('Veritabanında zaten kullanıcı var — seed atlandı.')
    return
  }

  const mkUser = async (username: string, password: string): Promise<UserRow> => {
    const { user } = await register(ctx, {
      username,
      email: `${username}@seed.local`,
      password,
      ip: `192.0.2.${Math.floor(Math.random() * 200) + 1}`,
    })
    return user
  }

  const admin = await mkUser('admin', 'seed-admin-pass-1') // first user = site admin
  const ustazah = await mkUser('ustazah_f', 'seed-mod-pass-1')
  const aisyah = await mkUser('aisyah', 'seed-user-pass-1')
  const rahim = await mkUser('rahim', 'seed-user-pass-2')
  const nurul = await mkUser('nurul', 'seed-user-pass-3')

  const weekend = createCommunity(ctx, ustazah, {
    name: 'hafta_sonu',
    title: 'Hafta Sonu Eğitimi — Veli',
    description: 'Hafta sonu İslaî programı için program, lojistik ve soru-cevap.',
    visibility: 'public',
  })
  replaceRules(ctx, ustazah, weekend, [
    { title: 'Saygılı olun', detail: 'Önce edep, her zaman.' },
    { title: 'Konuyla ilgili kalın', detail: 'Yalnızca programla ilgili tartışmalar.' },
    { title: 'Çocukların kişisel verileri paylaşmayın', detail: 'Reşit olmayanların isim/fotoğraflarını izin almadan paylaşmayın.' },
  ])

  const volunteers = createCommunity(ctx, ustazah, {
    name: 'gonulluler',
    title: 'Gönüllü Genç Liderler',
    description: 'Programlar arası gönüllüler için koordinasyon alanı.',
    visibility: 'restricted',
  })

  for (const user of [aisyah, rahim, nurul]) joinCommunity(ctx, user, weekend)
  joinCommunity(ctx, admin, weekend)

  const schedule = createTextPost(ctx, ustazah, weekend, {
    title: '3. Dönem programı ve lojistik (sabit)',
    body: '## 3. Dönem\n\n- **Cumartesi 09.00–12.00**: Kur’an ve Tecvid\n- **Pazar 09.00–11.00**: Çocuklar için fıkıh\n\nKapılar 08.40’ta açılır. Lütfen 08.55’e kadar gelin.',
  })
  pinPost(ctx, ustazah, schedule.id)

  const faq = createTextPost(ctx, ustazah, weekend, {
    title: 'SSS: ne getirmeli, otopark, teslim',
    body: '**Ne getirmeli:** varsa kendi mushafınız, su şişesi.\n\n**Otopark:** açık otoparkı kullanın; otopark altı ayrılmıştır.\n\n**Teslim:** yan kapıdan, tam 12.00’de.',
  })
  pinPost(ctx, ustazah, faq.id)

  const question = createTextPost(ctx, aisyah, weekend, {
    title: 'Çocuklar kendi mushaflarını getirmeli mi?',
    body: 'Oğlum bu cumartesi başlıyor — kendi mushafını getirmesi gerekiyor mu, yoksa kopyalar sağlanıyor mu?',
  })
  const answer = createComment(ctx, ustazah, question.id, {
    body: 'Sınıfta kopyalar sağlanıyor, ancak evde tekrar için kendi mushafını getirmesi teşvik edilir. Standart 15 satırlık herhangi bir mushaf uygundur.',
  })
  createComment(ctx, rahim, question.id, {
    body: 'Bizimkini cami yanındaki kitapçıdan aldık — sağlam ve uygun fiyatlıydı.',
    parentId: answer.id,
  })
  for (const user of [aisyah, rahim, nurul, admin]) {
    if (user.id !== answer.author_id) castVote(ctx, user, 'comment', answer.id, 1)
    if (user.id !== question.author_id) castVote(ctx, user, 'post', question.id, 1)
  }

  createTextPost(ctx, rahim, weekend, {
    title: 'Cumartesi günleri yolculuk paylaşımı var mı?',
    body: 'Merkezden 08.15’te çıkan aracımızda 2 boş koltuk var. İlgilenenler yanıtlayabilir.',
  })
  await createLinkPost(ctx, ustazah, volunteers, {
    title: 'Gönüllü bilgilendirme sunumu (3. dönem)',
    url: 'https://example.org/briefing-donem-3',
  })

  console.log('Demo verisi eklendi:')
  console.log('  topluluklar: c/hafta_sonu (herkese açık), c/gonulluler (kısıtlı)')
  console.log('  yönetici girişi: admin / seed-admin-pass-1')
  console.log('  moderatör:       ustazah_f / seed-mod-pass-1')
  console.log('  üyeler:          aisyah, rahim, nurul / seed-user-pass-{1,2,3}')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
