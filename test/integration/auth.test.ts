import { beforeEach, describe, expect, test } from 'vitest'
import { Agent, createTestWorld, registerUser, type TestWorld } from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

describe('US-001 registration', () => {
  test('registers, logs in immediately, and returns to the triggering page', async () => {
    const agent = new Agent(world.app)
    const res = await agent.post('/register?next=%2Fcommunities', {
      username: 'aisyah',
      email: 'aisyah@example.test',
      password: 'longenough123',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/communities')
    expect(agent.loggedIn()).toBe(true)
    const home = await agent.get('/')
    expect(await home.text()).toContain('/tc/aisyah')
  })

  test('first registered user becomes site admin', async () => {
    const { agent } = await registerUser(world, 'first_admin')
    const res = await agent.get('/admin')
    expect(res.status).toBe(200)
    const { agent: second } = await registerUser(world, 'regular')
    const denied = await second.get('/admin')
    expect(denied.status).toBe(403)
  })

  test('rejects invalid username, short password, bad email', async () => {
    const agent = new Agent(world.app)
    for (const [form, expectedError] of [
      [{ username: 'ab', email: 'a@b.co', password: 'longenough123' }, 'Kullanıcı adı'],
      [{ username: 'has space', email: 'a@b.co', password: 'longenough123' }, 'harf, rakam'],
      [{ username: 'okname', email: 'not-an-email', password: 'longenough123' }, 'Geçerli bir e-posta'],
      [{ username: 'okname', email: 'a@b.co', password: 'short' }, 'En az 10 karakter'],
    ] as const) {
      const res = await agent.post('/register', form as Record<string, string>)
      expect(res.status).toBe(302) // PRG back to form with flash
      const page = await agent.get('/register')
      expect(await page.text()).toContain(expectedError)
    }
  })

  test('duplicate username: clear error; duplicate email: non-enumerating message', async () => {
    await registerUser(world, 'taken_name', { email: 'taken@example.test' })

    const dupUser = new Agent(world.app)
    await dupUser.post('/register', { username: 'TAKEN_NAME', email: 'new@example.test', password: 'longenough123' })
    let page = await dupUser.get('/register')
    expect(await page.text()).toContain('zaten alınmış')

    const dupEmail = new Agent(world.app)
    await dupEmail.post('/register', { username: 'fresh_name', email: 'taken@example.test', password: 'longenough123' })
    page = await dupEmail.get('/register')
    const text = await page.text()
    // Never confirms the address exists (US-001).
    expect(text).toContain('Bu e-posta zaten kayıtlıysa')
    expect(text).not.toContain('kayıtlıdır')
  })

  test('passwords stored as Argon2id hashes, never plaintext', async () => {
    await registerUser(world, 'hashcheck', { password: 'supersecret999' })
    const row = world.ctx.db
      .prepare('SELECT password_hash FROM users WHERE username_lower = ?')
      .get('hashcheck') as { password_hash: string }
    expect(row.password_hash).toMatch(/^\$argon2id\$/)
    expect(row.password_hash).not.toContain('supersecret999')
  })

  test('per-IP registration rate limit', async () => {
    for (let i = 0; i < 5; i++) {
      await registerUser(world, `ratelim${i}`, { ip: '9.9.9.9' })
    }
    const agent = new Agent(world.app)
    const res = await agent.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '9.9.9.9' },
      body: new URLSearchParams({ username: 'onemore', email: 'onemore@x.test', password: 'longenough123' }).toString(),
    })
    expect(res.status).toBe(302)
    const page = await agent.get('/register')
    expect(await page.text()).toContain('Yavaşlayın')
  })
})

describe('US-038 registration modes', () => {
  test('closed mode shows explanatory message and blocks registration', async () => {
    const { agent: admin } = await registerUser(world, 'admin1')
    await admin.post('/admin/settings', { registrationMode: 'closed' })

    const agent = new Agent(world.app)
    const page = await agent.get('/register')
    expect(await page.text()).toContain('şu anda kapalı')
    const res = await agent.post('/register', { username: 'nope', email: 'nope@x.test', password: 'longenough123' })
    await res.text()
    expect(agent.loggedIn()).toBe(false)
  })

  test('invite-only mode requires a valid, unexpired, un-exhausted invite', async () => {
    const { agent: admin } = await registerUser(world, 'admin2')
    await admin.post('/admin/settings', { registrationMode: 'invite' })
    await admin.post('/admin/invites', { expiresInDays: '7', maxUses: '1' })
    const invite = world.ctx.db.prepare('SELECT code FROM invites').get() as { code: string }

    // Without invite: rejected.
    const noInvite = new Agent(world.app)
    await noInvite.post('/register', { username: 'lost', email: 'lost@x.test', password: 'longenough123' })
    expect(noInvite.loggedIn()).toBe(false)

    // With invite: works.
    const invited = new Agent(world.app)
    await invited.post('/register', {
      username: 'invited',
      email: 'invited@x.test',
      password: 'longenough123',
      inviteCode: invite.code,
    })
    expect(invited.loggedIn()).toBe(true)

    // Max uses exhausted.
    const third = new Agent(world.app)
    await third.post('/register', {
      username: 'toolate',
      email: 'toolate@x.test',
      password: 'longenough123',
      inviteCode: invite.code,
    })
    expect(third.loggedIn()).toBe(false)
  })

  test('expired invites are rejected', async () => {
    const { agent: admin } = await registerUser(world, 'admin3')
    await admin.post('/admin/settings', { registrationMode: 'invite' })
    await admin.post('/admin/invites', { expiresInDays: '1', maxUses: '10' })
    const invite = world.ctx.db.prepare('SELECT code FROM invites').get() as { code: string }
    world.tick(2 * 24 * 60 * 60 * 1000)
    const agent = new Agent(world.app)
    await agent.post('/register', {
      username: 'late',
      email: 'late@x.test',
      password: 'longenough123',
      inviteCode: invite.code,
    })
    expect(agent.loggedIn()).toBe(false)
  })
})

describe('US-002 login and logout', () => {
  test('login by username or email; logout invalidates server-side session', async () => {
    const { password, email } = await registerUser(world, 'logintest')

    const byUsername = new Agent(world.app)
    let res = await byUsername.post('/login', { identifier: 'LoginTest', password })
    expect(res.status).toBe(302)
    expect(byUsername.loggedIn()).toBe(true)

    const byEmail = new Agent(world.app)
    res = await byEmail.post('/login', { identifier: email, password })
    expect(byEmail.loggedIn()).toBe(true)

    // Grab the raw sid to prove server-side invalidation (not just cookie clearing).
    const sid = byEmail.cookieHeader().match(/sid=([^;]+)/)?.[1] as string
    await byEmail.post('/logout')
    expect(byEmail.loggedIn()).toBe(false)
    const zombie = new Agent(world.app)
    const zombieRes = await zombie.request('/settings', { headers: { cookie: `sid=${sid}` } })
    expect(zombieRes.status).toBe(302) // redirected to login: session is dead server-side
  })

  test('wrong password rejected with a generic error', async () => {
    await registerUser(world, 'wrongpw')
    const agent = new Agent(world.app)
    await agent.post('/login', { identifier: 'wrongpw', password: 'not-the-password' })
    expect(agent.loggedIn()).toBe(false)
    const page = await agent.get('/login')
    expect(await page.text()).toContain('Kullanıcı adı/e-posta veya parola hatalı')
  })

  test('5 failed logins in 15 minutes locks the account with a clear message', async () => {
    const { password } = await registerUser(world, 'locked')
    const attacker = new Agent(world.app)
    for (let i = 0; i < 5; i++) {
      await attacker.post('/login', { identifier: 'locked', password: 'wrong-guess-99' })
    }
    // Even the CORRECT password is now rejected.
    const victim = new Agent(world.app)
    await victim.post('/login', { identifier: 'locked', password })
    expect(victim.loggedIn()).toBe(false)
    const page = await victim.get('/login')
    expect(await page.text()).toContain('geçici olarak kilitlendi')

    // Lockout expires after the window.
    world.tick(16 * 60 * 1000)
    await victim.post('/login', { identifier: 'locked', password })
    expect(victim.loggedIn()).toBe(true)
  })
})

describe('US-003 password reset', () => {
  test('same confirmation whether or not the email exists', async () => {
    await registerUser(world, 'resetme', { email: 'resetme@example.test' })
    const agent = new Agent(world.app)

    await agent.post('/forgot-password', { email: 'resetme@example.test' })
    let page = await agent.get('/forgot-password')
    const known = await page.text()

    await agent.post('/forgot-password', { email: 'stranger@example.test' })
    page = await agent.get('/forgot-password')
    const unknown = await page.text()

    expect(known).toContain('sıfırlama bağlantısı gönderildi')
    expect(unknown).toContain('sıfırlama bağlantısı gönderildi')
    expect(world.mailer.sent).toHaveLength(1) // only the real account got mail
  })

  test('reset link works once, expires after 60 minutes, and kills all sessions', async () => {
    const { agent: existing, email } = await registerUser(world, 'resetflow')
    const requester = new Agent(world.app)
    await requester.post('/forgot-password', { email })
    const mail = world.mailer.sent[0]
    const token = mail?.text.match(/reset-password\/([A-Za-z0-9_-]+)/)?.[1] as string
    expect(token).toBeTruthy()

    const res = await requester.post(`/reset-password/${token}`, { password: 'brandnewpass99' })
    expect(res.headers.get('location')).toBe('/login')

    // Old session invalidated (US-003).
    const settingsRes = await existing.get('/settings')
    expect(settingsRes.status).toBe(302)

    // New password works; token is single-use.
    const fresh = new Agent(world.app)
    await fresh.post('/login', { identifier: 'resetflow', password: 'brandnewpass99' })
    expect(fresh.loggedIn()).toBe(true)
    const reuse = await requester.post(`/reset-password/${token}`, { password: 'anotherpass99' })
    await reuse.text()
    const page = await requester.get(`/reset-password/${token}`)
    expect(await page.text()).toContain('geçersiz ya da süresi dolmuş')
  })

  test('expired token is rejected', async () => {
    const { email } = await registerUser(world, 'expiry')
    const agent = new Agent(world.app)
    await agent.post('/forgot-password', { email })
    const token = world.mailer.sent[0]?.text.match(/reset-password\/([A-Za-z0-9_-]+)/)?.[1] as string
    world.tick(61 * 60 * 1000)
    await agent.post(`/reset-password/${token}`, { password: 'shouldnotwork1' })
    const login = new Agent(world.app)
    await login.post('/login', { identifier: 'expiry', password: 'shouldnotwork1' })
    expect(login.loggedIn()).toBe(false)
  })
})

describe('US-004 account deletion', () => {
  test('requires the correct password', async () => {
    const { agent } = await registerUser(world, 'staying')
    await agent.post('/settings/delete-account', { password: 'wrong-password' })
    expect(agent.loggedIn()).toBe(true)
    const row = world.ctx.db.prepare('SELECT deleted FROM users WHERE username_lower = ?').get('staying') as { deleted: number }
    expect(row.deleted).toBe(0)
  })

  test('anonymises profile, purges credentials, keeps content as [deleted]', async () => {
    const { agent: mod } = await registerUser(world, 'keeper')
    await mod.post('/communities/new', { name: 'general', title: 'General', description: '', visibility: 'public' })

    const { agent, password } = await registerUser(world, 'leaver', { email: 'leaver@example.test' })
    const postRes = await agent.post('/c/general/submit?type=text', { title: 'My question', body: 'Details here' })
    const postId = (postRes.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string

    await agent.post('/settings/delete-account', { password })
    expect(agent.loggedIn()).toBe(false)

    const row = world.ctx.db
      .prepare('SELECT deleted, email_lower, password_hash, display_name, bio FROM users WHERE username_lower = ?')
      .get('leaver') as { deleted: number; email_lower: string | null; password_hash: string }
    expect(row.deleted).toBe(1)
    expect(row.email_lower).toBeNull()
    expect(row.password_hash).toBe('')

    // Profile URL → not-available page, not an error (US-005).
    const guest = new Agent(world.app)
    const profile = await guest.get('/tc/leaver')
    expect(profile.status).toBe(404)
    expect(await profile.text()).toContain('kullanılamıyor')

    // Content remains, attributed to [deleted].
    const postPage = await guest.get(`/c/general/comments/${postId}`)
    expect(postPage.status).toBe(200)
    const text = await postPage.text()
    expect(text).toContain('My question')
    expect(text).toContain('[silindi]')
    expect(text).not.toContain('u/leaver')

    // Login is impossible.
    const returning = new Agent(world.app)
    await returning.post('/login', { identifier: 'leaver', password })
    expect(returning.loggedIn()).toBe(false)
  })
})
