/**
 * Oturum güvenliği: idle ve mutlak zaman aşımı, token yenileme, çıkışta
 * sunucu tarafı geçersiz kılma ve çerez bayrakları.
 *
 * Tüm kontroller sunucu tarafında yapılır; istemci tarafında hiçbir doğrulama
 * yoktur. Testler çerez bayraklarını da doğrudan HTTP yanıtından okur.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import { Agent, createTestWorld, registerUser, type TestWorld } from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Yanıt başlıklarındaki Set-Cookie değerini bulur. */
function setCookieHeader(res: Response, name = 'sid'): string {
  return res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? ''
}

describe('oturum zaman aşımı', () => {
  test('idle süresi aşıldığında oturum sunucuda düşer', async () => {
    const { agent } = await registerUser(world, 'idleuser')
    expect((await agent.get('/settings')).status).toBe(200)

    // Idle sınırı (7 gün) aşıldı.
    world.tick(8 * DAY)
    const res = await agent.get('/settings')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login')

    // Veritabanındaki oturum da silinmiş olmalı.
    const n = (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    expect(n).toBe(0)
  })

  test('idle sınırının içinde etkinlik oturumu uzatır', async () => {
    const { agent } = await registerUser(world, 'activeuser')
    // 3 günlük adımlarla 30 günlük MUTLAK ömür sınırına ulaşılmadan
    // yalnızca idle ömrünün uzadığı doğrulanır.
    for (let i = 0; i < 9; i++) {
      world.tick(3 * DAY)
      const res = await agent.get('/settings')
      expect(res.status, `tur ${i} → ${res.status}`).toBe(200)
    }
  })

  test('mutlak ömür idle kullanılmasa da sonunda biter', async () => {
    const { agent } = await registerUser(world, 'absoluteuser')
    // Sık kullanım (idle korunur) ama mutlak ömür aşılır.
    for (let i = 0; i < 40; i++) {
      world.tick(DAY)
      const res = await agent.get('/settings')
      if (res.status !== 200) break
    }
    const res = await agent.get('/settings')
    expect(res.status).toBe(302)
  })

  test('süresi dolmuş oturumla korumalı uç noktalara erişilemez', async () => {
    const { agent } = await registerUser(world, 'guarduser')
    world.tick(8 * DAY)
    // HTML sayfası girişe yönlendirir…
    expect((await agent.get('/settings')).status).toBe(302)
    // …API ise 401 döner.
    const api = await agent.get('/api/dm/thread')
    expect(api.status).toBe(401)
  })
})

describe('oturum tokenı', () => {
  test('giriş tokenı önceki oturumu geçersiz kılar (session fixation)', async () => {
    await registerUser(world, 'fixuser')
    // 1) Şüpheli bir çerez yerleştirilmiş gibi bir oturum açılır.
    const attacker = new Agent(world.app)
    await attacker.post('/login', { identifier: 'fixuser', password: 'password12345' })
    const before = setCookieHeader(await attacker.post('/login', { identifier: 'fixuser', password: 'password12345' }))
    const token = before.split(';')[0]?.split('=')[1] as string
    expect(token).toBeTruthy()

    // 2) Yeni bir giriş (dönüş) eski token'ı düşürmeli.
    const victim = new Agent(world.app)
    const res = await victim.post('/login', { identifier: 'fixuser', password: 'password12345' })
    const fresh = setCookieHeader(res).split(';')[0]?.split('=')[1] as string
    expect(fresh).toBeTruthy()
    expect(fresh).not.toBe(token)

    // 3) Eski token artık veritabanında yok.
    const row = world.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE token_hash = ?').get(token) as { n: number }
    expect(row.n).toBe(0)
  })

  test('çıkış oturumu sunucuda geçersiz kılar', async () => {
    const { agent, username } = await registerUser(world, 'byeuser')
    expect((await agent.get('/settings')).status).toBe(200)
    await agent.post('/logout')

    // Çerez silindi; sunucu da oturumu düşürdü.
    expect((await agent.get('/settings')).status).toBe(302)
    const n = (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n
    expect(n).toBe(0)

    // Yeni giriş çalışır.
    const again = new Agent(world.app)
    await again.post('/login', { identifier: username, password: 'password12345' })
    expect((await again.get('/settings')).status).toBe(200)
  })

  test('çerez bayrakları güvenli (HttpOnly, Path, SameSite)', async () => {
    await registerUser(world, 'cookieuser')
    const agent = new Agent(world.app)
    const res = await agent.post('/login', { identifier: 'cookieuser', password: 'password12345' })
    const cookie = setCookieHeader(res)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Path=/')
    expect(cookie.toLowerCase()).toContain('samesite=lax')
    // Üretimde Secure bayrağı eklenir (NODE_ENV=production).
    if (world.ctx.config.secureCookies) expect(cookie).toContain('Secure')
  })

  test('session token veritabanında düz metin tutulmaz', async () => {
    await registerUser(world, 'hashuser')
    const agent = new Agent(world.app)
    const res = await agent.post('/login', { identifier: 'hashuser', password: 'password12345' })
    const token = setCookieHeader(res).split(';')[0]?.split('=')[1] as string
    const rows = world.ctx.db.prepare('SELECT token_hash FROM sessions').all() as unknown as Array<{ token_hash: string }>
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.token_hash).not.toBe(token)
      // SHA-256 karması 64 hex karakter.
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  test('session token URL içinde taşınmaz', async () => {
    await registerUser(world, 'urluser')
    const agent = new Agent(world.app)
    await agent.post('/login', { identifier: 'urluser', password: 'password12345' })
    const token = setCookieHeader(
      await agent.post('/login', { identifier: 'urluser', password: 'password12345' }),
    ).split(';')[0]?.split('=')[1] as string
    // Sayfa HTML'inde token bulunmaz.
    const html = await (await agent.get('/')).text()
    expect(html).not.toContain(token)
  })

  test('parola değişimi diğer cihazların oturumunu düşürür', async () => {
    const { agent, username } = await registerUser(world, 'dev1')
    const second = new Agent(world.app)
    await second.post('/login', { identifier: username, password: 'password12345' })
    expect((await second.get('/settings')).status).toBe(200)

    await agent.post('/settings/password', {
      currentPassword: 'password12345',
      newPassword: 'yeniParola123',
    })
    // İkinci cihaz düşürüldü.
    expect((await second.get('/settings')).status).toBe(302)
    // İlk cihaz (oturum açık olan) korunur.
    expect((await agent.get('/settings')).status).toBe(200)
  })
})
