import { mkdirSync } from 'node:fs'
import { readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Object storage port. Production is S3-compatible storage with real
 * pre-signed URLs; this local adapter keeps the same shape (unguessable keys,
 * bytes never routed through app pages) for single-VPS deployments and tests.
 */
export interface ObjectStorage {
  put(key: string, bytes: Uint8Array): Promise<void>
  get(key: string): Promise<Uint8Array | null>
  delete(key: string): Promise<void>
}

export class LocalObjectStorage implements ObjectStorage {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private pathFor(key: string): string {
    if (!/^[A-Za-z0-9-]+$/.test(key)) throw new Error('invalid storage key')
    return join(this.dir, key)
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    await writeFile(this.pathFor(key), bytes)
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      return await readFile(this.pathFor(key))
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true })
  }
}

export class MemoryObjectStorage implements ObjectStorage {
  private objects = new Map<string, Uint8Array>()

  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(key, bytes)
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key) ?? null
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}
