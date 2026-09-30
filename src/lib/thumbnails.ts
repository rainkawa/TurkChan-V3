/**
 * Küçük resim (thumbnail) üretimi.
 *
 * Akış görseli yüklendiğinde sunucuda en uzun kenarı `MAX_EDGE` olan bir
 * JPEG türetilir; akış küçük resimleri kullanır, tam boyutlu dosya yalnızca
 * kullanıcı görsele tıkladığında indirilir. Bu hem hızlı akış hem de bant
 * genişliği tasarrufu sağlar.
 *
 * `@napi-rs/canvas` yerel bir modüldür ve üretimde kurulamayabilir. Bu
 * yüzden üretim **zarif biçimde düşer**: küçük resim üretilemezse görsel
 * olduğu gibi sunulur, yükleme asla başarısız olmaz.
 */
import { createRequire } from 'node:module'

/** Küçük resmin en uzun kenarı (piksel). */
export const MAX_EDGE = 640
const QUALITY = 72

type CanvasModule = {
  createCanvas: (w: number, h: number) => {
    getContext: (t: '2d') => { drawImage: (...a: unknown[]) => void; fillStyle: string; fillRect: (...a: number[]) => void }
    toBuffer: (mime: string, quality?: number) => Buffer
  }
  loadImage: (data: Buffer | Uint8Array) => Promise<{ width: number; height: number }>
}

let canvasPromise: Promise<CanvasModule | null> | null = null

async function loadCanvas(): Promise<CanvasModule | null> {
  if (!canvasPromise) {
    canvasPromise = (async () => {
      try {
        const require = createRequire(import.meta.url)
        return require('@napi-rs/canvas') as CanvasModule
      } catch {
        // Modül yoksa küçük resim üretimi kapalı; çağıran taraf bunu bilir.
        return null
      }
    })()
  }
  return canvasPromise
}

export interface ThumbnailResult {
  bytes: Buffer
  width: number
  height: number
}

/**
 * Görselin küçük resmini üretir.
 *
 * @returns `null` — görsel zaten küçükse, kütüphane yoksa veya çözme
 * başarısızsa. Çağıran taraf bu durumda orijinali kullanmalıdır.
 */
export async function makeThumbnail(bytes: Uint8Array): Promise<ThumbnailResult | null> {
  const canvas = await loadCanvas()
  if (!canvas) return null
  try {
    const image = await canvas.loadImage(bytes)
    const { width, height } = image
    if (width <= 0 || height <= 0) return null
    // Zaten küçükse yeniden kodlama yapmaz (kalite kaybı ve zaman kaybı olmaz).
    if (width <= MAX_EDGE && height <= MAX_EDGE) return null
    const scale = MAX_EDGE / Math.max(width, height)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const surface = canvas.createCanvas(w, h)
    const ctx = surface.getContext('2d')
    // Şeffaf arka planı beyaza düzleştir: JPEG alfa desteklemez.
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(image, 0, 0, w, h)
    const out = surface.toBuffer('image/jpeg', QUALITY)
    return { bytes: out, width: w, height: h }
  } catch {
    return null
  }
}