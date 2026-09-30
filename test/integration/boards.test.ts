/**
 * Board platformu özellikleri: sıralama, kişiselleştirilmiş ana sayfa akışı,
 * board etiketleri (flair), spoiler gizleme, medya önizleme, sabitlenmiş
 * gönderiler, sonsuz kaydırma parçaları ve yalnızca yöneticiye açık board
 * oluşturma.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerAdmin,
  registerUser,
  relogin,
  type TestWorld,
} from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

const HOUR = 60 * 60 * 1000

/** HTML içinde iki başlığın görünüm sırası. */
function order(html: string, titles: string[]): string[] {
  return titles.filter((t) => html.includes(t)).sort((a, b) => html.indexOf(a) - html.indexOf(b))
}

/** Bir gönderiyi doğrudan günceller (sıralama testleri için). */
function patchPost(id: string, columns: Record<string, string | number>): void {
  const sets = Object.keys(columns)
    .map((k) => `${k} = ?`)
    .join(', ')
  world.ctx.db
    .prepare(`UPDATE posts SET ${sets} WHERE id = ?`)
    .run(...Object.values(columns), id)
}

function latestPostId(): string {
  return (world.ctx.db.prepare('SELECT id FROM posts ORDER BY created_at DESC LIMIT 1').get() as { id: string }).id
}

/* -------------------------------------------------------------------------- */
/* Sıralama                                                                   */
/* -------------------------------------------------------------------------- */

describe('sıralama: Popüler / Yeni / En iyi', () => {
  test('ana sayfada üç sekme de bulunur ve her biri kendi kuralını uygular', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'ranking')

    // "En iyi" Wilson alt sınırına bakar: yüksek puanlı ama baskın olmayan
    // gönderi, yüksek puanlı ve tepkisi olmayan gönderiyi geçer.
    await createPostVia(agent, 'ranking', 'BEST-LOW-RATIO')
    patchPost(latestPostId(), { upvotes: 20, downvotes: 18, score: 2 })
    world.tick(HOUR)
    await createPostVia(agent, 'ranking', 'BEST-HIGH-RATIO')
    patchPost(latestPostId(), { upvotes: 30, downvotes: 0, score: 30 })

    const home = await agent.get('/')
    const text = await home.text()
    expect(text).toContain('Popüler')
    expect(text).toContain('Yeni')
    expect(text).toContain('En iyi')
    // Üyelik olmadığı için ana sayfa tüm okunabilir gönderileri gösterir.
    expect(text).toContain('BEST-LOW-RATIO')

    // En iyi: oy oranı baskın olan gönderi önde.
    const best = await agent.get('/?sort=best&t=all')
    expect(order(await best.text(), ['BEST-LOW-RATIO', 'BEST-HIGH-RATIO'])).toEqual([
      'BEST-HIGH-RATIO',
      'BEST-LOW-RATIO',
    ])

    // Yeni: yalnızca kronoloji.
    const fresh = await agent.get('/?sort=new')
    expect(order(await fresh.text(), ['BEST-LOW-RATIO', 'BEST-HIGH-RATIO'])).toEqual([
      'BEST-HIGH-RATIO',
      'BEST-LOW-RATIO',
    ])

    // Popüler: hot_rank — taze olan öne geçer.
    const hot = await agent.get('/?sort=hot')
    expect(order(await hot.text(), ['BEST-LOW-RATIO', 'BEST-HIGH-RATIO'])).toEqual([
      'BEST-HIGH-RATIO',
      'BEST-LOW-RATIO',
    ])
  })

  test('board akışında "En iyi" sekmesi zaman aralığına uyar', async () => {
    const { username } = await registerUser(world, 'windower')
    let agent = await relogin(world, username)
    await createCommunityVia(agent, 'windows')

    await createPostVia(agent, 'windows', 'ANCIENT-BEST')
    patchPost(latestPostId(), { upvotes: 40, downvotes: 0, score: 40 })
    world.tick(10 * 24 * HOUR)
    // 10 gün idle süresini aştığı için oturum sunucuda sona erdi.
    agent = await relogin(world, username)
    await createPostVia(agent, 'windows', 'RECENT-WEAK')
    patchPost(latestPostId(), { upvotes: 1, downvotes: 0, score: 1 })

    const all = await agent.get('/c/windows?sort=best&t=all')
    expect(order(await all.text(), ['ANCIENT-BEST', 'RECENT-WEAK'])).toEqual([
      'ANCIENT-BEST',
      'RECENT-WEAK',
    ])

    const week = await agent.get('/c/windows?sort=best&t=week')
    const weekText = await week.text()
    expect(weekText).toContain('RECENT-WEAK')
    expect(weekText).not.toContain('ANCIENT-BEST')
  })

  test('`top` eski adı "En iyi" olarak çalışır', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'alias')
    await createPostVia(agent, 'alias', 'ALIAS-POST')
    const res = await agent.get('/c/alias?sort=top&t=all')
    const text = await res.text()
    expect(text).toContain('ALIAS-POST')
    expect(text).toContain('En iyi')
  })

  test('yorum sıralaması En iyi / Popüler / Yeni sekmeleri sunar', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'talk')
    const postId = await createPostVia(agent, 'talk', 'COMMENT-THREAD')
    await agent.post(`/c/talk/comments/${postId}/comment`, { body: 'ilk yorum' })
    const page = await agent.get(`/c/talk/comments/${postId}`)
    const text = await page.text()
    expect(text).toContain('En iyi')
    expect(text).toContain('Popüler')
    expect(text).toContain('Yeni')
  })
})

/* -------------------------------------------------------------------------- */
/* Kişiselleştirilmiş ana sayfa akışı                                          */
/* -------------------------------------------------------------------------- */

describe('kişiselleştirilmiş ana sayfa akışı', () => {
  test('ana sayfada "Sana özel" yazısı gösterilmez, sıralama ve filtre hizalıdır', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'personal')
    await createPostVia(agent, 'personal', 'PERSONAL-POST')

    const home = await agent.get('/')
    const text = await home.text()
    // Rozet kaldırıldı: akış başlığı artık yalnızca sıralama + filtre.
    expect(text).not.toContain('for-you-chip')
    expect(text).not.toContain('Sana özel')
    // Sıralama sekmeleri ve filtre düğmesi aynı başlık satırında.
    expect(text).toContain('feed-head')
    expect(text).toContain('sort-tabs')
    expect(text).toContain('data-feed-filters')

    const guest = new Agent(world.app)
    const guestRes = await guest.get('/login')
    await guestRes.text()
    const guestHome = await guest.get('/')
    const guestText = await guestHome.text()
    expect(guestText).not.toContain('for-you-chip')
  })

  test('etkileşimde bulunulan boardun gönderileri eşit puanlı rakibe göre öne geçer', async () => {
    const owner = await registerUser(world)
    await createCommunityVia(owner.agent, 'liked')
    await createCommunityVia(owner.agent, 'neutral')

    const { agent: reader } = await registerUser(world)
    await reader.post('/c/liked/join')
    await reader.post('/c/neutral/join')

    const likedId = await createPostVia(owner.agent, 'liked', 'LIKED-BOARD-POST')
    await createPostVia(owner.agent, 'neutral', 'NEUTRAL-BOARD-POST')
    world.ctx.db.prepare("UPDATE posts SET upvotes = 10, downvotes = 0, score = 10 WHERE id IN (?, ?)").run(likedId, latestPostId())

    // Yorum yazmak boardun ilgi puanını yükseltir.
    await reader.post(`/c/liked/comments/${likedId}/comment`, { body: 'ilgimi çekti' })

    const hot = await reader.get('/?sort=hot')
    expect(order(await hot.text(), ['LIKED-BOARD-POST', 'NEUTRAL-BOARD-POST'])).toEqual([
      'LIKED-BOARD-POST',
      'NEUTRAL-BOARD-POST',
    ])

    // Yeni sekmesi kişiselleştirilmez: kronolojik kalır.
    world.tick(HOUR)
    await createPostVia(owner.agent, 'neutral', 'NEUTRAL-NEWER-POST')
    const fresh = await reader.get('/?sort=new')
    expect(order(await fresh.text(), ['LIKED-BOARD-POST', 'NEUTRAL-NEWER-POST'])).toEqual([
      'NEUTRAL-NEWER-POST',
      'LIKED-BOARD-POST',
    ])
  })

  test('"İlgimi azalt" puanı düşürür ve sıralamayı tersine çevirir', async () => {
    const owner = await registerUser(world)
    await createCommunityVia(owner.agent, 'noisy')
    await createCommunityVia(owner.agent, 'quiet')

    const { agent: reader } = await registerUser(world)
    await reader.post('/c/noisy/join')
    await reader.post('/c/quiet/join')

    await createPostVia(owner.agent, 'quiet', 'QUIET-POST')
    world.tick(HOUR)
    await createPostVia(owner.agent, 'noisy', 'NOISY-POST')
    world.ctx.db
      .prepare('UPDATE posts SET upvotes = 10, downvotes = 0, score = 10')
      .run()

    // İki board da üyelik puanıyla (1.4) eşit; tazelik NOISY'yi öne alır.
    const before = await reader.get('/?sort=hot')
    expect(order(await before.text(), ['NOISY-POST', 'QUIET-POST'])).toEqual(['NOISY-POST', 'QUIET-POST'])

    const dismissed = await reader.post('/feed/dismiss', { board: 'noisy', next: '/?sort=hot' })
    expect(dismissed.status).toBe(302)
    expect(dismissed.headers.get('location')).toContain('/?sort=hot')

    const after = await reader.get('/?sort=hot')
    expect(order(await after.text(), ['NOISY-POST', 'QUIET-POST'])).toEqual(['QUIET-POST', 'NOISY-POST'])
  })

  test('ilgi paneli yalnızca puanı olan boardları listeler', async () => {
    const owner = await registerUser(world)
    await createCommunityVia(owner.agent, 'tracked')
    const { agent: reader } = await registerUser(world)
    await createPostVia(reader, 'tracked', 'TRACKED-POST')

    // Gönderi yazmak ilgi puanı oluşturur.
    const home = await reader.get('/')
    const text = await home.text()
    expect(text).toContain('affinity-list')
    expect(text).toContain('b/tracked')
    expect(text).toContain('/feed/dismiss')
  })
})

/* -------------------------------------------------------------------------- */
/* Board etiketleri (flair)                                                    */
/* -------------------------------------------------------------------------- */

describe('board etiketleri (flair)', () => {
  test('moderatör etiket oluşturur, üye oluşturamaz', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'labelled')
    const { agent: member } = await registerUser(world)

    const created = await mod.post('/c/labelled/flairs', { name: 'Soru', color: '#0f6b62' })
    expect(created.status).toBe(302)
    expect(created.headers.get('location')).toBe('/c/labelled/settings')

    const row = world.ctx.db.prepare('SELECT name, color FROM board_flairs').get() as { name: string; color: string }
    expect(row.name).toBe('Soru')
    expect(row.color).toBe('#0f6b62')

    const denied = await member.post('/c/labelled/flairs', { name: 'Kötüye', color: '' })
    expect(denied.status).toBe(302)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM board_flairs').get() as { n: number }).n).toBe(1)
  })

  test('geçersiz etiket adı ve renk reddedilir', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'validated')

    await mod.post('/c/validated/flairs', { name: '   ', color: '' })
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM board_flairs').get() as { n: number }).n).toBe(0)

    await mod.post('/c/validated/flairs', { name: 'İyi', color: 'kirmizi' })
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM board_flairs').get() as { n: number }).n).toBe(0)

    await mod.post('/c/validated/flairs', { name: 'İyi', color: '#aabbcc' })
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM board_flairs').get() as { n: number }).n).toBe(1)
  })

  test('aynı ad iki kez kullanılamaz', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'unique')
    await mod.post('/c/unique/flairs', { name: 'Haber', color: '' })
    await mod.post('/c/unique/flairs', { name: 'haber', color: '' })
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM board_flairs').get() as { n: number }).n).toBe(1)
  })

  test('gönderi etiketle gönderilir, kartta rozet olarak görünür', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'tagged')
    await agent.post('/c/tagged/flairs', { name: 'Rehber', color: '#1144aa' })
    const flair = world.ctx.db.prepare('SELECT id FROM board_flairs').get() as { id: string }

    const res = await agent.post('/c/tagged/submit?type=text', {
      title: 'Etiketli gönderi',
      body: 'gövde',
      flairId: flair.id,
    })
    expect(res.status).toBe(302)
    const postId = (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    const row = world.ctx.db.prepare('SELECT flair_id FROM posts WHERE id = ?').get(postId) as { flair_id: string }
    expect(row.flair_id).toBe(flair.id)

    const board = await agent.get('/c/tagged')
    const text = await board.text()
    expect(text).toContain('post-flair')
    expect(text).toContain('Rehber')
    expect(text).toContain(`flair=${flair.id}`)

    const home = await agent.get('/')
    expect(await home.text()).toContain('Rehber')
  })

  test('etiket akış filtrelerinde sayacıyla listelenir ve ?flair= ile filtreler', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'filtered')
    await agent.post('/c/filtered/flairs', { name: 'Soru', color: '' })
    await agent.post('/c/filtered/flairs', { name: 'Tartışma', color: '' })
    const rows = world.ctx.db.prepare('SELECT id, name FROM board_flairs ORDER BY name').all() as Array<{
      id: string
      name: string
    }>
    const soru = rows.find((r) => r.name === 'Soru') as { id: string }
    const tartisma = rows.find((r) => r.name === 'Tartışma') as { id: string }

    await agent.post('/c/filtered/submit?type=text', { title: 'SORU-POST', body: '', flairId: soru.id })
    world.tick(HOUR)
    await agent.post('/c/filtered/submit?type=text', { title: 'TARTISMA-POST', body: '', flairId: tartisma.id })
    world.tick(HOUR)
    await agent.post('/c/filtered/submit?type=text', { title: 'ETIKETSIZ-POST', body: '', flairId: '' })

    const board = await agent.get('/c/filtered')
    const boardText = await board.text()
    expect(boardText).toContain('feed-filters')
    expect(boardText).toContain('Soru')
    expect(boardText).toContain('Tartışma')

    const filtered = await agent.get(`/c/filtered?flair=${soru.id}`)
    const filteredText = await filtered.text()
    expect(filteredText).toContain('SORU-POST')
    expect(filteredText).not.toContain('TARTISMA-POST')
    expect(filteredText).not.toContain('ETIKETSIZ-POST')

    // Ana sayfa filtresi de aynı etiketi kullanır.
    const homeFiltered = await agent.get(`/?flair=${tartisma.id}`)
    const homeText = await homeFiltered.text()
    expect(homeText).toContain('TARTISMA-POST')
    expect(homeText).not.toContain('SORU-POST')
  })

  test('board filtresi ana sayfada ?c= ile çalışır', async () => {
    const owner = await registerUser(world)
    await createCommunityVia(owner.agent, 'alpha')
    await createCommunityVia(owner.agent, 'beta')
    await createPostVia(owner.agent, 'alpha', 'ALPHA-POST')
    await createPostVia(owner.agent, 'beta', 'BETA-POST')

    const res = await owner.agent.get('/?c=beta')
    const text = await res.text()
    expect(text).toContain('BETA-POST')
    expect(text).not.toContain('ALPHA-POST')
  })

  test('etiket silinince gönderiler etiketsiz kalır', async () => {
    const { agent: mod } = await registerUser(world)
    await createCommunityVia(mod, 'cleanup')
    await mod.post('/c/cleanup/flairs', { name: 'Geçici', color: '' })
    const flair = world.ctx.db.prepare('SELECT id FROM board_flairs').get() as { id: string }
    await mod.post('/c/cleanup/submit?type=text', { title: 'GEÇICI-POST', body: '', flairId: flair.id })

    const res = await mod.post(`/c/cleanup/flairs/${flair.id}/delete`)
    expect(res.status).toBe(302)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM board_flairs').get() as { n: number }).n).toBe(0)

    const post = world.ctx.db.prepare('SELECT flair_id FROM posts').get() as { flair_id: string | null }
    expect(post.flair_id).toBeNull()

    const board = await mod.get('/c/cleanup')
    const text = await board.text()
    expect(text).toContain('GEÇICI-POST')
    expect(text).not.toContain('Geçici')
  })

  test('yazar gönderisinin spoiler ve etiketini gönderi sayfasından günceller', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'editable')
    await agent.post('/c/editable/flairs', { name: 'Güncel', color: '' })
    const flair = world.ctx.db.prepare('SELECT id FROM board_flairs').get() as { id: string }
    const postId = await createPostVia(agent, 'editable', 'META-POST')

    const res = await agent.post(`/posts/${postId}/meta`, {
      spoiler: '1',
      flairId: flair.id,
      back: `/c/editable/comments/${postId}`,
    })
    expect(res.status).toBe(302)

    const row = world.ctx.db.prepare('SELECT spoiler, flair_id FROM posts WHERE id = ?').get(postId) as {
      spoiler: number
      flair_id: string
    }
    expect(row.spoiler).toBe(1)
    expect(row.flair_id).toBe(flair.id)
  })

  test('başka kullanıcı gönderinin spoiler/etiketini değiştiremez', async () => {
    const { agent: author } = await registerUser(world)
    await createCommunityVia(author, 'guarded')
    const postId = await createPostVia(author, 'guarded', 'GUARDED-POST')
    const { agent: stranger } = await registerUser(world)

    const res = await stranger.post(`/posts/${postId}/meta`, { spoiler: '1', flairId: '' })
    expect(res.status).toBe(302)
    const row = world.ctx.db.prepare('SELECT spoiler FROM posts WHERE id = ?').get(postId) as { spoiler: number }
    expect(row.spoiler).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Spoiler                                                                     */
/* -------------------------------------------------------------------------- */

describe('spoiler içerik gizleme', () => {
  test('spoiler gönderi gizli blokla çizilir, spoiler olmayan gizlenmez', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'spoilers')

    const res = await agent.post('/c/spoilers/submit?type=text', {
      title: 'SPOILER-POST',
      body: 'gizli detay metni',
      spoiler: '1',
    })
    const postId = (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    await createPostVia(agent, 'spoilers', 'NORMAL-POST')

    const board = await agent.get('/c/spoilers?sort=new')
    const text = await board.text()
    expect(text).toContain('data-spoiler="1"')
    expect(text).toContain('data-spoiler-toggle')
    expect(text).toContain('spoiler-body')
    expect(text).toContain('Spoiler içerik')

    const detail = await agent.get(`/c/spoilers/comments/${postId}`)
    const detailText = await detail.text()
    expect(detailText).toContain('post-spoiler')
    expect(detailText).toContain('data-spoiler-toggle')
  })

  test('spoiler olmayan gönderide gizleme bloğu bulunmaz', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'plain')
    const postId = await createPostVia(agent, 'plain', 'PLAIN-POST', 'görünür gövde')
    const detail = await agent.get(`/c/plain/comments/${postId}`)
    const text = await detail.text()
    expect(text).toContain('görünür gövde')
    expect(text).not.toContain('data-spoiler="1"')
  })
})

/* -------------------------------------------------------------------------- */
/* Medya önizleme                                                              */
/* -------------------------------------------------------------------------- */

describe('medya önizleme', () => {
  async function linkPost(agent: Agent, community: string, title: string, url: string): Promise<string> {
    const res = await agent.post(`/c/${community}/submit?type=link`, { title, url })
    expect(res.status).toBe(302)
    return (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
  }

  test('bağlantı türüne göre medya_kind doğru atanır', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'media')
    await linkPost(agent, 'media', 'GIF-LINK', 'https://cdn.example.com/a.gif')
    await linkPost(agent, 'media', 'VIDEO-LINK', 'https://cdn.example.com/a.mp4')
    await linkPost(agent, 'media', 'IMAGE-LINK', 'https://cdn.example.com/a.jpg')
    await linkPost(agent, 'media', 'YOUTUBE-LINK', 'https://www.youtube.com/watch?v=abc123')
    await linkPost(agent, 'media', 'PLAIN-LINK', 'https://example.com/article')

    const kinds = world.ctx.db
      .prepare('SELECT title, media_kind FROM posts ORDER BY created_at ASC')
      .all() as Array<{ title: string; media_kind: string }>
    const byTitle = Object.fromEntries(kinds.map((k) => [k.title, k.media_kind]))
    expect(byTitle['GIF-LINK']).toBe('gif')
    expect(byTitle['VIDEO-LINK']).toBe('video')
    expect(byTitle['IMAGE-LINK']).toBe('image')
    expect(byTitle['YOUTUBE-LINK']).toBe('embed')
    expect(byTitle['PLAIN-LINK']).toBe('none')
  })

  test('GIF önizlemesi rozetle birlikte çizilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'gifs')
    await linkPost(agent, 'gifs', 'ANIMATED-ONE', 'https://cdn.example.com/funny.gif')
    const home = await agent.get('/')
    const text = await home.text()
    expect(text).toContain('is-gif')
    expect(text).toContain('media-badge')
    expect(text).toContain('GIF')
  })

  test('video önizlemesi <video> oynatıcısı üretir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'videos')
    await linkPost(agent, 'videos', 'CLIP-ONE', 'https://cdn.example.com/clip.mp4')
    const board = await agent.get('/c/videos')
    const text = await board.text()
    expect(text).toContain('is-video')
    expect(text).toContain('<video')
    expect(text).toContain('clip.mp4')
  })

  test('YouTube bağlantısı gömülü oynatıcı olarak çizilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'embeds')
    const postId = await linkPost(agent, 'embeds', 'VIDEO-ESSAY', 'https://www.youtube.com/watch?v=abc123')

    const board = await agent.get('/c/embeds')
    const boardText = await board.text()
    expect(boardText).toContain('is-embed')
    expect(boardText).toContain('youtube-nocookie.com/embed/abc123')

    const detail = await agent.get(`/c/embeds/comments/${postId}`)
    expect(await detail.text()).toContain('youtube-nocookie.com/embed/abc123')
  })

  test('görsel gönderi kartta ve detayda /media/ üzerinden servis edilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'shots')
    const exif = Array.from(Buffer.from('Exif\0\0SECRET-GPS'))
    const bytes = Uint8Array.from([
      0xff, 0xd8, 0xff, 0xe1, 0x00, exif.length + 2, ...exif, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x99, 0x88, 0xff, 0xd9,
    ])
    const form = new FormData()
    form.set('title', 'PHOTO-POST')
    form.set('image', new File([bytes], 'photo.jpg', { type: 'image/jpeg' }))
    const res = await agent.request('/c/shots/submit?type=image', { method: 'POST', body: form })
    const postId = (res.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    const post = world.ctx.db.prepare('SELECT image_key FROM posts WHERE id = ?').get(postId) as { image_key: string }

    const board = await agent.get('/c/shots')
    expect(await board.text()).toContain(`/media/${post.image_key}`)

    const media = await agent.get(`/media/${post.image_key}`)
    expect(media.status).toBe(200)
    expect(media.headers.get('content-type')).toBe('image/jpeg')
  })
})

/* -------------------------------------------------------------------------- */
/* Sabitlenmiş gönderiler                                                      */
/* -------------------------------------------------------------------------- */

describe('sabitlenmiş gönderi gösterimi', () => {
  test('boardda sabitlenen gönderi ayrı bölümde ve akışta tekrarlanmaz', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'pinned')
    const pinnedId = await createPostVia(agent, 'pinned', 'PINNED-NOTICE')
    world.tick(HOUR)
    await createPostVia(agent, 'pinned', 'REGULAR-CHATTER')
    await agent.post(`/posts/${pinnedId}/pin`)

    const board = await agent.get('/c/pinned?sort=new')
    const text = await board.text()
    expect(text).toContain('pinned-section')
    expect(text).toContain('Boardda sabitlenmiş gönderiler')

    // Sabitlenen gönderi akış bölümünde yer almaz.
    const feedPart = text.slice(text.indexOf('pinned-section'))
    const occurrences = feedPart.split('PINNED-NOTICE').length - 1
    expect(occurrences).toBe(1)
  })

  test('sabitlenen gönderi ana sayfa akışında kronolojik yerini korur', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'pinnedhome')
    const pinnedId = await createPostVia(agent, 'pinnedhome', 'HOME-PINNED')
    world.tick(HOUR)
    await createPostVia(agent, 'pinnedhome', 'HOME-NEWER')
    await agent.post(`/posts/${pinnedId}/pin`)

    const home = await agent.get('/?sort=new')
    const text = await home.text()
    expect(text).not.toContain('pinned-section')
    expect(order(text, ['HOME-PINNED', 'HOME-NEWER'])).toEqual(['HOME-NEWER', 'HOME-PINNED'])
  })
})

/* -------------------------------------------------------------------------- */
/* Sonsuz kaydırma (partial parçalar)                                          */
/* -------------------------------------------------------------------------- */

describe('sonsuz kaydırma parçaları', () => {
  test('ana sayfa ?partial=1 yalnızca kart listesi döndürür', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'scroller')
    for (let i = 0; i < 30; i++) {
      await createPostVia(agent, 'scroller', `SCROLL-${String(i).padStart(2, '0')}`)
      world.tick(60 * 1000)
      if ((i + 1) % 5 === 0) world.tick(10 * 60 * 1000)
    }

    const first = await agent.get('/?sort=new')
    const firstText = await first.text()
    expect(firstText).toContain('data-feed')
    expect(firstText).toContain('data-feed-status')
    const cursor = firstText.match(/data-next-cursor="([A-Za-z0-9_-]+)"/)?.[1] as string
    expect(cursor).toBeTruthy()

    const partial = await agent.get(`/?sort=new&partial=1&after=${cursor}`)
    expect(partial.status).toBe(200)
    const partialText = await partial.text()
    expect(partialText).toContain('data-feed-page="home-feed"')
    // Parça tam sayfa değildir: layout yok.
    expect(partialText).not.toContain('<html')
    expect(partialText).not.toContain('data-feed-status')
  })

  test('board akışı ?partial=1 ile devam eder', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'boardscroll')
    for (let i = 0; i < 30; i++) {
      await createPostVia(agent, 'boardscroll', `BSCROLL-${String(i).padStart(2, '0')}`)
      world.tick(60 * 1000)
      if ((i + 1) % 5 === 0) world.tick(10 * 60 * 1000)
    }

    const first = await agent.get('/c/boardscroll?sort=new')
    const firstText = await first.text()
    const cursor = firstText.match(/data-next-cursor="([A-Za-z0-9_-]+)"/)?.[1] as string
    expect(cursor).toBeTruthy()

    const seen1 = Array.from({ length: 30 }, (_, i) => `BSCROLL-${String(i).padStart(2, '0')}`).filter((t) =>
      firstText.includes(t),
    )
    expect(seen1).toHaveLength(25)

    const partial = await agent.get(`/c/boardscroll?sort=new&partial=1&after=${cursor}`)
    const partialText = await partial.text()
    expect(partialText).toContain('data-feed-page="board-feed"')
    const seen2 = Array.from({ length: 30 }, (_, i) => `BSCROLL-${String(i).padStart(2, '0')}`).filter((t) =>
      partialText.includes(t),
    )
    expect(seen2).toHaveLength(5)
    expect(seen1.filter((t) => seen2.includes(t))).toHaveLength(0)
  })

  test('imleç yoksa partial isteği tam sayfa döner', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'nopartial')
    await createPostVia(agent, 'nopartial', 'ONE-POST')
    const res = await agent.get('/?partial=1')
    const text = await res.text()
    expect(text).toContain('<html')
    expect(text).not.toContain('data-feed-page="home-feed"')
  })
})

/* -------------------------------------------------------------------------- */
/* Board oluşturma: yalnızca yönetim paneli                                    */
/* -------------------------------------------------------------------------- */

describe('board oluşturma yetkisi', () => {
  test('hiçbir kullanıcı /communities/new üzerinden board açamaz', async () => {
    await registerAdmin(world)
    const { agent } = await registerUser(world)

    const form = await agent.get('/communities/new')
    expect(form.status).toBe(302)
    expect(form.headers.get('location')).toBe('/communities')
    await form.text()

    const post = await agent.post('/communities/new', { name: 'sizintilar', title: 'Sızıntılar' })
    expect(post.status).toBe(302)
    await post.text()
    expect(world.ctx.db.prepare('SELECT 1 AS n FROM communities WHERE name = ?').get('sizintilar')).toBeUndefined()
  })

  test('board listesi create düğmesini yalnızca yöneticilere gösterir', async () => {
    const admin = await registerAdmin(world)
    const { agent: member } = await registerUser(world)

    const adminList = await admin.agent.get('/communities')
    const adminText = await adminList.text()
    expect(adminText).toContain('/admin?tab=communities')
    expect(adminText).toContain('Board oluştur')

    const memberList = await member.get('/communities')
    const memberText = await memberList.text()
    expect(memberText).not.toContain('/admin?tab=communities')
    expect(memberText).not.toContain('Board oluştur')
  })

  test('yönetim panelindeki form board oluşturur', async () => {
    const admin = await registerAdmin(world)
    const res = await admin.agent.post('/admin/boards', {
      name: 'panel_board',
      title: 'Panelden açılan board',
      description: 'Açıklama',
      visibility: 'public',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/c/panel_board')
    await res.text()
    expect(world.ctx.db.prepare('SELECT 1 AS n FROM communities WHERE name = ?').get('panel_board')).toBeTruthy()
  })

  test('board adı doğrulaması yönetim panelinde de çalışır', async () => {
    const admin = await registerAdmin(world)
    await admin.agent.post('/admin/boards', { name: 'a', title: 'Çok kısa', visibility: 'public' })
    expect(world.ctx.db.prepare('SELECT 1 AS n FROM communities WHERE name = ?').get('a')).toBeUndefined()
  })

  test('normal üye yönetim panelindeki board formunu kullanamaz', async () => {
    await registerAdmin(world)
    const { agent } = await registerUser(world)
    const res = await agent.post('/admin/boards', { name: 'korsan_board', title: 'Korsan', visibility: 'public' })
    expect(res.status).toBe(403)
    expect(world.ctx.db.prepare('SELECT 1 AS n FROM communities WHERE name = ?').get('korsan_board')).toBeUndefined()
  })
})
