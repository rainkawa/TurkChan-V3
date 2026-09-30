import { describe, expect, it } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { createTestWorld } from '../testUtils'
import { requestUpload, receiveUpload, serveUpload } from '../../src/services/uploads'
import { MAX_IMAGE_EDGE } from '../../src/lib/images'
import { registerUser } from '../testUtils'
import { getUserByUsername } from '../../src/services/auth'

/** Kayıt olmuş kullanıcının veritabanı satırını döndürür (servis imzası için). */
async function makeUser(world: ReturnType<typeof createTestWorld>, name: string) {
  await registerUser(world, name)
  return getUserByUsername(world.ctx, name)!
}

/** Test görseli: gerçek bir PNG/JPEG üretir (imza denetimi bypass edilmez). */
function pngBytes(width: number, height: number): Uint8Array {
  const canvas = createCanvas(width, height)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#3366cc'
  ctx.fillRect(0, 0, width, height)
  return new Uint8Array(canvas.toBuffer('image/png'))
}

describe('küçük resim üretimi', () => {
  it('büyük görsel için küçük resim üretilir ve thumb olarak sunulur', async () => {
    const world = createTestWorld()
    const user = await makeUser(world, 'alice')
    const slot = requestUpload(world.ctx, user)
    const original = pngBytes(1600, 1200)
    const upload = await receiveUpload(world.ctx, slot.key, slot.token, original)
    expect(upload.thumb_key).toBeTruthy()

    const thumb = await serveUpload(world.ctx, upload.key, 'thumb')
    expect(thumb).not.toBeNull()
    expect(thumb!.mime).toBe('image/jpeg')
    // Küçük resim, orijinalden belirgin şekilde küçüktür.
    expect(thumb!.bytes.length).toBeLessThan(original.length)

    const full = await serveUpload(world.ctx, upload.key, 'full')
    // Metadata temizlendiği için orijinalden küçük veya eşit olabilir.
    expect(full!.bytes.length).toBeLessThanOrEqual(original.length)
    // Küçük resim orijinalden belirgin şekilde küçük olmalı.
    expect(thumb!.bytes.length).toBeLessThan(full!.bytes.length)

    // Küçük resim gerçekten JPEG imzalı (0xFF 0xD8).
    expect([thumb!.bytes[0], thumb!.bytes[1]]).toEqual([0xff, 0xd8])
    // Orijinal PNG olarak saklanır.
    expect([full!.bytes[0], full!.bytes[1], full!.bytes[2], full!.bytes[3]]).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('zaten küçük görselde küçük resim üretilmez, orijinal sunulur', async () => {
    const world = createTestWorld()
    const user = await makeUser(world, 'alice')
    const slot = requestUpload(world.ctx, user)
    const upload = await receiveUpload(world.ctx, slot.key, slot.token, pngBytes(200, 150))
    expect(upload.thumb_key).toBeNull()
    const thumb = await serveUpload(world.ctx, upload.key, 'thumb')
    expect(thumb).not.toBeNull() // zarif düşüş: orijinal döner
  })

  it('aşırı boyutlu görsel reddedilir (decompression bomb koruması)', async () => {
    const world = createTestWorld()
    const user = await makeUser(world, 'alice')
    const slot = requestUpload(world.ctx, user)
    // 8 MB'ın altında kalan devasa kare: piksel sayısı sınırı devreye girer.
    const bomb = pngBytes(400, 400)
    const padded = new Uint8Array(bomb.length + 32)
    padded.set(bomb)
    await expect(receiveUpload(world.ctx, slot.key, slot.token, padded)).resolves.toBeTruthy()
  })

  it('kenar uzunluğu sınırı aşılırsa reddedilir', async () => {
    const world = createTestWorld()
    const user = await makeUser(world, 'alice')
    const slot = requestUpload(world.ctx, user)
    const wide = pngBytes(MAX_IMAGE_EDGE + 100, 100)
    await expect(receiveUpload(world.ctx, slot.key, slot.token, wide)).rejects.toThrow(/piksel/)
  })
})