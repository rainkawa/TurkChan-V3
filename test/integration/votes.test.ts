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

async function setup() {
  const { agent: author, username: authorName } = await registerUser(world)
  await createCommunityVia(author, 'arena')
  const { agent: voter, username: voterName } = await registerUser(world)
  await voter.post('/c/arena/join')
  const postId = await createPostVia(author, 'arena', 'Vote on me', 'Body')
  return { author, authorName, voter, voterName, postId }
}

function postState(postId: string) {
  return world.ctx.db.prepare('SELECT score, upvotes, downvotes FROM posts WHERE id = ?').get(postId) as {
    score: number
    upvotes: number
    downvotes: number
  }
}

describe('US-022 voting', () => {
  test('upvote, flip to downvote (net change 2), remove (back to 0)', async () => {
    const { voter, postId } = await setup()

    let res = await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ score: 1, upvotes: 1, downvotes: 0, myVote: 1 })

    res = await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: -1 })
    expect(await res.json()).toEqual({ score: -1, upvotes: 0, downvotes: 1, myVote: -1 })

    res = await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 0 })
    expect(await res.json()).toEqual({ score: 0, upvotes: 0, downvotes: 0, myVote: 0 })
    expect(postState(postId)).toEqual({ score: 0, upvotes: 0, downvotes: 0 })
  })

  test('repeated identical votes are idempotent — no score drift', async () => {
    const { voter, postId } = await setup()
    for (let i = 0; i < 5; i++) {
      await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    }
    expect(postState(postId)).toEqual({ score: 1, upvotes: 1, downvotes: 0 })
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM votes').get() as { n: number }).n).toBe(1)
  })

  test('own vote state is rendered and survives reload', async () => {
    const { voter, postId } = await setup()
    await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    const page = await voter.get(`/c/arena/comments/${postId}`)
    expect(await page.text()).toContain('data-my-vote="1"')
  })

  test('users cannot vote on their own content', async () => {
    const { author, postId } = await setup()
    const res = await author.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    expect(res.status).toBe(403)
    expect(postState(postId).score).toBe(0)
    // The control is disabled in their UI.
    const page = await author.get(`/c/arena/comments/${postId}`)
    expect(await page.text()).toContain('disabled')
  })

  test('guests get 401 and no vote is recorded', async () => {
    const { postId } = await setup()
    const guest = new Agent(world.app)
    const res = await guest.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    expect(res.status).toBe(401)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM votes').get() as { n: number }).n).toBe(0)
  })

  test('comment votes update comment score', async () => {
    const { author, voter, postId } = await setup()
    const commentId = await createCommentVia(author, 'arena', postId, 'Vote-worthy insight')
    await voter.json('/api/vote', { targetType: 'comment', targetId: commentId, value: 1 })
    const comment = world.ctx.db.prepare('SELECT score FROM comments WHERE id = ?').get(commentId) as { score: number }
    expect(comment.score).toBe(1)
  })

  test('votes on deleted/removed content are rejected', async () => {
    const { author, voter, postId } = await setup()
    await author.post(`/posts/${postId}/delete`)
    const res = await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    expect(res.status).toBe(404)
  })

  test('invalid payloads are rejected cleanly', async () => {
    const { voter, postId } = await setup()
    expect((await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 5 })).status).toBe(400)
    expect((await voter.json('/api/vote', { targetType: 'bogus', targetId: postId, value: 1 })).status).toBe(400)
    expect((await voter.json('/api/vote', { targetType: 'post', targetId: 'nonexistent', value: 1 })).status).toBe(404)
  })
})

describe('US-023 vote integrity', () => {
  test('votes are rate-limited per account (configurable, US-023)', async () => {
    // author is the first registered user → site admin; lower the limit to keep the test fast.
    const { author, voter } = await setup()
    await author.post('/admin/settings', { votesPerMinute: '5' })
    const postIds: string[] = []
    for (let i = 0; i < 6; i++) {
      const { agent } = await registerUser(world)
      postIds.push(await createPostVia(agent, 'arena', `Target ${i}`))
    }
    for (let i = 0; i < 5; i++) {
      const res = await voter.json('/api/vote', { targetType: 'post', targetId: postIds[i], value: 1 })
      expect(res.status).toBe(200)
    }
    const blocked = await voter.json('/api/vote', { targetType: 'post', targetId: postIds[5], value: 1 })
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as { error: string }).error).toContain('Yavaşlayın')

    // Window passes → allowed again.
    world.tick(60 * 1000 + 1)
    const after = await voter.json('/api/vote', { targetType: 'post', targetId: postIds[5], value: 1 })
    expect(after.status).toBe(200)
  })

  test('banned users cannot vote in that community', async () => {
    const { author, voter, voterName, postId } = await setup()
    await author.post('/c/arena/mod/ban', { username: voterName, duration: '3', reason: '' })
    const res = await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    expect(res.status).toBe(403)

    // Timed ban lifts automatically (US-032).
    world.tick(4 * 24 * 60 * 60 * 1000)
    const after = await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    expect(after.status).toBe(200)
  })

  test('individual vote rows are retained and never publicly exposed', async () => {
    const { voter, postId } = await setup()
    await voter.json('/api/vote', { targetType: 'post', targetId: postId, value: 1 })
    const rows = world.ctx.db.prepare('SELECT user_id, value FROM votes').all()
    expect(rows).toHaveLength(1) // auditable
    const page = await voter.get(`/c/arena/comments/${postId}`)
    const text = await page.text()
    expect(text).not.toContain((rows[0] as { user_id: string }).user_id) // raw voter identity not in HTML
  })
})
