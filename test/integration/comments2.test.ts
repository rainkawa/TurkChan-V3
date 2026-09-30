/**
 * Yorum sistemi: medya (görsel/GIF/video), spoiler, @mention bildirimi,
 * anonim yorum, gizlilik, yönetim paneli ve raporlama.
 *
 * Her özellik hem HTTP üzerinden (rota + görünüm) hem de veritabanı üzerinden
 * doğrulanır; böylece "HTML doğru görünüyor ama veri yanlış" durumu yakalanır.
 */
import { beforeEach, describe, expect, test } from 'vitest'
import {
  Agent,
  createCommentVia,
  createCommentWithFilesVia,
  createCommunityVia,
  createPostVia,
  createTestWorld,
  registerAdmin,
  registerUser,
  type TestWorld,
} from '../testUtils'
import { createComment } from '../../src/services/comments'
import { requestUpload, receiveUpload } from '../../src/services/uploads'
import type { UserRow } from '../../src/types'

let world: TestWorld

beforeEach(() => {
  world = createTestWorld()
})

function tinyJpeg(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0x99, 0x88, 0xff, 0xd9])
}
function tinyGif(): Uint8Array {
  return Uint8Array.from(Buffer.concat([
    Buffer.from('GIF89a'),
    Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff]),
  ]))
}
function tinyMp4(): Uint8Array {
  return Uint8Array.from(Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypisom'),
    Buffer.from([0x00, 0x00, 0x02, 0x00, 0x69, 0x73, 0x6f, 0x6d]),
  ]))
}

/** multipart yorum gönderir ve yanıtı döndürür. */
async function commentWithFiles(
  agent: Agent,
  community: string,
  postId: string,
  body: string,
  files: Array<{ name: string; bytes: Uint8Array; mime: string }>,
  extra: Record<string, string> = {},
): Promise<Response> {
  return createCommentWithFilesVia(
    agent,
    community,
    postId,
    body,
    files.map((f) => ({ filename: f.name, contentType: f.mime, data: f.bytes })),
    extra,
  )
}

function commentIdFrom(res: Response): string {
  return (res.headers.get('location') ?? '').match(/comment\/([a-z0-9]+)/)?.[1] as string
}

/** Yorum ağacının HTML'i (sayfa başlığı/nav dışında kalan bölüm). */
async function commentTreeHtml(agent: Agent, community: string, postId: string): Promise<string> {
  const html = await (await agent.get(`/c/${community}/comments/${postId}`)).text()
  const start = html.indexOf('<div class="comment-tree">')
  if (start === -1) return ''
  const end = html.indexOf('</main>', start)
  return html.slice(start, end === -1 ? undefined : end)
}

async function setup(community = 'talk') {
  const { agent: mod } = await registerUser(world)
  await createCommunityVia(mod, community)
  const { agent: alice, username: aliceName } = await registerUser(world, 'alice')
  const { agent: bob, username: bobName } = await registerUser(world, 'bobby')
  const postId = await createPostVia(mod, community, 'Tartışma', 'Buradan başlayalım')
  // Servis düzeyi doğrulamalar için ham kullanıcı satırları.
  const userRow = (username: string) =>
    world.ctx.db.prepare('SELECT * FROM users WHERE username_lower = ?').get(username.toLowerCase()) as unknown as UserRow
  return {
    mod,
    alice,
    bob,
    aliceRow: userRow(aliceName),
    bobRow: userRow(bobName),
    aliceName,
    bobName,
    postId,
    community,
  }
}

/* -------------------------------------------------------------------------- */

describe('yorumlara medya ekleme', () => {
  test('görsel, GIF ve video yoruma eklenir ve galeri çizilir', async () => {
    const { alice, postId } = await setup('medyali')
    const id = commentIdFrom(
      await commentWithFiles(alice, 'medyali', postId, 'baksan', [
        { name: 'a.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
        { name: 'b.gif', bytes: tinyGif(), mime: 'image/gif' },
        { name: 'c.mp4', bytes: tinyMp4(), mime: 'video/mp4' },
      ]),
    )
    expect(id).toBeTruthy()

    const rows = world.ctx.db
      .prepare('SELECT position, kind, mime FROM comment_media WHERE comment_id = ? ORDER BY position ASC')
      .all(id) as Array<{ position: number; kind: string; mime: string | null }>
    expect(rows.map((r) => r.kind)).toEqual(['image', 'gif', 'video'])
    expect(rows.map((r) => r.position)).toEqual([0, 1, 2])

    const page = await alice.get(`/c/medyali/comments/${postId}`)
    const html = await page.text()
    expect(html).toContain('data-gallery="3"')
    expect((html.match(/class="media-item/g) ?? []).length).toBe(3)
    // Video etiketi doğru oynatılır.
    expect(html).toContain('<video')
  })

  test('MIME istemciden değil imzadan türetilir (depolanmış XSS koruması)', async () => {
    const { alice, postId } = await setup('mimesafe')
    const id = commentIdFrom(
      await commentWithFiles(alice, 'mimesafe', postId, 'sahte mime', [
        { name: 'x.gif', bytes: tinyGif(), mime: 'text/html' },
      ]),
    )
    const row = world.ctx.db.prepare('SELECT mime FROM comment_media WHERE comment_id = ?').get(id) as { mime: string }
    expect(row.mime).toBe('image/gif')
    const served = await alice.get(`/media/${(world.ctx.db.prepare('SELECT media_key AS k FROM comment_media WHERE comment_id = ?').get(id) as { k: string }).k}`)
    expect(served.headers.get('content-type')).toBe('image/gif')
  })

  test('yazı olmadan yalnızca medya gönderilebilir', async () => {
    const { alice, postId } = await setup('medyonly')
    const res = await commentWithFiles(alice, 'medyonly', postId, '', [
      { name: 'a.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
    ])
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toContain('/comment/')
  })

  test('yorum medya sınırı (4 dosya) aşılırsa reddedilir', async () => {
    const { alice, postId } = await setup('cokmedya')
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `f${i}.jpg`,
      bytes: tinyJpeg(),
      mime: 'image/jpeg',
    }))
    const res = await commentWithFiles(alice, 'cokmedya', postId, 'çok', files)
    // Hata akışı: gönderi sayfasına geri döner, yorum yazılmaz.
    expect(res.headers.get('location')).toBe(`/c/cokmedya/comments/${postId}`)
    const count = (world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n
    expect(count).toBe(0)
  })

  test('bir yoruma birden fazla video eklenemez', async () => {
    const { alice, postId } = await setup('tekvideo')
    const res = await commentWithFiles(alice, 'tekvideo', postId, 'iki video', [
      { name: 'a.mp4', bytes: tinyMp4(), mime: 'video/mp4' },
      { name: 'b.mp4', bytes: tinyMp4(), mime: 'video/mp4' },
    ])
    expect(res.headers.get('location')).toBe(`/c/tekvideo/comments/${postId}`)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
  })

  test('başka bir hesabın yükleme anahtarı yoruma bağlanamaz (servis düzeyi)', async () => {
    const { aliceRow, bobRow, postId } = await setup('yabancidosya')
    const ctx = world.ctx
    const slot = requestUpload(ctx, aliceRow)
    await receiveUpload(ctx, slot.key, slot.token, tinyJpeg())
    // Bob, alice'in yükleme anahtarını kullanamaz.
    expect(() => createComment(ctx, bobRow, postId, { body: 'çalınan', mediaKeys: [slot.key] })).toThrow()
  })

  test('aynı yükleme anahtarı ikinci kez kullanılamaz', async () => {
    const { aliceRow, postId } = await setup('tekkullanim')
    const ctx = world.ctx
    const slot = requestUpload(ctx, aliceRow)
    await receiveUpload(ctx, slot.key, slot.token, tinyJpeg())
    createComment(ctx, aliceRow, postId, { body: 'bir', mediaKeys: [slot.key] })
    expect(() => createComment(ctx, aliceRow, postId, { body: 'iki', mediaKeys: [slot.key] })).toThrow()
  })

  test('video sınırı aşılınca yükleme alanı boşa çıkmaz (rollback)', async () => {
    const { aliceRow: user, postId } = await setup('rollback')
    const ctx = world.ctx
    const first = requestUpload(ctx, user)
    await receiveUpload(ctx, first.key, first.token, tinyJpeg())
    const second = requestUpload(ctx, user)
    await receiveUpload(ctx, second.key, second.token, tinyMp4())
    const third = requestUpload(ctx, user)
    await receiveUpload(ctx, third.key, third.token, tinyMp4())
    // İkinci video sınırı aşıyor → yorum yazılmaz.
    expect(() => createComment(ctx, user, postId, { body: 'çok video', mediaKeys: [first.key, second.key, third.key] })).toThrow()
    // Hiçbir yükleme 'attached' olmamalı: yorum oluşmadığı için alanlar boşta kalır.
    const rows = ctx.db
      .prepare('SELECT status FROM uploads WHERE key IN (?, ?, ?)')
      .all(first.key, second.key, third.key) as Array<{ status: string }>
    expect(rows.every((r) => r.status === 'uploaded')).toBe(true)
    expect((ctx.db.prepare('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0)
  })

  test('yorum silinince ekleri de temizlenir', async () => {
    const { alice, postId } = await setup('silmedya')
    const id = commentIdFrom(
      await commentWithFiles(alice, 'silmedya', postId, 'ekli', [
        { name: 'a.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
      ]),
    )
    await alice.post(`/comments/${id}/delete`)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comment_media WHERE comment_id = ?').get(id) as { n: number }).n).toBe(0)
  })

  test('yanıtlı yorum silinince ekler gizlenir (yer tutucu korunur)', async () => {
    const { alice, postId } = await setup('yanitmedya')
    const parentId = commentIdFrom(
      await commentWithFiles(alice, 'yanitmedya', postId, 'ana', [
        { name: 'a.jpg', bytes: tinyJpeg(), mime: 'image/jpeg' },
      ]),
    )
    await createCommentVia(alice, 'yanitmedya', postId, 'yanıt', parentId)
    await alice.post(`/comments/${parentId}/delete`)
    const row = world.ctx.db.prepare('SELECT deleted FROM comments WHERE id = ?').get(parentId) as { deleted: number }
    expect(row.deleted).toBe(1)
    // Ekler artık çizilmemeli.
    const html = await commentTreeHtml(alice, 'yanitmedya', postId)
    expect(html).not.toContain('media-gallery')
  })
})

/* -------------------------------------------------------------------------- */

describe('yorumda spoiler', () => {
  test('spoiler yorum gizli gövde ile çizilir ve açılabilir', async () => {
    const { alice, postId } = await setup('spoilerli')
    await createCommentVia(alice, 'spoilerli', postId, 'SONUC BİTTİ', null, { spoiler: '1' })
    const row = world.ctx.db
      .prepare("SELECT spoiler FROM comments WHERE body = 'SONUC BİTTİ'")
      .get() as { spoiler: number }
    expect(row.spoiler).toBe(1)

    const html = await commentTreeHtml(alice, 'spoilerli', postId)
    expect(html).toContain('comment-spoiler')
    expect(html).toContain('data-spoiler-toggle')
    // Gövde gizli kutu içinde durur, sayfa kaynağında düz metin olarak görünmez.
    expect(html).toMatch(/<div class="spoiler-body" hidden=/)
  })

  test('spoiler aç/kapat düğmesi ayarı değiştirir', async () => {
    const { alice, postId } = await setup('spoilertoggle')
    const id = await createCommentVia(alice, 'spoilertoggle', postId, 'gizli mi', null, { spoiler: '1' })
    await alice.post(`/comments/${id}/meta`, { spoiler: '0' })
    const row = world.ctx.db.prepare('SELECT spoiler FROM comments WHERE id = ?').get(id) as { spoiler: number }
    expect(row.spoiler).toBe(0)
    // Geri aç.
    await alice.post(`/comments/${id}/meta`, { spoiler: '1' })
    expect((world.ctx.db.prepare('SELECT spoiler FROM comments WHERE id = ?').get(id) as { spoiler: number }).spoiler).toBe(1)
  })

  test('başkasının yorumunun spoiler ayarı değiştirilemez', async () => {
    const { alice, bob, postId } = await setup('spoileryetki')
    const id = await createCommentVia(alice, 'spoileryetki', postId, 'benim')
    await bob.post(`/comments/${id}/meta`, { spoiler: '1' })
    expect((world.ctx.db.prepare('SELECT spoiler FROM comments WHERE id = ?').get(id) as { spoiler: number }).spoiler).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('yorumda @mention', () => {
  test('bahsedilen kullanıcıya bildirim gider ve bağlantı çizilir', async () => {
    const { alice, bobName, postId } = await setup('mentionli')
    const id = await createCommentVia(alice, 'mentionli', postId, `merhaba @${bobName} nasılsın`)

    const rows = world.ctx.db
      .prepare('SELECT user_id FROM comment_mentions WHERE comment_id = ?')
      .all(id) as Array<{ user_id: string }>
    expect(rows).toHaveLength(1)

    const bobUser = world.ctx.db.prepare('SELECT id FROM users WHERE username_lower = ?').get(bobName.toLowerCase()) as { id: string }
    const note = world.ctx.db
      .prepare("SELECT type, title, link FROM notifications WHERE user_id = ? AND type = 'mention'")
      .get(bobUser.id) as { type: string; title: string; link: string }
    expect(note.title).toContain(`@${bobName}`)
    expect(note.link).toBe(`/c/mentionli/comments/${postId}/comment/${id}`)

    const html = await commentTreeHtml(alice, 'mentionli', postId)
    expect(html).toContain(`href="/tc/${bobName}"`)
    expect(html).toContain('class="mention"')
  })

  test('kendine bahsetmek bildirim üretmez', async () => {
    const { alice, aliceName, postId } = await setup('selfmention')
    await createCommentVia(alice, 'selfmention', postId, `@${aliceName} kendime yazıyorum`)
    const n = (world.ctx.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE type = 'mention'").get() as { n: number }).n
    expect(n).toBe(0)
  })

  test('var olmayan kullanıcı adı bahis sayılmaz', async () => {
    const { alice, postId } = await setup('olmayanad')
    const id = await createCommentVia(alice, 'olmayanad', postId, '@boyle_bir_kisi_yok')
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comment_mentions WHERE comment_id = ?').get(id) as { n: number }).n).toBe(0)
    // Mevcut olmayan ad bağlantıya da dönüşmez.
    const html = await commentTreeHtml(alice, 'olmayanad', postId)
    expect(html).not.toContain('/tc/boyle_bir_kisi_yok')
  })

  test('düzenlemede bahisler yeniden hesaplanır', async () => {
    const { alice, bobName, postId } = await setup('mentionedit')
    const id = await createCommentVia(alice, 'mentionedit', postId, `@${bobName} selam`)
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comment_mentions WHERE comment_id = ?').get(id) as { n: number }).n).toBe(1)
    await alice.post(`/comments/${id}/edit`, { body: 'bahis kaldırıldı' })
    expect((world.ctx.db.prepare('SELECT COUNT(*) AS n FROM comment_mentions WHERE comment_id = ?').get(id) as { n: number }).n).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */

describe('anonim yorum', () => {
  test('anonim yorum 5 karakterlik karışık ad alır ve gerçek yazar sızmaz', async () => {
    const { alice, aliceName, postId } = await setup('anonim')
    const id = await createCommentVia(alice, 'anonim', postId, 'gizli yorum', null, { anonymous: '1' })
    const row = world.ctx.db
      .prepare('SELECT is_anonymous, anon_name FROM comments WHERE id = ?')
      .get(id) as { is_anonymous: number; anon_name: string }
    expect(row.is_anonymous).toBe(1)
    expect(row.anon_name).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[a-zA-Z0-9]{5}$/)

    // Gerçek hesap adı yorum ağacında hiç görünmemeli.
    const html = await commentTreeHtml(alice, 'anonim', postId)
    expect(html).not.toContain(aliceName)
    expect(html).toContain(row.anon_name as string)
    expect(html).toContain('Anonim')
  })

  test('anonim kutusu işaretlenmediğinde yazar adı görünür', async () => {
    const { alice, aliceName, postId } = await setup('normalyorum')
    await createCommentVia(alice, 'normalyorum', postId, 'adım ne')
    const html = await commentTreeHtml(alice, 'normalyorum', postId)
    expect(html).toContain(`/tc/${aliceName}`)
  })

  test('anonimlik tek tek açılıp kapatılabilir', async () => {
    const { alice, aliceName, postId } = await setup('anontoggle')
    const id = await createCommentVia(alice, 'anontoggle', postId, 'anonimden çık', null, { anonymous: '1' })
    // Kapat: gerçek yazar byline'ına döner.
    await alice.post(`/comments/${id}/meta`, { anonymous: '0' })
    let row = world.ctx.db
      .prepare('SELECT is_anonymous, anon_name FROM comments WHERE id = ?')
      .get(id) as { is_anonymous: number; anon_name: string | null }
    expect(row.is_anonymous).toBe(0)
    expect(row.anon_name).toBeNull()
    let html = await commentTreeHtml(alice, 'anontoggle', postId)
    expect(html).toContain(`/tc/${aliceName}`)

    // Tekrar aç: yeni bir anonim ad üretilir.
    await alice.post(`/comments/${id}/meta`, { anonymous: '1' })
    row = world.ctx.db
      .prepare('SELECT is_anonymous, anon_name FROM comments WHERE id = ?')
      .get(id) as { is_anonymous: number; anon_name: string | null }
    expect(row.is_anonymous).toBe(1)
    expect(row.anon_name).toMatch(/^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])[a-zA-Z0-9]{5}$/)
    html = await commentTreeHtml(alice, 'anontoggle', postId)
    expect(html).not.toContain(aliceName)
  })

  test('kullanıcının anonim varsayılanı yorum formunda işaretli gelir', async () => {
    const { alice, postId } = await setup('anondflt')
    world.ctx.db.prepare('UPDATE users SET anon_by_default = 1 WHERE username_lower = ?').run('alice')
    const html = await (await alice.get(`/c/anondflt/comments/${postId}`)).text()
    expect(html).toMatch(/name="anonymous"[^>]*checked/)
  })

  test('başkasının yorumu anonim yapılamaz', async () => {
    const { alice, bob, postId } = await setup('anonyetki')
    const id = await createCommentVia(alice, 'anonyetki', postId, 'benim yorumum')
    await bob.post(`/comments/${id}/meta`, { anonymous: '1' })
    const row = world.ctx.db.prepare('SELECT is_anonymous FROM comments WHERE id = ?').get(id) as { is_anonymous: number }
    expect(row.is_anonymous).toBe(0)
  })

  test('yönetim panelinde anonim yorumun gerçek yazarı görünür', async () => {
    world = createTestWorld()
    const admin = await registerAdmin(world)
    await createCommunityVia(admin.agent, 'anonpanel')
    const postId = await createPostVia(admin.agent, 'anonpanel', 'Gönderi', 'gövde')
    const { agent: alice, username: aliceName } = await registerUser(world, 'alice')
    const id = await createCommentVia(alice, 'anonpanel', postId, 'gizli', null, { anonymous: '1' })
    const anonName = (world.ctx.db.prepare('SELECT anon_name FROM comments WHERE id = ?').get(id) as { anon_name: string }).anon_name

    const html = await (await admin.agent.get('/admin?tab=anonymous')).text()
    expect(html).toContain('Anonim yorumlar')
    expect(html).toContain(anonName as string)
    expect(html).toContain(`/tc/${aliceName}`)
    expect(html).toContain(`/c/anonpanel/comments/${postId}/comment/${id}`)
  })

  test('sıradan üye yönetim panelindeki gerçek yazarı göremez', async () => {
    const { alice, postId } = await setup('anonizni')
    await createCommentVia(alice, 'anonizni', postId, 'gizli', null, { anonymous: '1' })
    const res = await alice.get('/admin?tab=anonymous')
    expect(res.status).toBe(403)
  })

  test('anonim yorum profil döneminde görünmez (gerçek yazar sızmaz)', async () => {
    const { alice, aliceName, postId } = await setup('anonprofil')
    await createCommentVia(alice, 'anonprofil', postId, 'PROFIL SIZINTISI', null, { anonymous: '1' })
    // Kontrol: normal yorum profil yorum sekmesinde görünür.
    await createCommentVia(alice, 'anonprofil', postId, 'GORUNUR YORUM')
    const normal = await (await alice.get(`/tc/${aliceName}?tab=comments`)).text()
    expect(normal).toContain('GORUNUR YORUM')
    // Anonim yorum sızmamalı.
    expect(normal).not.toContain('PROFIL SIZINTISI')
  })
})

/* -------------------------------------------------------------------------- */

describe('yorum raporlama', () => {
  test('yorum rapor formu açılır ve rapor kuyruğa düşer', async () => {
    const { alice, bob, postId } = await setup('rapor')
    const id = await createCommentVia(alice, 'rapor', postId, 'şüpheli yorum')

    const form = await bob.get(`/report/comment/${id}`)
    expect(form.status).toBe(200)
    expect(await form.text()).toContain('spam')

    const res = await bob.post(`/report/comment/${id}`, { reason: 'harassment', detail: 'kötüye kullanım' })
    expect(res.status).toBe(302)
    const row = world.ctx.db
      .prepare("SELECT target_type, target_id, status FROM reports WHERE target_id = ?")
      .get(id) as { target_type: string; target_id: string; status: string }
    expect(row.target_type).toBe('comment')
    expect(row.status).toBe('open')
  })

  test('yorum şikayet bağlantısı yorum sayfasında görünür', async () => {
    const { alice, bob, postId } = await setup('raporlink')
    const id = await createCommentVia(alice, 'raporlink', postId, 'yorum')
    const html = await (await bob.get(`/c/raporlink/comments/${postId}`)).text()
    expect(html).toContain(`/report/comment/${id}`)
  })
})

/* -------------------------------------------------------------------------- */

describe('yorum ağacı', () => {
  test('iç içe yanıtlar ve collapse/expand çalışır', async () => {
    const { alice, postId } = await setup('agac')
    const root = await createCommentVia(alice, 'agac', postId, 'kök yorum')
    const child = await createCommentVia(alice, 'agac', postId, 'yanıt', root)
    await createCommentVia(alice, 'agac', postId, 'yanıtın yanıtı', child)

    const html = await (await alice.get(`/c/agac/comments/${postId}`)).text()
    expect((html.match(/class="subtree"/g) ?? []).length).toBe(3)
    expect((html.match(/data-depth="/g) ?? []).length).toBe(3)
    // İç içe yorumlar görsel olarak da iç içe görünür.
    expect(html).toContain('data-depth="3"')
  })

  test('derinlik sınırı 8 ile sınırlıdır', async () => {
    const { alice, postId } = await setup('derin')
    let parent: string | undefined
    for (let i = 0; i < 12; i++) {
      parent = await createCommentVia(alice, 'derin', postId, `derinlik ${i}`, parent)
    }
    const max = (world.ctx.db.prepare('SELECT MAX(depth) AS d FROM comments').get() as { d: number }).d
    expect(max).toBe(8)
  })

  test('yorum permalinki yorumu vurgular ve bağlamını gösterir', async () => {
    const { alice, postId } = await setup('permalink')
    const root = await createCommentVia(alice, 'permalink', postId, 'ilk')
    const child = await createCommentVia(alice, 'permalink', postId, 'ikinci', root)

    const html = await (await alice.get(`/c/permalink/comments/${postId}/comment/${child}`)).text()
    expect(html).toContain('highlight')
    expect(html).toContain(`id="comment-${child}"`)
    expect(html).toContain(`href="/c/permalink/comments/${postId}/comment/${child}"`)
  })

  test('yorum düzenleme gövdeyi günceller ve düzenleme tarihini gösterir', async () => {
    const { alice, postId } = await setup('duzenle')
    const id = await createCommentVia(alice, 'duzenle', postId, 'ilk metin')
    await alice.post(`/comments/${id}/edit`, { body: 'düzeltilmiş metin' })
    const row = world.ctx.db.prepare('SELECT edited_at FROM comments WHERE id = ?').get(id) as { edited_at: number | null }
    expect(row.edited_at).not.toBeNull()
    const html = await (await alice.get(`/c/duzenle/comments/${postId}`)).text()
    expect(html).toContain('düzeltilmiş metin')
    expect(html).toContain('düzenlendi')
  })

  test('başkasının yorumu düzenlenemez veya silinemez', async () => {
    const { alice, bob, postId } = await setup('yetki')
    const id = await createCommentVia(alice, 'yetki', postId, 'alice yorumu')
    await bob.post(`/comments/${id}/edit`, { body: 'ele geçirme' })
    await bob.post(`/comments/${id}/delete`)
    const row = world.ctx.db.prepare('SELECT body, deleted FROM comments WHERE id = ?').get(id) as {
      body: string
      deleted: number
    }
    expect(row.body).toBe('alice yorumu')
    expect(row.deleted).toBe(0)
  })

  test('sıralama sekmeleri çalışır', async () => {
    const { alice, postId } = await setup('sirala')
    await createCommentVia(alice, 'sirala', postId, 'birinci')
    world.tick(60_000)
    await createCommentVia(alice, 'sirala', postId, 'ikinci')
    for (const sort of ['best', 'top', 'new']) {
      const res = await alice.get(`/c/sirala/comments/${postId}?sort=${sort}`)
      expect(res.status).toBe(200)
    }
  })
})
