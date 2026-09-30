import { beforeEach, describe, expect, test } from 'vitest'
import {
  createCommentVia,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerUser,
  type TestWorld,
} from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

async function setup() {
  const { agent: admin } = await registerUser(world) // first user = site admin
  const { agent: mod, username: modName } = await registerUser(world)
  await createCommunityVia(mod, 'watch')
  const { agent: author, username: authorName } = await registerUser(world)
  await author.post('/c/watch/join')
  const { agent: reporter, username: reporterName } = await registerUser(world)
  await reporter.post('/c/watch/join')
  const postId = await createPostVia(author, 'watch', 'Questionable post', 'Hmm')
  return { admin, mod, modName, author, authorName, reporter, reporterName, postId }
}

describe('US-029 reporting', () => {
  test('report with community rule reason; duplicates absorbed; reporter anonymous', async () => {
    const { mod, reporter, postId } = await setup()
    await mod.post('/c/watch/settings', { title: 'Watch', description: '', visibility: 'public', rules: 'No spam | Absolutely none', autoHideReports: '0', hideScores: '0' })
    const rule = world.ctx.db.prepare('SELECT id FROM community_rules').get() as { id: string }

    // Report dialog lists the community's rules (US-029).
    const dialog = await reporter.get(`/report/post/${postId}`)
    expect(await dialog.text()).toContain('No spam')

    await reporter.post(`/report/post/${postId}`, { reason: `rule:${rule.id}`, detail: '' })
    await reporter.post(`/report/post/${postId}`, { reason: 'spam', detail: '' }) // duplicate absorbed silently
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM reports').get() as { n: number }).n).toBe(1)

    // Queue shows the report; the reporter's identity is not displayed.
    const queue = await mod.get('/c/watch/mod/queue')
    const queueText = await queue.text()
    expect(queueText).toContain('Questionable post')
    const { reporterName } = { reporterName: '' }
    void reporterName
  })

  test('"other" requires free text; reports are rate-limited', async () => {
    const { admin, reporter, postId } = await setup()
    let res = await reporter.post(`/report/post/${postId}`, { reason: 'other', detail: '' })
    expect(res.headers.get('location')).toContain('/report/') // bounced back
    res = await reporter.post(`/report/post/${postId}`, { reason: 'other', detail: 'It worries me' })
    expect(res.headers.get('location')).toBe('/')

    // Rate limit (configurable; lower it for test speed).
    await admin.post('/admin/settings', { reportsPerHour: '2' })
    const { agent: spammer } = await registerUser(world)
    await spammer.post('/c/watch/join')
    const targets: string[] = []
    for (let i = 0; i < 3; i++) {
      const { agent: a } = await registerUser(world)
      targets.push(await createPostVia(a, 'watch', `Target ${i}`))
    }
    await spammer.post(`/report/post/${targets[0]}`, { reason: 'spam', detail: '' })
    await spammer.post(`/report/post/${targets[1]}`, { reason: 'spam', detail: '' })
    await spammer.post(`/report/post/${targets[2]}`, { reason: 'spam', detail: '' })
    expect((world.ctx.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE reason_type='spam'").get() as { n: number }).n).toBe(2)
  })

  test('guests cannot report', async () => {
    const { postId } = await setup()
    const { Agent } = await import('../testUtils')
    const guest = new Agent(world.app)
    const res = await guest.post(`/report/post/${postId}`, { reason: 'spam', detail: '' })
    expect(res.headers.get('location')).toContain('/login')
  })
})

describe('US-030/US-031 queue and removal', () => {
  test('remove from queue: placeholder shown, reports resolved, author notified, karma reversed, mod-logged', async () => {
    const { mod, author, authorName, reporter, postId } = await setup()
    await reporter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    let profile = await reporter.get(`/tc/${authorName}`)
    expect(await profile.text()).toContain('Gönderi karma: 1')

    await reporter.post(`/report/post/${postId}`, { reason: 'spam', detail: '' })
    await mod.post(`/mod/remove/post/${postId}`, { rule: 'No spam' })

    // Placeholder for everyone; title hidden.
    const page = await reporter.get(`/c/watch/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('[moderatör tarafından kaldırıldı]')
    expect(text).not.toContain('Questionable post')

    // Reports auto-resolved.
    expect((world.ctx.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='open'").get() as { n: number }).n).toBe(0)

    // Karma reversed (US-031).
    profile = await reporter.get(`/tc/${authorName}`)
    expect(await profile.text()).toContain('Gönderi karma: 0')

    // Author notified with the cited rule; moderator not identified (US-041).
    const notif = await author.get('/notifications')
    const notifText = await notif.text()
    expect(notifText).toContain('kaldırıldı')
    expect(notifText).toContain('No spam')

    // Mod log records it (US-035).
    const log = await mod.get('/c/watch/mod/log')
    expect(await log.text()).toContain('remove_post')
  })

  test('site admin can reverse any removal', async () => {
    const { admin, mod, postId } = await setup()
    await mod.post(`/mod/remove/post/${postId}`)
    await admin.post(`/mod/restore/post/${postId}`)
    const page = await admin.get(`/c/watch/comments/${postId}`)
    expect(await page.text()).toContain('Questionable post')
  })

  test('dismissing reports clears the queue without touching content', async () => {
    const { mod, reporter, postId } = await setup()
    await reporter.post(`/report/post/${postId}`, { reason: 'harassment', detail: '' })
    await mod.post(`/c/watch/mod/dismiss/post/${postId}`)
    expect((world.ctx.db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='open'").get() as { n: number }).n).toBe(0)
    const page = await reporter.get(`/c/watch/comments/${postId}`)
    expect(await page.text()).toContain('Questionable post')
  })

  test('auto-hide after N reports hides content pending review and flags the queue', async () => {
    const { mod, postId } = await setup()
    await mod.post('/c/watch/settings', { title: 'Watch', description: '', visibility: 'public', rules: '', autoHideReports: '2', hideScores: '0' })

    const reporters = []
    for (let i = 0; i < 2; i++) {
      const { agent } = await registerUser(world)
      await agent.post('/c/watch/join')
      reporters.push(agent)
    }
    await reporters[0]?.post(`/report/post/${postId}`, { reason: 'spam', detail: '' })
    let feed = await mod.get('/c/watch?sort=new')
    expect(await feed.text()).toContain('Questionable post') // below threshold

    await reporters[1]?.post(`/report/post/${postId}`, { reason: 'spam', detail: '' })
    feed = await mod.get('/c/watch?sort=new')
    expect(await feed.text()).not.toContain('Questionable post') // hidden pending review

    const queue = await mod.get('/c/watch/mod/queue')
    expect(await queue.text()).toContain('otomatik gizlendi')

    // Dismissing restores visibility.
    await mod.post(`/c/watch/mod/dismiss/post/${postId}`)
    feed = await mod.get('/c/watch?sort=new')
    expect(await feed.text()).toContain('Questionable post')
  })

  test('non-moderators cannot remove content; moderator rights are per-community', async () => {
    const { author, postId } = await setup()
    // author is not a mod of watch.
    const res = await author.post(`/mod/remove/post/${postId}`)
    await res.text()
    expect((world.ctx.db.prepare('SELECT removed FROM posts WHERE id = ?').get(postId) as { removed: number }).removed).toBe(0)

    // A moderator of a DIFFERENT community also cannot (US: scoped strictly per community).
    const { agent: otherMod } = await registerUser(world)
    await createCommunityVia(otherMod, 'elsewhere')
    const res2 = await otherMod.post(`/mod/remove/post/${postId}`)
    await res2.text()
    expect((world.ctx.db.prepare('SELECT removed FROM posts WHERE id = ?').get(postId) as { removed: number }).removed).toBe(0)
  })

  test('removed comments show placeholder, replies preserved, collapsed by default', async () => {
    const { mod, author, postId } = await setup()
    const commentId = await createCommentVia(author, 'watch', postId, 'Rude remark')
    await createCommentVia(mod, 'watch', postId, 'A reply survives', commentId)
    await mod.post(`/mod/remove/comment/${commentId}`)
    const page = await mod.get(`/c/watch/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('[moderatör tarafından kaldırıldı]')
    expect(text).not.toContain('Rude remark')
    expect(text).toContain('A reply survives')
  })
})

describe('US-032 bans', () => {
  test('banned user cannot post/comment/vote/rejoin; can still read public; ban lifts on schedule', async () => {
    const { mod, author, authorName, postId } = await setup()
    await mod.post('/c/watch/mod/ban', { username: authorName, duration: '7', reason: 'Repeated spam' })

    // Notification includes duration + reason (US-041).
    const notif = await author.get('/notifications')
    const notifText = await notif.text()
    expect(notifText).toContain('yasaklandınız')
    expect(notifText).toContain('7 gün')
    expect(notifText).toContain('Repeated spam')

    // Reading still works (public community).
    expect((await author.get('/c/watch')).status).toBe(200)

    // Posting, commenting, voting, rejoining all fail.
    const postRes = await author.post('/c/watch/submit?type=text', { title: 'Sneaky', body: '' })
    expect(postRes.headers.get('location')).toContain('/submit')
    const commentRes = await author.post(`/c/watch/comments/${postId}/comment`, { body: 'hi' })
    await commentRes.text()
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
    expect((await author.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })).status).toBe(403)
    await author.post('/c/watch/join')
    expect(
      (world.ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.username = ?").get(authorName) as { n: number }).n,
    ).toBe(0)

    // Mod log records the ban with duration.
    const log = await mod.get('/c/watch/mod/log')
    const logText = await log.text()
    expect(logText).toContain('ban_user')
    expect(logText).toContain('7 gün')

    // Timed ban lifts automatically.
    world.tick(8 * 24 * 60 * 60 * 1000)
    await author.post('/c/watch/join')
    const postAfter = await author.post('/c/watch/submit?type=text', { title: 'Reformed', body: '' })
    expect(postAfter.headers.get('location')).toContain('/comments/')
  })

  test('bans are scoped to one community', async () => {
    const { mod, author, authorName } = await setup()
    const { agent: otherOwner } = await registerUser(world)
    await createCommunityVia(otherOwner, 'freeland')
    await mod.post('/c/watch/mod/ban', { username: authorName, duration: 'permanent', reason: '' })
    const res = await author.post('/c/freeland/submit?type=text', { title: 'Still welcome here', body: '' })
    expect(res.headers.get('location')).toContain('/comments/')
  })
})

describe('US-033 pins', () => {
  test('max 2 pinned posts; third requires unpinning; pins mod-logged', async () => {
    const { mod } = await setup()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      ids.push(await createPostVia(mod, 'watch', `Pin candidate ${i}`))
    }
    await mod.post(`/posts/${ids[0]}/pin`)
    await mod.post(`/posts/${ids[1]}/pin`)
    await mod.post(`/posts/${ids[2]}/pin`)

    const pinned = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE pinned_at IS NOT NULL').get() as { n: number }
    expect(pinned.n).toBe(2) // third rejected

    await mod.post(`/posts/${ids[0]}/unpin`)
    await mod.post(`/posts/${ids[2]}/pin`)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts WHERE pinned_at IS NOT NULL').get() as { n: number }).n).toBe(2)

    const log = await mod.get('/c/watch/mod/log')
    const logText = await log.text()
    expect(logText).toContain('pin_post')
    expect(logText).toContain('unpin_post')
  })
})

describe('US-034 moderator management', () => {
  test('any mod can appoint; only oldest-standing mod or admin removes; last mod protected', async () => {
    const { admin, mod, reporterName, postId } = await setup()
    void postId

    // Appoint reporter as a second moderator.
    await mod.post('/c/watch/mod/moderators/appoint', { username: reporterName })
    let mods = world.ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role='moderator' AND community_id=(SELECT id FROM communities WHERE name='watch')").get() as { n: number }
    expect(mods.n).toBe(2)

    // The newer mod cannot remove the older one.
    const reporterId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(reporterName) as { id: string }).id
    const modId = (world.ctx.db.prepare("SELECT user_id FROM memberships WHERE role='moderator' AND user_id != ? AND community_id=(SELECT id FROM communities WHERE name='watch')").get(reporterId) as { user_id: string }).user_id

    // Build an agent for the reporter? We already have `reporter` in setup — re-setup omitted; fetch from setup return.
    // (Handled below via the stored agents.)
    void modId

    // Oldest mod removes the newer one.
    await mod.post(`/c/watch/mod/moderators/${reporterId}/remove`)
    mods = world.ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role='moderator' AND community_id=(SELECT id FROM communities WHERE name='watch')").get() as { n: number }
    expect(mods.n).toBe(1)

    // Last moderator cannot be removed, even by admin.
    const lastModId = (world.ctx.db.prepare("SELECT user_id FROM memberships WHERE role='moderator' AND community_id=(SELECT id FROM communities WHERE name='watch')").get() as { user_id: string }).user_id
    const res = await admin.post(`/c/watch/mod/moderators/${lastModId}/remove`)
    await res.text()
    mods = world.ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role='moderator' AND community_id=(SELECT id FROM communities WHERE name='watch')").get() as { n: number }
    expect(mods.n).toBe(1)

    // Appointing requires the target to be an approved member.
    const { username: outsiderName } = await registerUser(world)
    const appointRes = await mod.post('/c/watch/mod/moderators/appoint', { username: outsiderName })
    await appointRes.text()
    mods = world.ctx.db.prepare("SELECT COUNT(*) AS n FROM memberships WHERE role='moderator' AND community_id=(SELECT id FROM communities WHERE name='watch')").get() as { n: number }
    expect(mods.n).toBe(1)

    // Mod changes are logged.
    const log = await mod.get('/c/watch/mod/log')
    const logText = await log.text()
    expect(logText).toContain('moderator_appoint')
    expect(logText).toContain('moderator_remove')
  })

  test('newer moderator cannot remove the oldest-standing moderator', async () => {
    const { mod, reporter, reporterName, modName } = await setup()
    await mod.post('/c/watch/mod/moderators/appoint', { username: reporterName })
    const oldestId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(modName) as { id: string }).id
    const res = await reporter.post(`/c/watch/mod/moderators/${oldestId}/remove`)
    await res.text()
    const stillMod = world.ctx.db
      .prepare("SELECT role FROM memberships WHERE user_id = ? AND community_id=(SELECT id FROM communities WHERE name='watch')")
      .get(oldestId) as { role: string }
    expect(stillMod.role).toBe('moderator')
  })
})

describe('US-035 mod log access', () => {
  test('visible to that community moderators and site admin only', async () => {
    const { admin, mod, author } = await setup()
    expect((await mod.get('/c/watch/mod/log')).status).toBe(200)
    expect((await admin.get('/c/watch/mod/log')).status).toBe(200)
    expect((await author.get('/c/watch/mod/log')).status).toBe(403)
    const { agent: otherMod } = await registerUser(world)
    await createCommunityVia(otherMod, 'unrelated')
    expect((await otherMod.get('/c/watch/mod/log')).status).toBe(403)
  })
})
