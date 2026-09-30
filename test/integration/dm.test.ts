import { beforeEach, describe, expect, test } from 'vitest'
import { createTestWorld, registerUser, type Agent, type TestWorld } from '../testUtils'
import { resetPresence } from '../../src/services/presence'
import { t } from '../../src/i18n/tr'

/**
 * Özel mesajlaşma (DM):
 *  - gelen kutusu, istekler ve arşiv bölümleri
 *  - okundu/okunmadı (koyu satır + rozet) ve okundu bilgisi (tik)
 *  - çevrimiçi/çevrimdışi ve "yazıyor"
 *  - yanıtlama, beğeni, şikayet
 *  - mesajı herkesten silme / sadece benden silme
 *  - sohbeti arşivleme ve silme
 *  - kullanıcı arama ve yeni sohbet başlatma
 *  - alt bardaki kırmızı rozet
 */

let world: TestWorld
let alice: Agent
let bob: Agent
let carol: Agent

/** Sohbeti iki kullanıcı arasında açar ve id döndürür. */
async function openChat(from: Agent, to: string): Promise<string> {
  const res = await from.post('/messages/new', { username: to })
  const location = res.headers.get('location') ?? ''
  const match = location.match(/\/messages\/([a-z0-9]+)$/)
  if (!match) throw new Error(`sohbet açılamadı: ${res.status} → ${location}`)
  return match[1] as string
}

async function send(from: Agent, conversation: string, body: string, replyTo = ''): Promise<Response> {
  return from.post(`/messages/${conversation}/send`, { body, replyTo })
}

interface PollPayload {
  messages: Array<{ id: string; body: string; createdAt: number }>
  reads: Record<string, boolean>
  online: boolean
  typing: boolean
}

/** Yoklama ucunu çağırır (yoklamanın döndüğü gövde tiplenmiştir). */
async function poll(agent: Agent, query: string): Promise<PollPayload> {
  return (await agent.get(`/api/dm/thread?${query}`)).json() as Promise<PollPayload>
}

async function like(agent: Agent, messageId: string): Promise<{ liked: boolean }> {
  return (await agent.json('/api/dm/like', { messageId })).json() as Promise<{ liked: boolean }>
}

beforeEach(async () => {
  resetPresence()
  world = createTestWorld()
  alice = (await registerUser(world, 'alice')).agent
  bob = (await registerUser(world, 'bobby')).agent
  carol = (await registerUser(world, 'carol')).agent
})

describe('DM — giriş ve arama', () => {
  test('girişsiz kullanıcı gelen kutusuna giremez', async () => {
    const res = await world.app.request('/messages')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/login')
  })

  test('arama en az 2 karakter ister ve kullanıcı bulur', async () => {
    const short = await (await alice.get('/messages?q=a')).text()
    expect(short).toContain('En az 2 karakter')

    const found = await (await alice.get('/messages?q=bo')).text()
    expect(found).toContain('@bobby')
    expect(found).toContain('Sohbet başlat')

    const missing = await (await alice.get('/messages?q=zzzzz')).text()
    expect(missing).toContain('Kullanıcı bulunamadı')
  })

  test('kullanıcı aramasından sohbet açılır ve profil bilgileri görünür', async () => {
    const conversation = await openChat(alice, 'bobby')
    const page = await (await alice.get(`/messages/${conversation}`)).text()
    expect(page).toContain('/tc/bobby')
    expect(page).toContain('@bobby')
    // Sohbet başlığında profil resmi (avatar) bulunur.
    expect(page).toContain('dm-avatar')
  })

  test('arama sonucunda "Sohbet başlat" düğmesi formu gönderir', async () => {
    const page = await (await alice.get('/messages?q=bobby')).text()
    // Tıklanabilir bir gönder düğmesi olmadan form gönderilemez.
    expect(page).toContain('action="/messages/new"')
    expect(page).toMatch(/<form method="post" action="\/messages\/new"[\s\S]{0,400}type="submit"/)
    expect(page).toContain('name="username" value="bobby"')

    // Düğmeye basmak sohbeti başlatır.
    const res = await alice.post('/messages/new', { username: 'bobby' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toMatch(/^\/messages\/[a-z0-9]+$/)
  })

  test('kullanıcı adına basıldığında profile gider, satırın geri kalanı sohbete', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Satır testi')

    const inbox = await (await alice.get('/messages')).text()
    // Kullanıcı adı profille, satır sohbetle bağlı (uzatılmış bağlantı).
    expect(inbox).toContain(`class="dm-row-username" href="/tc/bobby"`)
    expect(inbox).toContain(`class="dm-row-open" href="/messages/${conversation}"`)
  })

  test('başlıktaki DM simgesi kaldırıldı, gelen kutusu alt barda', async () => {
    const home = await (await alice.get('/')).text()
    expect(home).not.toContain('header-messages')
    expect(home).toContain('bottom-nav')
    expect(home).toContain('href="/messages"')
  })

  test('rozet sayısı alt bardaki rozetle aynıdır', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Bir')
    world.tick(1000)
    await send(alice, conversation, 'İki')

    const home = await (await bob.get('/')).text()
    const inbox = home.slice(home.indexOf('bottom-inbox'))
    expect(inbox).toContain('notif-badge')
    expect(inbox).toMatch(/notif-badge[^>]*>2</)
  })

  test('kendine mesaj gönderilemez', async () => {
    const res = await alice.post('/messages/new', { username: 'alice' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/messages')
  })
})

describe('DM — mesaj gönderme ve okundu durumu', () => {
  test('mesaj gönderilir ve alıcıda okunmamış olarak koyu satır çıkar', async () => {
    const conversation = await openChat(alice, 'bobby')
    const sent = await send(alice, conversation, 'Merhaba Bob')
    expect(sent.status).toBe(302)

    // Okunmamış sohbet bildirimler sayfasında koyu satır + kırmızı rozet olarak
    // listelenir; alt bardaki rozet de orada görünür.
    const inbox = await (await bob.get('/notifications')).text()
    expect(inbox).toContain('is-unread')
    expect(inbox).toContain('data-unread="1"')
    expect(inbox).toContain('dm-row-badge')
    expect(inbox).toContain('Merhaba Bob')
    expect(inbox).toMatch(/bottom-inbox[\s\S]{0,400}notif-badge/)
  })

  test('okunduğunda satır normal renge döner ve rozet kaybolur', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Birinci')

    expect(await (await bob.get('/notifications')).text()).toContain('is-unread')

    // Sohbeti açmak sunucuda okundu sayılır.
    await bob.get(`/messages/${conversation}`)

    expect(await (await bob.get('/notifications')).text()).not.toContain('is-unread')
    // Gelen kutusu da rozet göstermez.
    const inbox = await (await bob.get('/messages')).text()
    expect(inbox).not.toContain('dm-row-badge')
  })

  test('gönderene okundu bilgisi (tik) düşer', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Okunacak mı?')

    let page = await (await alice.get(`/messages/${conversation}`)).text()
    expect(page).toContain('data-dm-read="0"')

    await bob.get(`/messages/${conversation}`)
    world.tick(1000)
    page = await (await alice.get(`/messages/${conversation}`)).text()
    expect(page).toContain('data-dm-read="1"')
  })

  test('boş ve aşırı uzun mesaj gönderilemez', async () => {
    const conversation = await openChat(alice, 'bobby')
    expect((await send(alice, conversation, '   ')).status).toBe(302)

    const tooLong = await send(alice, conversation, 'x'.repeat(2001))
    expect(tooLong.status).toBe(302)

    const page = await (await alice.get(`/messages/${conversation}`)).text()
    expect(page).not.toContain('xxxxxx')
  })

  test('üye olmayan kullanıcı sohbeti göremez', async () => {
    const conversation = await openChat(alice, 'bobby')
    const res = await carol.get(`/messages/${conversation}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/messages')
  })
})

describe('DM — istekler, arşiv ve sohbet silme', () => {
  test('yeni sohbet alıcının istekler bölümüne düşer ve kabul edilebilir', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Merhaba')

    const inbox = await (await bob.get('/messages')).text()
    expect(inbox).toContain('dm-section-request')
    expect(inbox).toContain('İstekler')
    expect(inbox).toContain(`/messages/${conversation}/accept`)

    const accepted = await bob.post(`/messages/${conversation}/accept`)
    expect(accepted.status).toBe(302)

    const after = await (await bob.get('/messages')).text()
    expect(after).toContain('dm-section-main')
    // Kabulden sonra istek bölümünde sohbet kalmaz.
    const requestSection = after.slice(after.indexOf('dm-section-request'))
    expect(requestSection).not.toContain(`/messages/${conversation}/accept`)
  })

  test('basılı tutma menüsü arşivler ve sohbet arşivden çıkarılabilir', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Arşiv testi')

    const inboxBefore = await (await alice.get('/messages')).text()
    expect(inboxBefore).toContain(`/messages/${conversation}/conversation`)

    const archived = await alice.post(`/messages/${conversation}/conversation`, { intent: 'archive' })
    expect(archived.status).toBe(302)

    const inbox = await (await alice.get('/messages')).text()
    const archiveSection = inbox.slice(inbox.indexOf('dm-section-archived'))
    expect(archiveSection).toContain(`data-dm-conversation="${conversation}"`)

    await alice.post(`/messages/${conversation}/conversation`, { intent: 'unarchive' })
    const restored = await (await alice.get('/messages')).text()
    const mainSection = restored.slice(0, restored.indexOf('dm-section-request'))
    expect(mainSection).toContain(`data-dm-conversation="${conversation}"`)
  })

  test('sohbeti silmek yalnızca kendi listesinden kaldırır', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Silinecek sohbet')

    const res = await alice.post(`/messages/${conversation}/conversation`, { intent: 'delete' })
    expect(res.status).toBe(302)

    const aliceInbox = await (await alice.get('/messages')).text()
    expect(aliceInbox).not.toContain(`data-dm-conversation="${conversation}"`)

    // Karşı tarafın listesi etkilenmez.
    const bobInbox = await (await bob.get('/messages')).text()
    expect(bobInbox).toContain(`data-dm-conversation="${conversation}"`)
  })
})

describe('DM — mesaj eylemleri', () => {
  test('kendi mesajını herkesten silmek iki tarafta da gizler', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Gizli olacak')
    const chat = await (await alice.get(`/messages/${conversation}`)).text()
    const messageId = chat.match(/data-dm-message="([a-z0-9]+)"/)?.[1] as string
    expect(messageId).toBeTruthy()

    const res = await alice.post(`/messages/message/${messageId}`, { intent: 'delete-everyone' })
    expect(res.status).toBe(302)

    for (const agent of [alice, bob]) {
      const page = await (await agent.get(`/messages/${conversation}`)).text()
      expect(page).toContain('Silinmiş mesaj')
      expect(page).not.toContain('Gizli olacak')
    }
  })

  test('karşı tarafın mesajını sadece benden silmek', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(bob, conversation, 'Sadece bende silinsin')
    const chat = await (await alice.get(`/messages/${conversation}`)).text()
    const messageId = chat.match(/data-dm-message="([a-z0-9]+)"/)?.[1] as string

    const res = await alice.post(`/messages/message/${messageId}`, { intent: 'delete-self' })
    expect(res.status).toBe(302)

    const alicePage = await (await alice.get(`/messages/${conversation}`)).text()
    expect(alicePage).not.toContain('Sadece bende silinsin')

    // Bob mesajı hâlâ görür.
    const bobPage = await (await bob.get(`/messages/${conversation}`)).text()
    expect(bobPage).toContain('Sadece bende silinsin')
  })

  test('başkasının mesajını herkesten silmek reddedilir', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(bob, conversation, 'Bob mesajı')
    const chat = await (await alice.get(`/messages/${conversation}`)).text()
    const messageId = chat.match(/data-dm-message="([a-z0-9]+)"/)?.[1] as string

    const res = await alice.post(`/messages/message/${messageId}`, { intent: 'delete-everyone' })
    expect(res.status).toBe(302)
    const page = await (await alice.get(`/messages/${conversation}`)).text()
    expect(page).toContain('Bob mesajı')
  })

  test('çift dokunma beğeniyi açar ve kapatır', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Beğenilecek')

    const liked = await alice.json('/api/dm/like', { messageId: 'yok-boyle-bir-mesaj' })
    expect(liked.status).toBe(404)

    const chat = await (await alice.get(`/messages/${conversation}`)).text()
    const messageId = chat.match(/data-dm-message="([a-z0-9]+)"/)?.[1] as string

    const first = await like(alice, messageId)
    expect(first.liked).toBe(true)

    const page = await (await alice.get(`/messages/${conversation}`)).text()
    expect(page).toContain('data-liked="1"')
    expect(page).toContain('dm-bubble-like')

    const second = await like(alice, messageId)
    expect(second.liked).toBe(false)
  })

  test('basılı tutarak raporlama kaydedilir, kendi mesajı raporlanamaz', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(bob, conversation, 'Raporlanacak mesaj')

    const chat = await (await alice.get(`/messages/${conversation}`)).text()
    const messageId = chat.match(/data-dm-message="([a-z0-9]+)"/)?.[1] as string

    const form = await (await alice.get(`/messages/report/${messageId}`)).text()
    expect(form).toContain('Mesajı şikayet et')
    expect(form).toContain('Raporlanacak mesaj')

    const res = await alice.post(`/messages/report/${messageId}`, {
      reason: 'harassment',
      detail: 'Kaba söz',
      back: `/messages/${conversation}`,
    })
    expect(res.status).toBe(302)

    const reports = world.ctx.db.prepare('SELECT * FROM message_reports').all() as Array<{ reason: string; detail: string }>
    expect(reports).toHaveLength(1)
    expect(reports[0]?.reason).toBe('harassment')
    expect(reports[0]?.detail).toBe('Kaba söz')

    // Kendi mesajını raporlamak reddedilir.
    const mine = await (await bob.get(`/messages/${conversation}`)).text()
    const mineId = mine.match(/data-dm-message="([a-z0-9]+)"/)?.[1] as string
    await bob.post(`/messages/report/${mineId}`, { reason: 'spam' })
    expect(world.ctx.db.prepare('SELECT COUNT(*) AS n FROM message_reports').get()).toEqual({ n: 1 })
  })

  test('soldan sağa kaydırarak yanıtlama alanı doldurulur', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(bob, conversation, 'Şu mesajı yanıtla')
    const chat = await (await bob.get(`/messages/${conversation}`)).text()
    const messageId = chat.match(/data-dm-message="([a-z0-9]+)"/)?.[1] as string

    const replyPage = await (await bob.get(`/messages/${conversation}?reply=${messageId}`)).text()
    expect(replyPage).toContain('Yanıtlıyorsun')
    expect(replyPage).toContain('dm-reply-bar')

    await send(bob, conversation, 'Yanıtım bu', messageId)
    const after = await (await bob.get(`/messages/${conversation}`)).text()
    expect(after).toContain('Yanıtım bu')
    expect(after).toContain('dm-bubble-reply')
  })
})

describe('DM — bildirim rozeti ve sohbet ekranı', () => {
  test('rozet 2 derken bildirimler sayfası boş görünmez', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Birinci mesaj')
    world.tick(1000)
    await send(alice, conversation, 'İkinci mesaj')

    // Rozet bildirim + DM toplamını gösterir; sayfa da aynı içeriği listeler.
    const page = await (await bob.get('/notifications')).text()
    expect(page).toContain('/messages/')
    expect(page).toContain('@alice')
    expect(page).toContain('İkinci mesaj')
    expect(page).toContain('dm-row-badge')
    expect(page).toContain('2')
    // Bildirim yoksa bile "bildirim yok" yazmaz, çünkü sayfada mesaj var.
    expect(page).not.toContain(t.notifications.empty)
  })

  test('bildirimler sayfasından tüm mesajlar okundu işaretlenir', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Okunacak mesaj')

    expect(await (await bob.get('/notifications')).text()).toContain('Okunacak mesaj')

    const res = await bob.post('/messages/read-all')
    expect(res.status).toBe(302)

    const after = await (await bob.get('/notifications')).text()
    expect(after).not.toContain('Okunacak mesaj')
    expect(after).toContain(t.notifications.empty)
  })

  test('sohbet ekranı tam ekrandır: alt bar yok, liste kendi içinde kaydırılır', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Merhaba')

    const page = await (await alice.get(`/messages/${conversation}`)).text()
    expect(page).toContain('body class="is-member is-chat"')
    expect(page).not.toContain('bottom-nav')
    // Sabit başlık, kaydırılan liste ve sabit yazma alanı.
    expect(page).toContain('dm-chat-head')
    expect(page).toContain('data-dm-thread')
    expect(page).toContain('dm-composer')
  })
})

describe('DM — çevrimiçi, yazıyor ve yoklama', () => {  test('karşı taraf çevrimiçi görünür ve "yazıyor" göstergesi çalışır', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'Sohbet açık')

    // Alice sohbeti açtı → presence dokundu, Bob çevrimiçi sayılır.
    await alice.get(`/messages/${conversation}`)
    const inbox = await (await bob.get('/messages')).text()
    expect(inbox).toContain('is-online')

    const typing = await bob.json('/api/dm/typing', { conversation, typing: true })
    expect(typing.status).toBe(200)

    const chat = await (await alice.get(`/messages/${conversation}`)).text()
    expect(chat).toContain('is-typing')
    expect(chat).toContain('yazıyor')

    // Süre dolunca gösterge söner.
    world.tick(10_000)
    const later = await (await alice.get(`/messages/${conversation}`)).text()
    expect(later).not.toContain('is-typing')
  })

  test('yoklama ucu yeni mesajları ve okundu bilgisini döndürür', async () => {
    const conversation = await openChat(alice, 'bobby')
    await send(alice, conversation, 'İlk')

    const first = await poll(bob, `conversation=${conversation}`)
    expect(first.messages).toHaveLength(1)
    expect(first.online).toBe(true)
    expect(first.typing).toBe(false)

    world.tick(500)
    await send(alice, conversation, 'İkinci')

    // "since" kapsayıcıdır; istemci yinelenen mesajı ayıklar.
    const since = (first.messages[0]?.createdAt as number) + 1
    const second = await poll(bob, `conversation=${conversation}&since=${since}`)
    expect(second.messages).toHaveLength(1)
    expect(second.messages[0]?.body).toBe('İkinci')

    // Okundu bilgisi: Bob sohbeti açtığında Alice'in mesajları "okundu" olur.
    world.tick(500)
    await bob.get(`/messages/${conversation}`)

    const alicePoll = await poll(alice, `conversation=${conversation}&read=1`)
    expect(alicePoll.reads[second.messages[0]?.id as string]).toBe(true)
  })

  test('üye olmayan kullanıcı yoklama ucuna erişemez', async () => {    const conversation = await openChat(alice, 'bobby')
    const res = await carol.get(`/api/dm/thread?conversation=${conversation}`)
    expect(res.status).toBe(403)
  })

  test('girişsiz yoklama reddedilir', async () => {
    const res = await world.app.request('/api/dm/thread?conversation=x')
    expect(res.status).toBe(401)
  })
})
