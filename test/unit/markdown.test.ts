import { describe, expect, test } from 'vitest'
import { renderMarkdown, escapeHtml } from '../../src/lib/markdown'

describe('renderMarkdown (US-013 sanitisation)', () => {
  test('renders basic markdown', () => {
    const html = renderMarkdown('**bold** and *italic*\n\n- item')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<li>item</li>')
  })

  test('raw HTML is escaped, not executed', () => {
    const html = renderMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  test('links get rel="nofollow noopener"', () => {
    const html = renderMarkdown('[site](https://example.com)')
    expect(html).toContain('rel="nofollow noopener"')
    expect(html).toContain('href="https://example.com"')
  })

  test('javascript: URLs are neutralised', () => {
    const html = renderMarkdown('[click](javascript:alert(1))')
    expect(html).not.toContain('href="javascript:')
  })

  test('data: URLs are neutralised', () => {
    const html = renderMarkdown('[click](data:text/html,<script>alert(1)</script>)')
    expect(html).not.toContain('href="data:')
  })

  test('autolinked URLs also get nofollow', () => {
    const html = renderMarkdown('see https://example.com/page')
    expect(html).toContain('rel="nofollow noopener"')
  })

  test('blockquote and code render', () => {
    const html = renderMarkdown('> quoted\n\n`code`')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('<code>code</code>')
  })
})

describe('escapeHtml', () => {
  test('escapes all dangerous characters', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;',
    )
  })
})
