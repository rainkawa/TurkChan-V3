/**
 * Opaque cursor pagination (US-024): encodes the last row's sort values + id
 * so pages stay stable when new content arrives (no duplicates or skips).
 * Sort values are compared lexicographically, descending, with id as the
 * final deterministic tiebreak.
 */
export interface Cursor {
  values: number[]
  id: string
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.values, cursor.id])).toString('base64url')
}

export function decodeCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [values, id] = parsed
    if (!Array.isArray(values) || values.some((v) => typeof v !== 'number') || typeof id !== 'string') {
      return null
    }
    return { values, id }
  } catch {
    return null
  }
}

/**
 * SQL predicate for "rows strictly after the cursor" under a descending
 * lexicographic order on (…exprs, id). Returns clause + params.
 */
export function cursorPredicate(exprs: string[], idExpr: string, cursor: Cursor): { clause: string; params: (number | string)[] } {
  const alternatives: string[] = []
  const params: (number | string)[] = []
  for (let i = 0; i < exprs.length; i++) {
    const equalities = exprs.slice(0, i).map((e) => `${e} = ?`)
    alternatives.push([...equalities, `${exprs[i]} < ?`].join(' AND '))
    params.push(...cursor.values.slice(0, i + 1))
  }
  const idEqualities = exprs.map((e) => `${e} = ?`)
  alternatives.push([...idEqualities, `${idExpr} < ?`].join(' AND '))
  params.push(...cursor.values, cursor.id)
  return { clause: `(${alternatives.map((a) => `(${a})`).join(' OR ')})`, params }
}
