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

/**
 * Anonimlik denetimi.
 *
 * "Anonim" bir arayüz etiketi değil, bir gizlilik garantisidir: anonim içeriğin
 * gerçek hesabı normal kullanıcıya HİÇBİR yüzeyde sızmamalıdır.
 */
describe('anonimlik ve gizlilik', () => {
  /** Gerçek hesabın hiçbir yerde geçmediğini doğrular. */
  function assertNoLeak(html: string, username: string, label: string): void {
    expect(html, `${label}: kullanıcı adı sızdı`).not.toContain(username)
    expect(html, `${label}: profil bağlantısı sızdı`).not.toContain(`/tc/${username}`)
  }

  it('anonim gönderinin yazarı hiçbir genel yüzeyde görünmez', async () => {
    const world = createTestWorld()
    await registerAdmin(world)
    const author = await registerUser(world, 'gizliyazar')
    const reader = await registerUser(world, 'okuyucu')
    // Board sahibi başka biri: aksi hâlde yazar "Moderatörler" listesinde
    // meşru olarak görünür ve test yanlış pozitif verir.
    const owner = await registerUser(world, 'boardsahibi')
    await createCommunityVia(owner.agent, 'anonimtest')

    // Anonim metin gönderisi
    const post = await createPostVia(author.agent, 'anonimtest', 'anonim baslik', 'anonim govde')
    world.ctx.db.prepare('UPDATE posts SET is_anonymous = 1, anon_name = ? WHERE id = ?').run('Zq4Rt', post)

    const authorId = getUserByUsername(world.ctx, 'gizliyazar')!.id
    const surfaces: Array<[string, string]> = [
      ['board akışı', '/c/anonimtest'],
      ['ana akış', '/'],
      ['gönderi sayfası', `/c/anonimtest/comments/${post}`],
      ['arama', '/search?q=anonim'],
      ['kaydedilenler', '/saved'],
    ]
    for (const [label, path] of surfaces) {
      const html = await (await reader.agent.get(path)).text()
      assertNoLeak(html, 'gizliyazar', label)
      // Hesap kimliği de sızmamalı (HTML'de gizli alan yok).
      expect(html, `${label}: hesap kimliği sızdı`).not.toContain(authorId)
    }
  })

  it('anonim yorumun yazarı hiçbir genel yüzeyde görünmez', async () => {
    const world = createTestWorld()
    await registerAdmin(world)
    const author = await registerUser(world, 'gizliyorumcu')
    const reader = await registerUser(world, 'okuyucu')
    const owner = await registerUser(world, 'gonderisahibi')
    await createCommunityVia(owner.agent, 'anonimtest')
    const post = await createPostVia(owner.agent, 'anonimtest', 'konu', 'govde')
    const comment = await createCommentVia(author.agent, 'anonimtest', post, 'anonim yorum')
    world.ctx.db.prepare('UPDATE comments SET is_anonymous = 1, anon_name = ? WHERE id = ?').run('Kp7Wz', comment)

    const authorId = getUserByUsername(world.ctx, 'gizliyorumcu')!.id
    for (const [label, path] of [
      ['gönderi sayfası', `/c/anonimtest/comments/${post}`],
      ['ana akış', '/'],
    ] as Array<[string, string]>) {
      const html = await (await reader.agent.get(path)).text()
      assertNoLeak(html, 'gizliyorumcu', label)
      expect(html, `${label}: hesap kimliği sızdı`).not.toContain(authorId)
    }
  })

  it('anonim içerik gerçek yazarı yalnızca yönetim panelinde gösterir', async () => {
    const world = createTestWorld()
    const admin = await registerAdmin(world)
    const author = await registerUser(world, 'gizliyazar')
    const owner = await registerUser(world, 'boardsahibi2')
    await createCommunityVia(owner.agent, 'anonimtest')
    const post = await createPostVia(author.agent, 'anonimtest', 'anonim baslik', 'govde')
    world.ctx.db.prepare('UPDATE posts SET is_anonymous = 1, anon_name = ? WHERE id = ?').run('Zq4Rt', post)

    // Yazarın kendi profilinde anonim gönderi görünmemeli (aksi hâlde
    // gerçek hesap ile anonim içerik arasındaki bağlantı sızar).
    const ownProfile = await (await author.agent.get('/tc/gizliyazar')).text()
    expect(ownProfile).not.toContain('anonim baslik')
    expect(ownProfile).not.toContain('/p/' + post)

    const panel = await (await admin.agent.get('/admin?tab=anonymous')).text()
    expect(panel).toContain('gizliyazar')
    expect(panel).toContain('Zq4Rt')
  })

  it('anonim içerik moderasyon kuyruğunda yazarıyla birlikte görünür (denetim)', async () => {
    const world = createTestWorld()
    const admin = await registerAdmin(world)
    const author = await registerUser(world, 'gizliyazar')
    const owner = await registerUser(world, 'boardsahibi3')
    await createCommunityVia(owner.agent, 'anonimtest')
    const post = await createPostVia(author.agent, 'anonimtest', 'anonim baslik', 'govde')
    world.ctx.db.prepare('UPDATE posts SET is_anonymous = 1, anon_name = ? WHERE id = ?').run('Zq4Rt', post)
    await owner.agent.post(`/report/post/${post}`, { reasonType: 'spam', detail: 'test' })
    // Moderatörün müdahale ettiği kuyruk gerçek yazarı gösterir.
    const queue = await (await admin.agent.get('/c/anonimtest/mod/queue')).text()
    expect(queue).toContain('gizliyazar')
  })

  it('özel mesajlar yalnızca taraflar tarafından görülebilir', async () => {
    const world = createTestWorld()
    await registerAdmin(world)
    const alice = await registerUser(world, 'alice')
    const bob = await registerUser(world, 'bobb')
    const outsider = await registerUser(world, 'disaridaki')

    // Konuşmayı aç, sonra mesajı gönder.
    const start = await alice.agent.post('/messages/new', { username: 'bobb' })
    const location = start.headers.get('location') ?? ''
    const conversation = location.match(/\/messages\/([a-z0-9]+)$/)?.[1]
    expect(conversation, `konuşma oluşturulamadı: ${location}`).toBeTruthy()
    await alice.agent.post(`/messages/${conversation}/send`, { body: 'gizli mesaj icerigi' })

    // Alıcı görebilir.
    const inbox = await (await bob.agent.get('/messages')).text()
    expect(inbox).toContain('gizli mesaj icerigi')
    // Gönderen görebilir.
    const outbox = await (await alice.agent.get('/messages')).text()
    expect(outbox).toContain('gizli mesaj icerigi')
    // Dışarıdaki hiçbir yerde görünmez.
    for (const path of ['/messages', '/']) {
      const html = await (await outsider.agent.get(path)).text()
      expect(html).not.toContain('gizli mesaj icerigi')
    }
    // Arama sonuçlarında da sızmaz.
    const search = await (await outsider.agent.get('/search?q=gizli+mesaj')).text()
    expect(search).not.toContain('gizli mesaj icerigi')
  })

  it('DM uç noktaları oturum açmadan erişilemez', async () => {
    const world = createTestWorld()
    const { app } = world
    const anon = new Agent(app)
    for (const path of ['/messages', '/messages/new?to=bobb']) {
      const res = await anon.get(path)
      expect(res.status === 200 ? await res.text() : '').not.toContain('Mesaj')
    }
  })

  it('DM gövdesi bildirim merkezine kopyalanmaz (veri minimizasyonu)', async () => {
    const world = createTestWorld()
    await registerAdmin(world)
    const alice = await registerUser(world, 'alice')
    await registerUser(world, 'bobb')
    const start = await alice.agent.post('/messages/new', { username: 'bobb' })
    const conversation = (start.headers.get('location') ?? '').match(/\/messages\/([a-z0-9]+)$/)?.[1]
    await alice.agent.post(`/messages/${conversation}/send`, { body: 'cok gizli bir sey' })
    // Bildirim tablosunda özel mesaj gövdesi SAKLANMAZ.
    const rows = world.ctx.db.prepare('SELECT * FROM notifications').all() as unknown as Array<Record<string, unknown>>
    expect(JSON.stringify(rows)).not.toContain('cok gizli bir sey')
  })
})