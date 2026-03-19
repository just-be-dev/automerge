/**
 * A {@link StorageAdapterInterface} implementation that stores data in
 * Cloudflare R2 using the Workers R2 bucket binding.
 */

import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"

export interface R2StorageAdapterOptions {
  /** Optional key prefix for all objects (e.g. `"automerge/"`). */
  prefix?: string
}

export class R2StorageAdapter implements StorageAdapterInterface {
  private bucket: R2Bucket
  private prefix: string

  constructor(bucket: R2Bucket, options?: R2StorageAdapterOptions) {
    this.bucket = bucket
    this.prefix = options?.prefix ?? ""
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const obj = await this.bucket.get(this.toObjectKey(key))
    if (obj === null) return undefined
    return new Uint8Array(await obj.arrayBuffer())
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.bucket.put(this.toObjectKey(key), data)
  }

  async remove(key: StorageKey): Promise<void> {
    await this.bucket.delete(this.toObjectKey(key))
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = this.toObjectKey(keyPrefix) + "/"
    const keys = await this.listKeys(prefix)

    const chunks = await Promise.all(
      keys.map(async (objectKey) => {
        const key = this.fromObjectKey(objectKey)
        const data = await this.load(key)
        return { key, data } satisfies Chunk
      })
    )

    return chunks
  }

  async saveChunks(chunks: Chunk[], batchSize = 50): Promise<void> {
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      await Promise.all(batch.map((chunk) => this.save(chunk.key, chunk.data!)))
    }
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = this.toObjectKey(keyPrefix) + "/"
    const keys = await this.listKeys(prefix)

    // R2 delete supports up to 1000 keys per call
    for (let i = 0; i < keys.length; i += 1000) {
      await this.bucket.delete(keys.slice(i, i + 1000))
    }
  }

  /**
   * Convert a StorageKey to an R2 object key.
   *
   * Mirrors the NodeFS adapter's layout: the first key element is split so
   * the first 2 characters become a directory prefix (for shard distribution),
   * then the remainder of that element plus any additional key segments are
   * joined with `/`.
   *
   * Example: `["abc123", "snapshot", "hash"]` → `"ab/c123/snapshot/hash"`
   */
  private toObjectKey(key: StorageKey): string {
    const [first, ...rest] = key
    const parts = [first!.slice(0, 2), first!.slice(2), ...rest]
    return this.prefix + parts.join("/")
  }

  /**
   * Reverse of {@link toObjectKey}: reconstruct a StorageKey from an R2 object key.
   */
  private fromObjectKey(objectKey: string): StorageKey {
    const unprefixed = this.prefix
      ? objectKey.slice(this.prefix.length)
      : objectKey
    const [shard, firstRest, ...rest] = unprefixed.split("/")
    return [shard! + firstRest!, ...rest]
  }

  private async listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined

    for (;;) {
      const result = await this.bucket.list({
        prefix,
        limit: 1000,
        cursor,
      })

      for (const obj of result.objects) {
        keys.push(obj.key)
      }

      if (!result.truncated) break
      cursor = result.cursor
    }

    return keys
  }
}
