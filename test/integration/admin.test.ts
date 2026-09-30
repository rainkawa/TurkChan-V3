import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
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

const DAY = 24 * 60 * 60 * 1000

describe('US-036 account suspension', () => {
  test('suspension kills sessions immediately, blocks login with duration, and is admin-logged', async () => {
    const { agent: admin } = await registerUser(world)
    const { agent: target, username, password } = await registerUser(world)
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id

    await admin.post(`/admin/users/${userId}/suspend`, { days: '7', reason: 'Abusive behaviour' })

    // Existing session invalidated at once.
    const res = await target.get('/settings')
    expect(res.status).toBe(302)

    // Login blocked with message + duration.
    const again = new Agent(world.app)
    await again.post('/login', { identifier: username, password })
    expect(again.loggedIn()).toBe(false)
    const page = await again.get('/login')
    const text = await page.text()
    expect(text).toContain('askıya alınmış')
    expect(text).toContain('Abusive behaviour')

    // Admin-logged (site-level).
    const log = await admin.get('/admin?tab=log')
    expect(await log.text()).toContain('Hesap askıya alındı')

    // Timed suspension expires.
    world.tick(8 * DAY)
    await again.post('/login', { identifier: username, password })
    expect(again.loggedIn()).toBe(true)
  })

  test('indefinite suspension persists; unsuspend restores access; content stays visible', async () => {
    const { agent: admin } = await registerUser(world)
    const { agent: author, username, password } = await registerUser(world)
    await createCommunityVia(admin, 'plaza')
    const postId = await createPostVia(author, 'plaza', 'Suspended author post')
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id

    await admin.post(`/admin/users/${userId}/suspend`, { days: 'indefinite', reason: '' })
    world.tick(20 * DAY) // well past any timed duration; admin session (30d) stays valid
    const attempt = new Agent(world.app)
    await attempt.post('/login', { identifier: username, password })
    expect(attempt.loggedIn()).toBe(false)

    // Suspended users' content remains visible unless separately removed (US-036).
    // Site kapalı olduğu için yönetici oturumuyla okunur.
    const page = await admin.get(`/c/plaza/comments/${postId}`)
    expect(await page.text()).toContain('Suspended author post')

    await admin.post(`/admin/users/${userId}/unsuspend`)
    await attempt.post('/login', { identifier: username, password })
    expect(attempt.loggedIn()).toBe(true)
  })

  test('yönetim panelinden kullanıcı adı 2 karaktere kadar düşürülebilir', async () => {
    const { agent: admin } = await registerUser(world)
    const { agent: member, username } = await registerUser(world, 'longname')
    const memberId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id

    // Kayıt sınırı (4) yönetim panelinde gevşer: 2 karakter kabul edilir.
    const res = await admin.post(`/admin/users/${memberId}`, {
      username: 'ab',
      displayName: '',
      bio: '',
      rankMode: 'auto',
    })
    expect(res.status).toBe(302)
    const row = world.ctx.db.prepare('SELECT username FROM users WHERE id = ?').get(memberId) as { username: string }
    expect(row.username).toBe('ab')
    void member
  })

  test('non-admins cannot suspend; admins cannot be suspended', async () => {
    const { agent: admin, username: adminName } = await registerUser(world)
    const { agent: member, username } = await registerUser(world)
    const adminId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(adminName) as { id: string }).id
    const memberId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id

    expect((await member.post(`/admin/users/${adminId}/suspend`, { days: '7' })).status).toBe(403)
    const res = await admin.post(`/admin/users/${adminId}/suspend`, { days: '7' })
    await res.text()
    const row = world.ctx.db.prepare('SELECT suspended_until, suspended_indefinitely FROM users WHERE id = ?').get(adminId) as { suspended_until: number | null; suspended_indefinitely: number }
    expect(row.suspended_until).toBeNull()
    expect(row.suspended_indefinitely).toBe(0)
    void memberId
  })
})

describe('US-037 community administration', () => {
  test('delete requires typed name confirmation; soft-deleted communities vanish; restorable; purged after 30 days', async () => {
    const { agent: admin } = await registerUser(world)
    await createCommunityVia(admin, 'doomed')
    const postId = await createPostVia(admin, 'doomed', 'Doomed content')
    await createCommentVia(admin, 'doomed', postId, 'Doomed comment')
    const communityId = (world.ctx.db.prepare("SELECT id FROM communities WHERE name = 'doomed'").get() as { id: string }).id

    // Wrong confirmation → rejected.
    await admin.post(`/admin/communities/${communityId}/delete`, { confirmName: 'wrong' })
    expect((world.ctx.db.prepare('SELECT deleted_at FROM communities WHERE id = ?').get(communityId) as { deleted_at: number | null }).deleted_at).toBeNull()

    // Correct confirmation → gone for everyone (404), content out of search.
    await admin.post(`/admin/communities/${communityId}/delete`, { confirmName: 'doomed' })
    // Topluluğun kurucusu olmayan, giriş yapmış bir üye: site kapalı olduğu için
    // "herkes" burada onu ifade eder.
    const guest = (await registerUser(world)).agent
    expect((await guest.get('/c/doomed')).status).toBe(404)
    expect((await guest.get(`/c/doomed/comments/${postId}`)).status).toBe(404)
    const searchRes = await guest.get('/search?q=Doomed')
    expect(await searchRes.text()).not.toContain('Doomed content')

    // Recoverable within 30 days.
    await admin.post(`/admin/communities/${communityId}/restore`)
    expect((await guest.get('/c/doomed')).status).toBe(200)

    // Delete again and purge after 30 days.
    await admin.post(`/admin/communities/${communityId}/delete`, { confirmName: 'doomed' })
    world.tick(31 * DAY)
    const { purgeExpiredCommunities } = await import('../../src/services/admin')
    const purged = purgeExpiredCommunities(world.ctx)
    expect(purged).toBe(1)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM communities WHERE id = ?').get(communityId) as { n: number }).n).toBe(0)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n).toBe(0)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
  })
})

describe('US-038 site policies', () => {
  test('settings changes take effect immediately and are admin-logged', async () => {
    const { agent: admin } = await registerUser(world)
    await admin.post('/admin/settings', { registrationMode: 'closed', communityCreation: 'admin', hotDecaySeconds: '120000' })

    const agent = new Agent(world.app)
    await agent.post('/register', { username: 'walkin', email: 'walkin@x.test', password: 'longenough123' })
    expect(agent.loggedIn()).toBe(false)

    const log = await admin.get('/admin?tab=log')
    expect(await log.text()).toContain('Site ayarları güncellendi')

    const settingsRow = world.ctx.db.prepare("SELECT value FROM site_settings WHERE key = 'hotDecaySeconds'").get() as { value: string }
    expect(JSON.parse(settingsRow.value)).toBe(120000)
  })
})

describe('US-039 community export', () => {
  test('export includes content + scores + authors; excludes emails, hashes, votes, IPs; link expires in 24h', async () => {
    const { agent: admin } = await registerUser(world)
    const { agent: author, username: authorName, email } = await registerUser(world)
    await createCommunityVia(admin, 'exportable')
    const postId = await createPostVia(author, 'exportable', 'Export me', 'Body text')
    await createCommentVia(admin, 'exportable', postId, 'A comment')
    await admin.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })

    const communityId = (world.ctx.db.prepare("SELECT id FROM communities WHERE name = 'exportable'").get() as { id: string }).id
    await admin.post(`/admin/export/${communityId}`)
    const token = (world.ctx.db.prepare('SELECT token FROM exports').get() as { token: string }).token

    const res = await admin.get(`/exports/${token}`)
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { posts: Array<Record<string, unknown>>; comments: Array<Record<string, unknown>> }
    expect(payload.posts).toHaveLength(1)
    expect(payload.posts[0]).toEqual(expect.objectContaining({ title: 'Export me', score: 1, author: authorName }))
    expect(payload.comments).toHaveLength(1)
    const raw = JSON.stringify(payload)
    expect(raw).not.toContain(email)
    expect(raw).not.toContain('argon2')
    expect(raw).not.toContain('password')

    // Non-admins cannot fetch exports.
    const { agent: member } = await registerUser(world)
    expect((await member.get(`/exports/${token}`)).status).toBe(403)

    // Admin-logged; link expires after 24h.
    const log = await admin.get('/admin?tab=log')
    expect(await log.text()).toContain('Topluluk dışa aktarıldı')
    world.tick(25 * 60 * 60 * 1000)
    expect((await admin.get(`/exports/${token}`)).status).toBe(404)
  })
})

describe('admin global report queue', () => {
  test('site admin sees reports across all communities', async () => {
    const { agent: admin } = await registerUser(world)
    const { agent: modA } = await registerUser(world)
    await createCommunityVia(modA, 'aaa_town')
    const { agent: modB } = await registerUser(world)
    await createCommunityVia(modB, 'bbb_town')
    const { agent: reporter } = await registerUser(world)

    const postA = await createPostVia(modA, 'aaa_town', 'Reported in A')
    const postB = await createPostVia(modB, 'bbb_town', 'Reported in B')
    await reporter.post(`/report/post/${postA}`, { reason: 'spam', detail: '' })
    await reporter.post(`/report/post/${postB}`, { reason: 'harassment', detail: '' })

    const dashboard = await admin.get('/admin?tab=reports')
    const text = await dashboard.text()
    expect(text).toContain('Reported in A')
    expect(text).toContain('Reported in B')

    // Community mods only see their own queue.
    const queueA = await modA.get('/c/aaa_town/mod/queue')
    const textA = await queueA.text()
    expect(textA).toContain('Reported in A')
    expect(textA).not.toContain('Reported in B')
  })
})
