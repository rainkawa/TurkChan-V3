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

describe('hide comment scores for first N minutes (community setting)', () => {
  test('fresh comment scores are masked; revealed after the window; votes still recorded', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'calm')
    await mod.post('/c/calm/settings', { title: 'Calm', description: '', visibility: 'public', rules: '', autoHideReports: '0', hideScores: '30' })
    const { agent: member } = await registerUser(world)
    const postId = await createPostVia(mod, 'calm', 'Herding test')
    const commentId = await createCommentVia(member, 'calm', postId, 'Early comment')
    await mod.json('/api/vote', { targetType: 'comment', targetId: commentId, value: 1 })

    let page = await member.get(`/c/calm/comments/${postId}`)
    let text = await page.text()
    expect(text).toContain('data-hidden="1"') // masked in the vote rail
    expect(text).toContain('· puan')

    world.tick(31 * 60 * 1000)
    page = await member.get(`/c/calm/comments/${postId}`)
    text = await page.text()
    expect(text).not.toContain('data-hidden="1"')
    expect(text).toContain('1 puan')
  })
})

describe('request hardening', () => {
  test('cross-origin form POSTs are rejected (CSRF defence-in-depth)', async () => {
    const { agent, password, username } = await registerUser(world)
    void password
    const res = await agent.request('/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example.com',
      },
      body: new URLSearchParams({ displayName: 'Hacked', bio: '' }).toString(),
    })
    expect(res.status).toBe(403)
    const row = world.ctx.db.prepare('SELECT display_name FROM users WHERE username = ?').get(username) as { display_name: string | null }
    expect(row.display_name).toBeNull()

    // Same-origin passes.
    const ok = await agent.request('http://localhost/settings', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://localhost',
      },
      body: new URLSearchParams({ displayName: 'Legit', bio: '' }).toString(),
    })
    expect(ok.status).toBe(302)
  })

  test('login next param cannot be used as an open redirect', async () => {
    const { username, password } = await registerUser(world)
    const agent = new Agent(world.app)
    for (const evil of ['//evil.example.com', 'https://evil.example.com', '/\\evil']) {
      const res = await agent.post(`/login?next=${encodeURIComponent(evil)}`, { identifier: username, password })
      expect(res.headers.get('location')).toBe('/')
      await agent.post('/logout')
    }
  })

  test('malformed cursors and unknown sorts degrade gracefully', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'sturdy')
    await createPostVia(agent, 'sturdy', 'Still standing')
    for (const url of [
      '/c/sturdy?sort=bogus',
      '/c/sturdy?sort=new&after=%%%%',
      '/c/sturdy?sort=top&t=nonsense',
      '/?after=' + 'A'.repeat(500),
    ]) {
      const res = await agent.get(url)
      expect(res.status).toBe(200)
    }
  })
})

describe('archived community lockdown', () => {
  test('editing posts/comments and voting are blocked once archived', async () => {
    const { agent: admin } = await registerUser(world)
    await createCommunityVia(admin, 'frozen')
    const { agent: author } = await registerUser(world)
    const postId = await createPostVia(author, 'frozen', 'Frozen post', 'Original')
    const commentId = await createCommentVia(author, 'frozen', postId, 'Frozen comment')

    const communityId = (world.ctx.db.prepare("SELECT id FROM communities WHERE name = 'frozen'").get() as { id: string }).id
    await admin.post(`/admin/communities/${communityId}/archive`)

    await author.post(`/posts/${postId}/edit`, { body: 'Changed' })
    expect((world.ctx.db.prepare('SELECT body FROM posts WHERE id = ?').get(postId) as { body: string }).body).toBe('Original')

    await author.post(`/comments/${commentId}/edit`, { body: 'Changed' })
    expect((world.ctx.db.prepare('SELECT body FROM comments WHERE id = ?').get(commentId) as { body: string }).body).toBe('Frozen comment')

    expect((await admin.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })).status).toBe(400)

    // Reading remains available.
    expect((await author.get(`/c/frozen/comments/${postId}`)).status).toBe(200)
  })
})

describe('markdown preview API', () => {
  test('returns sanitised HTML', async () => {
    const { agent } = await registerUser(world)
    const res = await agent.json('/api/markdown-preview', { text: '**bold** <script>alert(1)</script>' })
    const { html } = (await res.json()) as { html: string }
    expect(html).toContain('<strong>bold</strong>')
    expect(html).not.toContain('<script>')
  })
})

describe('US-043 graceful missing content', () => {
  test('unavailable-content pages always offer a way back home', async () => {
    const guest = new Agent(world.app)
    for (const url of ['/c/never_existed', '/c/never_existed/comments/aaaaaaaaaaaaa', '/tc/nobody_here']) {
      const res = await guest.get(url)
      expect([403, 404]).toContain(res.status)
      const text = await res.text()
      expect(text).toMatch(/href="\/"|Back to home/) // link back to the home feed
    }
  })

  test('deleted comment permalink renders the thread, never a raw error', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'resilient')
    const { agent: author } = await registerUser(world)
    const postId = await createPostVia(mod, 'resilient', 'Host post')
    const parentId = await createCommentVia(author, 'resilient', postId, 'Parent soon deleted')
    const childId = await createCommentVia(mod, 'resilient', postId, 'Child stays', parentId)
    await author.post(`/comments/${parentId}/delete`)

    const res = await mod.get(`/c/resilient/comments/${postId}/comment/${childId}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).toContain('[silindi]')
    expect(text).toContain('Child stays')

    // Permalink of the deleted comment itself also renders (placeholder).
    const deletedPermalink = await mod.get(`/c/resilient/comments/${postId}/comment/${parentId}`)
    expect(deletedPermalink.status).toBe(200)
  })
})

describe('membership request state visibility (US-011)', () => {
  test('requester sees pending, then approved state end to end', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'stateful', 'restricted')
    const { agent: requester, username } = await registerUser(world)

    // Restricted: readable by guests/members, join requires approval.
    let page = await requester.get('/c/stateful')
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('Katılmak için istek gönder')

    await requester.post('/c/stateful/join')
    page = await requester.get('/c/stateful')
    expect(await page.text()).toContain('İstek gönderildi')

    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: string }).id
    await mod.post(`/c/stateful/mod/requests/${userId}/approve`)
    page = await requester.get('/c/stateful')
    expect(await page.text()).toContain('Ayrıl') // now a member

    // Approved member of restricted community can post.
    const res = await requester.post('/c/stateful/submit?type=text', { title: 'Now allowed', body: '' })
    expect(res.headers.get('location')).toContain('/comments/')
  })
})
