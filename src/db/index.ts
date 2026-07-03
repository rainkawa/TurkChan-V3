import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA_SQL } from './schema'
import { hotRank, wilsonLowerBound } from '../lib/ranking'

export type DB = DatabaseSync

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(SCHEMA_SQL)
  registerFunctions(db)
  return db
}

function registerFunctions(db: DatabaseSync) {
  db.function('hot_rank', { deterministic: true }, (score: unknown, createdAtMs: unknown, decay: unknown) =>
    hotRank(Number(score), Number(createdAtMs), Number(decay)),
  )
  db.function('wilson', { deterministic: true }, (up: unknown, down: unknown) =>
    wilsonLowerBound(Number(up), Number(down)),
  )
}

/** Run fn inside a transaction; rolls back on throw. */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
}
