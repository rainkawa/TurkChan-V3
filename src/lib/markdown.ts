import MarkdownIt from 'markdown-it'

/** markdown-it iç state tipleri için asgari yapı. */
interface InlineState {
  pos: number
  src: string
  env: unknown
  push(type: string, tag: string, nesting: number): {
    attrSet(name: string, value: string): void
    content: string
  }
}

/**
 * Sanitised-by-construction Markdown: raw HTML is disabled entirely (html:false
 * escapes it), so no script execution or HTML injection is possible. Links get
 * rel="nofollow noopener" per US-013.
 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
})

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!
  token.attrSet('rel', 'nofollow noopener')
  const href = token.attrGet('href') ?? ''
  if (!isSafeHref(href)) token.attrSet('href', '#')
  return defaultLinkOpen(tokens, idx, options, env, self)
}

function isSafeHref(href: string): boolean {
  const trimmed = href.trim().toLowerCase()
  // Dahili (göreli) bağlantılar her zaman güvenlidir.
  if (trimmed.startsWith('/') || trimmed.startsWith('#')) return true
  return !trimmed.startsWith('javascript:') && !trimmed.startsWith('data:') && !trimmed.startsWith('vbscript:')
}

/**
 * @kullanıcı bahsi → profil bağlantısı.
 *
 * Yalnızca gerçekten bahsi bulunan kullanıcı adları bağlantıya dönüşür; rastgele
 * bir "@metin" tıklanabilir olmaz. Böylece yorumlar spam bağlantısı deposuna
 * dönüşmez. Kural `code_inline`/`fence` gibi kod token'larından sonra çalıştığı
 * için kod blokları içindeki @metinler dokunulmadan kalır.
 */
function mentionPlugin(mdInstance: MarkdownIt): void {
  mdInstance.inline.ruler.before('link', 'mention', (state: InlineState, silent: boolean): boolean => {
    const start = state.pos
    if (state.src.charCodeAt(start) !== 0x40 /* @ */) return false
    // @ işaretinin hemen önünde harf/rakam/alt çizgi varsa bu bir bahis değil
    // (örn. e-posta adresi).
    if (start > 0 && /[\w]/.test(state.src.charAt(start - 1))) return false

    const allowed: Set<string> = (state.env as { mentions?: Set<string> }).mentions ?? new Set()
    const match = /^@([A-Za-z0-9_]{2,20})/.exec(state.src.slice(start))
    const name = match?.[1]
    if (!name || !allowed.has(name.toLowerCase())) return false

    if (!silent) {
      const open = state.push('link_open', 'a', 1)
      open.attrSet('href', `/tc/${encodeURIComponent(name)}`)
      open.attrSet('class', 'mention')
      open.attrSet('rel', 'nofollow noopener')
      const text = state.push('text', '', 0)
      text.content = `@${name}`
      state.push('link_close', 'a', -1)
    }
    state.pos += (match?.[0].length ?? 0)
    return true
  })
}

/**
 * `>>123` gönderi referansı.
 *
 * Yalnızca numara → gönderi kimliği eşlemesi `env.refs` içinde VERİLMİŞSE
 * bağlantıya dönüşür. Eşleşme sunucuda aynı topluluk içinde çözülür; tanınmayan
 * numara (`>>9999`) düz metin olarak kalır — uydurma bağlantı üretilmez ve
 * başka topluluğun gönderi numarası sızmaz.
 */
function referencePlugin(mdInstance: MarkdownIt): void {
  mdInstance.inline.ruler.before('link', 'postref', (state: InlineState, silent: boolean): boolean => {
    const rest = state.src.slice(state.pos)
    // İki olası biçim:
    //  1) satır içi `>>123`
    //  2) satır başı `>>123` — blok alıntısına karışmasın diye başına görünmez
    //     sıfır genişlikli boşluk eklenir (bkz. protectLeadingReferences).
    const match = /^>>(\d+)/.exec(rest) ?? /^\u200B>>(\d+)/.exec(rest)
    if (!match) return false
    const refs: Map<number, string> =
      (state.env as { refs?: Map<number, string> }).refs ?? new Map()
    const number = Number(match[1])
    if (!Number.isSafeInteger(number) || number <= 0) return false
    const target = refs.get(number)
    if (!target) return false

    if (!silent) {
      const open = state.push('link_open', 'a', 1)
      open.attrSet('href', `/p/${encodeURIComponent(target)}`)
      open.attrSet('class', 'post-ref')
      open.attrSet('rel', 'nofollow noopener')
      open.attrSet('data-post-number', String(number))
      const text = state.push('text', '', 0)
      text.content = `>>${number}`
      state.push('link_close', 'a', -1)
    }
    state.pos += match[0].length
    return true
  })
}

mentionPlugin(md)
referencePlugin(md)

/**
 * Markdown → HTML.
 *
 * `mentions` verildiğinde yalnızca o kullanıcı adları bağlantıya dönüşür.
 * Ham HTML üretilmediği için çıktı her zaman güvenlidir.
 */
export function renderMarkdown(
  source: string,
  mentions?: string[],
  refs?: Map<number, string>,
): string {
  const env: { mentions?: Set<string>; refs?: Map<number, string> } = {}
  if (mentions && mentions.length > 0) env.mentions = new Set(mentions.map((m) => m.toLowerCase()))
  if (refs && refs.size > 0) env.refs = refs
  // Koruma amaçlı eklenen sıfır genişlikli boşluklar çıktıdan temizlenir.
  return md.render(protectLeadingReferences(source), env).replaceAll('\u200B', '')
}

/**
 * Satır başındaki `>>123` ifadesi markdown'da iç içe blok alıntısı olarak
 * yorumlanır ve referanstan düşer. Başa görünmez bir sıfır genişlikli boşluk
 * eklenir: alıntı ayrıştırıcısı devreye girmez, referans eklentisi yine
 * eşleşir ve boşluk ekranda görünmez.
 */
function protectLeadingReferences(source: string): string {
  return source.replace(/^([ \t]*)>>(\d+)/gm, '$1\u200B>>$2')
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
