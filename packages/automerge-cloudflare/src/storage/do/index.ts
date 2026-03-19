/**
 * A {@link StorageAdapterInterface} implementation that stores data in
 * Cloudflare Durable Object SQLite storage.
 */

import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"

export class DOStorageAdapter implements StorageAdapterInterface {
  private sql: SqlStorage

  constructor(storage: DurableObjectStorage) {
    this.sql = storage.sql
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS automerge_storage (
        key TEXT PRIMARY KEY,
        data BLOB NOT NULL
      )`
    )
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const row = this.sql
      .exec<{ data: ArrayBuffer }>(
        "SELECT data FROM automerge_storage WHERE key = ?",
        joinKey(key)
      )
      .toArray()[0]
    if (!row) return undefined
    return new Uint8Array(row.data)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.sql.exec(
      "INSERT INTO automerge_storage (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data",
      joinKey(key),
      data
    )
  }

  async remove(key: StorageKey): Promise<void> {
    this.sql.exec(
      "DELETE FROM automerge_storage WHERE key = ?",
      joinKey(key)
    )
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const prefix = joinKey(keyPrefix) + "/"
    const rows = this.sql
      .exec<{ key: string; data: ArrayBuffer }>(
        "SELECT key, data FROM automerge_storage WHERE key LIKE ? || '%'",
        prefix
      )
      .toArray()

    return rows.map((row) => ({
      key: splitKey(row.key),
      data: new Uint8Array(row.data),
    }))
  }

  async getChunks(): Promise<Chunk[]> {
    const rows = this.sql
      .exec<{ key: string; data: ArrayBuffer }>(
        "SELECT key, data FROM automerge_storage"
      )
      .toArray()

    return rows.map((row) => ({
      key: splitKey(row.key),
      data: new Uint8Array(row.data),
    }))
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const prefix = joinKey(keyPrefix) + "/"
    this.sql.exec(
      "DELETE FROM automerge_storage WHERE key LIKE ? || '%'",
      prefix
    )
  }
}

/**
 * Join a StorageKey into a flat string key using `/` as separator.
 * The first element is split into a 2-char shard prefix, matching
 * the R2 and D1 adapters' layout.
 *
 * Example: `["abc123", "snapshot", "hash"]` → `"ab/c123/snapshot/hash"`
 */
function joinKey(key: StorageKey): string {
  const [first, ...rest] = key
  return [first!.slice(0, 2), first!.slice(2), ...rest].join("/")
}

/**
 * Split a flat string key back into a StorageKey.
 */
function splitKey(keyStr: string): StorageKey {
  const [shard, firstRest, ...rest] = keyStr.split("/")
  return [shard! + firstRest!, ...rest]
}
