import { describe, expect, test } from 'vitest'
import { encodeCursor, decodeCursor, cursorPredicate } from '../../src/lib/cursor'

describe('cursor codec', () => {
  test('round-trips values + id', () => {
    const cursor = { values: [123.456, 789], id: 'abc123' }
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor)
  })

  test('rejects garbage input gracefully', () => {
    expect(decodeCursor('not-base64!!!')).toBeNull()
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor(undefined)).toBeNull()
    expect(decodeCursor(Buffer.from('{"a":1}').toString('base64url'))).toBeNull()
    expect(decodeCursor(Buffer.from('[["x"],"id"]').toString('base64url'))).toBeNull()
  })
})

describe('cursorPredicate', () => {
  test('single sort expression', () => {
    const { clause, params } = cursorPredicate(['p.created_at'], 'p.id', { values: [100], id: 'x' })
    expect(clause).toBe('((p.created_at < ?) OR (p.created_at = ? AND p.id < ?))')
    expect(params).toEqual([100, 100, 'x'])
  })

  test('composite sort expressions (top: score, recency)', () => {
    const { clause, params } = cursorPredicate(['p.score', 'p.created_at'], 'p.id', {
      values: [5, 100],
      id: 'x',
    })
    expect(clause).toBe(
      '((p.score < ?) OR (p.score = ? AND p.created_at < ?) OR (p.score = ? AND p.created_at = ? AND p.id < ?))',
    )
    expect(params).toEqual([5, 5, 100, 5, 100, 'x'])
  })
})
