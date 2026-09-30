import { describe, expect, it } from 'vitest'
import { createCommunityVia, createPostVia, createTestWorld, registerUser } from '../testUtils'
import { parseReferenceNumbers, repliesTo, referencesOut } from '../../src/services/references'

describe('>>12345 gönderi referansları', () => {
  it('gönderi numaraları topluluk içinde 1’den başlar ve artar', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'referans')
    const first = await createPostVia(agent, 'referans', 'birinci', 'gövde')
    const second = await createPostVia(agent, 'referans', 'ikinci', 'gövde')
    const n1 = (world.ctx.db.prepare('SELECT number FROM posts WHERE id = ?').get(first) as { number: number }).number
    const n2 = (world.ctx.db.prepare('SELECT number FROM posts WHERE id = ?').get(second) as { number: number }).number
    expect(n1).toBe(1)
    expect(n2).toBe(2)
  })

  it('referans bağlantıya dönüşür ve hedef gönderiye gider', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'referans')
    const first = await createPostVia(agent, 'referans', 'ilk gonderi', 'gövde')
    await createPostVia(agent, 'referans', 'cevaplayan', '>>1 mesajım bu yazıya cevap veriyor')

    // Ana akış kartında gövde markdown olarak çizilir ve referans bağlantıya dönüşür.
    const html = await (await agent.get('/')).text()
    expect(html).toContain('class="post-ref"')
    expect(html).toContain(`/p/${first}`)
    // Detay sayfasında da bağlantı görünür.
    const detail = await (await agent.get(`/c/referans/comments/${first}`)).text()
    expect(detail).toContain('class="post-ref"')
  })

  it('tanınmayan numara düz metin kalır (uydurma bağlantı üretilmez)', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'referans')
    const post = await createPostVia(agent, 'referans', 'uydurma', '>>9999 olmayan bir gonderi')
    const html = await (await agent.get(`/c/referans/comments/${post}`)).text()
    expect(html).not.toContain('class="post-ref"')
    // Numara düz metin olarak korunur.
    expect(html).toContain('&gt;&gt;9999')
  })

  it('backlink listesi oluşur ("bu gönderiye cevap verenler")', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'referans')
    const first = await createPostVia(agent, 'referans', 'ilk gonderi', 'gövde')
    await createPostVia(agent, 'referans', 'cevaplayan', '>>1 cevabım')

    // Referans yazıldığı anda (sayfa görüntülenmeden) kaydedilmiş olmalı.
    const inbound = repliesTo(world.ctx, first)
    expect(inbound.length).toBe(1)
    expect(inbound[0]!.title).toBe('cevaplayan')
  })

  it('ileri referanslar gönderinin kendi sayfasında listelenir', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'referans')
    const first = await createPostVia(agent, 'referans', 'ilk gonderi', 'gövde')
    const second = await createPostVia(agent, 'referans', 'cevaplayan', '>>1 cevabım')
    const out = referencesOut(world.ctx, second)
    expect(out.map((r) => r.id)).toEqual([first])

    const html = await (await agent.get(`/c/referans/comments/${second}`)).text()
    expect(html).toContain('Referans verilen gönderiler')
    // Hedef gönderide ise geri bağlantı listelenir.
    const targetHtml = await (await agent.get(`/c/referans/comments/${first}`)).text()
    expect(targetHtml).toContain('Bu gönderiye cevap verenler')
  })

  it('başka topluluğun gönderi numarası çözülmez (numara sızıntısı yok)', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'birinci')
    await createCommunityVia(agent, 'ikinci')
    // "birinci"de iki gönderi: numaralar 1 ve 2.
    await createPostVia(agent, 'birinci', 'gizli hedef', 'gövde')
    await createPostVia(agent, 'birinci', 'ikinci gonderi', 'gövde')
    // "ikinci"de tek gönderi (numarası 1). >>2 yalnızca "birinci"de var.
    await createPostVia(agent, 'ikinci', 'saldirgan', '>>2 dogrudan birinci topluluk')

    const rows = world.ctx.db
      .prepare('SELECT COUNT(*) AS n FROM post_references')
      .get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('XSS yükü referans olarak ayrıştırılmaz', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'referans')
    await createPostVia(agent, 'referans', 'ilk gonderi', 'gövde')
    const saldirgi = await createPostVia(agent, 'referans', 'saldirgi', '>>1"><script>alert(1)</script>')
    const html = await (await agent.get(`/c/referans/comments/${saldirgi}`)).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('referans numarası güvenli biçimde ayrıştırılır', () => {
    expect(parseReferenceNumbers('>>1 ve >>2 ve >>2')).toEqual([1, 2])
    expect(parseReferenceNumbers('0 ve >>0')).toEqual([])
    expect(parseReferenceNumbers('>>99999999999999')).toEqual([])
    expect(parseReferenceNumbers(null)).toEqual([])
    expect(parseReferenceNumbers('>>-1')).toEqual([])
  })

  it('gönderi düzenlendiğinde referanslar yeniden hesaplanır', async () => {
    const world = createTestWorld()
    const { agent } = await registerUser(world, 'alice')
    await createCommunityVia(agent, 'referans')
    const first = await createPostVia(agent, 'referans', 'ilk gonderi', 'gövde')
    const second = await createPostVia(agent, 'referans', 'cevaplayan', '>>1 cevabım')
    expect(repliesTo(world.ctx, first).length).toBe(1)

    // Referans kaldırılır.
    await agent.post(`/posts/${second}/edit`, { body: 'artık referans yok' })
    expect(repliesTo(world.ctx, first).length).toBe(0)
  })
})