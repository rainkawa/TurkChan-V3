import { describe, expect, test } from 'vitest'
import { isValidPublicUrlSyntax, isPrivateAddress } from '../../src/lib/urlguard'

describe('isValidPublicUrlSyntax (US-014 SSRF guard)', () => {
  test('accepts normal public URLs', () => {
    expect(isValidPublicUrlSyntax('https://example.com/article')).toBe(true)
    expect(isValidPublicUrlSyntax('http://news.site.org:8080/x?y=1')).toBe(true)
  })

  test('rejects non-http(s) schemes', () => {
    expect(isValidPublicUrlSyntax('ftp://example.com')).toBe(false)
    expect(isValidPublicUrlSyntax('javascript:alert(1)')).toBe(false)
    expect(isValidPublicUrlSyntax('file:///etc/passwd')).toBe(false)
    expect(isValidPublicUrlSyntax('not a url')).toBe(false)
  })

  test('rejects private/reserved IP literals', () => {
    expect(isValidPublicUrlSyntax('http://127.0.0.1/admin')).toBe(false)
    expect(isValidPublicUrlSyntax('http://10.0.0.5/')).toBe(false)
    expect(isValidPublicUrlSyntax('http://192.168.1.1/')).toBe(false)
    expect(isValidPublicUrlSyntax('http://172.16.0.1/')).toBe(false)
    expect(isValidPublicUrlSyntax('http://169.254.169.254/latest/meta-data')).toBe(false) // cloud metadata
    expect(isValidPublicUrlSyntax('http://[::1]/')).toBe(false)
    expect(isValidPublicUrlSyntax('http://localhost:3000/')).toBe(false)
    expect(isValidPublicUrlSyntax('http://foo.localhost/')).toBe(false)
  })
})

describe('isPrivateAddress', () => {
  test('IPv4 ranges', () => {
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('1.1.1.1')).toBe(false)
    expect(isPrivateAddress('10.1.2.3')).toBe(true)
    expect(isPrivateAddress('100.64.0.1')).toBe(true) // CGNAT
    expect(isPrivateAddress('198.18.0.1')).toBe(true)
    expect(isPrivateAddress('224.0.0.1')).toBe(true) // multicast
    expect(isPrivateAddress('0.0.0.0')).toBe(true)
  })

  test('IPv6 ranges', () => {
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fe80::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateAddress('2606:4700::1111')).toBe(false)
  })

  test('unparseable input treated as unsafe', () => {
    expect(isPrivateAddress('bogus')).toBe(true)
  })
})
