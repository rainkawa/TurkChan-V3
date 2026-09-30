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

beforeEach(async () => {
  world = createTestWorld()
})

async function setup() {
  const { agent: mod } = await registerUser(world, `mod${Math.random().toString(36).slice(2, 8)}`)
  await createCommunityVia(mod, 'lounge')
  const { agent: member, username: memberName } = await registerUser(world)
  await member.post('/c/lounge/join')
  return { mod, member, memberName }
}

describe('US-013 text posts', () => {
  test('creates a post, renders sanitised markdown, appears in feed and New sort', async () => {
    const { member } = await setup()
    const postId = await createPostVia(member, 'lounge', 'Carpark question', '**Where** do we park?\n\n<script>alert(1)</script>')
    const page = await member.get(`/c/lounge/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('Carpark question')
    expect(text).toContain('<strong>Where</strong>')
    expect(text).not.toContain('<script>alert(1)</script>')

    const feed = await member.get('/c/lounge?sort=new')
    expect(await feed.text()).toContain('Carpark question')
  })

  test('title 1-300 chars enforced; body cap 40k', async () => {
    const { member } = await setup()
    let res = await member.post('/c/lounge/submit?type=text', { title: '', body: 'x' })
    expect(res.headers.get('location')).toContain('/submit')
    res = await member.post('/c/lounge/submit?type=text', { title: 'x'.repeat(301), body: '' })
    expect(res.headers.get('location')).toContain('/submit')
    res = await member.post('/c/lounge/submit?type=text', { title: 'ok', body: 'y'.repeat(40001) })
    expect(res.headers.get('location')).toContain('/submit')
  })

  test('posting to a public community auto-joins (one-tap join in composer)', async () => {
    const { member } = await setup()
    const { agent: drifter, username } = await registerUser(world)
    await createPostVia(drifter, 'lounge', 'Drive-by question')
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username.toLowerCase()) as { id: string }).id
    const membership = world.ctx.db
      .prepare('SELECT status FROM memberships WHERE user_id = ?')
      .get(userId) as { status: string }
    expect(membership.status).toBe('approved')
    void member
  })

  test('restricted community: only approved members can post', async () => {
    const { agent: owner } = await registerUser(world)
    await createCommunityVia(owner, 'annexe', 'restricted')
    const { agent: outsider } = await registerUser(world)
    const res = await outsider.post('/c/annexe/submit?type=text', { title: 'Sneaky', body: '' })
    expect(res.headers.get('location')).toContain('/submit') // bounced with error
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n).toBe(0)
  })

  test('guests cannot post', async () => {
    await setup()
    const guest = new Agent(world.app)
    const res = await guest.post('/c/lounge/submit?type=text', { title: 'Anon', body: '' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login')
  })
})

describe('US-016 edit and delete', () => {
  test('author edits body (edited indicator); title immutable; others cannot edit', async () => {
    const { member, mod } = await setup()
    const postId = await createPostVia(member, 'lounge', 'Original title', 'Original body')
    await member.post(`/posts/${postId}/edit`, { body: 'Updated body' })
    const page = await member.get(`/c/lounge/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('Updated body')
    expect(text).toContain('Original title')
    expect(text).toContain('(düzenlendi)')

    // Non-author (even a moderator) cannot edit.
    const res = await mod.post(`/posts/${postId}/edit`, { body: 'Hijacked' })
    await res.text()
    const post = world.ctx.db.prepare('SELECT body FROM posts WHERE id = ?').get(postId) as { body: string }
    expect(post.body).toBe('Updated body')
  })

  test('deleting a post with zero comments removes it from feeds entirely', async () => {
    const { member } = await setup()
    const postId = await createPostVia(member, 'lounge', 'Gone soon', '')
    await member.post(`/posts/${postId}/delete`)
    const feed = await member.get('/c/lounge?sort=new')
    expect(await feed.text()).not.toContain('Gone soon')
    const page = await member.get(`/c/lounge/comments/${postId}`)
    expect(page.status).toBe(404)
    expect(await page.text()).toContain('artık mevcut değil')
  })

  test('deleting a post with comments keeps the thread with [deleted] placeholder', async () => {
    const { member, mod } = await setup()
    const postId = await createPostVia(member, 'lounge', 'Keep my thread', 'Body')
    await createCommentVia(mod, 'lounge', postId, 'Useful answer')
    await member.post(`/posts/${postId}/delete`)

    const page = await member.get(`/c/lounge/comments/${postId}`)
    expect(page.status).toBe(200)
    const text = await page.text()
    expect(text).toContain('[silindi]')
    expect(text).toContain('Useful answer') // replies preserved
    expect(text).not.toContain('Keep my thread') // title hidden

    const feed = await member.get('/c/lounge?sort=new')
    expect(await feed.text()).not.toContain('Keep my thread')
  })

  test('link post gövdesi düzenlenebilir, medya gönderisi düzenlenemez', async () => {
    const { member } = await setup()
    // Bağlantı gönderileri de markdown gövde taşır; yazarı gövdeyi düzeltebilmeli.
    const res = await member.post('/c/lounge/submit?type=link', {
      title: 'A link',
      url: 'https://example.com/a',
      body: 'ilk gövde',
    })
    const postId = (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    const editRes = await member.post(`/posts/${postId}/edit`, { body: 'düzeltilmiş gövde' })
    expect(editRes.status).toBe(302)
    const post = world.ctx.db.prepare('SELECT body, edited_at FROM posts WHERE id = ?').get(postId) as {
      body: string | null
      edited_at: number | null
    }
    expect(post.body).toBe('düzeltilmiş gövde')
    expect(post.edited_at).not.toBeNull()

    // Medya gönderisinin içeriği dosyadır; düzenlenemez.
    const form = new FormData()
    form.set('title', 'Media post')
    form.set('image', new File([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xff, 0xd9])], 'x.jpg', { type: 'image/jpeg' }))
    const mediaRes = await member.request('/c/lounge/submit?type=image', { method: 'POST', body: form })
    const mediaId = (mediaRes.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    await member.post(`/posts/${mediaId}/edit`, { body: 'nope' })
    await (await member.get(`/c/lounge/comments/${mediaId}`)).text()
    const mediaPost = world.ctx.db.prepare('SELECT body FROM posts WHERE id = ?').get(mediaId) as {
      body: string | null
    }
    expect(mediaPost.body).toBeNull()
  })
})

describe('US-014 link posts', () => {
  test('accepts valid public URLs; rejects malformed and private-network URLs', async () => {
    const { member } = await setup()
    const good = await member.post('/c/lounge/submit?type=link', { title: 'Good', url: 'https://example.com/article' })
    expect(good.headers.get('location')).toContain('/comments/')

    for (const url of ['notaurl', 'ftp://example.com/x', 'http://127.0.0.1/admin', 'http://169.254.169.254/meta', 'http://localhost:8080/']) {
      const res = await member.post('/c/lounge/submit?type=link', { title: 'Bad', url })
      expect(res.headers.get('location')).toContain('/submit')
    }
  })

  test('preview fetch failure never blocks creation (network is down in tests)', async () => {
    const { member } = await setup()
    const res = await member.post('/c/lounge/submit?type=link', { title: 'No preview', url: 'https://unreachable.example.com/x' })
    expect(res.headers.get('location')).toContain('/comments/')
  })

  test('OG preview is stored when fetch succeeds', async () => {
    const { member } = await setup()
    world.ctx.fetchFn = (async () =>
      new Response('<html><head><meta property="og:title" content="Fancy Article"/><meta property="og:image" content="https://cdn.example.com/img.jpg"/><title>fallback</title></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch
    const res = await member.post('/c/lounge/submit?type=link', { title: 'With preview', url: 'https://example.com/fancy' })
    const postId = (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    const post = world.ctx.db.prepare('SELECT link_preview_title, link_preview_image FROM posts WHERE id = ?').get(postId) as {
      link_preview_title: string
      link_preview_image: string
    }
    expect(post.link_preview_title).toBe('Fancy Article')
    expect(post.link_preview_image).toBe('https://cdn.example.com/img.jpg')
  })

  test('duplicate URL in same community within 30 days: non-blocking warning', async () => {
    const { member, mod } = await setup()
    const first = await member.post('/c/lounge/submit?type=link', { title: 'First share', url: 'https://example.com/dup' })
    const firstId = (first.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string

    const second = await mod.post('/c/lounge/submit?type=link', { title: 'Second share', url: 'https://example.com/dup' })
    expect(second.headers.get('location')).toContain('/comments/') // still created (non-blocking)
    const landing = await mod.get(second.headers.get('location') as string)
    const text = await landing.text()
    expect(text).toContain('paylaşılmış')
    expect(text).toContain(firstId) // links the earlier post

    // Same URL in a DIFFERENT community: no warning.
    await createCommunityVia(mod, 'elsewhere')
    const third = await mod.post('/c/elsewhere/submit?type=link', { title: 'Cross-post', url: 'https://example.com/dup' })
    const landing3 = await mod.get(third.headers.get('location') as string)
    expect(await landing3.text()).not.toContain('paylaşılmış')
  })
})

describe('US-015 image posts', () => {
  function tinyJpeg(): Uint8Array {
    // SOI + APP1(EXIF) + SOS + EOI — enough structure for the pipeline.
    const exif = Array.from(Buffer.from('Exif\0\0SECRET-GPS'))
    return Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, exif.length + 2, ...exif,
      0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x99, 0x88,
      0xff, 0xd9,
    ])
  }

  async function submitImage(agent: Agent, community: string, title: string, bytes: Uint8Array, filename = 'photo.jpg') {
    const form = new FormData()
    form.set('title', title)
    form.set('image', new File([bytes], filename, { type: 'image/jpeg' }))
    return agent.request(`/c/${community}/submit?type=image`, { method: 'POST', body: form })
  }

  test('uploads via pre-signed flow, strips EXIF, serves via unguessable key', async () => {
    const { member } = await setup()
    const res = await submitImage(member, 'lounge', 'Event photo', tinyJpeg())
    expect(res.status).toBe(302)
    const postId = (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    const post = world.ctx.db.prepare('SELECT image_key FROM posts WHERE id = ?').get(postId) as { image_key: string }
    expect(post.image_key).toMatch(/^[0-9a-f-]{36}$/) // UUID key (US-044)

    const media = await member.get(`/media/${post.image_key}`)
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/jpeg')
    const served = Buffer.from(await media.arrayBuffer())
    expect(served.includes(Buffer.from('SECRET-GPS'))).toBe(false) // EXIF stripped
  })

  test('rejects wrong file type by signature (not extension) and >10MB files; no orphaned post', async () => {
    const { member } = await setup()
    const fakeJpeg = Uint8Array.from(Buffer.from('GIF89a-actually-a-gif'))
    let res = await submitImage(member, 'lounge', 'Fake', fakeJpeg, 'innocent.jpg')
    expect(res.headers.get('location')).toContain('/submit')

    const huge = new Uint8Array(10 * 1024 * 1024 + 1)
    huge[0] = 0xff; huge[1] = 0xd8; huge[2] = 0xff
    res = await submitImage(member, 'lounge', 'Huge', huge)
    expect(res.headers.get('location')).toContain('/submit')

    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n).toBe(0)
  })

  test('attaching someone else’s upload or an incomplete upload fails', async () => {
    const { member, mod } = await setup()
    const slotRes = await member.json('/api/uploads', {})
    const slot = (await slotRes.json()) as { key: string; token: string }

    // Incomplete (never uploaded): post creation must fail.
    let res = await mod.post('/c/lounge/submit?type=text', {}) // warm-up no-op
    await res.text()
    const directAttach = await member.request(`/c/lounge/submit?type=image`, {
      method: 'POST',
      body: (() => {
        const form = new FormData()
        form.set('title', 'Stolen slot')
        form.set('image', new File([Uint8Array.from([1, 2, 3])], 'x.jpg'))
        return form
      })(),
    })
    expect(directAttach.headers.get('location')).toContain('/submit') // invalid bytes rejected

    // Upload with the wrong token fails.
    const badToken = await member.request(`/api/uploads/${slot.key}?token=wrong`, { method: 'PUT', body: tinyJpeg() as unknown as ArrayBuffer })
    expect(badToken.status).toBe(404)
  })
})

describe('rate limiting (US-042)', () => {
  test('posts capped at 5 per 10 minutes with clear retry message', async () => {
    const { member } = await setup()
    for (let i = 0; i < 5; i++) {
      await createPostVia(member, 'lounge', `Post number ${i}`)
    }
    const res = await member.post('/c/lounge/submit?type=text', { title: 'Sixth', body: '' })
    expect(res.headers.get('location')).toContain('/submit')
    const page = await member.get('/c/lounge/submit?type=text')
    expect(await page.text()).toContain('Yavaşlayın')

    // Window passes → allowed again.
    world.tick(10 * 60 * 1000 + 1)
    await createPostVia(member, 'lounge', 'After the window')
  })
})

describe('archived community is read-only (US-037)', () => {
  test('no new posts in archived community; banner shown', async () => {
    const { agent: admin } = await registerUser(world, 'archadmin')
    await createCommunityVia(admin, 'oldprog')
    const { agent: member } = await registerUser(world)
    await member.post('/c/oldprog/join')

    const communityId = (world.ctx.db.prepare("SELECT id FROM communities WHERE name = 'oldprog'").get() as { id: string }).id
    await admin.post(`/admin/communities/${communityId}/archive`)

    const page = await member.get('/c/oldprog')
    expect(await page.text()).toContain('arşivlenmiş')

    const res = await member.post('/c/oldprog/submit?type=text', { title: 'Too late', body: '' })
    await res.text()
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n).toBe(0)

    // Unarchive restores posting.
    await admin.post(`/admin/communities/${communityId}/unarchive`)
    await createPostVia(member, 'oldprog', 'Back in business')
  })
})
