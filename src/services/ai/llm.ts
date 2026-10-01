/**
 * OpenAI uyumlu sohbet tamamlama istemcisi — AI karakterlerinin METNİNİ
 * gerçekten modele yazdırdığı yer.
 *
 * Neden şablon yetmiyor: hazır cümleleri birleştirmek "Merhaba, kararsızlık
 * konusunda deneyimimi paylaşmak istiyorum. Farklı görüşlerinizi de merak
 * ediyorum." gibi konuyla ilgisi olmayan, insanın yazmayacağı gönderiler
 * üretiyor. Model, okuduğu içeriğe ve karakterin kişiliğine göre yazar.
 *
 * Tasarım kuralları:
 *   - Uç nokta sağlayıcıdan bağımsızdır (AI_LLM_BASE_URL + AI_LLM_MODEL);
 *     anahtar yoksa motor sessizce şablon moda düşer.
 *   - Ağ erişimi ctx.fetchFn üzerinden gider → testler gerçek HTTP çağrısı
 *     yapmadan yanıtı taklit edebilir.
 *   - Hata asla fırlatmaz; çağıran taraf "üretilemedi" diye geri düşer.
 */
import type { Ctx } from '../../context'

export interface ChatOptions {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

/** Model cevabını temizler: tırnak, kod bloğu, fazla boşluk. */
function clean(text: string): string {
  return text
    .replace(/```[a-z]*\n?/giu, '')
    .replace(/^\s*["“”']+/u, '')
    .replace(/["“”']+\s*$/u, '')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * Tek bir sohbet tamamlama isteği yapar.
 *
 * @returns Modelin yazdığı metin veya null (yapılandırılmamış/hata/timeout).
 */
export async function chatCompletion(ctx: Ctx, options: ChatOptions): Promise<string | null> {
  const { aiLlmApiKey, aiLlmBaseUrl, aiLlmModel, aiLlmTimeoutMs } = ctx.config
  if (!aiLlmApiKey) return null

  try {
    const response = await ctx.fetchFn(`${aiLlmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${aiLlmApiKey}`,
      },
      body: JSON.stringify({
        model: aiLlmModel,
        messages: [
          { role: 'system', content: options.system },
          { role: 'user', content: options.user },
        ],
        temperature: options.temperature ?? 0.8,
        max_tokens: options.maxTokens ?? 400,
      }),
      signal: AbortSignal.timeout(aiLlmTimeoutMs),
    } as RequestInit)

    if (!response.ok) return null
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const raw = data.choices?.[0]?.message?.content
    if (typeof raw !== 'string' || raw.trim() === '') return null
    const cleaned = clean(raw)
    return cleaned === '' ? null : cleaned
  } catch {
    // Ağ hatası, timeout, 429, bozuk JSON: hepsi "üretilemedi" demektir.
    return null
  }
}

/** Metin üretimi bu kurulumda kullanılabilir mi? */
export function llmAvailable(ctx: Ctx): boolean {
  return ctx.config.aiLlmApiKey !== ''
}