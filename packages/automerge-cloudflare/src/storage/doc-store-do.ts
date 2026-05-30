/**
 * Per-document Durable Object. One instance per Automerge documentId, named
 * via `namespace.idFromName(documentId)`. Owns the chunks for that doc.
 *
 * Storage: the live store is the DO's own SQLite storage; the archive is an
 * optional R2 bucket bound via env. When R2 is present, the DO acts as a
 * write-through live cache — writes hit the store only; reads fall through
 * to the archive (with read-through promotion); lifecycle methods
 * (`flushToArchive`, `hydrate`, `clearAll`) are driven by the consumer.
 *
 * **Idle-flush alarm.** When an archive is bound, the DO maintains a
 * "last write" timestamp and arms an alarm at `lastWrite + idleFlushMs`
 * (default 7 days). When the alarm fires and the doc is still idle, the
 * whole store is flushed to the archive. Configure via the
 * `AUTOMERGE_IDLE_FLUSH_MS` env var.
 *
 * Wire this DO into your `wrangler.toml`:
 * ```toml
 * [[durable_objects.bindings]]
 * name = "AUTOMERGE_DOC_STORE"
 * class_name = "DocStoreDO"
 * ```
 */

import { DurableObject } from "cloudflare:workers"
import type { Chunk, StorageKey } from "@automerge/automerge-repo"
import { DocStoreCore, type ChunkStore } from "./doc-store-core.ts"

const DEFAULT_IDLE_FLUSH_MS = 1000 * 60 * 60 * 24 * 7 // 7 days
const META_TABLE = "automerge_meta"
const META_LAST_WRITE_KEY = "last-write"

export interface DocStoreEnv {
  /** Optional R2 bucket for the archive tier. */
  AUTOMERGE_R2?: R2Bucket
  /** Optional R2 object key prefix (e.g. `"automerge/"`). */
  AUTOMERGE_R2_PREFIX?: string
  /**
   * Idle threshold (ms) after which this doc's chunks are flushed from the
   * store to the archive. Default 7 days. Ignored when no archive is bound.
   * Accepts a number or a numeric string (wrangler `[vars]` values arrive
   * as strings).
   */
  AUTOMERGE_IDLE_FLUSH_MS?: string | number
}

export class DocStoreDO<
  Env extends DocStoreEnv = DocStoreEnv,
> extends DurableObject<Env> {
  #core: DocStoreCore
  #ctx: DurableObjectState
  #sql: SqlStorage
  #idleFlushMs: number
  #hasArchive: boolean

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#ctx = ctx
    this.#sql = ctx.storage.sql
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`
    )
    const store = new SqliteStore(ctx.storage)
    const archive = env.AUTOMERGE_R2
      ? new R2Archive(env.AUTOMERGE_R2, env.AUTOMERGE_R2_PREFIX)
      : undefined
    this.#hasArchive = archive !== undefined
    this.#core = new DocStoreCore(store, archive)
    this.#idleFlushMs =
      parseIdleFlushMs(env.AUTOMERGE_IDLE_FLUSH_MS) ?? DEFAULT_IDLE_FLUSH_MS
  }

  load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#core.load(key)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.#core.save(key, data)
    await this.#noteWrite()
  }

  async remove(key: StorageKey): Promise<void> {
    await this.#core.remove(key)
    await this.#noteWrite()
  }

  loadRange(prefix: StorageKey): Promise<Chunk[]> {
    return this.#core.loadRange(prefix)
  }

  async removeRange(prefix: StorageKey): Promise<void> {
    await this.#core.removeRange(prefix)
    await this.#noteWrite()
  }

  hydrate(prefix: StorageKey): Promise<void> {
    return this.#core.hydrate(prefix)
  }

  flushToArchive(prefix: StorageKey): Promise<void> {
    return this.#core.flushToArchive(prefix)
  }

  clearAll(): Promise<void> {
    return this.#core.clearAll()
  }

  /**
   * Runtime-invoked alarm. Flushes the doc if it's been idle for at least
   * `idleFlushMs`; otherwise reschedules itself for the next due time.
   */
  override async alarm(): Promise<void> {
    if (!this.#hasArchive) return
    const lastWrite = this.#readLastWrite() ?? 0
    const dueAt = lastWrite + this.#idleFlushMs
    const now = Date.now()
    if (now >= dueAt) {
      await this.#core.flushToArchive([])
    } else {
      await this.#ctx.storage.setAlarm(dueAt)
    }
  }

  async #noteWrite(): Promise<void> {
    if (!this.#hasArchive) return
    const now = Date.now()
    this.#writeLastWrite(now)
    // Arm the alarm lazily — if one is already scheduled, the existing
    // alarm fires, sees the fresh lastWrite, and reschedules itself.
    if ((await this.#ctx.storage.getAlarm()) === null) {
      await this.#ctx.storage.setAlarm(now + this.#idleFlushMs)
    }
  }

  #readLastWrite(): number | undefined {
    const row = this.#sql
      .exec<{ value: string }>(
        `SELECT value FROM ${META_TABLE} WHERE key = ?`,
        META_LAST_WRITE_KEY
      )
      .toArray()[0]
    if (!row) return undefined
    const n = Number(row.value)
    return Number.isFinite(n) ? n : undefined
  }

  #writeLastWrite(t: number): void {
    this.#sql.exec(
      `INSERT INTO ${META_TABLE} (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      META_LAST_WRITE_KEY,
      String(t)
    )
  }
}

function parseIdleFlushMs(
  v: string | number | undefined
): number | undefined {
  if (v === undefined) return undefined
  const n = typeof v === "number" ? v : Number(v)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n
}

// ── Store tier: SQLite-backed Durable Object storage ──────────────────

class SqliteStore implements ChunkStore {
  #sql: SqlStorage

  constructor(storage: DurableObjectStorage) {
    this.#sql = storage.sql
    this.#sql.exec(
      `CREATE TABLE IF NOT EXISTS automerge_storage (
        key TEXT PRIMARY KEY,
        data BLOB NOT NULL
      )`
    )
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const row = this.#sql
      .exec<{ data: ArrayBuffer }>(
        "SELECT data FROM automerge_storage WHERE key = ?",
        joinKey(key)
      )
      .toArray()[0]
    if (!row) return undefined
    return new Uint8Array(row.data)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.#sql.exec(
      "INSERT INTO automerge_storage (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data",
      joinKey(key),
      data
    )
  }

  async remove(key: StorageKey): Promise<void> {
    this.#sql.exec(
      "DELETE FROM automerge_storage WHERE key = ?",
      joinKey(key)
    )
  }

  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const rows =
      prefix.length === 0
        ? this.#sql
            .exec<{ key: string; data: ArrayBuffer }>(
              "SELECT key, data FROM automerge_storage"
            )
            .toArray()
        : this.#sql
            .exec<{ key: string; data: ArrayBuffer }>(
              "SELECT key, data FROM automerge_storage WHERE key LIKE ? || '%'",
              joinKey(prefix) + "/"
            )
            .toArray()

    return rows.map((row) => ({
      key: splitKey(row.key),
      data: new Uint8Array(row.data),
    }))
  }

  async removeRange(prefix: StorageKey): Promise<void> {
    if (prefix.length === 0) {
      this.#sql.exec("DELETE FROM automerge_storage")
      return
    }
    this.#sql.exec(
      "DELETE FROM automerge_storage WHERE key LIKE ? || '%'",
      joinKey(prefix) + "/"
    )
  }

  async clearAll(): Promise<void> {
    this.#sql.exec("DELETE FROM automerge_storage")
  }
}

function joinKey(key: StorageKey): string {
  return key.join("/")
}

function splitKey(s: string): StorageKey {
  return s.split("/")
}

// ── Archive tier: R2 bucket ───────────────────────────────────────────

class R2Archive implements ChunkStore {
  #bucket: R2Bucket
  #prefix: string

  constructor(bucket: R2Bucket, prefix: string = "") {
    this.#bucket = bucket
    this.#prefix = prefix
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const obj = await this.#bucket.get(this.#toObjectKey(key))
    if (obj === null) return undefined
    return new Uint8Array(await obj.arrayBuffer())
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.#bucket.put(this.#toObjectKey(key), data)
  }

  async remove(key: StorageKey): Promise<void> {
    await this.#bucket.delete(this.#toObjectKey(key))
  }

  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const objPrefix =
      prefix.length === 0 ? this.#prefix : this.#toObjectKey(prefix) + "/"
    const keys = await this.#listKeys(objPrefix)
    return Promise.all(
      keys.map(async (objKey) => {
        const key = this.#fromObjectKey(objKey)
        const data = await this.load(key)
        return { key, data } satisfies Chunk
      })
    )
  }

  async removeRange(prefix: StorageKey): Promise<void> {
    const objPrefix =
      prefix.length === 0 ? this.#prefix : this.#toObjectKey(prefix) + "/"
    const keys = await this.#listKeys(objPrefix)
    // R2 delete accepts up to 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      await this.#bucket.delete(keys.slice(i, i + 1000))
    }
  }

  async saveChunks(chunks: Chunk[], batchSize = 50): Promise<void> {
    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      await Promise.all(batch.map((c) => this.save(c.key, c.data!)))
    }
  }

  #toObjectKey(key: StorageKey): string {
    return this.#prefix + key.join("/")
  }

  #fromObjectKey(objectKey: string): StorageKey {
    const unprefixed = this.#prefix
      ? objectKey.slice(this.#prefix.length)
      : objectKey
    return unprefixed.split("/")
  }

  async #listKeys(prefix: string): Promise<string[]> {
    const keys: string[] = []
    let cursor: string | undefined

    for (;;) {
      const result = await this.#bucket.list({
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
