/**
 * Tüm rotaları gezen duman testi (smoke test).
 *
 * Amaç: hiçbir sayfa "undefined", "NaN", "[object Object]" ya da boş gövde
 * basmamalı; 5xx dönmemeli. Yalnızca gerçek kırılmaları yakalar.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCommunityVia, createPostVia, createTestWorld, registerAdmin, registerUser, type TestWorld } from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

/** Bir sayfada görülmesi bir hata olan kalıplar. */
const BAD = ['undefined', 'NaN', '[object Object]', '[object HTML', '>null<', '>null ']

describe('rota duman testi', () => {
  test('kayıtlı kullanıcı her sayfayı gezebilir ve temiz HTML üretir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'smoke')
    await agent.post('/c/smoke/flairs', { name: 'Etiket', color: '#112233' })
    const flair = world.ctx.db.prepare('SELECT id FROM board_flairs').get() as { id: string }
    const postRes = await agent.post('/c/smoke/submit?type=text', {
      title: 'SMOKE-POST',
      body: 'gövde metni',
      flairId: flair.id,
    })
    const postId = (postRes.headers.get('location') ?? '').match(/comments\/([a-z0-9]+)/)?.[1] as string
    await agent.post(`/c/smoke/comments/${postId}/comment`, { body: 'bir yorum' })
    const commentId = (world.ctx.db.prepare('SELECT id FROM comments').get() as { id: string }).id

    const paths = [
      '/',
      '/?sort=new',
      '/?sort=best&t=all',
      '/communities',
      '/submit',
      '/search?q=smoke',
      '/notifications',
      '/messages',
      '/messages/new',
      '/settings',
      '/settings/delete-account',
      '/privacy',
      '/c/smoke',
      '/c/smoke?sort=new',
      `/c/smoke?flair=${flair.id}`,
      '/c/smoke/settings',
      '/c/smoke/submit',
      '/c/smoke/submit?type=link',
      '/c/smoke/submit?type=image',
      `/c/smoke/comments/${postId}`,
      `/c/smoke/comments/${postId}?sort=new`,
      `/c/smoke/comments/${postId}/comment/${commentId}`,
      `/posts/${postId}/edit`,
      `/comments/${commentId}/edit`,
      `/report/post/${postId}`,
      `/report/comment/${commentId}`,
      '/admin',
    ]

    for (const path of paths) {
      const res = await agent.get(path)
      expect(res.status, `${path} → ${res.status}`).toBeLessThan(500)
      // 3xx: yönlendirme yardımcıları (örn. /messages/new), 404: erişim kapısı.
      if (res.status >= 300 && res.status < 400) continue
      if (res.status === 404) continue
      const html = await res.text()
      for (const bad of BAD) {
        expect(html, `${path} içinde "${bad}" var`).not.toContain(bad)
      }
      expect(html, `${path} boş gövde döndü`).toContain('<body')
    }
  })

  test('yönetim panelleri ve yönetim rotaları temiz üretilir', async () => {
    const admin = await registerAdmin(world)
    await createCommunityVia(admin.agent, 'adminboard')
    await createPostVia(admin.agent, 'adminboard', 'ADMIN-POST')
    await admin.agent.post('/c/adminboard/flairs', { name: 'Yönetim', color: '' })

    const tabs = ['communities', 'users', 'settings', 'invites', 'moderation']
    for (const tab of tabs) {
      const res = await admin.agent.get(`/admin?tab=${tab}`)
      expect(res.status, `/admin?tab=${tab} → ${res.status}`).toBeLessThan(500)
      const html = await res.text()
      for (const bad of BAD) expect(html, `/admin?tab=${tab} içinde "${bad}"`).not.toContain(bad)
      expect(html).toContain('<body')
    }
  })

  test('alt navigasyonda yalnızca aktif sekme aria-current="page" taşır', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'nav')
    // Ana sayfa açıkken yalnızca "Ana Sayfa" işaretli olmalı.
    const home = await agent.get('/')
    const homeHtml = await home.text()
    expect(homeHtml.match(/aria-current="page"/g)?.length ?? 0).toBe(1)

    // Gelen kutusu açıkken yalnızca o işaretli olmalı.
    const inbox = await agent.get('/messages')
    const inboxHtml = await inbox.text()
    expect(inboxHtml.match(/aria-current="page"/g)?.length ?? 0).toBe(1)
  })

  test('etiket filtresi "Tüm etiketler" der, "Tüm boardlar" değil', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'chips')
    await agent.post('/c/chips/flairs', { name: 'Etiket', color: '' })
    const flair = world.ctx.db.prepare('SELECT id FROM board_flairs').get() as { id: string }
    // Etiket filtresi yalnızca etiketli gönderi varsa listelenir.
    await agent.post('/c/chips/submit?type=text', { title: 'CHIP-POST', body: '', flairId: flair.id })

    const home = await agent.get('/')
    const text = await home.text()
    // Board grubu "Tüm boardlar", etiket grubu "Tüm etiketler" olmalı.
    expect(text).toContain('Tüm etiketler')
    const boardGroup = text.slice(text.indexOf('>Board</span>'), text.indexOf('>Etiket</span>'))
    expect(boardGroup).toContain('Tüm boardlar')
    const flairGroup = text.slice(text.indexOf('>Etiket</span>'))
    expect(flairGroup.slice(0, 400)).toContain('Tüm etiketler')
  })

  test('kullanıcıya hiçbir yerde board kurma vaadi verilmez', async () => {
    // Board oluşturma artık yalnızca yöneticilere açık; metinler bunu yansıtmalı.
    const i18n = readFileSync('src/i18n/tr.ts', 'utf8')
    // "Board oluştur" yalnızca yönetim paneli bağlamında geçebilir.
    const promises = [...i18n.matchAll(/(ogDescription|tagline|emptyPostsBody|joinPrompt):[^\n]*/g)].map((m) => m[0])
    for (const line of promises) {
      expect(line, `yanıltıcı metin: ${line}`).not.toMatch(/topluluğunu oluştur|kendi board/u)
    }

    const { agent } = await registerUser(world)
    const home = await agent.get('/')
    const html = await home.text()
    expect(html).not.toContain('kendi topluluğunu oluştur')
  })

  test('"En iyi" seçilince 3 ana + 4 zaman aralığı sekmesi eksiksiz render edilir', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'best')
    await createPostVia(agent, 'best', 'BEST-PAGE-POST')

    // Ana sayfa ve board sayfası aynı bileşeni kullanır; ikisini de denetle.
    for (const path of ['/?sort=best&t=week', '/c/best?sort=best&t=week']) {
      const res = await agent.get(path)
      const html = await res.text()
      const navStart = html.indexOf('class="sort-tabs"')
      const nav = html.slice(navStart, html.indexOf('</nav>', navStart))

      // 3 ana sıralama + 4 zaman aralığı = 7 bağlantı, hiçbiri eksik değil.
      const links = [...nav.matchAll(/<a\s+href="([^"]+)"/g)].map((m) => m[1] as string)
      expect(links.length, `${path} → ${links.length} bağlantı`).toBe(7)

      for (const w of ['day', 'week', 'month', 'all']) {
        expect(nav, `${path} → t=${w} eksik`).toContain(`t=${w}`)
      }
      // Zaman aralığı çipleri "Tüm zamanlar" dahil tam görünmeli.
      expect(html).toContain('Tüm zamanlar')
    }
  })

  test('sıralama çubuğu dar ekranda taşmaz (sarmalama + grid sıfırlama)', () => {
    const css = readFileSync('public/style.css', 'utf8')
    // Yatay kaydırma yerine sarmalama: hiçbir chip gizli kalmaz.
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.sort-tabs \{[^}]*flex-wrap: wrap/)
    // Izgara çocukları taşmayı bırakmaz.
    expect(css).toContain('.home-layout > *, .layout > * { min-width: 0; }')
  })

  test('ziyaretçi ve girişsiz rotalar 5xx vermez', async () => {
    const owner = await registerUser(world)
    await createCommunityVia(owner.agent, 'open')
    const postId = await createPostVia(owner.agent, 'open', 'PUBLIC-POST')
    await owner.agent.post(`/posts/${postId}/pin`)

    const publicPaths = [
      '/login',
      '/register',
      '/forgot-password',
      '/',
      '/communities',
      '/c/open',
      `/c/open/comments/${postId}`,
      '/search?q=public',
      '/privacy',
      '/u/someone',
    ]
    for (const path of publicPaths) {
      const res = await new (await import('../testUtils')).Agent(world.app).get(path)
      expect(res.status, `${path} → ${res.status}`).toBeLessThan(500)
      const html = await res.text()
      for (const bad of BAD) expect(html, `${path} içinde "${bad}"`).not.toContain(bad)
    }
  })
})
