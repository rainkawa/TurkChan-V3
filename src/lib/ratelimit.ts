/**
 * In-memory sliding-window rate limiter (FR-16). Single-node deployment per
 * PRD, so process memory is the correct home. Clock is injectable for tests.
 */
export interface RateLimitResult {
  allowed: boolean
  retryAfterMs: number
}

export class RateLimiter {
  private hits = new Map<string, number[]>()

  constructor(private now: () => number = Date.now) {}

  /** Record-and-check: counts this attempt if allowed. */
  check(key: string, limit: number, windowMs: number): RateLimitResult {
    const cutoff = this.now() - windowMs
    const existing = (this.hits.get(key) ?? []).filter((t) => t > cutoff)
    if (existing.length >= limit) {
      const oldest = existing[0] as number
      this.hits.set(key, existing)
      return { allowed: false, retryAfterMs: oldest + windowMs - this.now() }
    }
    this.hits.set(key, [...existing, this.now()])
    return { allowed: true, retryAfterMs: 0 }
  }

  reset(key?: string) {
    if (key === undefined) this.hits.clear()
    else this.hits.delete(key)
  }
}
