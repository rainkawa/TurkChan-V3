import { randomBytes, randomUUID, createHash } from 'node:crypto'

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Unguessable 13-char base36 id (~67 bits of entropy) for domain objects. */
export function newId(): string {
  const bytes = randomBytes(13)
  let out = ''
  for (let i = 0; i < 13; i++) out += ALPHABET[(bytes[i] as number) % 36]
  return out
}

export function newUuid(): string {
  return randomUUID()
}

/** 43-char url-safe secret for sessions / reset tokens / upload tokens. */
export function newSecret(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
