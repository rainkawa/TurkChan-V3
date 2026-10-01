/**
 * İnternet araştırması (grounding) — AI karakterlerinin "araştırıp cevap
 * vermesinin" kaynağı.
 *
 * Karakter bir konuya yazmadan ya da bir yoruma cevap vermeden önce, ilgi
 * alanına uygun birkaç arama sonucu (başlık + özet) toplanır ve modele
 * bağlam olarak verilir. Böylece cevap genel klişeler yerine o konuda
 * gerçekten bilgi taşır.
 *
 * Anahtar yoksa ya da hata olursa boş dizi döner: motor yine çalışır,
 * sadece araştırmasız yazar.
 */
import type { Ctx } from '../../context'

export interface ResearchNote {
  title: string
  snippet: string
  url: string
}

/** Arama sorgusunu ilgi alanlarından türetir. */
export function buildQuery(subject: string, interests: string[]): string {
  const clean = subject.trim().slice(0, 120)
  if (interests.length === 0) return clean
  return `${clean} ${interests.slice(0, 2).join(' ')}`.trim()
}

/**
 * Konu için en alakalı birkaç sonucu getirir.
 *
 * @returns Sonuç listesi; hata veya anahtar yoksa boş dizi.
 */
export async function researchTopic(
  ctx: Ctx,
  query: string,
): Promise<ResearchNote[]> {
  const { aiSearchApiKey, aiSearchUrl, aiSearchResults } = ctx.config
  if (!aiSearchApiKey || query.trim() === '') return []

  try {
    const response = await ctx.fetchFn(aiSearchUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': aiSearchApiKey,
      },
      body: JSON.stringify({
        query,
        numResults: aiSearchResults,
        type: 'auto',
        contents: { text: { maxCharacters: 500 } },
      }),
      signal: AbortSignal.timeout(Math.min(10000, ctx.config.aiLlmTimeoutMs)),
    } as RequestInit)

    if (!response.ok) return []
    const data = (await response.json()) as {
      results?: Array<{ title?: string | null; text?: string | null; url?: string | null }>
    }
    const notes: ResearchNote[] = []
    for (const item of data.results ?? []) {
      const snippet = (item.text ?? '').replace(/\s+/gu, ' ').trim()
      if (snippet === '' && !item.title) continue
      notes.push({
        title: (item.title ?? '').trim(),
        snippet: snippet.slice(0, 600),
        url: item.url ?? '',
      })
    }
    return notes
  } catch {
    return []
  }
}

/** Araştırma sonuçlarını modele verilecek düz metne çevirir. */
export function formatNotes(notes: ResearchNote[]): string {
  return notes
    .map((n, i) => `[${i + 1}] ${n.title}\n${n.snippet}`)
    .join('\n\n')
}

/** Araştırma yapılabilir mi? */
export function searchAvailable(ctx: Ctx): boolean {
  return ctx.config.aiSearchApiKey !== ''
}