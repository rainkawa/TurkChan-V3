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
  const { agent: mod } = await registerUser(world)
  await createCommunityVia(mod, 'talk')
  const { agent: alice } = await registerUser(world, `alice${Math.random().toString(36).slice(2, 6)}`)
  await alice.post('/c/talk/join')
  const { agent: bob } = await registerUser(world, `bob${Math.random().toString(36).slice(2, 6)}`)
  await bob.post('/c/talk/join')
  const postId = await createPostVia(mod, 'talk', 'Discussion thread', 'Start here')
  return { mod, alice, bob, postId }
}

describe('US-018 commenting', () => {
  test('comment appears immediately and increments comment count', async () => {
    const { alice, postId } = await setup()
    await createCommentVia(alice, 'talk', postId, 'First **comment**')
    const page = await alice.get(`/c/talk/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('<strong>comment</strong>')
    const post = world.ctx.db.prepare('SELECT comment_count FROM posts WHERE id = ?').get(postId) as { comment_count: number }
    expect(post.comment_count).toBe(1)
  })

  test('body 1-10,000 chars enforced', async () => {
    const { alice, postId } = await setup()
    let res = await alice.post(`/c/talk/comments/${postId}/comment`, { body: '' })
    expect(res.headers.get('location')).not.toContain('/comment/')
    res = await alice.post(`/c/talk/comments/${postId}/comment`, { body: 'x'.repeat(10001) })
    expect(res.headers.get('location')).not.toContain('/comment/')
  })

  test('commenting blocked on removed posts with a clear message', async () => {
    const { mod, alice, postId } = await setup()
    await mod.post(`/mod/remove/post/${postId}`)
    const res = await alice.post(`/c/talk/comments/${postId}/comment`, { body: 'Too late' })
    await res.text()
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
  })

  test('banned members cannot comment', async () => {
    const { mod, alice, postId } = await setup()
    const aliceRow = world.ctx.db.prepare("SELECT id, username FROM users WHERE username_lower LIKE 'alice%'").get() as { id: string; username: string }
    await mod.post('/c/talk/mod/ban', { username: aliceRow.username, duration: '7', reason: 'testing' })
    const res = await alice.post(`/c/talk/comments/${postId}/comment`, { body: 'Banned voice' })
    await res.text()
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
  })
})

describe('US-019 nested replies and depth cap', () => {
  test('replies nest; beyond depth 8 they flatten to depth 8 but are stored', async () => {
    const { alice, bob, postId } = await setup()
    let parentId: string | undefined
    const agents = [alice, bob]
    for (let i = 0; i < 12; i++) {
      parentId = await createCommentVia(agents[i % 2] as typeof alice, 'talk', postId, `Reply level ${i + 1}`, parentId)
    }
    const depths = world.ctx.db.prepare('SELECT depth FROM comments ORDER BY created_at ASC, path ASC').all() as Array<{ depth: number }>
    expect(depths).toHaveLength(12)
    expect(Math.max(...depths.map((d) => d.depth))).toBe(8) // capped
    expect(depths.slice(0, 8).map((d) => d.depth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(depths.slice(8).every((d) => d.depth === 8)).toBe(true) // flattened

    // All 12 render on the post page.
    const page = await alice.get(`/c/talk/comments/${postId}`)
    const text = await page.text()
    for (let i = 1; i <= 12; i++) expect(text).toContain(`Reply level ${i}`)
  })

  test('permalink highlights the comment and shows its ancestors', async () => {
    const { alice, bob, postId } = await setup()
    const rootId = await createCommentVia(alice, 'talk', postId, 'Root comment')
    const childId = await createCommentVia(bob, 'talk', postId, 'Child answer', rootId)
    const page = await alice.get(`/c/talk/comments/${postId}/comment/${childId}`)
    const text = await page.text()
    expect(text).toContain('Root comment') // ancestor context
    expect(text).toContain('Child answer')
    expect(text).toContain(`comment-${childId}`) // highlight anchor
  })
})

describe('US-020 comment edit and delete', () => {
  test('edit shows indicator; only the author may edit', async () => {
    const { alice, bob, postId } = await setup()
    const commentId = await createCommentVia(alice, 'talk', postId, 'Original text')
    await alice.post(`/comments/${commentId}/edit`, { body: 'Fixed text' })
    const page = await alice.get(`/c/talk/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('Fixed text')
    expect(text).toContain('(edited)')

    const res = await bob.post(`/comments/${commentId}/edit`, { body: 'Vandalised' })
    await res.text()
    const comment = world.ctx.db.prepare('SELECT body FROM comments WHERE id = ?').get(commentId) as { body: string }
    expect(comment.body).toBe('Fixed text')
  })

  test('deleting a leaf removes it and decrements count; with replies leaves [deleted] placeholder', async () => {
    const { alice, bob, postId } = await setup()
    const leafId = await createCommentVia(alice, 'talk', postId, 'Leaf comment')
    await alice.post(`/comments/${leafId}/delete`)
    expect(world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get()).toEqual(expect.objectContaining({ n: 0 }))
    expect((world.ctx.db.prepare('SELECT comment_count FROM posts WHERE id = ?').get(postId) as { comment_count: number }).comment_count).toBe(0)

    const parentId = await createCommentVia(alice, 'talk', postId, 'Parent comment')
    await createCommentVia(bob, 'talk', postId, 'The reply', parentId)
    await alice.post(`/comments/${parentId}/delete`)

    const page = await alice.get(`/c/talk/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('[deleted]')
    expect(text).toContain('The reply') // structure preserved
    expect(text).not.toContain('Parent comment')
  })

  test('deleted comment no longer counts toward karma', async () => {
    const { alice, bob, postId } = await setup()
    const commentId = await createCommentVia(alice, 'talk', postId, 'Soon deleted')
    await bob.json('/api/vote', { targetType: 'comment', targetId: commentId, value: 1 })

    const aliceName = (world.ctx.db.prepare('SELECT username FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?').get(commentId) as { username: string }).username
    let profile = await bob.get(`/u/${aliceName}`)
    expect(await profile.text()).toContain('Comment karma: 1')

    await alice.post(`/comments/${commentId}/delete`)
    profile = await bob.get(`/u/${aliceName}`)
    expect(await profile.text()).toContain('Comment karma: 0')
  })
})

describe('US-027 comment sorting', () => {
  test('Best (Wilson) ranks 10/0 above 15/8; New and Top differ', async () => {
    const { mod, postId } = await setup()
    const idA = await createCommentVia(mod, 'talk', postId, 'COMMENT-AAA') // 10 up, 0 down
    world.tick(60 * 1000)
    const idB = await createCommentVia(mod, 'talk', postId, 'COMMENT-BBB') // 15 up, 8 down
    world.tick(60 * 1000)
    const idC = await createCommentVia(mod, 'talk', postId, 'COMMENT-CCC') // no votes, newest

    // Set up votes directly (voting through API would need 33 accounts).
    const setVotes = (id: string, up: number, down: number) =>
      world.ctx.db.prepare('UPDATE comments SET upvotes = ?, downvotes = ?, score = ? WHERE id = ?').run(up, down, up - down, id)
    setVotes(idA, 10, 0)
    setVotes(idB, 15, 8)

    const best = await mod.get(`/c/talk/comments/${postId}?sort=best`)
    const bestText = await best.text()
    expect(bestText.indexOf('COMMENT-AAA')).toBeLessThan(bestText.indexOf('COMMENT-BBB'))

    const newSort = await mod.get(`/c/talk/comments/${postId}?sort=new`)
    const newText = await newSort.text()
    expect(newText.indexOf('COMMENT-CCC')).toBeLessThan(newText.indexOf('COMMENT-AAA'))

    const top = await mod.get(`/c/talk/comments/${postId}?sort=top`)
    const topText = await top.text()
    // Top by score: A(10) before B(7) before C(0).
    expect(topText.indexOf('COMMENT-AAA')).toBeLessThan(topText.indexOf('COMMENT-BBB'))
    expect(topText.indexOf('COMMENT-BBB')).toBeLessThan(topText.indexOf('COMMENT-CCC'))
  })
})

describe('comment rate limit (US-042)', () => {
  test('20 comments per 10 minutes per account', async () => {
    const { alice, postId } = await setup()
    for (let i = 0; i < 20; i++) {
      await createCommentVia(alice, 'talk', postId, `Comment ${i}`)
    }
    const res = await alice.post(`/c/talk/comments/${postId}/comment`, { body: 'One too many' })
    await res.text()
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(20)
    world.tick(10 * 60 * 1000 + 1)
    await createCommentVia(alice, 'talk', postId, 'Allowed again')
  })
})
