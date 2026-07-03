import { hash, verify } from '@node-rs/argon2'

/** Argon2id per PRD auth requirements. Plaintext is never logged or stored. */

const ARGON2ID = 2

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, { algorithm: ARGON2ID, memoryCost: 19456, timeCost: 2, parallelism: 1 })
}

export async function verifyPassword(hashValue: string, plain: string): Promise<boolean> {
  if (!hashValue) return false
  try {
    return await verify(hashValue, plain)
  } catch {
    return false
  }
}
