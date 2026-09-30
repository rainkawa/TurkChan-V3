/**
 * Rozet (badge) okunma durumu — server-side.
 *
 * Bildirim ve DM rozetleri veritabanındaki okunma durumundan hesaplanır.
 * Kullanıcı ekranı açtığında durum SUNUCUDA güncellenmelidir; yalnızca
 * frontend'de gizlemek sayfa yenileyince rozeti geri getirir.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import {
  createCommentVia,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerUser,
  type TestWorld,
} from '../testUtils'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

const db = () => world.ctx.db

/** Okunmamış bildirim sayısı (veritabanı gerçeği). */
function unreadInDb(userId: string): number {
  return (
    db().prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND withdrawn = 0 AND read = 0').get(userId) as {
      n: number
    }
  ).n
}

/** HTML'deki bildirim rozet sayısını çıkarır. */
function badgeFromHtml(html: string): number {
  const m = html.match(/data-notification-badge="(\d+)"/)
  if (m) return Number(m[1])
  return 0
}

describe('bildirim rozeti', () => {
  test('bildirim ekranı açılınca okunmamışlar sunucuda okunur ve rozet 0 olur', async () => {
    const { agent: mod } = await registerUser(world, 'mert')
    await createCommunityVia(mod, 'talk')
    const { agent: alice } = await registerUser(world, 'alice')
    const { agent: bob } = await registerUser(world, 'bobby')
    const postId = await createPostVia(mod, 'talk', 'Konu', 'gövde')

    // Üç okunmamış bildirim: alice iki kez yanıtlar, bir kez bahis eder.
    await createCommentVia(alice, 'talk', postId, 'ilk yanıt')
    await createCommentVia(bob, 'talk', postId, 'mert diyor ki')
    world.tick(1000)
    await createCommentVia(alice, 'talk', postId, 'mert şunu söyledi')

    const modUser = db().prepare('SELECT id FROM users WHERE username_lower = ?').get('mert') as { id: string }
    expect(unreadInDb(modUser.id)).toBe(3)

    // Rozet, ekran açılmadan önce ana sayfada görünür.
    const home = await (await mod.get('/')).text()
    expect(badgeFromHtml(home)).toBe(3)

    // Bildirim ekranını aç → hepsi okundu.
    const page = await mod.get('/notifications')
    expect(page.status).toBe(200)
    expect(unreadInDb(modUser.id)).toBe(0)

    // Görüntülenen HTML'de rozet 0.
    const html = await (await mod.get('/')).text()
    expect(badgeFromHtml(html)).toBe(0)

    // Sayfa yenilendiğinde rozet geri gelmez.
    const refreshed = await (await mod.get('/')).text()
    expect(badgeFromHtml(refreshed)).toBe(0)
    expect(unreadInDb(modUser.id)).toBe(0)
  })

  test('yeni bildirim rozeti tekrar artırır', async () => {
    const { agent: mod } = await registerUser(world, 'mert2')
    await createCommunityVia(mod, 'talk')
    const { agent: alice } = await registerUser(world, 'alice2')
    const postId = await createPostVia(mod, 'talk', 'Konu', 'gövde')

    await createCommentVia(alice, 'talk', postId, 'merhaba')
    await mod.get('/notifications')
    expect(badgeFromHtml(await (await mod.get('/')).text())).toBe(0)

    // Yeni yanıt → rozet tekrar görünür.
    await createCommentVia(alice, 'talk', postId, 'tekrar merhaba')
    expect(badgeFromHtml(await (await mod.get('/')).text())).toBe(1)
  })

  test('başka kullanıcının bildirimi işaretlenmez', async () => {
    const { agent: mod } = await registerUser(world, 'mert3')
    await createCommunityVia(mod, 'talk')
    const { agent: alice } = await registerUser(world, 'alice3')
    const postId = await createPostVia(mod, 'talk', 'Konu', 'gövde')

    await createCommentVia(alice, 'talk', postId, 'sadece mert için')
    await mod.get('/notifications')

    const aliceUser = db().prepare('SELECT id FROM users WHERE username_lower = ?').get('alice3') as { id: string }
    expect(unreadInDb(aliceUser.id)).toBe(0)
  })

  test('"tümünü okundu işaretle" çalışır', async () => {
    const { agent: mod } = await registerUser(world, 'mert4')
    await createCommunityVia(mod, 'talk')
    const { agent: alice } = await registerUser(world, 'alice4')
    const postId = await createPostVia(mod, 'talk', 'Konu', 'gövde')

    await createCommentVia(alice, 'talk', postId, 'bir')
    await createCommentVia(alice, 'talk', postId, 'iki')
    await createCommentVia(alice, 'talk', postId, 'üç')

    const modUser = db().prepare('SELECT id FROM users WHERE username_lower = ?').get('mert4') as { id: string }
    expect(unreadInDb(modUser.id)).toBe(3)

    await mod.post('/notifications/read-all')
    expect(unreadInDb(modUser.id)).toBe(0)
    expect(badgeFromHtml(await (await mod.get('/')).text())).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('DM rozeti', () => {
  async function startDm() {
    const { agent: alice } = await registerUser(world, 'alice5')
    const { agent: bob, username: bobName } = await registerUser(world, 'bob5')
    const res = await bob.post('/messages/new', { username: 'alice5' })
    expect(res.status).toBe(302)
    const conversationId = (res.headers.get('location') ?? '').split('/').pop() as string
    return { alice, bob, bobName, conversationId }
  }

  /** Veritabanındaki gerçek okunmamış sayısı (rowid su damgasıyla). */
  function unreadInDb(userId: string, conversationId: string): number {
    const member = db()
      .prepare('SELECT last_read_rowid FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
      .get(conversationId, userId) as { last_read_rowid: number }
    return (
      db()
        .prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND sender_id != ? AND rowid > ?')
        .get(conversationId, userId, member.last_read_rowid) as { n: number }
    ).n
  }

  test('DM ekranı açılınca rozet sunucuda sıfırlanır ve yenilemede geri gelmez', async () => {
    const { alice, bob, conversationId } = await startDm()
    await bob.post(`/messages/${conversationId}/send`, { body: 'selam alice' })

    const aliceUser = db().prepare('SELECT id FROM users WHERE username_lower = ?').get('alice5') as { id: string }
    // Alıcının (alice) veritabanında 1 okunmamış mesaj var.
    expect(unreadInDb(aliceUser.id, conversationId)).toBe(1)
    // Rozet yalnızca ALICI'da görünür; gönderende görünmez.
    expect(badgeFromHtml(await (await alice.get('/')).text())).toBe(1)
    expect(badgeFromHtml(await (await bob.get('/')).text())).toBe(0)

    // DM ekranı aç → sunucuda okundu.
    const page = await alice.get('/messages')
    expect(page.status).toBe(200)
    expect(unreadInDb(aliceUser.id, conversationId)).toBe(0)

    // Rozet 0 ve yenilemede geri gelmez.
    expect(badgeFromHtml(await (await alice.get('/')).text())).toBe(0)
    expect(badgeFromHtml(await (await alice.get('/')).text())).toBe(0)
  })

  test('yeni mesaj rozeti tekrar artırır', async () => {
    const { alice, bob, conversationId } = await startDm()
    await bob.post(`/messages/${conversationId}/send`, { body: 'ilk' })
    await alice.get('/messages')
    expect(badgeFromHtml(await (await alice.get('/')).text())).toBe(0)

    await bob.post(`/messages/${conversationId}/send`, { body: 'ikinci mesaj' })
    expect(badgeFromHtml(await (await alice.get('/')).text())).toBe(1)

    // Açınca tekrar sıfırlanır.
    await alice.get('/messages')
    expect(badgeFromHtml(await (await alice.get('/')).text())).toBe(0)
  })

  test('kendi gönderdiğin mesajın rozet sayısına katılmaz', async () => {
    const { alice, bob, conversationId } = await startDm()
    await alice.post(`/messages/${conversationId}/send`, { body: 'kendi mesajım' })
    // Gönderen kendi mesajını okumuş sayılır.
    expect(badgeFromHtml(await (await alice.get('/')).text())).toBe(0)
    // Alıcıda görünür.
    expect(badgeFromHtml(await (await bob.get('/')).text())).toBe(1)
  })

  test('üçüncü taraf sohbeti okunmuş işaretleyemez (yetki)', async () => {
    const { bob, conversationId } = await startDm()
    await bob.post(`/messages/${conversationId}/send`, { body: 'gizli mesaj' })
    const { agent: mallory } = await registerUser(world, 'mallory')

    // Sohbeti açmaya çalışmak da yetkisiz.
    const open = await mallory.get(`/messages/${conversationId}`)
    expect([302, 403, 404]).toContain(open.status)

    const aliceUser = db().prepare('SELECT id FROM users WHERE username_lower = ?').get('alice5') as { id: string }
    // Alıcının okunmamış durumu üçüncü tarafın denemesiyle bozulmadı.
    expect(unreadInDb(aliceUser.id, conversationId)).toBe(1)
    // Sohbet içeriği de sızmadı.
    expect(await (await mallory.get(`/messages/${conversationId}`)).text()).not.toContain('gizli mesaj')
  })
})
