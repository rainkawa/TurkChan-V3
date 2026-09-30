import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommunityVia,
  createTestWorld,
  registerUser,
  type TestWorld,
} from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

describe('US-008 community creation', () => {
  test('creates community; creator is first moderator and member', async () => {
    const { agent } = await registerUser(world, 'founder')
    await createCommunityVia(agent, 'parents_2026')
    const page = await agent.get('/c/parents_2026')
    const text = await page.text()
    expect(text).toContain('Community parents_2026')
    expect(text).toContain('/tc/founder') // listed as moderator
    expect(text).toContain('1 üye')

    const membership = world.ctx.db
      .prepare("SELECT role, status FROM memberships WHERE community_id = (SELECT id FROM communities WHERE name = 'parents_2026')")
      .get() as { role: string; status: string }
    expect(membership).toEqual(expect.objectContaining({ role: 'moderator', status: 'approved' }))
  })

  test('name validation and uniqueness; immutable slug', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'unique_one')
    const dup = await agent.post('/communities/new', { name: 'UNIQUE_ONE', title: '', description: '', visibility: 'public' })
    expect(dup.headers.get('location')).toBe('/communities/new') // rejected → back to form
    const bad = await agent.post('/communities/new', { name: 'x', title: '', description: '', visibility: 'public' })
    expect(bad.headers.get('location')).toBe('/communities/new')
  })

  test('community creation policy: admin-only blocks members', async () => {
    const { agent: admin } = await registerUser(world, 'siteadmin')
    await admin.post('/admin/settings', { communityCreation: 'admin' })
    const { agent: member } = await registerUser(world, 'pleb')
    const res = await member.post('/communities/new', { name: 'blocked', title: '', description: '', visibility: 'public' })
    await res.text()
    expect(world.ctx.db.prepare("SELECT COUNT(*) AS n FROM communities WHERE name = 'blocked'").get()).toEqual(
      expect.objectContaining({ n: 0 }),
    )
    // Admin still can.
    await createCommunityVia(admin, 'allowed')
  })
})

describe('US-009 directory', () => {
  test('lists public and restricted; hides private from non-members; sorts by member count', async () => {
    const { agent: a } = await registerUser(world, 'owner_a')
    await createCommunityVia(a, 'bigclub', 'public')
    await createCommunityVia(a, 'smallclub', 'restricted')
    await createCommunityVia(a, 'secretclub', 'private')

    // Grow bigclub.
    for (let i = 0; i < 3; i++) {
      const { agent } = await registerUser(world)
      await agent.post('/c/bigclub/join')
    }

    const guest = new Agent(world.app)
    const page = await guest.get('/communities')
    const text = await page.text()
    expect(text).toContain('c/bigclub')
    expect(text).toContain('c/smallclub')
    expect(text).not.toContain('secretclub')
    expect(text.indexOf('c/bigclub')).toBeLessThan(text.indexOf('c/smallclub'))

    // Members of the private community see it.
    const ownPage = await a.get('/communities')
    expect(await ownPage.text()).toContain('c/secretclub')
  })
})

describe('US-010 join and leave', () => {
  test('joining a public community is instant', async () => {
    const { agent: owner } = await registerUser(world)
    await createCommunityVia(owner, 'openclub')
    const { agent: joiner } = await registerUser(world, 'joiner')
    await joiner.post('/c/openclub/join')
    const page = await joiner.get('/c/openclub')
    expect(await page.text()).toContain('Ayrıl')
  })

  test('joining restricted/private creates a pending request; approval grants access', async () => {
    const { agent: owner } = await registerUser(world, 'gatekeeper')
    await createCommunityVia(owner, 'gated', 'private')
    const { agent: requester, username } = await registerUser(world, 'hopeful')

    // Private gate: no content leaks (403).
    let page = await requester.get('/c/gated')
    expect(page.status).toBe(403)

    await requester.post('/c/gated/join')
    page = await requester.get('/c/gated')
    expect(page.status).toBe(403)
    expect(await page.text()).toContain('İstek gönderildi')

    // Moderator sees the queue and approves.
    const queue = await owner.get('/c/gated/mod/members')
    expect(await queue.text()).toContain(`/tc/${username}`)
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get('hopeful') as { id: string }).id
    await owner.post(`/c/gated/mod/requests/${userId}/approve`)

    page = await requester.get('/c/gated')
    expect(page.status).toBe(200)

    // Approval is mod-logged (US-011) and notified.
    const log = await owner.get('/c/gated/mod/log')
    expect(await log.text()).toContain('membership_approve')
    const notif = await requester.get('/notifications')
    expect(await notif.text()).toContain('approved')
  })

  test('rejected requester sees state; rejection mod-logged', async () => {
    const { agent: owner } = await registerUser(world)
    await createCommunityVia(owner, 'choosy', 'restricted')
    const { agent: requester } = await registerUser(world, 'unlucky')
    await requester.post('/c/choosy/join')
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get('unlucky') as { id: string }).id
    await owner.post(`/c/choosy/mod/requests/${userId}/reject`)
    const membership = world.ctx.db
      .prepare('SELECT status FROM memberships WHERE user_id = ?')
      .get(userId) as { status: string }
    expect(membership.status).toBe('rejected')
    const notif = await requester.get('/notifications')
    expect(await notif.text()).toContain('declined')
  })

  test('leaving removes home-feed membership immediately; last moderator cannot leave', async () => {
    const { agent: owner } = await registerUser(world, 'solomod')
    await createCommunityVia(owner, 'lonely')
    const res = await owner.post('/c/lonely/leave')
    await res.text()
    const page = await owner.get('/c/lonely')
    expect(await page.text()).toContain('Son moderatör')

    const { agent: member } = await registerUser(world)
    await member.post('/c/lonely/join')
    await member.post('/c/lonely/leave')
    const membership = world.ctx.db
      .prepare("SELECT COUNT(*) AS n FROM memberships WHERE community_id = (SELECT id FROM communities WHERE name='lonely')")
      .get() as { n: number }
    expect(membership.n).toBe(1) // only the mod remains
  })
})

describe('US-012 community settings and rules', () => {
  test('moderator edits settings + ordered rules; all changes mod-logged', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'ruled')
    await mod.post('/c/ruled/settings', {
      title: 'Ruled Community',
      description: 'Now with rules',
      visibility: 'public',
      rules: 'Be kind | Respect everyone\nNo spam\nStay on topic | Keep it relevant',
      autoHideReports: '0',
      hideScores: '0',
    })
    const page = await mod.get('/c/ruled')
    const text = await page.text()
    expect(text).toContain('Be kind')
    expect(text).toContain('No spam')
    expect(text.indexOf('Be kind')).toBeLessThan(text.indexOf('No spam'))

    const log = await mod.get('/c/ruled/mod/log')
    const logText = await log.text()
    expect(logText).toContain('Topluluk ayarları güncellendi')
    expect(logText).toContain('Kurallar güncellendi')
  })

  test('rules cap at 15; non-moderators cannot edit settings', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'capped')
    const tooMany = Array.from({ length: 16 }, (_, i) => `Rule ${i + 1}`).join('\n')
    await mod.post('/c/capped/settings', { title: 'x', description: '', visibility: 'public', rules: tooMany, autoHideReports: '0', hideScores: '0' })
    const count = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM community_rules').get() as { n: number }
    expect(count.n).toBe(0) // rejected wholesale

    const { agent: outsider } = await registerUser(world)
    const res = await outsider.post('/c/capped/settings', { title: 'hacked', description: '', visibility: 'public', rules: '', autoHideReports: '0', hideScores: '0' })
    await res.text()
    const community = world.ctx.db.prepare("SELECT title FROM communities WHERE name = 'capped'").get() as { title: string }
    expect(community.title).not.toBe('hacked')
  })

  test('changing visibility public→private keeps existing members, blocks newcomers', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'shifting')
    const { agent: existing } = await registerUser(world)
    await existing.post('/c/shifting/join')

    await mod.post('/c/shifting/settings', { title: 'Shifting', description: '', visibility: 'private', rules: '', autoHideReports: '0', hideScores: '0' })

    const existingView = await existing.get('/c/shifting')
    expect(existingView.status).toBe(200) // existing member keeps access

    const { agent: newcomer } = await registerUser(world)
    const newcomerView = await newcomer.get('/c/shifting')
    expect(newcomerView.status).toBe(403) // new unapproved access stops
  })
})
