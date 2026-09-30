import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommunityVia,
  createTestWorld,
  registerUser,
  type TestWorld,
} from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

/* --------------------------------------------------------------------------
 * Başlık çubuğu
 * ------------------------------------------------------------------------ */

describe('başlık çubuğu', () => {
  test('hamburger yerine marka alanı var, çizgi menü düğmesi duruyor', async () => {
    const { agent } = await registerUser(world)
    const html = await (await agent.get('/')).text()

    // Marka: monogram + site adı, ana sayfaya bağlı.
    expect(html).toContain('home-brand')
    expect(html).toContain('home-brand-name')
    expect(html).toContain('>TurkChan<')
    expect(html).toMatch(/<a class="brand home-brand" href="\/"/)

    // Menü düğmesi hâlâ var (gezinme çekmecesi erişimi kaybolmaz) ama
    // markanın sağında, ikincil sınıfla.
    expect(html).toContain('data-drawer-toggle')
    expect(html).toContain('drawer-toggle')
  })

  test('arama alanındaki eski marka işareti kaldırıldı', async () => {
    const { agent } = await registerUser(world)
    const html = await (await agent.get('/')).text()
    expect(html).not.toContain('app-search-mark')
    // Arama alanı ve bildirim düğmesi yerinde.
    expect(html).toContain('app-search')
    expect(html).toContain('header-bell')
  })
})

/* --------------------------------------------------------------------------
 * Sıralama + filtre hizası
 * ------------------------------------------------------------------------ */

describe('akış başlığı', () => {
  test('sıralama ve filtre aynı satırda', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'align')
    const html = await (await agent.get('/')).text()

    expect(html).toContain('feed-head')
    expect(html).toContain('sort-tabs')
    expect(html).toContain('data-feed-filters')
  })
})

/* --------------------------------------------------------------------------
 * Medya seçici
 * ------------------------------------------------------------------------ */

describe('medya seçici', () => {
  for (const type of ['image', 'gif', 'video'] as const) {
    test(`${type} türünde sürükle-bırak alanı ve önizleme kapsayıcısı var`, async () => {
      const { agent } = await registerUser(world)
      await createCommunityVia(agent, 'media')
      const html = await (await agent.get('/c/media/submit?type=' + type)).text()

      // Varsayılan dosya kutusu gizlenir, onun yerine özel alan gelir.
      expect(html).toContain('data-media-input')
      expect(html).toContain('visually-hidden')
      expect(html).toContain('data-media-drop')
      expect(html).toContain('data-media-preview')
      expect(html).toContain('media-drop-cta')
      // Doğrulama sunucuda kalır: gizli input hâlâ required ve accept'li.
      const input = html.match(/<input[^>]*data-media-input="true"[^>]*>/)
      expect(input, 'medya inputu bulunamadı').not.toBeNull()
      expect(input![0]).toContain('required')
      expect(input![0]).toContain('accept="')
      expect(input![0]).toContain('type="file"')
      // Form multipart kalmalı.
      expect(html).toContain('multipart/form-data')
    })
  }

  test('metin türünde medya alanı gösterilmez', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'plain')
    const html = await (await agent.get('/c/plain/submit?type=text')).text()
    expect(html).not.toContain('data-media-drop')
  })
})

/* --------------------------------------------------------------------------
 * Gönderi oluşturma sayfası taşması
 * ------------------------------------------------------------------------ */

describe('gönderi oluşturma sayfası', () => {
  test('taşmayı önleyen kapsayıcı sınıfı uygulanmış', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'narrow')
    const html = await (await agent.get('/c/narrow/submit?type=text')).text()
    expect(html).toContain('submit-card')
    expect(html).toContain('submit-card-title')
    expect(html).toContain('submit-card-board')
  })

  test('çok uzun board adı sayfayı taşırmaz', async () => {
    const { agent } = await registerUser(world)
    const long = 'b'.repeat(18)
    await createCommunityVia(agent, long)
    const res = await agent.get(`/c/${long}/submit?type=text`)
      expect(res.status).toBe(200)
      const html = await res.text()
      // Başlık ayrıştırılabilir: board adı metin olarak mevcut.
      expect(html).toContain(`c/${long}`)
      expect(html).toContain('submit-card-board')
  })
})
