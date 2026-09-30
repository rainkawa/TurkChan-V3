import { beforeAll, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommentVia,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerUser,
  type TestWorld,
} from '../testUtils'

/**
 * US-044: automated access-matrix sweep. Each role from the PRD's role table
 * attempts each restricted action; denial is asserted server-side.
 */

let world: TestWorld
let guest: Agent
let member: Agent
let moderator: Agent
let admin: Agent
let outsideMod: Agent // moderator of an unrelated community
let outsider: Agent // signed in, member of no community

let publicPostId: string
let privatePostId: string
let privateCommentId: string
let memberName: string

beforeAll(async () => {
  world = createTestWorld()
  const adminUser = await registerUser(world, 'site_admin')
  admin = adminUser.agent

  const modUser = await registerUser(world, 'the_mod')
  moderator = modUser.agent
  await createCommunityVia(moderator, 'townsq', 'public')
  await createCommunityVia(moderator, 'vault', 'private')

  const memberUser = await registerUser(world, 'the_member')
  member = memberUser.agent
  memberName = memberUser.username
  await member.post('/c/townsq/join')

  const outsideUser = await registerUser(world, 'other_mod')
  outsideMod = outsideUser.agent
  await createCommunityVia(outsideMod, 'faraway', 'public')

  // Site kapalıdır: giriş yapmamış ziyaretçi hiçbir sayfaya ulaşamaz.
  // İçerik kontrolleri bu yüzden giriş yapmış ama üye olmayan biriyle yapılır.
  const outsiderUser = await registerUser(world, 'plain_reader')
  outsider = outsiderUser.agent

  guest = new Agent(world.app)

  publicPostId = await createPostVia(moderator, 'townsq', 'PUBLIC-SQUARE-POST', 'Open to all')
  privatePostId = await createPostVia(moderator, 'vault', 'VAULT-SECRET-POST', 'Members only secret')
  privateCommentId = await createCommentVia(moderator, 'vault', privatePostId, 'VAULT-SECRET-COMMENT')
})

describe('guest permissions', () => {
  test('cannot reach any page before signing in', async () => {
    for (const path of ['/', '/c/townsq', `/c/townsq/comments/${publicPostId}`, '/search?q=PUBLIC', '/communities', '/messages', '/notifications', '/settings']) {
      const res = await guest.get(path)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/login')
    }
    // Giriş sayfasında gezinme düğmesi yok.
    const login = await (await guest.get('/login')).text()
    expect(login).not.toContain('bottom-nav')
    expect(login).not.toContain('data-drawer-toggle')
  })

  test('can read public communities and search once signed in', async () => {
    expect((await outsider.get('/c/townsq')).status).toBe(200)
    expect((await outsider.get(`/c/townsq/comments/${publicPostId}`)).status).toBe(200)
    const search = await outsider.get('/search?q=PUBLIC')
    expect(await search.text()).toContain('PUBLIC-SQUARE-POST')
  })

  test('cannot post, comment, vote, or report', async () => {
    expect((await guest.post('/c/townsq/submit?type=text', { title: 'x', body: '' })).headers.get('location')).toContain('/login')
    const commentRes = await guest.post(`/c/townsq/comments/${publicPostId}/comment`, { body: 'x' })
    expect(commentRes.headers.get('location')).toContain('/login')
    expect((await guest.json('/api/vote', { targetType: 'post', targetId: publicPostId, value: 1 })).status).toBe(401)
    expect((await guest.post(`/report/post/${publicPostId}`, { reason: 'spam' })).headers.get('location')).toContain('/login')
  })

  test('cannot read private communities: zero content leakage anywhere', async () => {
    const gate = await outsider.get('/c/vault')
    expect(gate.status).toBe(403)
    const gateText = await gate.text()
    expect(gateText).not.toContain('VAULT-SECRET-POST')

    const post = await outsider.get(`/c/vault/comments/${privatePostId}`)
    expect(post.status).toBe(403)
    const postText = await post.text()
    expect(postText).not.toContain('VAULT-SECRET-POST') // not even the title (US-017)
    expect(postText).not.toContain('Members only secret')
    expect(postText).not.toContain('VAULT-SECRET-COMMENT')
    expect(postText).not.toContain('og:title') // no OG leakage either

    // Absent from feeds, search, directory, and the author's public profile.
    expect(await (await outsider.get('/')).text()).not.toContain('VAULT-SECRET-POST')
    expect(await (await outsider.get('/search?q=VAULT')).text()).not.toContain('VAULT-SECRET-POST')
    expect(await (await outsider.get('/communities')).text()).not.toContain('vault')
    expect(await (await outsider.get('/tc/the_mod')).text()).not.toContain('VAULT-SECRET-POST')
  })
})

describe('member permissions', () => {
  test('can post, comment, vote, report in joined public community', async () => {
    const postId = await createPostVia(member, 'townsq', 'Member speaks')
    await createCommentVia(member, 'townsq', publicPostId, 'Member comments')
    expect((await member.json('/api/vote', { targetType: 'post', targetId: publicPostId, value: 1 })).status).toBe(200)
    expect((await member.post(`/report/post/${publicPostId}`, { reason: 'spam', detail: '' })).headers.get('location')).toBe('/')
    void postId
  })

  test('cannot access private community content (matrix: read restricted/private = if approved)', async () => {
    expect((await member.get('/c/vault')).status).toBe(403)
    expect((await member.get(`/c/vault/comments/${privatePostId}`)).status).toBe(403)
    expect((await member.json('/api/vote', { targetType: 'post', targetId: privatePostId, value: 1 })).status).toBe(403)
    expect((await member.json('/api/vote', { targetType: 'comment', targetId: privateCommentId, value: 1 })).status).toBe(403)
    const commentRes = await member.post(`/c/vault/comments/${privatePostId}/comment`, { body: 'sneak' })
    await commentRes.text()
    expect(
      (world.ctx.db.prepare("SELECT COUNT(*) AS n FROM comments WHERE body = 'sneak'").get() as { n: number }).n,
    ).toBe(0)
  })

  test('cannot remove content, pin, ban, access mod pages or admin', async () => {
    const removeRes = await member.post(`/mod/remove/post/${publicPostId}`)
    await removeRes.text()
    expect((world.ctx.db.prepare('SELECT removed FROM posts WHERE id = ?').get(publicPostId) as { removed: number }).removed).toBe(0)

    await member.post(`/posts/${publicPostId}/pin`)
    expect((world.ctx.db.prepare('SELECT pinned_at FROM posts WHERE id = ?').get(publicPostId) as { pinned_at: number | null }).pinned_at).toBeNull()

    const banRes = await member.post('/c/townsq/mod/ban', { username: 'the_mod', duration: '3' })
    await banRes.text()
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM bans').get() as { n: number }).n).toBe(0)

    expect((await member.get('/c/townsq/mod/queue')).status).toBe(403)
    expect((await member.get('/c/townsq/mod/log')).status).toBe(403)
    expect((await member.get('/c/townsq/mod/members')).status).toBe(403)
    expect((await member.get('/admin')).status).toBe(403)
    expect((await member.post('/admin/settings', { registrationMode: 'closed' })).status).toBe(403)
  })
})

describe('moderator permissions are strictly scoped per community', () => {
  test('moderator of community A has only member rights in community B', async () => {
    // outsideMod moderates 'faraway', not 'townsq'.
    const removeRes = await outsideMod.post(`/mod/remove/post/${publicPostId}`)
    await removeRes.text()
    expect((world.ctx.db.prepare('SELECT removed FROM posts WHERE id = ?').get(publicPostId) as { removed: number }).removed).toBe(0)
    expect((await outsideMod.get('/c/townsq/mod/queue')).status).toBe(403)
    expect((await outsideMod.get('/c/townsq/mod/members')).status).toBe(403)

    // And still cannot see the private vault.
    expect((await outsideMod.get('/c/vault')).status).toBe(403)
  })

  test('moderator can remove/pin/ban within their own community but not suspend site-wide', async () => {
    const targetId = await createPostVia(member, 'townsq', 'Mod target post')
    await moderator.post(`/mod/remove/post/${targetId}`)
    expect((world.ctx.db.prepare('SELECT removed FROM posts WHERE id = ?').get(targetId) as { removed: number }).removed).toBe(1)

    const memberId = (world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(memberName) as { id: string }).id
    expect((await moderator.post(`/admin/users/${memberId}/suspend`, { days: '7' })).status).toBe(403)
    expect((await moderator.get('/admin')).status).toBe(403)
  })
})

describe('site admin permissions', () => {
  test('admin can act anywhere: read private, remove content, view all queues', async () => {
    expect((await admin.get('/c/vault')).status).toBe(200)
    expect((await admin.get(`/c/vault/comments/${privatePostId}`)).status).toBe(200)
    expect((await admin.get('/c/vault/mod/queue')).status).toBe(200)
    expect((await admin.get('/admin')).status).toBe(200)

    const targetId = await createPostVia(member, 'townsq', 'Admin removes this')
    await admin.post(`/mod/remove/post/${targetId}`)
    expect((world.ctx.db.prepare('SELECT removed FROM posts WHERE id = ?').get(targetId) as { removed: number }).removed).toBe(1)
  })
})

describe('direct object reference hardening (US-044)', () => {
  test('post/comment ids are unguessable and access-checked; image keys are UUIDs', async () => {
    // Ids are 13-char random base36 (not sequential integers).
    expect(publicPostId).toMatch(/^[a-z0-9]{13}$/)
    expect(privatePostId).toMatch(/^[a-z0-9]{13}$/)

    // Even knowing a private post id exactly, access is checked server-side.
    expect((await outsider.get(`/c/vault/comments/${privatePostId}`)).status).toBe(403)

    // Unknown media keys 404 without information leakage.
    expect((await guest.get('/media/00000000-0000-0000-0000-000000000000')).status).toBe(404)
  })

  test('permalink of a private comment is access-checked too', async () => {
    const res = await member.get(`/c/vault/comments/${privatePostId}/comment/${privateCommentId}`)
    expect(res.status).toBe(403)
    expect(await res.text()).not.toContain('VAULT-SECRET-COMMENT')
  })
})
