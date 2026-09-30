/**
 * Sunucu tarafı spam/tekrar koruması.
 *
 * Hız limitleri "çok hızlı" gönderimi engeller; ancak bir saldırgan sınırların
 * içinde kalarak aynı içeriği onlarca kez gönderebilir. Burada içeriğin kendisi
 * de konuşulur: aynı kullanıcının kısa bir pencerede birebir aynı içeriği
 * göndermesi engellenir.
 *
 * Bellek içi tutulur (tek düğme deployment) ve içerik KARMASI üzerinden
 * karşılaştırılır — ham içerik hiçbir yerde saklanmaz.
 */
import type { Ctx } from '../context'
import { sha256 } from './ids'
import { rateLimited } from '../services/errors'

/** Boşluk ve noktalama farkı "aynı içerik" sayılmasın diye normalleştirilir. */
function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 500)
}

/**
 * Aynı içeriğin tekrar gönderilmesini engeller.
 *
 * @param max Aynı içeriğin pencere içinde kabul edileceği azami sayı (1 = hiç tekrar).
 * @param windowMs Tekrar sayımının unutulacağı süre.
 * @returns Kaç kez daha gönderildiği (max'ı aşarsa çağıran hata fırlatır).
 * @throws AppError 429 — içerik pencere içinde fazla kez gönderildiyse.
 */
export function assertNotDuplicate(
  ctx: Ctx,
  opts: { scope: string; userId: string; content: string; max?: number; windowMs: number },
): void {
  const normalized = normalize(opts.content)
  if (normalized.length < 3) return
  const max = opts.max ?? 1
  const digest = sha256(normalized).slice(0, 32)
  const result = ctx.rateLimiter.check(`dup:${opts.scope}:${opts.userId}:${digest}`, max, opts.windowMs)
  if (!result.allowed) throw rateLimited(result.retryAfterMs)
}