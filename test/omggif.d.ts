/**
 * `omggif` paketinde tip tanımı yok; testlerde kullandığımız okuyucu için
 * minimal bir bildirim. Yazma tarafı (GifWriter) yalnızca üretim script'inde
 * kullanılıyor ve script JS olduğu için tip kontrolüne girmiyor.
 */
declare module 'omggif' {
  export interface GifFrameInfo {
    delay: number
    disposal: number
    transparent?: number
  }

  export class GifReader {
    constructor(buf: Uint8Array)
    readonly width: number
    readonly height: number
    numFrames(): number
    loopCount(): number
    frameInfo(index: number): GifFrameInfo
    decodeAndBlitFrameRGBA(frame: number, pixels: Uint8Array): void
  }
}
