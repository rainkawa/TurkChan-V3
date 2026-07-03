import { describe, expect, test } from 'vitest'
import { detectImageType, stripImageMetadata, mimeForImageType } from '../../src/lib/images'

/** Minimal valid-enough JPEG: SOI, APP0(JFIF), APP1(EXIF w/ GPS marker bytes), SOS, EOI. */
function makeJpegWithExif(): Uint8Array {
  const soi = [0xff, 0xd8]
  const app0Payload = [0x4a, 0x46, 0x49, 0x46, 0x00] // "JFIF\0"
  const app0 = [0xff, 0xe0, 0x00, app0Payload.length + 2, ...app0Payload]
  const exifPayload = Array.from(Buffer.from('Exif\0\0GPS-SECRET-LOCATION'))
  const app1 = [0xff, 0xe1, 0x00, exifPayload.length + 2, ...exifPayload]
  const comPayload = Array.from(Buffer.from('secret comment'))
  const com = [0xff, 0xfe, 0x00, comPayload.length + 2, ...comPayload]
  const sos = [0xff, 0xda, 0x00, 0x04, 0x01, 0x02, 0xaa, 0xbb, 0xcc]
  const eoi = [0xff, 0xd9]
  return Uint8Array.from([...soi, ...app0, ...app1, ...com, ...sos, ...eoi])
}

function pngChunk(type: string, payload: number[]): number[] {
  const len = payload.length
  return [
    (len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...Array.from(type).map((ch) => ch.charCodeAt(0)),
    ...payload,
    0, 0, 0, 0, // fake CRC (parser does not validate)
  ]
}

function makePngWithMetadata(): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  return Uint8Array.from([
    ...signature,
    ...pngChunk('IHDR', new Array(13).fill(1)),
    ...pngChunk('eXIf', Array.from(Buffer.from('GPS-DATA-HERE'))),
    ...pngChunk('tEXt', Array.from(Buffer.from('Author\0secret'))),
    ...pngChunk('IDAT', [1, 2, 3, 4]),
    ...pngChunk('IEND', []),
  ])
}

function webpChunk(fourcc: string, payload: number[]): number[] {
  const len = payload.length
  const padded = len % 2 === 1 ? [...payload, 0] : payload
  return [
    ...Array.from(fourcc).map((ch) => ch.charCodeAt(0)),
    len & 0xff, (len >> 8) & 0xff, (len >> 16) & 0xff, (len >> 24) & 0xff,
    ...padded,
  ]
}

function makeWebpWithExif(): Uint8Array {
  const body = [
    ...webpChunk('VP8 ', [1, 2, 3, 4, 5, 6]),
    ...webpChunk('EXIF', Array.from(Buffer.from('GPS-COORDS'))),
    ...webpChunk('XMP ', Array.from(Buffer.from('<xmp>secret</xmp>'))),
  ]
  const size = body.length + 4
  return Uint8Array.from([
    0x52, 0x49, 0x46, 0x46,
    size & 0xff, (size >> 8) & 0xff, (size >> 16) & 0xff, (size >> 24) & 0xff,
    0x57, 0x45, 0x42, 0x50,
    ...body,
  ])
}

describe('detectImageType (US-015: real signature, not extension)', () => {
  test('detects jpeg/png/webp by magic bytes', () => {
    expect(detectImageType(makeJpegWithExif())).toBe('jpeg')
    expect(detectImageType(makePngWithMetadata())).toBe('png')
    expect(detectImageType(makeWebpWithExif())).toBe('webp')
  })

  test('rejects non-images regardless of claimed extension', () => {
    expect(detectImageType(Uint8Array.from(Buffer.from('GIF89a....')))).toBeNull()
    expect(detectImageType(Uint8Array.from(Buffer.from('<html></html>')))).toBeNull()
    expect(detectImageType(Uint8Array.from(Buffer.from('%PDF-1.4')))).toBeNull()
    expect(detectImageType(new Uint8Array(0))).toBeNull()
  })

  test('mime mapping', () => {
    expect(mimeForImageType('jpeg')).toBe('image/jpeg')
    expect(mimeForImageType('png')).toBe('image/png')
    expect(mimeForImageType('webp')).toBe('image/webp')
  })
})

describe('stripImageMetadata (EXIF incl. GPS removed, US-015)', () => {
  test('JPEG: strips APP1/COM, keeps image data', () => {
    const stripped = Buffer.from(stripImageMetadata(makeJpegWithExif()))
    expect(stripped.includes(Buffer.from('GPS-SECRET-LOCATION'))).toBe(false)
    expect(stripped.includes(Buffer.from('secret comment'))).toBe(false)
    expect(stripped.includes(Buffer.from('JFIF'))).toBe(true) // structural APP0 kept
    expect(stripped[0]).toBe(0xff)
    expect(stripped[1]).toBe(0xd8)
    expect(stripped.includes(Buffer.from([0xaa, 0xbb, 0xcc]))).toBe(true) // scan data kept
    expect(detectImageType(stripped)).toBe('jpeg')
  })

  test('PNG: strips eXIf/tEXt, keeps critical chunks', () => {
    const stripped = Buffer.from(stripImageMetadata(makePngWithMetadata()))
    expect(stripped.includes(Buffer.from('GPS-DATA-HERE'))).toBe(false)
    expect(stripped.includes(Buffer.from('secret'))).toBe(false)
    expect(stripped.includes(Buffer.from('IDAT'))).toBe(true)
    expect(stripped.includes(Buffer.from('IEND'))).toBe(true)
    expect(detectImageType(stripped)).toBe('png')
  })

  test('WebP: strips EXIF/XMP chunks, keeps image chunk, fixes RIFF size', () => {
    const stripped = Buffer.from(stripImageMetadata(makeWebpWithExif()))
    expect(stripped.includes(Buffer.from('GPS-COORDS'))).toBe(false)
    expect(stripped.includes(Buffer.from('secret'))).toBe(false)
    expect(stripped.includes(Buffer.from('VP8 '))).toBe(true)
    expect(detectImageType(stripped)).toBe('webp')
    const riffSize = stripped.readUInt32LE(4)
    expect(riffSize).toBe(stripped.length - 8)
  })

  test('throws for unsupported input', () => {
    expect(() => stripImageMetadata(Uint8Array.from(Buffer.from('nope')))).toThrow()
  })
})
