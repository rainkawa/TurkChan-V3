import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
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

const HOUR = 60 * 60 * 1000

function extractOrder(html: string, titles: string[]): string[] {
  return titles
    .filter((title) => html.includes(title))
    .sort((a, b) => html.indexOf(a) - html.indexOf(b))
}

describe('US-025 hot sort', () => {
  test('a new post with score 0 outranks a week-old post with modest score', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'front')
    await createPostVia(agent, 'front', 'OLD-MODEST-POST')
    const oldId = (world.ctx.db.prepare('SELECT id FROM posts').get() as { id: string }).id
    world.ctx.db.prepare('UPDATE posts SET score = 15, upvotes = 15 WHERE id = ?').run(oldId)

    world.tick(7 * 24 * HOUR)
    await createPostVia(agent, 'front', 'FRESH-ZERO-POST')

    const page = await agent.get('/c/front?sort=hot')
    const order = extractOrder(await page.text(), ['OLD-MODEST-POST', 'FRESH-ZERO-POST'])
    expect(order).toEqual(['FRESH-ZERO-POST', 'OLD-MODEST-POST'])
  })

  test('at similar age, higher score wins', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'front')
    await createPostVia(agent, 'front', 'LOW-SCORE')
    world.tick(1000)
    await createPostVia(agent, 'front', 'HIGH-SCORE')
    const highId = (world.ctx.db.prepare('SELECT id FROM posts ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id
    world.ctx.db.prepare('UPDATE posts SET score = 50, upvotes = 50 WHERE id = ?').run(highId)

    const page = await agent.get('/c/front?sort=hot')
    const order = extractOrder(await page.text(), ['LOW-SCORE', 'HIGH-SCORE'])
    expect(order).toEqual(['HIGH-SCORE', 'LOW-SCORE'])
  })
})

describe('US-026 new and top sorts', () => {
  test('new sorts strictly by creation time descending', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'chrono')
    for (const title of ['FIRST-POST', 'SECOND-POST', 'THIRD-POST']) {
      await createPostVia(agent, 'chrono', title)
      world.tick(60 * 1000)
    }
    const page = await agent.get('/c/chrono?sort=new')
    const order = extractOrder(await page.text(), ['FIRST-POST', 'SECOND-POST', 'THIRD-POST'])
    expect(order).toEqual(['THIRD-POST', 'SECOND-POST', 'FIRST-POST'])
  })

  test('top respects the selected window and tie-breaks by recency', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'peaks')

    await createPostVia(agent, 'peaks', 'ANCIENT-HIGH') // score 100, 10 days ago (outside the week window)
    const ancientId = (world.ctx.db.prepare('SELECT id FROM posts ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id
    world.ctx.db.prepare('UPDATE posts SET score = 100 WHERE id = ?').run(ancientId)

    world.tick(10 * 24 * HOUR)
    await createPostVia(agent, 'peaks', 'RECENT-MID') // score 10, now
    const recentId = (world.ctx.db.prepare('SELECT id FROM posts ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id
    world.ctx.db.prepare('UPDATE posts SET score = 10 WHERE id = ?').run(recentId)

    // Top all-time: ancient wins.
    let page = await agent.get('/c/peaks?sort=top&t=all')
    let order = extractOrder(await page.text(), ['ANCIENT-HIGH', 'RECENT-MID'])
    expect(order).toEqual(['ANCIENT-HIGH', 'RECENT-MID'])

    // Top this week: ancient falls outside the window entirely.
    page = await agent.get('/c/peaks?sort=top&t=week')
    const text = await page.text()
    expect(text).toContain('RECENT-MID')
    expect(text).not.toContain('ANCIENT-HIGH')
  })
})

describe('US-024 home feed and cursor pagination', () => {
  test('home feed shows joined communities; members without memberships see all-public fallback', async () => {
    const { agent: owner } = await registerUser(world)
    await createCommunityVia(owner, 'joined_club')
    await createCommunityVia(owner, 'other_club')
    await createPostVia(owner, 'joined_club', 'JOINED-CONTENT')
    await createPostVia(owner, 'other_club', 'OTHER-CONTENT')

    const { agent: selective } = await registerUser(world)
    await selective.post('/c/joined_club/join')
    let page = await selective.get('/')
    let text = await page.text()
    expect(text).toContain('JOINED-CONTENT')
    expect(text).not.toContain('OTHER-CONTENT')

    // Member with zero memberships → all readable posts + browse prompt.
    const { agent: fresh } = await registerUser(world)
    page = await fresh.get('/')
    text = await page.text()
    expect(text).toContain('JOINED-CONTENT')
    expect(text).toContain('OTHER-CONTENT')

    // Guests see the same fallback; private content never appears.
    await createCommunityVia(owner, 'sanctum', 'private')
    await createPostVia(owner, 'sanctum', 'PRIVATE-CONTENT')
    const guest = new Agent(world.app)
    page = await guest.get('/')
    text = await page.text()
    expect(text).toContain('JOINED-CONTENT')
    expect(text).not.toContain('PRIVATE-CONTENT')
  })

  test('cursor pagination: no duplicates or skips when new posts arrive between pages', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'busy')
    // 30 posts, oldest first (default page size 25).
    for (let i = 0; i < 30; i++) {
      await createPostVia(agent, 'busy', `PAGED-${String(i).padStart(2, '0')}`)
      world.tick(60 * 1000)
      if ((i + 1) % 5 === 0) world.tick(10 * 60 * 1000) // stay under the post rate limit
    }

    const page1 = await agent.get('/c/busy?sort=new')
    const text1 = await page1.text()
    const cursor = text1.match(/after=([A-Za-z0-9_-]+)/)?.[1] as string
    expect(cursor).toBeTruthy()

    // New content lands between page fetches.
    await createPostVia(agent, 'busy', 'PAGED-LATECOMER')

    const page2 = await agent.get(`/c/busy?sort=new&after=${cursor}`)
    const text2 = await page2.text()

    const all = Array.from({ length: 30 }, (_, i) => `PAGED-${String(i).padStart(2, '0')}`)
    const seen1 = all.filter((t) => text1.includes(t))
    const seen2 = all.filter((t) => text2.includes(t))
    expect(seen1).toHaveLength(25)
    expect(seen2).toHaveLength(5)
    expect(new Set([...seen1, ...seen2]).size).toBe(30) // no skips
    expect(seen1.filter((t) => seen2.includes(t))).toHaveLength(0) // no duplicates
    expect(text2).not.toContain('PAGED-LATECOMER') // late arrival not injected mid-pagination
  })
})

describe('US-025/US-033 pinned posts', () => {
  test('pinned posts render above the community feed but do not affect the home feed', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'pinned_place')
    await createPostVia(agent, 'pinned_place', 'PINNED-SCHEDULE')
    const pinnedId = (world.ctx.db.prepare('SELECT id FROM posts').get() as { id: string }).id
    world.tick(60 * 1000)
    await createPostVia(agent, 'pinned_place', 'NEWER-CHATTER')
    await agent.post(`/posts/${pinnedId}/pin`)

    const community = await agent.get('/c/pinned_place?sort=new')
    const communityText = await community.text()
    const order = extractOrder(communityText, ['PINNED-SCHEDULE', 'NEWER-CHATTER'])
    expect(order).toEqual(['PINNED-SCHEDULE', 'NEWER-CHATTER'])
    expect(communityText).toContain('Sabitlendi')

    // Home feed: chronological order wins; pin does not float (US-025).
    const home = await agent.get('/?sort=new')
    const homeOrder = extractOrder(await home.text(), ['PINNED-SCHEDULE', 'NEWER-CHATTER'])
    expect(homeOrder).toEqual(['NEWER-CHATTER', 'PINNED-SCHEDULE'])
  })
})

describe('feed exclusions', () => {
  test('deleted, removed, and auto-hidden posts never appear in feeds', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'cleaned')
    const { agent: author } = await registerUser(world)

    await createPostVia(author, 'cleaned', 'VISIBLE-POST')
    const deletedId = await createPostVia(author, 'cleaned', 'DELETED-POST')
    const removedId = await createPostVia(author, 'cleaned', 'REMOVED-POST')
    await author.post(`/posts/${deletedId}/delete`)
    await mod.post(`/mod/remove/post/${removedId}`)

    const page = await mod.get('/c/cleaned?sort=new')
    const text = await page.text()
    expect(text).toContain('VISIBLE-POST')
    expect(text).not.toContain('DELETED-POST')
    expect(text).not.toContain('REMOVED-POST')
  })
})
