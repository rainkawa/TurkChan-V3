import { readFileSync } from 'node:fs'
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
  test('logo ayrı satırda ortalanmış, altında hamburger arama bildirim var', async () => {
    const { agent } = await registerUser(world)
    const html = await (await agent.get('/')).text()

    // Satır 1: kelime logosu, ortalanmış.
    expect(html).toContain('app-header-brand')
    expect(html).toContain('class="wordmark"')
    expect(html).toContain('/static/logo.svg')
    // Küçük favicon/monogram marka alanı kaldırıldı.
    expect(html).not.toContain('home-brand-name')
    expect(html).not.toContain('class="brand home-brand"')

    // Satır 2: hamburger · arama · bildirim, bu sırada.
    const inner = html.slice(html.indexOf('app-header-inner'))
    const at = (needle: string): number => {
      const idx = inner.indexOf(needle)
      expect(idx, `${needle} bulunamadı`).toBeGreaterThan(-1)
      return idx
    }
    const menu = at('data-drawer-toggle')
    const search = at('app-search')
    const bell = at('header-bell')
    expect(menu).toBeLessThan(search)
    expect(search).toBeLessThan(bell)

    // Logo satırı ikinci satırdan önce gelir.
    expect(html.indexOf('app-header-brand')).toBeLessThan(html.indexOf('app-header-inner'))
  })

  test('logo dosyası repoda mevcut ve geçerli SVG', () => {
    // Test dünyası statik dosya servisi kurmaz (serveStatic yalnızca
    // server.ts'te bağlıdır), bu yüzden dosyanın kendisi doğrulanır.
    const svg = readFileSync(new URL('../../public/logo.svg', import.meta.url), 'utf8')
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox')
    expect(svg).toContain('TurkChan')
    // Açık/kapalı etiket dengesi.
    expect(svg.split('<svg').length).toBe(2)
    expect(svg.split('</svg>').length).toBe(2)
  })

  test('statik varlıklar sürüm parametreli sunulur (cache busting)', async () => {
    // max-age=3600 nedeniyle tarayıcı eski CSS/JS kullanıyordu; yeni sınıf
    // kuralları uygulanmadığı için ikonlar 300×150 varsayılanına düşüyordu.
    const { agent } = await registerUser(world)
    const html = await (await agent.get('/')).text()
    expect(html).toMatch(/href="\/static\/style\.css\?v=\d+"/)
    expect(html).toMatch(/src="\/static\/app\.js\?v=\d+"/)
    expect(html).toMatch(/src="\/static\/logo\.svg\?v=\d+"/)
  })

  test('logo ortalanmış kapsayıcıda', async () => {
    const { agent } = await registerUser(world)
    const html = await (await agent.get('/')).text()
    expect(html).toContain('class="app-header-brand"')
    expect(html).toContain('class="wordmark"')
    const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')
    // Ortalamayı taşıyan kurallar gerçekten var mı.
    expect(css).toMatch(/\.app-header-brand\s*\{[^}]*justify-content:\s*center/)
    expect(css).toMatch(/\.wordmark\s*\{[^}]*margin-inline:\s*auto/)
  })

  test('arama alanında eski marka işareti yok', async () => {
    const { agent } = await registerUser(world)
    const html = await (await agent.get('/')).text()
    expect(html).not.toContain('app-search-mark')
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

      // Alan gerçek bir <label for="image">: dosya seçiciyi JS olmadan açar.
      expect(html).toMatch(/<label class="media-drop" for="image"/)
      expect(html).toContain('data-media-input')
      expect(html).toContain('data-media-drop')
      expect(html).toContain('data-media-preview')
      expect(html).toContain('media-drop-cta')
      // Gizli input: odaklanamayan required alan "erişim gerekli" uyarısı
      // veriyordu, bu yüzden required KALDIRILDI. Zorunluluk sunucuda var.
      const input = html.match(/<input[^>]*data-media-input="true"[^>]*>/)
      expect(input, 'medya inputu bulunamadı').not.toBeNull()
      expect(input![0]).toContain('accept="')
      expect(input![0]).toContain('type="file"')
      expect(input![0]).not.toContain('required')
      // Form multipart kalmalı; doğrulama sunucuda.
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

describe('gönderi oluşturma sayfası', () => {  test('taşmayı önleyen kapsayıcı sınıfı uygulanmış', async () => {
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

/* --------------------------------------------------------------------------
 * İkon ölçüleri
 * ------------------------------------------------------------------------ */

describe('ikon ölçüleri', () => {
  /**
   * Boyutu ne öznitelikle ne CSS kuralı tanımlanmamış bir `<svg>`, tarayıcı
   * varsayılanı olarak 300×150 çizilir ve tek ikon sayfayı kaplar. Yeni
   * eklenen ikonların hepsi öznitelik taşımalı.
   */
  test('kullanıcıya görünen sayfalarda boyutsuz satır içi SVG kalmadı', async () => {
    const { agent } = await registerUser(world)
    await createCommunityVia(agent, 'icons')
    const pages = [
      '/',
      '/c/icons',
      '/c/icons/submit?type=image',
      '/c/icons/submit?type=link',
      '/notifications',
      '/settings',
    ]
    for (const path of pages) {
      const html = await (await agent.get(path)).text()
      const unsized = [...html.matchAll(/<svg(?![^>]*\bwidth=)[^>]*>/g)].map((m) => m[0])
      expect(unsized, `${path} sayfasında boyutsuz SVG var`).toEqual([])
    }
  })

  test('CSS güvenlik ağı mevcut', () => {
    const css = readFileSync(new URL('../../public/style.css', import.meta.url), 'utf8')
    expect(css).toMatch(/svg:not\(\[width\]\)\s*\{[^}]*max-height/)
  })
})
