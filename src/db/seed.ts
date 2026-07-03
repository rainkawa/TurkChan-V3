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
    console.log('Database already has users — skipping seed.')
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
    name: 'weekend_madrasah',
    title: 'Weekend Madrasah — Parents',
    description: 'Schedules, logistics, and Q&A for the weekend Islamic programme.',
    visibility: 'public',
  })
  replaceRules(ctx, ustazah, weekend, [
    { title: 'Be respectful', detail: 'Adab first, always.' },
    { title: 'Keep it relevant', detail: 'Programme-related discussion only.' },
    { title: 'No personal data of children', detail: 'Never post names/photos of minors without consent.' },
  ])

  const volunteers = createCommunity(ctx, ustazah, {
    name: 'volunteers',
    title: 'Volunteer Youth Leaders',
    description: 'Coordination space for volunteers across programmes.',
    visibility: 'restricted',
  })

  for (const user of [aisyah, rahim, nurul]) joinCommunity(ctx, user, weekend)
  joinCommunity(ctx, admin, weekend)

  const schedule = createTextPost(ctx, ustazah, weekend, {
    title: 'Term 3 schedule and logistics (pinned)',
    body: '## Term 3\n\n- **Sat 9am–12pm**: Quran + Tajweed\n- **Sun 9am–11am**: Fiqh for kids\n\nDoors open 8.40am. Please arrive by 8.55am.',
  })
  pinPost(ctx, ustazah, schedule.id)

  const faq = createTextPost(ctx, ustazah, weekend, {
    title: 'FAQ: what to bring, parking, pickup',
    body: '**What to bring:** own mushaf if you have one, water bottle.\n\n**Parking:** use the open-air carpark; the basement is reserved.\n\n**Pickup:** at the side gate, 12 sharp.',
  })
  pinPost(ctx, ustazah, faq.id)

  const question = createTextPost(ctx, aisyah, weekend, {
    title: 'Should children bring their own Quran?',
    body: 'My son starts this Saturday — does he need his own mushaf or are copies provided?',
  })
  const answer = createComment(ctx, ustazah, question.id, {
    body: 'Copies are provided in class, but bringing his own is encouraged for home revision. Any standard 15-line mushaf is fine.',
  })
  createComment(ctx, rahim, question.id, {
    body: 'We bought ours from the bookshop next to the mosque — RM12 and sturdy.',
    parentId: answer.id,
  })
  for (const user of [aisyah, rahim, nurul, admin]) {
    if (user.id !== answer.author_id) castVote(ctx, user, 'comment', answer.id, 1)
    if (user.id !== question.author_id) castVote(ctx, user, 'post', question.id, 1)
  }

  createTextPost(ctx, rahim, weekend, {
    title: 'Carpool from Tampines on Saturdays?',
    body: 'We have 2 spare seats leaving Tampines Central at 8.15am. Reply if interested.',
  })
  await createLinkPost(ctx, ustazah, volunteers, {
    title: 'Volunteer briefing deck (term 3)',
    url: 'https://example.org/briefing-term3',
  })

  console.log('Seeded demo data:')
  console.log('  communities: c/weekend_madrasah (public), c/volunteers (restricted)')
  console.log('  admin login: admin / seed-admin-pass-1')
  console.log('  moderator:   ustazah_f / seed-mod-pass-1')
  console.log('  members:     aisyah, rahim, nurul / seed-user-pass-{1,2,3}')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
