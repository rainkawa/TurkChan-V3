/**
 * Image validation and metadata stripping (US-015).
 * - Validates actual file signatures (magic bytes), never trusting extension.
 * - Strips metadata: JPEG APPn/COM segments (EXIF incl. GPS lives in APP1),
 *   PNG ancillary text/eXIf chunks, WebP EXIF/XMP chunks.
 * Pure JS so there is no native-image-library attack surface.
 */

export type ImageType = 'jpeg' | 'png' | 'webp'

export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return 'png'
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp'
  return null
}

export function mimeForImageType(type: ImageType): string {
  return type === 'jpeg' ? 'image/jpeg' : type === 'png' ? 'image/png' : 'image/webp'
}

/** En büyük kabul edilen kenar boyutu (decompression bomb koruması). */
export const MAX_IMAGE_EDGE = 8192
export const MAX_IMAGE_PIXELS = 40_000_000 // ~8000x5000

/**
 * Görselin piksel boyutunu başlık bloğundan okur; pikselleri çözmez.
 *
 *  - JPEG: SOFn işareti (0xC0..0xCF, 0xC4/C8/CC hariç)
 *  - PNG:  IHDR genişlik/yükseklik
 *  - WebP: VP8/VP8L/VP8X başlıkları
 *
 * Boyut sınırı, küçük dosya boyutlu ama devasa açılan görsellerin (decompression
 * bomb) bellek ve CPU tüketmesini engeller.
 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const type = detectImageType(bytes)
  if (type === 'jpeg') return jpegDimensions(bytes)
  if (type === 'png') {
    if (bytes.length < 24) return null
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (type === 'webp') return webpDimensions(bytes)
  return null
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  let offset = 2
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1] as number
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xda || marker === 0xd9) return null // SOS/EOI: boyut yok
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)
    const isSof =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 && // DHT
      marker !== 0xc8 && // JPG
      marker !== 0xcc // DAC
    if (isSof) {
      if (offset + 9 > bytes.length) return null
      return {
        height: ((bytes[offset + 5] as number) << 8) | (bytes[offset + 6] as number),
        width: ((bytes[offset + 7] as number) << 8) | (bytes[offset + 8] as number),
      }
    }
    offset += 2 + length
  }
  return null
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const chunk = String.fromCharCode(
    bytes[12] as number, bytes[13] as number, bytes[14] as number, bytes[15] as number,
  )
  if (chunk === 'VP8 ') {
    // Kayıpsız değil, temel VP8: 14 baytlık başlıktan sonra 3 boyut baytı.
    if (bytes.length < 30) return null
    return {
      width: ((bytes[26] as number) | ((bytes[27] as number) << 8)) & 0x3fff,
      height: ((bytes[28] as number) | ((bytes[29] as number) << 8)) & 0x3fff,
    }
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25) return null
    const bits =
      (bytes[21] as number) | ((bytes[22] as number) << 8) | ((bytes[23] as number) << 16) | ((bytes[24] as number) << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null
    const b = (i: number) => bytes[i] as number
    const width = 1 + (b(24) | (b(25) << 8) | (b(26) << 16))
    const height = 1 + (b(27) | (b(28) << 8) | (b(29) << 16))
    return { width, height }
  }
  return null
}

/** GIF başlığından kare sayısı, piksel boyutu ve tüm karelerdeki toplam piksel. */
export function gifStats(bytes: Uint8Array): {
  width: number
  height: number
  frames: number
  pixels: number
} | null {
  if (bytes.length < 13) return null
  const width = (bytes[6] as number) | ((bytes[7] as number) << 8)
  const height = (bytes[8] as number) | ((bytes[9] as number) << 8)
  let frames = 0
  let pixels = 0
  let offset = 13
  // Global renk tablosu
  const packed = bytes[10] as number
  if (packed & 0x80) offset += 3 * (2 << ((packed & 0x07) as number))
  while (offset < bytes.length) {
    const block = bytes[offset] as number
    if (block === 0x3b) break // trailer
    if (block === 0x21) {
      offset += 2 // extension introducer + label
      offset = skipSubBlocks(bytes, offset)
      continue
    }
    if (block === 0x2c) {
      frames += 1
      pixels += width * height
      if (offset + 10 > bytes.length) break
      const localPacked = bytes[offset + 9] as number
      offset += 10
      if (localPacked & 0x80) offset += 3 * (2 << (localPacked & 0x07))
      offset += 1 // LZW minimum code size
      offset = skipSubBlocks(bytes, offset)
      continue
    }
    break
  }
  return { width, height, frames, pixels }
}

function skipSubBlocks(bytes: Uint8Array, start: number): number {
  let offset = start
  while (offset < bytes.length) {
    const size = bytes[offset] as number
    offset += 1
    if (size === 0) return offset
    offset += size
  }
  return offset
}

export function stripImageMetadata(bytes: Uint8Array): Uint8Array {
  const type = detectImageType(bytes)
  if (type === 'jpeg') return stripJpeg(bytes)
  if (type === 'png') return stripPng(bytes)
  if (type === 'webp') return stripWebp(bytes)
  throw new Error('Desteklenmeyen görsel türü')
}

function stripJpeg(bytes: Uint8Array): Uint8Array {
  const out: number[] = [0xff, 0xd8]
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break // entropy-coded data reached unexpectedly; keep rest
    const marker = bytes[offset + 1] as number
    if (marker === 0xda) {
      // Start of scan: copy the remainder verbatim.
      for (let i = offset; i < bytes.length; i++) out.push(bytes[i] as number)
      return Uint8Array.from(out)
    }
    const length = ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)
    const segmentEnd = offset + 2 + length
    if (segmentEnd > bytes.length) break
    const isMetadata =
      (marker >= 0xe1 && marker <= 0xef) || // APP1..APP15 (EXIF, XMP, GPS...)
      marker === 0xfe // COM
    // APP0 (JFIF) and everything structural is kept.
    if (!isMetadata) {
      for (let i = offset; i < segmentEnd; i++) out.push(bytes[i] as number)
    }
    offset = segmentEnd
  }
  // Malformed tail: keep whatever remains so the image still decodes.
  for (let i = offset; i < bytes.length; i++) out.push(bytes[i] as number)
  return Uint8Array.from(out)
}

const PNG_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'gAMA', 'sRGB', 'pHYs'])

function stripPng(bytes: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < 8; i++) out.push(bytes[i] as number)
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length =
      ((bytes[offset] as number) << 24) | ((bytes[offset + 1] as number) << 16) |
      ((bytes[offset + 2] as number) << 8) | (bytes[offset + 3] as number)
    const chunkType = String.fromCharCode(
      bytes[offset + 4] as number, bytes[offset + 5] as number,
      bytes[offset + 6] as number, bytes[offset + 7] as number,
    )
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) break
    if (PNG_CRITICAL.has(chunkType)) {
      for (let i = offset; i < chunkEnd; i++) out.push(bytes[i] as number)
    }
    offset = chunkEnd
    if (chunkType === 'IEND') break
  }
  return Uint8Array.from(out)
}

const WEBP_METADATA_CHUNKS = new Set(['EXIF', 'XMP '])

function stripWebp(bytes: Uint8Array): Uint8Array {
  const chunks: number[][] = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const fourcc = String.fromCharCode(
      bytes[offset] as number, bytes[offset + 1] as number,
      bytes[offset + 2] as number, bytes[offset + 3] as number,
    )
    const length =
      (bytes[offset + 4] as number) | ((bytes[offset + 5] as number) << 8) |
      ((bytes[offset + 6] as number) << 16) | ((bytes[offset + 7] as number) << 24)
    const padded = length + (length % 2)
    const chunkEnd = Math.min(offset + 8 + padded, bytes.length)
    if (!WEBP_METADATA_CHUNKS.has(fourcc)) {
      const chunk: number[] = []
      for (let i = offset; i < chunkEnd; i++) chunk.push(bytes[i] as number)
      chunks.push(chunk)
    }
    offset = chunkEnd
  }
  const body = chunks.flat()
  const out = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, ...body]
  const riffSize = out.length - 8
  out[4] = riffSize & 0xff
  out[5] = (riffSize >> 8) & 0xff
  out[6] = (riffSize >> 16) & 0xff
  out[7] = (riffSize >> 24) & 0xff
  return Uint8Array.from(out)
}
