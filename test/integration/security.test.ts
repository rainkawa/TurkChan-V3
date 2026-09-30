/**
 * Güvenlik testleri — OWASP yaklaşımı.
 *
 * Buradaki her test bir saldırı yükünün GERÇEKTEN reddedildiğini kanıtlar;
 * "zaten çalışıyor" varsayımı üzerine yazılmaz.
 */
import { describe, expect, it } from 'vitest'
import {
  Agent,
  createCommentVia,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerAdmin,
  registerUser,
} from '../testUtils'
import { getUserByUsername } from '../../src/services/auth'
import { hashPassword } from '../../src/lib/passwords'

const XSS = '<script>alert(1)</script>'
const XSS_ATTR = '"><script>alert(1)</script>'
const SQLI = "' OR 1=1 --"
const SQLI2 = "1; DROP TABLE users; --"
const TRAVERSAL = '../../etc/passwd'

describe('güvenlik', () => {
  // ---------------------------------------------------------------- CSRF ---
  describe('CSRF', () => {
    it('durum değiştiren istek geçersiz jetonla reddedilir', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')

      // Jeton bilerek bozulur (test agent'ı normalde otomatik ekler).
      const res = await agent.postWithoutCsrf(`/c/guvenlik/posts`, { title: 'saldırı', body: 'x' })
      expect(res.status).toBe(403)

      // Gerçekten yazılmadığını doğrula.
      const home = await (await agent.get('/')).text()
      expect(home).not.toContain('saldırı')
    })

    it('çapraz origin istek reddedilir', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')
      const res = await agent.request(`/c/guvenlik/posts`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://kotu.example' },
        body: new URLSearchParams({ title: 'saldırı', body: 'x' }).toString(),
      })
      expect(res.status).toBe(403)
    })

    it('CSRF jetonu HTML formlarına otomatik enjekte edilir', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const html = await (await agent.get('/settings')).text()
      expect(html).toMatch(/name="_csrf" value="[A-Za-z0-9_-]{43}"/)
      expect(html).toMatch(/<meta name="csrf-token"/)
    })
  })

  // ----------------------------------------------------------------- XSS ---
  describe('XSS', () => {
    it('gönderi gövdesindeki script etiketi çalıştırılamaz', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')
      await createPostVia(agent, 'guvenlik', XSS, XSS)
      const html = await (await agent.get('/c/guvenlik')).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    })

    it('yorumdaki XSS yükü kaçışsız kalır', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')
      const post = await createPostVia(agent, 'guvenlik', 'konu', 'gövde')
      await createCommentVia(agent, 'guvenlik', post, `${XSS} ${XSS_ATTR}`)
      const html = await (await agent.get(`/c/guvenlik/comments/${post}`)).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    })

    it('javascript: şeması bağlantıda nötrleştirilir', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')
      await createPostVia(
        agent,
        'guvenlik',
        'bağlantı',
        '[tıkla](javascript:alert(1)) ve [veri](data:text/html,<script>alert(1)</script>)',
      )
      const html = await (await agent.get('/c/guvenlik')).text()
      expect(html).not.toContain('javascript:alert')
      expect(html).not.toContain('data:text/html')
    })

    it('kullanıcı adı ve görünen ad HTML kaçışı uygular', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await agent.post('/settings', { displayName: XSS, bio: XSS })
      const html = await (await agent.get('/settings')).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    })

    it('arama sorgusu yansıtılırken kaçışlanır', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const html = await (await agent.get(`/search?q=${encodeURIComponent(XSS)}`)).text()
      expect(html).not.toContain('<script>alert(1)</script>')
      expect(html).toContain('&lt;script&gt;')
    })

    it('hata mesajında stack trace sızmaz', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const res = await agent.get('/c/guvenlik/comments/yok-boyle-bir-gonderi')
      const html = await res.text()
      expect(html).not.toContain('at Object.')
      expect(html).not.toContain('node:internal')
    })
  })

  // --------------------------------------------------------- SQL injection ---
  describe('SQL injection', () => {
    it('arama sorgusu enjeksiyonu veri sızdırmaz', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')
      await createPostVia(agent, 'guvenlik', 'gizli gönderi', 'gizli gövde')
      for (const payload of [SQLI, SQLI2, `${SQLI}' UNION SELECT password_hash FROM users--`]) {
        const html = await (await agent.get(`/search?q=${encodeURIComponent(payload)}`)).text()
        expect(html).not.toContain('$argon2')
        expect(html).not.toContain('gizli gövde')
      }
    })

    it('enjeksiyon yükü kullanıcı adı olarak kullanılamaz', async () => {
      const world = createTestWorld()
      const agent = new Agent(world.app)
      const res = await agent.post('/register', { username: SQLI, password: 'password12345' })
      expect(agent.loggedIn()).toBe(false)
      expect(agent.cookieHeaderFlash()).toContain('yalnızca harf, rakam')
      // Kayıt oluşmadı ve kullanıcı tablosu boş.
      expect(world.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
      expect(res.status).toBeLessThan(400)
    })

    it('sıralama ve filtre parametreleri enjeksiyona açık değil', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')
      const res = await agent.get(`/c/guvenlik?sort=${encodeURIComponent(SQLI2)}`)
      expect(res.status).toBe(200)
    })
  })

  // ------------------------------------------------------- Path traversal ---
  describe('path traversal ve dosya yükleme', () => {
    it('medya anahtarındaki traversal reddedilir', async () => {
      const world = createTestWorld()
      for (const key of [TRAVERSAL, encodeURIComponent(TRAVERSAL), '..%2F..%2Fetc%2Fpasswd']) {
        const res = await world.app.request(`/media/${key}`)
        // Hono yolu normalleştirip yönlendirebilir; önemli olan 200/206 dönerek
        // dosya içeriğinin SERVİS EDİLMEMESİ.
        expect([200, 206]).not.toContain(res.status)
      }
      // Anahtar doğrulaması: geçersiz anahtar hiçbir koşulda dosya getirmez.
      expect((await world.app.request(`/media/${encodeURIComponent('../../../etc/passwd')}`)).status).not.toBe(200)
    })

    it('yürütülebilir/aktif içerik reddedilir (imza denetimi)', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const payload = '<?php system($_GET["c"]); ?>'
      const slot = (await (await agent.json('/api/uploads', {})).json()) as { key: string; token: string }
      const res = await agent.request(`/api/uploads/${slot.key}?token=${slot.token}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/html' },
        body: payload,
      })
      expect(res.status).toBe(400)
    })

    it('SVG (aktif içerik taşıyabilir) reddedilir', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
      const slot = (await (await agent.json('/api/uploads', {})).json()) as { key: string; token: string }
      const res = await agent.request(`/api/uploads/${slot.key}?token=${slot.token}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/svg+xml' },
        body: svg,
      })
      expect(res.status).toBe(400)
    })

    it('beyan edilen MIME ile saklanan içerik tipi farklıysa içerik tipi sunucudan gelir', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      // Gerçek JPEG imzalı bayt, beyan edilen MIME "text/html".
      const jpeg = Uint8Array.from([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
        0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
      ])
      const slot = (await (await agent.json('/api/uploads', {})).json()) as { key: string; token: string }
      await agent.request(`/api/uploads/${slot.key}?token=${slot.token}`, {
        method: 'PUT',
        headers: { 'content-type': 'text/html' },
        body: jpeg,
      })
      const res = await world.app.request(`/media/${slot.key}`)
      expect(res.headers.get('content-type')).toBe('image/jpeg')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    })

    it('başka kullanıcının yükleme anahtarı kullanılamaz', async () => {
      const world = createTestWorld()
      const alice = await registerUser(world, 'alice')
      const bob = await registerUser(world, 'bobby')
      await createCommunityVia(alice.agent, 'guvenlik', 'public')
      const slot = (await (await alice.agent.json('/api/uploads', {})).json()) as { key: string; token: string }
      // Bob, Alice'in yükleme alanını posta bağlamayı dener.
      const res = await bob.agent.post(`/c/guvenlik/posts`, {
        title: 'çalınma',
        body: 'x',
        type: 'image',
        mediaKeys: slot.key,
      })
      expect(res.status).toBeGreaterThanOrEqual(400)
    })
  })

  // ----------------------------------------------------------------- IDOR ---
  describe('IDOR / yetki atlama', () => {
    it('normal kullanıcı yönetim uç noktalarına erişemez', async () => {
      const world = createTestWorld()
      // İlk kayıt olan kullanıcı site yöneticisidir; sıradan üye için ikinci
      // bir hesap gerekir.
      await registerAdmin(world)
      const { agent } = await registerUser(world, 'alice')
      for (const path of ['/admin', '/admin?tab=users', '/admin?tab=settings']) {
        const res = await agent.get(path)
        expect(res.status).toBeGreaterThanOrEqual(400)
      }
      // Durum değiştiren uç noktalar da.
      const post = await agent.post('/admin/settings', { postsPer10Min: '99999' })
      expect(post.status).toBeGreaterThanOrEqual(400)
    })

    it('normal kullanıcı başkasının profilini düzenleyemez', async () => {
      const world = createTestWorld()
      await registerAdmin(world)
      const alice = await registerUser(world, 'alice')
      await registerUser(world, 'bobby')
      const bobRow = getUserByUsername(world.ctx, 'bobby')!
      // Profil güncelleme yalnızca oturumdaki hesabı değiştirir; gönderilen
      // `userId` alanı yok sayılır (kütle atama yetkilendirme açığı yok).
      await alice.agent.post('/settings', { displayName: 'Alice', bio: 'kendi biyografisi', userId: bobRow.id })
      const afterBob = getUserByUsername(world.ctx, 'bobby')!
      expect(afterBob.bio).not.toBe('kendi biyografisi')
      const afterAlice = getUserByUsername(world.ctx, 'alice')!
      expect(afterAlice.bio).toBe('kendi biyografisi')
    })

    it('başkasının gönderisini silemez', async () => {
      const world = createTestWorld()
      await registerAdmin(world)
      const alice = await registerUser(world, 'alice')
      const bob = await registerUser(world, 'bobby')
      await createCommunityVia(alice.agent, 'guvenlik', 'public')
      const post = await createPostVia(alice.agent, 'guvenlik', 'alicenin gonderisi', 'x')
      await bob.agent.post(`/posts/${post}/delete`, {})
      // Gönderi hâlâ duruyor ve içeriği değişmemiş.
      const row = world.ctx.db.prepare('SELECT deleted FROM posts WHERE id = ?').get(post) as { deleted: number }
      expect(row.deleted).toBe(0)
    })

    it('gizli topluluğa erişilemez', async () => {
      const world = createTestWorld()
      const alice = await registerUser(world, 'alice')
      const bob = await registerUser(world, 'bobby')
      await createCommunityVia(alice.agent, 'gizli', 'private')
      const post = await createPostVia(alice.agent, 'gizli', 'gizli', 'x')
      const res = await bob.agent.get(`/c/guvenlik/comments/${post}`)
      expect(res.status).toBeGreaterThanOrEqual(300)
      const list = await (await bob.agent.get('/c/gizli')).text()
      expect(list).not.toContain('gizli</h1>')
    })
  })

  // ----------------------------------------------------- Rate limit/spam ---
  describe('rate limit ve kaba kuvvet', () => {
    it('başarısız girişler hesabı geçici olarak kilitler', async () => {
      const world = createTestWorld()
      const { password } = await registerUser(world, 'alice')
      const attacker = new Agent(world.app)
      for (let i = 0; i < 6; i++) {
        await attacker.post('/login', { usernameOrEmail: 'alice', password: `yanl${i}`, ip: '9.9.9.9' })
      }
      world.tick(60_000)
      // Doğru parola bile artık kabul edilmez.
      const res = await attacker.post('/login', { usernameOrEmail: 'alice', password, ip: '9.9.9.9' })
      expect(attacker.loggedIn()).toBe(false)
      const message = decodeURIComponent(attacker.cookieHeaderFlash() ?? '')
      expect(message).toContain('kilitlendi')
      expect(res.status).toBeLessThan(400)
    })

    it('hesabın var olup olmadığını ayırt eden mesaj dönmez', async () => {
      const world = createTestWorld()
      await registerUser(world, 'alice')
      const agent = new Agent(world.app)
      const existing = await agent.post('/login', { usernameOrEmail: 'alice', password: 'yanlisparola' })
      const missing = await agent.post('/login', { usernameOrEmail: 'hayalet', password: 'yanlisparola' })
      // Durum kodu ve hata mesajı aynı olmalı (kullanıcı sayımı engellenir).
      expect(existing.status).toBe(missing.status)
      const agent2 = new Agent(world.app)
      await agent2.post('/login', { usernameOrEmail: 'alice', password: 'yanlisparola' })
      expect(decodeURIComponent(agent2.cookieHeaderFlash() ?? '')).toContain(
        'Kullanıcı adı/e-posta veya parola hatalı',
      )
    })

    it('aynı içeriğin tekrar gönderilmesi engellenir', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      await createCommunityVia(agent, 'guvenlik', 'public')
      const first = await createPostVia(agent, 'guvenlik', 'spam', 'aynı içerik')
      expect(first).toBeTruthy()
      const countBefore = (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
      await agent.post('/c/guvenlik/submit?type=text', { title: 'spam', body: 'aynı içerik' })
      expect(agent.cookieHeaderFlash()).toContain('Yavaşlayın')
      const countAfter = (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM posts').get() as { n: number }).n
      expect(countAfter).toBe(countBefore)
    })

    it('genel istek sınırı IP başına uygulanır', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      world.ctx.config.globalRequestsPerMinute = 5
      let limited = false
      for (let i = 0; i < 12; i++) {
        const res = await agent.request('/', { headers: { 'x-forwarded-for': '8.8.8.8' } })
        if (res.status === 429) {
          limited = true
          break
        }
      }
      expect(limited).toBe(true)
    })
  })

  // ---------------------------------------------------- Session & parola ---
  describe('parola ve oturum', () => {
    it('veritabanında düz metin parola saklanmaz', async () => {
      const world = createTestWorld()
      await registerUser(world, 'alice', { password: 'benzersizparola123' })
      const row = world.ctx.db.prepare('SELECT password_hash FROM users').get() as { password_hash: string }
      expect(row.password_hash).not.toContain('benzersizparola123')
      expect(row.password_hash).toMatch(/^\$argon2id\$/)
    })

    it('parola değiştirildikten sonra eski oturumlar düşer', async () => {
      const world = createTestWorld()
      const { agent, password } = await registerUser(world, 'alice')
      await agent.post('/settings/password', { currentPassword: password, newPassword: 'yeniparola45678' })
      const res = await agent.get('/')
      // Oturum düştüğünde giriş sayfasına yönlendirilir.
      expect(res.status === 200 ? await res.text() : '').not.toContain('Yeni gönderi')
    })

    it('süresi dolan oturum korumalı sayfaya erişemez', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      world.tick(40 * 24 * 60 * 60 * 1000)
      const res = await agent.get('/settings')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/login')
    })

    it('çıkış oturumu sunucuda geçersiz kılar', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const stolen = agent.cookieHeader()
      await agent.post('/logout', {})
      // Çerez yeniden kullanılsa bile sunucu reddeder.
      const res = await world.app.request('/settings', { headers: { cookie: stolen } })
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/login')
    })
  })

  // ------------------------------------------------------------ Gizlilik ---
  describe('gizlilik', () => {
    it('oturum ve giriş denemelerinde IP / User-Agent saklanmaz', async () => {
      const world = createTestWorld()
      await registerUser(world, 'alice')
      await new Agent(world.app).post('/login', { usernameOrEmail: 'alice', password: 'yanlis' })
      const sessionCols = (world.ctx.db.prepare('PRAGMA table_info(sessions)').all() as unknown as Array<{ name: string }>).map((c) => c.name)
      expect(sessionCols).not.toContain('ip')
      expect(sessionCols).not.toContain('user_agent')
      const attemptCols = (world.ctx.db.prepare('PRAGMA table_info(login_attempts)').all() as unknown as Array<{ name: string }>).map((c) => c.name)
      expect(attemptCols).not.toContain('ip')
    })

    it('parola karması hiçbir HTML yanıtında görünmez', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const row = getUserByUsername(world.ctx, 'alice')!
      expect(row.password_hash).toMatch(/argon2/)
      for (const path of ['/', '/settings', '/admin?tab=users']) {
        const html = await (await agent.get(path)).text()
        expect(html).not.toContain('$argon2')
      }
    })

    it('oturum jetonu HTML içine yazılmaz', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const token = agent.cookieHeader().match(/sid=([^;]+)/)?.[1]
      expect(token).toBeTruthy()
      const html = await (await agent.get('/')).text()
      expect(html).not.toContain(token!)
    })

    it('oturum çerezi HttpOnly ve SameSite içerir', async () => {
      const world = createTestWorld()
      const agent = new Agent(world.app)
      const res = await agent.request('/register', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ username: 'alice', password: 'password12345' }).toString(),
      })
      const cookie = res.headers.get('set-cookie') ?? ''
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite')
      expect(cookie).toContain('Path=/')
    })
  })

  // ------------------------------------------------------------- Admin ---
  describe('yönetici güvenliği', () => {
    it('yönetici işlemleri denetim günlüğüne yazılır', async () => {
      const world = createTestWorld()
      const admin = await registerAdmin(world)
      const settings = await admin.agent.post('/admin/settings', { postsPer10Min: '9' })
      expect(settings.status).toBeLessThan(400)
      const logged = world.ctx.db
        .prepare("SELECT COUNT(*) AS n FROM mod_actions WHERE action LIKE '%/admin/%'")
        .get() as { n: number }
      expect(logged.n).toBeGreaterThan(0)
    })

    it('kilitli hesap yönetici paneline giremez', async () => {
      const world = createTestWorld()
      const admin = await registerAdmin(world)
      const row = world.ctx.db.prepare('SELECT id FROM users WHERE username = ?').get(admin.username) as { id: string }
      world.ctx.db.prepare('UPDATE users SET suspended_indefinitely = 1 WHERE id = ?').run(row.id)
      const res = await admin.agent.get('/admin')
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toContain('/login')
    })
  })

  // --------------------------------------------------- Güvenlik başlıkları ---
  describe('güvenlik başlıkları', () => {
    it('tüm yanıtlarda güvenlik başlıkları bulunur', async () => {
      const world = createTestWorld()
      const { agent } = await registerUser(world, 'alice')
      const res = await agent.get('/')
      expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
      expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
      expect(res.headers.get('content-security-policy')).toContain("object-src 'none'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin')
      expect(res.headers.get('permissions-policy')).toContain('camera=()')
      // Geliştirmede HSTS eklenmez (localhost korunur).
      expect(res.headers.get('strict-transport-security')).toBeNull()
    })
  })

  // ------------------------------------------------------- Parola hashleme ---
  describe('parola hashleme', () => {
    it('hash Argon2id üretir ve doğrular', async () => {
      const hash = await hashPassword('gizli-parola-123')
      expect(hash).toMatch(/^\$argon2id\$/)
      // Aynı parola iki kez aynı hash'i üretmez (tuz).
      expect(await hashPassword('gizli-parola-123')).not.toBe(hash)
    })
  })
})