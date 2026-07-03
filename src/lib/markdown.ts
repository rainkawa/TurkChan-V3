import MarkdownIt from 'markdown-it'

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
  return !trimmed.startsWith('javascript:') && !trimmed.startsWith('data:') && !trimmed.startsWith('vbscript:')
}

export function renderMarkdown(source: string): string {
  return md.render(source)
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
