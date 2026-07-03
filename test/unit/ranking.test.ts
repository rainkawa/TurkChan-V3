import { describe, expect, test } from 'vitest'
import { hotRank, wilsonLowerBound } from '../../src/lib/ranking'

const HOUR = 60 * 60 * 1000
const DECAY = 90000

describe('hotRank', () => {
  test('newer post with score 0 outranks week-old post with modest score (US-025)', () => {
    const now = Date.UTC(2026, 6, 1)
    const fresh = hotRank(0, now, DECAY)
    const weekOldModest = hotRank(20, now - 7 * 24 * HOUR, DECAY)
    expect(fresh).toBeGreaterThan(weekOldModest)
  })

  test('at equal age, higher score ranks higher', () => {
    const at = Date.UTC(2026, 6, 1)
    expect(hotRank(100, at, DECAY)).toBeGreaterThan(hotRank(10, at, DECAY))
    expect(hotRank(10, at, DECAY)).toBeGreaterThan(hotRank(0, at, DECAY))
    expect(hotRank(0, at, DECAY)).toBeGreaterThan(hotRank(-10, at, DECAY))
  })

  test('log scaling: 10→100 votes adds as much as 1→10', () => {
    const at = Date.UTC(2026, 6, 1)
    const delta1 = hotRank(10, at, DECAY) - hotRank(1, at, DECAY)
    const delta2 = hotRank(100, at, DECAY) - hotRank(10, at, DECAY)
    expect(delta1).toBeCloseTo(delta2, 10)
  })

  test('larger decay constant makes score matter longer', () => {
    const now = Date.UTC(2026, 6, 1)
    const oldGood = (decay: number) => hotRank(50, now - 48 * HOUR, decay)
    const freshZero = (decay: number) => hotRank(0, now, decay)
    // With fast decay (Reddit's 45k) the fresh post wins; with slow decay the old good post can win.
    expect(freshZero(45000) - oldGood(45000)).toBeGreaterThan(freshZero(180000) - oldGood(180000))
  })
})

describe('wilsonLowerBound', () => {
  test('zero votes scores zero', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0)
  })

  test('10 up / 0 down beats 15 up / 8 down (US-027)', () => {
    expect(wilsonLowerBound(10, 0)).toBeGreaterThan(wilsonLowerBound(15, 8))
  })

  test('more votes at the same ratio increases confidence', () => {
    expect(wilsonLowerBound(100, 10)).toBeGreaterThan(wilsonLowerBound(10, 1))
  })

  test('bounded between 0 and 1', () => {
    for (const [up, down] of [[1, 0], [0, 1], [50, 50], [1000, 1]]) {
      const score = wilsonLowerBound(up as number, down as number)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})
