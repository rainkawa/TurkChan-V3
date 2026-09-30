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

describe('US-005/US-007 profiles and karma', () => {
  test('profile shows username, join date, karma, and history', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'plaza')
    const { agent: user, username } = await registerUser(world, 'contributor')
    const postId = await createPostVia(user, 'plaza', 'My contribution', 'Text')
    await createCommentVia(user, 'plaza', postId, 'And my comment')
    await mod.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })

    const guest = new Agent(world.app)
    const page = await guest.get(`/u/${username}`)
    const text = await page.text()
    expect(text).toContain(`u/${username}`)
    expect(text).toContain('Katıldı: 1 Temmuz 2026')
    expect(text).toContain('Gönderi karma: 1')
    expect(text).toContain('Yorum karma: 0')
    expect(text).toContain('My contribution')
    // Yorumlar kendi sekmesinde gösterilir.
    const commentsTab = await guest.get(`/u/${username}?tab=comments`)
    expect(await commentsTab.text()).toContain('And my comment')
  })

  test('private-community content is hidden from profile history but karma still counts (US-007)', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'inner', 'private')
    const { agent: insider, username } = await registerUser(world, 'insider')
    await insider.post('/c/inner/join')
    const insiderId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id
    await mod.post(`/c/inner/mod/requests/${insiderId}/approve`)

    const postId = await createPostVia(insider, 'inner', 'INNER-CIRCLE-POST')
    await mod.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })

    // Outsider: karma counts, content hidden.
    const guest = new Agent(world.app)
    const page = await guest.get(`/u/${username}`)
    const text = await page.text()
    expect(text).toContain('Gönderi karma: 1')
    expect(text).not.toContain('INNER-CIRCLE-POST')

    // Fellow member sees it.
    const modView = await mod.get(`/u/${username}`)
    expect(await modView.text()).toContain('INNER-CIRCLE-POST')
  })
})

describe('US-006 profile editing', () => {
  test('display name and bio save; bio renders as plain text (no HTML injection)', async () => {
    const { agent, username } = await registerUser(world)
    await agent.post('/settings', { displayName: 'Ustazah A', bio: '<script>alert(1)</script> loves <b>teaching</b>' })
    const page = await agent.get(`/u/${username}`)
    const text = await page.text()
    expect(text).toContain('Ustazah A')
    expect(text).toContain('&lt;script&gt;')
    expect(text).not.toContain('<script>alert(1)</script>')
    expect(text).not.toContain('<b>teaching</b>')

    // Length limits.
    const res = await agent.post('/settings', { displayName: 'x'.repeat(41), bio: '' })
    await res.text()
    const row = world.ctx.db.prepare('SELECT display_name FROM users WHERE username = ?').get(username) as { display_name: string }
    expect(row.display_name).toBe('Ustazah A') // unchanged
  })
})

describe('US-040 reply notifications', () => {
  test('direct replies notify; deep-link opens the reply; unread count shows; mark all read', async () => {
    const { agent: op, username: opName } = await registerUser(world)
    await createCommunityVia(op, 'chatty')
    const { agent: replier } = await registerUser(world)
    const postId = await createPostVia(op, 'chatty', 'Notify me')

    const commentId = await createCommentVia(replier, 'chatty', postId, 'Direct reply to post')
    let home = await op.get('/')
    expect(await home.text()).toContain('notif-badge')

    const list = await op.get('/notifications')
    const listText = await list.text()
    expect(listText).toContain('gönderinize')

    // Opening deep-links to the permalink and marks it read.
    const notifId = (world.ctx.db.prepare('SELECT id FROM notifications').get() as { id: string }).id
    const open = await op.get(`/notifications/open/${notifId}`)
    expect(open.headers.get('location')).toContain(`/comment/${commentId}`)
    home = await op.get('/')
    expect(await home.text()).not.toContain('notif-badge')
    void opName
  })

  test('nested reply notifies the parent comment author, not the post author; no self-notifications', async () => {
    const { agent: op } = await registerUser(world, 'poster_op')
    await createCommunityVia(op, 'threads')
    const { agent: alice } = await registerUser(world, 'alice_n')
    const { agent: bob } = await registerUser(world, 'bob_n')
    const postId = await createPostVia(op, 'threads', 'Thread start')

    const aliceComment = await createCommentVia(alice, 'threads', postId, 'Alice top-level')
    await createCommentVia(bob, 'threads', postId, 'Bob replies to Alice', aliceComment)

    const aliceNotifs = await alice.get('/notifications')
    expect(await aliceNotifs.text()).toContain('yorumunuza')

    // op got exactly one notification (Alice's top-level), not Bob's nested reply.
    const opNotifCount = (world.ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = 'poster_op')",
    ).get() as { n: number }).n
    expect(opNotifCount).toBe(1)

    // Self-reply generates nothing.
    await createCommentVia(alice, 'threads', postId, 'Alice replies to herself', aliceComment)
    const aliceNotifCount = (world.ctx.db.prepare(
      "SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE username = 'alice_n')",
    ).get() as { n: number }).n
    expect(aliceNotifCount).toBe(1)
  })

  test('notification is withdrawn when the reply is removed before being read (US-040)', async () => {
    const { agent: op } = await registerUser(world, 'withdraw_op')
    await createCommunityVia(op, 'modtown')
    const { agent: troll } = await registerUser(world)
    const postId = await createPostVia(op, 'modtown', 'Bait post')
    const commentId = await createCommentVia(troll, 'modtown', postId, 'Nasty reply')

    // op moderates their own community: remove before reading.
    await op.post(`/mod/remove/comment/${commentId}`)

    const list = await op.get('/notifications')
    const text = await list.text()
    expect(text).not.toContain('gönderinize') // withdrawn
    const home = await op.get('/')
    expect(await home.text()).not.toContain('notif-badge')
  })
})
