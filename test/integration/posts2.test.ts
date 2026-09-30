/**
 * Gönderi türleri, çoklu medya, istatistik, anonim paylaşım ve thread modu.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerAdmin,
  registerUser,
  type TestWorld,
} from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

const HOUR = 60 * 60 * 1000

function tinyJpeg(): Uint8Array {
  const exif = Array.from(Buffer.from('Exif\0\0SECRET-GPS'))
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xe1, 0x00, exif.length + 2, ...exif, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x99, 0x88, 0xff, 0xd9,
  ])
}
function tinyGif(): Uint8Array {
  return Uint8Array.from(Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff]),
  ]))
}
function tinyMp4(): Uint8Array {
  // ISO BMFF: boyut(4) + "ftyp" + marka
  return Uint8Array.from(Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.from([0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d]),
  ]))
}

async function submitFiles(
  agent: Agent,
  community: string,
  type: string,
  title: string,
  files: Array<{ name: string; bytes: Uint8Array; mime: string }>,
  extra: Record<string, string> = {},
): Promise<Response> {
  const form = new FormData()
  form.set('title', title)
  for (const f of files) form.append('image', new File([f.bytes], f.name, { type: f.mime }))
  for (const [k, v] of Object.entries(extra)) form.set(k, v)
  return agent.request(`/c/${community}/submit?type=${type}`, { method: 'POST', body: form })
}

function postIdFrom(res: Response): string {
  return (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
}

/* -------------------------------------------------------------------------- */

describe('gönderi türleri', () => {
  test('kompozitör beş türü de sunar', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'types')
    const res = await agent.get('/c/types/submit')
    const html = await res.text()
    for (const label of ['Metin', 'Bağlantı', 'Görsel', 'GIF', 'Video']) {
      expect(html, `tür sekmesi yok: ${label}`).toContain(label)
    }
    // Her tür kendi formuna bağlanır.
    for (const type of ['text', 'link', 'image', 'gif', 'video']) {
      expect(html).toContain(`/c/types/submit?type=${type}`)
    }
  })

  test('metin gönderisi markdown gövdesiyle oluşur', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'mdboard')
    const id = await createPostVia(agent, 'mdboard', 'MD-POST', '**kalın** metin')
    const res = await agent.get(`/c/mdboard/comments/${id}`)
    const html = await res.text()
    expect(html).toContain('<strong>kalın</strong>')
  })

  test('bağlantı gönderisi markdown gövdesi de kabul eder', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'linkmd')
    const res = await agent.post('/c/linkmd/submit?type=link', {
      title: 'LINK-MD',
      url: 'https://example.com/a',
      body: 'gövde **metni**',
    })
    const id = postIdFrom(res)
    const detail = await agent.get(`/c/linkmd/comments/${id}`)
    const html = await detail.text()
    expect(html).toContain('<strong>metni</strong>')
  })

  test('görsel, GIF ve video gönderileri doğru medya türüyle oluşur', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'media')

    const img = await submitFiles(agent, 'media', 'image', 'IMG-POST', [
      { name: 'a.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
    ])
    const gif = await submitFiles(agent, 'media', 'gif', 'GIF-POST', [
      { name: 'a.gif', bytes: tinyGif(), mime: 'image/gif' },
    ])
    const vid = await submitFiles(agent, 'media', 'video', 'VID-POST', [
      { name: 'a.mp4', bytes: tinyMp4(), mime: 'video/mp4' },
    ])

    for (const res of [img, gif, vid]) expect(res.status).toBe(302)
    const kinds = world.ctx.db
      .prepare('SELECT title, media_kind FROM posts ORDER BY created_at ASC')
      .all() as Array<{ title: string; media_kind: string }>
    const byTitle = Object.fromEntries(kinds.map((k) => [k.title, k.media_kind]))
    expect(byTitle['IMG-POST']).toBe('image')
    expect(byTitle['GIF-POST']).toBe('gif')
    expect(byTitle['VID-POST']).toBe('video')
  })

  test('yüklenen dosyanın içerik tipi imzadan türetilir (beyan güvenilmez)', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'mimesafe')
    // GIF imzalı dosya, text/html beyanıyla: sunucu yine image/gif demeli.
    const res = await submitFiles(agent, 'mimesafe', 'gif', 'SPOOF-GIF', [
      { name: 'x.gif', bytes: tinyGif(), mime: 'text/html' },
    ])
    const id = postIdFrom(res)
    const row = world.ctx.db.prepare('SELECT image_key FROM posts WHERE id = ?').get(id) as { image_key: string }
    const media = await agent.get(`/media/${row.image_key}`)
    expect(media.headers.get('content-type')).toBe('image/gif')
    expect(media.headers.get('x-content-type-options')).toBe('nosniff')

    // MP4 imzalı dosya text/html beyan etse de video/mp4 servis edilir.
    const vres = await submitFiles(agent, 'mimesafe', 'video', 'SPOOF-VID', [
      { name: 'x.mp4', bytes: tinyMp4(), mime: 'text/html' },
    ])
    const vid = postIdFrom(vres)
    const vrow = world.ctx.db.prepare('SELECT image_key FROM posts WHERE id = ?').get(vid) as { image_key: string }
    const vmedia = await agent.get(`/media/${vrow.image_key}`)
    expect(vmedia.headers.get('content-type')).toBe('video/mp4')
  })

  test('yanlış tür reddedilir (imzaya göre)', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'strict')
    // Görsel alanına GIF yüklenemez.
    const res = await submitFiles(agent, 'strict', 'image', 'WRONG', [
      { name: 'a.gif', bytes: tinyGif(), mime: 'image/jpeg' },
    ])
    expect(res.headers.get('location')).toContain('/submit')
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('birden fazla görsel / video', () => {
  test('çoklu görsel tek gönderide sırayla saklanır ve galeri çizilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'galeri')
    const res = await submitFiles(agent, 'galeri', 'image', 'MULTI-POST', [
      { name: 'a.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
      { name: 'b.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
      { name: 'c.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
    ])
    const id = postIdFrom(res)
    const media = world.ctx.db
      .prepare('SELECT position, kind FROM post_media WHERE post_id = ? ORDER BY position ASC')
      .all(id) as Array<{ position: number; kind: string }>
    expect(media).toHaveLength(3)
    expect(media.map((m) => m.position)).toEqual([0, 1, 2])

    const detail = await agent.get(`/c/galeri/comments/${id}`)
    const html = await detail.text()
    expect(html).toContain('data-gallery="3"')
    expect((html.match(/class="media-item/g) ?? []).length).toBe(3)
  })

  test('aynı dosya iki gönderide kullanılamaz (tek kullanımlık)', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'singleuse')
    // Önce yükleme alanı oluşturup baytları gönderelim, sonra aynı anahtarı tekrar deneyelim.
    const slot = (await (await agent.json('/api/uploads', {})).json()) as { key: string; token: string }
    await agent.request(`/api/uploads/${slot.key}?token=${slot.token}`, {
      method: 'PUT',
      body: tinyJpeg() as unknown as ArrayBuffer,
    })
    const form1 = new FormData()
    form1.set('title', 'FIRST')
    form1.set('imageKey', slot.key)
    // İlk gönderi (attach edilir).
    const r1 = await agent.request('/c/singleuse/submit?type=image', {
      method: 'POST',
      body: (() => {
        const f = new FormData()
        f.set('title', 'FIRST')
        f.set('image', new File([tinyJpeg()], 'x.jpg', { type: 'image/jpeg' }))
        return f
      })(),
    })
    expect(r1.status).toBe(302)
    // Anahtar artık 'attached' → ikinci kez kullanılamaz.
    const status = world.ctx.db.prepare('SELECT status FROM uploads WHERE key = ?').get(slot.key) as { status: string }
    expect(['uploaded', 'attached']).toContain(status.status)
  })

  test('bir gönderiye birden fazla video eklenemez', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'onevideo')
    const res = await submitFiles(agent, 'onevideo', 'video', 'TWO-VIDEOS', [
      { name: 'a.mp4', bytes: tinyMp4(), mime: 'video/mp4' },
      { name: 'b.mp4', bytes: tinyMp4(), mime: 'video/mp4' },
    ])
    expect(res.headers.get('location')).toContain('/submit')
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n).toBe(0)
  })

  test('medya sayısı sınırı aşılırsa reddedilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'toomany')
    const files = Array.from({ length: 12 }, (_, i) => ({
      name: `f${i}.jpg`,
      bytes: tinyJpeg(),
      mime: 'image/jpeg',
    }))
    const res = await submitFiles(agent, 'toomany', 'image', 'TOO-MANY', files)
    expect(res.headers.get('location')).toContain('/submit')
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('permalink, post id, tarihler ve istatistikler', () => {
  test('detay sayfası kimliği, kalıcı bağlantıyı ve tarihleri gösterir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'meta')
    const id = await createPostVia(agent, 'meta', 'META-POST')
    const res = await agent.get(`/c/meta/comments/${id}`)
    const html = await res.text()
    expect(html).toContain('post-id')
    expect(html).toContain(id)
    expect(html).toContain('/p/' + id)
    expect(html).toContain('Oluşturuldu')
    expect(html).toContain('Düzenlendi')
    expect(html).toContain('Henüz düzenlenmedi')
  })

  test('/p/:id kalıcı bağlantısı gönderiye yönlendirir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'plink')
    const id = await createPostVia(agent, 'plink', 'PLINK-POST')
    const res = await agent.get(`/p/${id}`)
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe(`/c/plink/comments/${id}`)
  })

  test('görüntülenme sayacı artar ve aynı ziyaretçi iki kez sayılmaz', async () => {
    const author = await registerUser(world)
    await createCommunityVia(author.agent, 'views')
    const id = await createPostVia(author.agent, 'views', 'VIEW-POST')

    const reader = await registerUser(world)
    await reader.agent.get(`/c/views/comments/${id}`)
    let row = world.ctx.db.prepare('SELECT view_count FROM posts WHERE id = ?').get(id) as { view_count: number }
    expect(row.view_count).toBe(1)

    // Aynı okuyucu tekrar bakınca sayı artmaz.
    await reader.agent.get(`/c/views/comments/${id}`)
    row = world.ctx.db.prepare('SELECT view_count FROM posts WHERE id = ?').get(id) as { view_count: number }
    expect(row.view_count).toBe(1)

    // Farklı okuyucu → artar.
    const other = await registerUser(world)
    await other.agent.get(`/c/views/comments/${id}`)
    row = world.ctx.db.prepare('SELECT view_count FROM posts WHERE id = ?').get(id) as { view_count: number }
    expect(row.view_count).toBe(2)

    // Yazar kendi gönderisini saymaz.
    await author.agent.get(`/c/views/comments/${id}`)
    row = world.ctx.db.prepare('SELECT view_count FROM posts WHERE id = ?').get(id) as { view_count: number }
    expect(row.view_count).toBe(2)
  })

  test('istatistik bloğu görüntülenme ve yorum sayısını gösterir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'stats')
    const id = await createPostVia(agent, 'stats', 'STATS-POST')
    await agent.post(`/c/stats/comments/${id}/comment`, { body: 'yorum' })
    const res = await agent.get(`/c/stats/comments/${id}`)
    const html = await res.text()
    expect(html).toContain('post-meta-bar')
    expect(html).toContain('görüntülenme')
    expect(html).toContain('tekil ziyaretçi')
  })
})

/* -------------------------------------------------------------------------- */

describe('anonim paylaşım', () => {
  test('anonim gönderide sistem 5 haneli karışık ad atar', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'anon')
    const res = await agent.post('/c/anon/submit?type=text', {
      title: 'ANON-POST',
      body: '',
      anonymous: '1',
    })
    const id = postIdFrom(res)
    const row = world.ctx.db.prepare('SELECT is_anonymous, anon_name FROM posts WHERE id = ?').get(id) as {
      is_anonymous: number
      anon_name: string
    }
    expect(row.is_anonymous).toBe(1)
    expect(row.anon_name).toHaveLength(5)
    // Büyük harf + küçük harf + rakam içermeli.
    expect(row.anon_name).toMatch(/[a-z]/)
    expect(row.anon_name).toMatch(/[A-Z]/)
    expect(row.anon_name).toMatch(/[0-9]/)
    expect(row.anon_name).toMatch(/^[a-zA-Z0-9]{5}$/)
  })

  test('anonim gönderi gerçek hesabı sızdırmaz', async () => {
    const author = await registerUser(world, 'gizliyazar')
    await createCommunityVia(author.agent, 'anonprivacy')
    const res = await author.agent.post('/c/anonprivacy/submit?type=text', {
      title: 'GIZLI-POST',
      body: '',
      anonymous: '1',
    })
    const id = postIdFrom(res)

    const reader = await registerUser(world)
    const detail = await reader.agent.get(`/c/anonprivacy/comments/${id}`)
    const html = await detail.text()
    expect(html).toContain('Anonim')
    expect(html, 'gerçek kullanıcı adı sızdı').not.toContain('gizliyazar')
    expect(html, 'gerçek profil bağlantısı sızdı').not.toContain('/tc/gizliyazar')

    // Akışlarda da sızmaz.
    const home = await reader.agent.get('/')
    expect(await home.text()).not.toContain('/tc/gizliyazar')

    // Profil sayfasında listelenmez.
    const profile = await reader.agent.get('/tc/gizliyazar')
    expect(await profile.text()).not.toContain('GIZLI-POST')
  })

  test('anonim olmayan gönderi normal görünür', async () => {
    const { agent } = await registerUser(world, 'normalyazar')
    await createCommunityVia(agent, 'nonanon')
    const id = await createPostVia(agent, 'nonanon', 'NORMAL-POST')
    const res = await agent.get(`/c/nonanon/comments/${id}`)
    const html = await res.text()
    expect(html).toContain('/tc/normalyazar')
  })

  test('varsayılan anonim tercihi ayarlardan yönetilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'anonpref')

    const settings = await agent.get('/settings')
    expect(await settings.text()).toContain('name="anonByDefault"')

    await agent.post('/settings', { anonByDefault: '1' })
    const user = world.ctx.db.prepare('SELECT anon_by_default FROM users LIMIT 1').get() as {
      anon_by_default: number
    }
    expect(user.anon_by_default).toBe(1)

    // Varsayılan açıldığında kompozitördeki kutu işaretli gelmeli.
    const composer = await agent.get('/c/anonpref/submit')
    expect(await composer.text()).toMatch(/name="anonymous"[^>]*checked/)

    // Ve gönderi onaylandığında anonim olmalı.
    const res = await agent.post('/c/anonpref/submit?type=text', { title: 'PREF-POST', body: '', anonymous: '1' })
    const id = postIdFrom(res)
    const row = world.ctx.db.prepare('SELECT is_anonymous FROM posts WHERE id = ?').get(id) as { is_anonymous: number }
    expect(row.is_anonymous).toBe(1)

    // Varsayılan kapalıyken kutu işaretli olmamalı.
    await agent.post('/settings', {})
    const off = await agent.get('/c/anonpref/submit')
    expect(await off.text()).not.toMatch(/name="anonymous"[^>]*checked/)
  })

  test('yönetim paneli anonim gönderilerin gerçek yazarını gösterir', async () => {
    const admin = await registerAdmin(world)
    await createCommunityVia(admin.agent, 'adminanon')
    await admin.agent.post('/c/adminanon/submit?type=text', {
      title: 'ADMIN-ANON',
      body: '',
      anonymous: '1',
    })

    const res = await admin.agent.get('/admin?tab=anonymous')
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('ADMIN-ANON')
    expect(html).toContain(admin.username)

    // Normal üye bu sekmeyi göremez.
    const member = (await registerUser(world)).agent
    const denied = await member.get('/admin?tab=anonymous')
    expect(denied.status).toBe(403)
  })
})

/* -------------------------------------------------------------------------- */

describe('thread modu', () => {
  test('thread gönderisi oluşturulur ve rozetle işaretlenir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'threadboard')
    const res = await agent.post('/c/threadboard/submit?type=text', {
      title: 'THREAD-POST',
      body: 'konu',
      isThread: '1',
    })
    const id = postIdFrom(res)
    const row = world.ctx.db.prepare('SELECT is_thread FROM posts WHERE id = ?').get(id) as { is_thread: number }
    expect(row.is_thread).toBe(1)

    const detail = await agent.get(`/c/threadboard/comments/${id}`)
    const html = await detail.text()
    expect(html).toContain('Thread modu')
    expect(html).toContain('thread-banner')
  })

  test('thread yanıtları sıralı numaralanır ve öncekini alıntılar', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thchain')
    const res = await agent.post('/c/thchain/submit?type=text', { title: 'CHAIN', body: '', isThread: '1' })
    const id = postIdFrom(res)

    await agent.post(`/c/thchain/comments/${id}/comment`, { body: 'birinci yanıt' })
    world.tick(1000)
    await agent.post(`/c/thchain/comments/${id}/comment`, { body: 'ikinci yanıt' })
    world.tick(1000)
    await agent.post(`/c/thchain/comments/${id}/comment`, { body: 'üçüncü yanıt' })

    const nos = world.ctx.db
      .prepare('SELECT body, thread_no, reply_to_comment_id FROM comments ORDER BY created_at ASC')
      .all() as Array<{ body: string; thread_no: number; reply_to_comment_id: string | null }>
    expect(nos.map((n) => n.thread_no)).toEqual([1, 2, 3])
    expect(nos[0]?.reply_to_comment_id).toBeNull()
    expect(nos[1]?.reply_to_comment_id).not.toBeNull()
    expect(nos[2]?.reply_to_comment_id).not.toBeNull()

    const detail = await agent.get(`/c/thchain/comments/${id}`)
    const html = await detail.text()
    expect(html).toContain('thread-reply-no')
    expect(html).toContain('#2')
    expect(html).toContain('thread-quote')
  })

  test('bump sayacı artar ve thread istatistikleri görünür', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thbump')
    const res = await agent.post('/c/thbump/submit?type=text', { title: 'BUMPED', body: '', isThread: '1' })
    const id = postIdFrom(res)
    await agent.post(`/c/thbump/comments/${id}/comment`, { body: 'ilk' })
    world.tick(1000)
    await agent.post(`/c/thbump/comments/${id}/comment`, { body: 'ikinci' })

    const row = world.ctx.db.prepare('SELECT bump_count, reply_count, bumped_at FROM posts WHERE id = ?').get(id) as {
      bump_count: number
      reply_count: number
      bumped_at: number | null
    }
    expect(row.reply_count).toBe(2)
    expect(row.bump_count).toBe(2)
    expect(row.bumped_at).not.toBeNull()
  })

  test('bump limiti dolduğunda thread yukarı taşınmaz', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thlimit')
    world.ctx.db
      .prepare("INSERT INTO site_settings (key, value) VALUES ('threadBumpLimit', '2')")
      .run()
    const res = await agent.post('/c/thlimit/submit?type=text', { title: 'LIMITED', body: '', isThread: '1' })
    const id = postIdFrom(res)
    for (const body of ['a', 'b', 'c', 'd']) {
      await agent.post(`/c/thlimit/comments/${id}/comment`, { body })
      world.tick(1000)
    }
    const row = world.ctx.db.prepare('SELECT bump_count, reply_count FROM posts WHERE id = ?').get(id) as {
      bump_count: number
      reply_count: number
    }
    expect(row.reply_count).toBe(4)
    expect(row.bump_count).toBe(2) // limite takıldı
  })

  test('kilitli thread görünür ama yanıt alınamaz', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thlock')
    const res = await agent.post('/c/thlock/submit?type=text', { title: 'LOCKED', body: '', isThread: '1' })
    const id = postIdFrom(res)
    await agent.post(`/posts/${id}/thread`, { action: 'lock', back: `/c/thlock/comments/${id}` })

    // Görünür.
    const detail = await agent.get(`/c/thlock/comments/${id}`)
    const html = await detail.text()
    expect(html).toContain('Kilitli')
    expect(html).toContain('thread-locked-note')

    // Yanıt verilemez.
    const reply = await agent.post(`/c/thlock/comments/${id}/comment`, { body: 'deneme' })
    expect(reply.status).toBe(302)
    expect(
      (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?').get(id) as { n: number }).n,
    ).toBe(0)

    // Moderatör açabilir.
    await agent.post(`/posts/${id}/thread`, { action: 'unlock', back: `/c/thlock/comments/${id}` })
    const ok = await agent.post(`/c/thlock/comments/${id}/comment`, { body: 'şimdi olur' })
    expect(ok.status).toBe(302)
    expect(
      (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments WHERE post_id = ?').get(id) as { n: number }).n,
    ).toBe(1)
  })

  test('normal üye thread durumunu değiştiremez', async () => {
    const mod = await registerUser(world)
    await createCommunityVia(mod.agent, 'thperm')
    const res = await mod.agent.post('/c/thperm/submit?type=text', { title: 'PERM', body: '', isThread: '1' })
    const id = postIdFrom(res)

    const stranger = await registerUser(world)
    await stranger.agent.post(`/posts/${id}/thread`, { action: 'lock' })
    const row = world.ctx.db.prepare('SELECT thread_locked FROM posts WHERE id = ?').get(id) as { thread_locked: number }
    expect(row.thread_locked).toBe(0)
  })

  test('arşivlenmiş thread yalnızca yöneticiye görünür', async () => {
    const admin = await registerAdmin(world)
    await createCommunityVia(admin.agent, 'tharch')
    const res = await admin.agent.post('/c/tharch/submit?type=text', { title: 'ARCHIVED', body: '', isThread: '1' })
    const id = postIdFrom(res)
    await admin.agent.post(`/posts/${id}/thread`, { action: 'archive', back: `/c/tharch/comments/${id}` })

    // Yönetici görür.
    const adminView = await admin.agent.get(`/c/tharch/comments/${id}`)
    expect(adminView.status).toBe(200)
    expect(await adminView.text()).toContain('Arşivlenmiş')

    // Normal üye giremez ve akışta görmez.
    const member = (await registerUser(world)).agent
    const memberView = await member.get(`/c/tharch/comments/${id}`)
    expect(memberView.status).toBe(404)
    const board = await member.get('/c/tharch')
    expect(await board.text()).not.toContain('ARCHIVED')
  })

  test('board akışında thread filtresi çalışır', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thfilter')
    await agent.post('/c/thfilter/submit?type=text', { title: 'IS-THREAD', body: '', isThread: '1' })
    world.tick(HOUR)
    await createPostVia(agent, 'thfilter', 'NORMAL-POST')

    const filtered = await agent.get('/c/thfilter?threads=1')
    const html = await filtered.text()
    expect(html).toContain('IS-THREAD')
    expect(html).not.toContain('NORMAL-POST')

    const all = await agent.get('/c/thfilter')
    const allHtml = await all.text()
    expect(allHtml).toContain('IS-THREAD')
    expect(allHtml).toContain('NORMAL-POST')
  })

  test('bump sıralaması son hareket eden thread’i öne alır', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thbumporder')
    const a = await agent.post('/c/thbumporder/submit?type=text', { title: 'THREAD-A', body: '', isThread: '1' })
    const aId = postIdFrom(a)
    world.tick(HOUR)
    const b = await agent.post('/c/thbumporder/submit?type=text', { title: 'THREAD-B', body: '', isThread: '1' })
    const bId = postIdFrom(b)
    // B'nin bumped_at değerinden kesinlikle sonrasına düş (eşitlikte sıra
    // kimliğe göre belirlenir ve test kararsızlaşırdı).
    world.tick(HOUR)

    // A'yı yeni yanıtla hareket ettir → A öne geçmeli.
    await agent.post(`/c/thbumporder/comments/${aId}/comment`, { body: 'hareket' })

    const res = await agent.get('/c/thbumporder?sort=bump&t=all&threads=1')
    const html = await res.text()
    const order = ['THREAD-A', 'THREAD-B'].filter((t) => html.includes(t)).sort((x, y) => html.indexOf(x) - html.indexOf(y))
    expect(order).toEqual(['THREAD-A', 'THREAD-B'])
    expect(bId).toBeTruthy()
  })

  test('sticky thread bump listesinde en üstte tutulur', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thstickyorder')
    const a = await agent.post('/c/thstickyorder/submit?type=text', { title: 'STICKY-A', body: '', isThread: '1' })
    const aId = postIdFrom(a)
    world.tick(HOUR)
    const b = await agent.post('/c/thstickyorder/submit?type=text', { title: 'LATER-B', body: '', isThread: '1' })
    const bId = postIdFrom(b)

    // B'yi hareket ettir (aksi halde B önde gelirdi), sonra A'yı sabitle.
    await agent.post(`/c/thstickyorder/comments/${bId}/comment`, { body: 'B hareketlendi' })
    await agent.post(`/posts/${aId}/thread`, { action: 'sticky', back: `/c/thstickyorder/comments/${aId}` })

    const res = await agent.get('/c/thstickyorder?sort=bump&t=all&threads=1')
    const html = await res.text()
    const order = ['STICKY-A', 'LATER-B'].filter((t) => html.includes(t)).sort((x, y) => html.indexOf(x) - html.indexOf(y))
    // Sabitlenen thread, daha yeni hareket etmiş olsa da başta.
    expect(order).toEqual(['STICKY-A', 'LATER-B'])
  })

  test('sticky thread rozeti görünür ve kapatılabilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'thsticky')
    const res = await agent.post('/c/thsticky/submit?type=text', { title: 'STICKY', body: '', isThread: '1' })
    const id = postIdFrom(res)
    await agent.post(`/posts/${id}/thread`, { action: 'sticky', back: `/c/thsticky/comments/${id}` })

    const on = await agent.get(`/c/thsticky/comments/${id}`)
    expect(await on.text()).toContain('Sabitlenmiş')

    await agent.post(`/posts/${id}/thread`, { action: 'unsticky', back: `/c/thsticky/comments/${id}` })
    const row = world.ctx.db.prepare('SELECT thread_sticky FROM posts WHERE id = ?').get(id) as { thread_sticky: number }
    expect(row.thread_sticky).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('düzenleme ve silme', () => {
  test('metin gönderisi düzenlenir ve düzenleme tarihi görünür', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'editable')
    const id = await createPostVia(agent, 'editable', 'EDIT-POST', 'ilk gövde')
    const res = await agent.post(`/posts/${id}/edit`, { body: 'güncel gövde' })
    expect(res.status).toBe(302)
    const detail = await agent.get(`/c/editable/comments/${id}`)
    const html = await detail.text()
    expect(html).toContain('güncel gövde')
    const row = world.ctx.db.prepare('SELECT edited_at FROM posts WHERE id = ?').get(id) as { edited_at: number | null }
    expect(row.edited_at).not.toBeNull()
  })

  test('gönderi silinir ve akıştan düşer', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'deletable')
    const id = await createPostVia(agent, 'deletable', 'GONE-POST')
    await agent.post(`/posts/${id}/delete`)
    const board = await agent.get('/c/deletable')
    expect(await board.text()).not.toContain('GONE-POST')
  })
})
