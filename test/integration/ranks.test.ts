import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommunityVia,
  createPostVia,
  createCommentVia,
  createTestWorld,
  registerUser,
  type TestWorld,
} from '../testUtils'
import { rankForKarma, rankBadgeLabel, userRankInfo } from '../../src/services/ranks'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

/**
 * Bir kullanıcının toplam karma değerini ayarlar (test kısayolu).
 * Karma = gönderi ve yorum score toplamı; tek bir gönderiye hedef değer yazılır.
 */
function setKarma(userId: string, karma: number): void {
  world.ctx.db.prepare('UPDATE posts SET score = ? WHERE author_id = ?').run(karma, userId)
  world.ctx.db.prepare('UPDATE comments SET score = 0 WHERE author_id = ?').run(userId)
}

async function setupAuthor() {
  const { agent: admin } = await registerUser(world, 'patron')
  await createCommunityVia(admin, 'plaza')
  const { agent: author, username } = await registerUser(world, 'mert')
  // Karma testleri için yazarın bir gönderisi olsun.
  const postId = await createPostVia(author, 'plaza', 'Rank rozeti testi', 'Gövde')
  return { admin, author, username, postId }
}

describe('rank rozetleri arayüzde', () => {
  test('profil, gönderi ve yorumda aynı rütbe görseli görünür', async () => {
    const { admin, author, username, postId } = await setupAuthor()
    await createCommentVia(author, 'plaza', postId, 'Yorum')

    // Karma 351 → Legend
    setKarma((world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as { id: string }).id, 351)

    // Site kapalı olduğu için sayfalar giriş yapmış bir üye tarafından okunur.
    const profile = await (await admin.get(`/tc/${username}`)).text()
    expect(profile).toContain('rank-legend')
    expect(profile).toContain('/static/assets/ranks/legend.gif')
    expect(profile).toContain('Legend')

    const post = await (await admin.get(`/c/plaza/comments/${postId}`)).text()
    expect(post).toContain('rank-legend')
    expect(post).toContain('/static/assets/ranks/legend.gif')
    expect(post).toContain('Legend')

    const home = await (await admin.get('/')).text()
    expect(home).toContain('rank-legend')
  })

  test('yeni kullanıcı New User görselini görür', async () => {
    const { admin, postId } = await setupAuthor()
    const post = await (await admin.get(`/c/plaza/comments/${postId}`)).text()
    expect(post).toContain('rank-new_user')
    expect(post).toContain('/static/assets/ranks/new-user.gif')
    expect(post).toContain('New User')
  })

  test('arama sonuçları ve bildirimler de aynı rütbe görselini kullanır', async () => {
    const { author, username, postId } = await setupAuthor()
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as {
      id: string
    }).id
    setKarma(userId, 126)

    const search = await (await author.get('/search?q=Rank')).text()
    expect(search).toContain('/tc/' + username)
    expect(search).toContain('/static/assets/ranks/super-user.gif')
    expect(search).toContain('Super User')

    // Başka bir kullanıcı gönderiye yorum yazınca bildirim satırında rozet görünür.
    const { agent: replier, username: replierName } = await registerUser(world, 'yanitci')
    await createPostVia(replier, 'plaza', 'Replier gönderisi', 'Gövde')
    setKarma(
      (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(replierName) as { id: string }).id,
      351,
    )
    await createCommentVia(replier, 'plaza', postId, 'Katılıyorum')

    const notifications = await (await author.get('/notifications')).text()
    expect(notifications).toContain('/tc/' + replierName)
    expect(notifications).toContain('rank-legend')
    expect(notifications).toContain('/static/assets/ranks/legend.gif')
  })
})

describe('kısıtlama (ban) rütbesi', () => {
  test('askıya alınan kullanıcı Yasaklı görünür, süre bitince rütbesine döner', async () => {
    const { admin, author, username } = await setupAuthor()
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as {
      id: string
    }).id
    setKarma(userId, 400)
    const guest = admin

    const before = await (await guest.get(`/tc/${username}`)).text()
    expect(before).toContain('Legend')

    // 3 günlük kısıtlama
    const res = await admin.post(`/admin/users/${userId}/suspend`, { days: '3', reason: 'test' })
    expect(res.status).toBe(302)

    const during = await (await guest.get(`/tc/${username}`)).text()
    expect(during).toContain('rank-banned')
    expect(during).toContain('/static/assets/ranks/banned.gif')
    expect(during).toContain('Yasaklı')
    expect(during).not.toContain('rank-legend')

    // Süre doldu → kullanıcı kendi karma rütbesine döner
    world.tick(4 * 24 * 60 * 60 * 1000)
    const after = await (await guest.get(`/tc/${username}`)).text()
    expect(after).toContain('rank-legend')
    expect(after).not.toContain('rank-banned')
  })

  test('süresiz kısıtlama Yasaklı olarak kalır', async () => {
    const { admin, username } = await setupAuthor()
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as {
      id: string
    }).id
    await admin.post(`/admin/users/${userId}/suspend`, { days: 'indefinite', reason: 'test' })
    world.tick(365 * 24 * 60 * 60 * 1000)
    // Bir yıl geçtiği için eski oturumun süresi doldu; tekrar giriş yapılır.
    const reader = new Agent(world.app)
    await reader.post('/login', { identifier: 'patron', password: 'password12345' })
    const page = await (await reader.get(`/tc/${username}`)).text()
    expect(page).toContain('rank-banned')
    expect(page).toContain('/static/assets/ranks/banned.gif')
  })
})

describe('yönetim yetkileri', () => {
  test('moderator rolü rozeti koyu yeşil sınıfıyla gösterilir ve moderasyon yetkisi verir', async () => {
    const { admin, author, username } = await setupAuthor()
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as {
      id: string
    }).id

    // Başlangıçta moderasyon ekranı erişilemez.
    const denied = await author.get('/c/plaza/mod/queue')
    expect(denied.status).toBe(403)

    await admin.post(`/admin/users/${userId}`, { username, displayName: '', bio: '', rankMode: 'auto', staffRole: 'moderator' })

    const profile = await (await admin.get(`/tc/${username}`)).text()
    expect(profile).toContain('role-moderator')
    expect(profile).toContain('/static/assets/ranks/moderator.gif')
    expect(profile).toContain('Moderator')
    // Yetki varken karma rütbesi rozeti gösterilmez (tek rozet kuralı).
    expect(profile).not.toContain('/static/assets/ranks/new-user.gif')
    expect(profile).not.toContain('rank-new_user')

    const allowed = await author.get('/c/plaza/mod/queue')
    expect(allowed.status).toBe(200)
  })

  test('yönetim yetkisi olan kullanıcıda karma rütbe hiçbir yerde görünmez', async () => {
    const { admin, username } = await setupAuthor()
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as {
      id: string
    }).id
    // 600 karma → God olurdu; yönetici olunca yalnızca yetki rozeti görünmeli.
    setKarma(userId, 600)
    await admin.post(`/admin/users/${userId}`, { username, displayName: '', bio: '', rankMode: 'auto', staffRole: 'admin' })

    const profile = await (await admin.get(`/tc/${username}`)).text()
    expect(profile).toContain('/static/assets/ranks/admin.gif')
    expect(profile).toContain('rank-admin')
    expect(profile).not.toContain('/static/assets/ranks/god.gif')
    expect(profile).not.toContain('rank-god')
    // Profildeki her rozet aynı yetki görseli (başka bir rütbe görseli yok).
    const images = [...profile.matchAll(/<img class="rank-img" src="([^"]+)"/g)].map((m) => m[1])
    expect(images.length).toBeGreaterThan(0)
    expect([...new Set(images)]).toEqual(['/static/assets/ranks/admin.gif'])
  })

  test('süper moderatör, yardımcı yönetici ve yönetici rozetleri ayrı görsellerle görünür', async () => {
    const { admin } = await setupAuthor()
    const roles: Array<[string, string, string]> = [
      ['super_moderator', 'role-super_moderator', '/static/assets/ranks/super-moderator.gif'],
      ['co_admin', 'role-co_admin', '/static/assets/ranks/co-admin.gif'],
      ['admin', 'role-admin', '/static/assets/ranks/admin.gif'],
    ]
    for (const [role, className, asset] of roles) {
      const { agent, username } = await registerUser(world, `u_${role}`)
      const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as {
        id: string
      }).id
      await admin.post(`/admin/users/${userId}`, { username, displayName: '', bio: '', rankMode: 'auto', staffRole: role })
      const page = await (await agent.get(`/tc/${username}`)).text()
      expect(page, role).toContain(className)
      expect(page, role).toContain(asset)
    }
  })

  test('kullanıcı kendi yetkisini yükseltemez', async () => {
    const { author } = await setupAuthor()
    // Ayarlar sayfasında rol alanı yok; yönetim paneli de erişilemez.
    const settings = await (await author.get('/settings')).text()
    expect(settings).not.toContain('name="staffRole"')
    const panel = await author.get('/admin')
    expect(panel.status).toBe(403)
  })
})

describe('yönetim panelinden rütbe ve profil yönetimi', () => {
  test('manuel rütbe atanır ve otomatik moda dönülebilir', async () => {
    const { admin, username } = await setupAuthor()
    const userId = (world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(username) as {
      id: string
    }).id
    const guest = admin

    await admin.post(`/admin/users/${userId}`, { username, displayName: 'Mert', bio: 'Selam', rankMode: 'manual', rank: 'god' })
    const manual = await (await guest.get(`/tc/${username}`)).text()
    expect(manual).toContain('rank-god')
    expect(manual).toContain('/static/assets/ranks/god.gif')
    expect(manual).toContain('God')

    const detail = await (await admin.get(`/admin?tab=users&edit=${userId}`)).text()
    expect(detail).toContain('name="rankMode"')
    expect(detail).toContain('Mert')

    await admin.post(`/admin/users/${userId}`, { username, displayName: 'Mert', bio: 'Selam', rankMode: 'auto' })
    const auto = await (await guest.get(`/tc/${username}`)).text()
    expect(auto).toContain('rank-new_user')
    expect(auto).not.toContain('rank-god')
  })

  test('kullanıcı listesi rütbe ve yetki sütunlarını gösterir', async () => {
    const { admin, username } = await setupAuthor()
    const page = await (await admin.get('/admin?tab=users')).text()
    expect(page).toContain('rank-badge-img')
    expect(page).toContain(`/tc/${username}`)
    expect(page).toContain('Rütbe')
    expect(page).toContain('Yönetim yetkisi')
  })

  test('kullanıcı kendi yönetim yetkisini kaldıramaz', async () => {
    const { admin, username: adminName } = await setupAuthor()
    const adminId = (world.ctx.db.prepare('SELECT id FROM users WHERE is_admin = 1').get() as { id: string }).id
    const res = await admin.post(`/admin/users/${adminId}`, {
      username: adminName,
      displayName: '',
      bio: '',
      rankMode: 'auto',
      staffRole: '',
    })
    expect(res.status).toBe(302)
    const after = await (await admin.get('/admin?tab=users&edit=' + adminId)).text()
    expect(after).toContain('yetkinizi değiştiremezsiniz')
    // Rol hâlâ Yönetici olarak duruyor.
    expect(after).toContain('role-admin')
  })
})

describe('rank hesaplama yardımcıları', () => {
  test('userRankInfo manuel rütbi ve kısıtlamayı birlikte yönetir', async () => {
    const { username } = await setupAuthor()
    void createPostVia
    const user = world.ctx.db.prepare('SELECT * FROM users WHERE username_lower = ?').get(username) as unknown as Parameters<
      typeof userRankInfo
    >[1]
    setKarma(user.id, 501)
    expect(userRankInfo(world.ctx, user).rank).toBe('god')
    expect(rankBadgeLabel({ ...userRankInfo(world.ctx, user), banned: true })).toBe('Yasaklı')
    expect(rankForKarma(51)).toBe('active_user')
  })
})
