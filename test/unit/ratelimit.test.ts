import { describe, expect, test } from 'vitest'
import { RateLimiter } from '../../src/lib/ratelimit'

describe('RateLimiter (FR-16)', () => {
  test('allows up to the limit then blocks with retry time', () => {
    let now = 1000000
    const limiter = new RateLimiter(() => now)
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('k', 5, 60000).allowed).toBe(true)
    }
    const blocked = limiter.check('k', 5, 60000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(60000)
  })

  test('window slides: old hits expire', () => {
    let now = 1000000
    const limiter = new RateLimiter(() => now)
    for (let i = 0; i < 5; i++) limiter.check('k', 5, 60000)
    expect(limiter.check('k', 5, 60000).allowed).toBe(false)
    now += 60001
    expect(limiter.check('k', 5, 60000).allowed).toBe(true)
  })

  test('keys are independent', () => {
    const limiter = new RateLimiter(() => 0)
    for (let i = 0; i < 5; i++) limiter.check('a', 5, 60000)
    expect(limiter.check('a', 5, 60000).allowed).toBe(false)
    expect(limiter.check('b', 5, 60000).allowed).toBe(true)
  })

  test('blocked attempts do not consume quota', () => {
    let now = 0
    const limiter = new RateLimiter(() => now)
    for (let i = 0; i < 5; i++) limiter.check('k', 5, 60000)
    for (let i = 0; i < 10; i++) limiter.check('k', 5, 60000) // hammering while blocked
    now += 60001
    expect(limiter.check('k', 5, 60000).allowed).toBe(true)
  })
})
