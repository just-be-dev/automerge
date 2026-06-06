/**
 * Storage logic for a single-document Durable Object. Runtime-agnostic so it
 * can be unit-tested without the Workers runtime — {@link DocStoreDO}
 * supplies the concrete `ChunkStore` implementations.
 *
 * Two-tier layout (store / archive) is implemented inline here rather than as
 * a separate adapter because tiering is only ever relevant at the per-document
 * layer: the top-level {@link RepoStoreDO} is a pure router and does no
 * storage of its own. The archive tier is optional — without it, the store is
 * authoritative on its own.
 */

import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"
import type { StorageOps } from "./types.ts"

/**
 * Storage contract for a single tier (store or archive). Mirrors
 * automerge-repo's {@link StorageAdapterInterface} so the same in-memory
 * test doubles work for both.
 *
 * Most consumers wire up storage by binding a {@link DocStoreDO} and never
 * touch this; implement it (and construct a {@link DocStoreCore} directly)
 * only when supplying custom tiers outside the DO wrapper.
 */
export interface ChunkStore extends StorageOps {
  /** Optional batch save — used by `hydrate`/`flushToArchive` when present. */
  saveChunks?(chunks: Chunk[]): Promise<void>
  /** Optional fast wipe — used by `clearAll` when present. */
  clearAll?(): Promise<void>
}

const COPY_BATCH_SIZE = 50

export class DocStoreCore implements StorageAdapterInterface {
  #store: ChunkStore
  #archive: ChunkStore | undefined

  constructor(store: ChunkStore, archive?: ChunkStore) {
    this.#store = store
    this.#archive = archive
  }

  // ── StorageAdapterInterface ───────────────────────────────────────

  /**
   * Reads fall through store → archive. Archive hits are promoted into the
   * store so subsequent reads stay hot.
   */
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const hit = await this.#store.load(key)
    if (hit !== undefined) return hit
    if (!this.#archive) return undefined
    const data = await this.#archive.load(key)
    if (data !== undefined) await this.#store.save(key, data)
    return data
  }

  save(key: StorageKey, data: Uint8Array): Promise<void> {
    return this.#store.save(key, data)
  }

  async remove(key: StorageKey): Promise<void> {
    if (this.#archive) {
      await Promise.all([this.#store.remove(key), this.#archive.remove(key)])
      return
    }
    await this.#store.remove(key)
  }

  /**
   * Reads fall through store → archive. Chunks that only exist in the archive
   * are promoted into the store before the merged result is returned.
   */
  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    if (!this.#archive) return this.#store.loadRange(prefix)
    const [storeChunks, archiveChunks] = await Promise.all([
      this.#store.loadRange(prefix),
      this.#archive.loadRange(prefix),
    ])

    const storeKeys = new Set(storeChunks.map((c) => JSON.stringify(c.key)))
    const toPromote = archiveChunks.filter(
      (c): c is Chunk & { data: Uint8Array } =>
        c.data !== undefined && !storeKeys.has(JSON.stringify(c.key))
    )
    if (toPromote.length > 0) {
      if (this.#store.saveChunks) {
        await this.#store.saveChunks(toPromote)
      } else {
        await Promise.all(
          toPromote.map((c) => this.#store.save(c.key, c.data))
        )
      }
    }

    const merged = new Map<string, Chunk>()
    for (const c of archiveChunks) merged.set(JSON.stringify(c.key), c)
    for (const c of storeChunks) merged.set(JSON.stringify(c.key), c)
    return Array.from(merged.values())
  }

  async removeRange(prefix: StorageKey): Promise<void> {
    if (this.#archive) {
      await Promise.all([
        this.#store.removeRange(prefix),
        this.#archive.removeRange(prefix),
      ])
      return
    }
    await this.#store.removeRange(prefix)
  }

  // ── Lifecycle (no-ops without an archive tier) ────────────────────

  async hydrate(prefix: StorageKey): Promise<void> {
    if (!this.#archive) return
    await copyChunks(this.#archive, this.#store, prefix)
  }

  /**
   * Move chunks under `prefix` from store → archive. The archive copy lands
   * first so a failure between the copy and the eviction leaves the data
   * recoverable (and a retry is a safe overwrite).
   */
  async flushToArchive(prefix: StorageKey): Promise<void> {
    if (!this.#archive) return
    await copyChunks(this.#store, this.#archive, prefix)
    await this.#store.removeRange(prefix)
  }

  async clearAll(): Promise<void> {
    if (this.#store.clearAll) {
      await this.#store.clearAll()
      return
    }
    await this.#store.removeRange([])
  }
}

async function copyChunks(
  src: ChunkStore,
  dst: ChunkStore,
  prefix: StorageKey
): Promise<void> {
  // Chunk.data is optional in the automerge-repo type; neither tier here
  // produces dataless chunks, but skip them rather than assert.
  const chunks = (await src.loadRange(prefix)).filter(
    (c): c is Chunk & { data: Uint8Array } => c.data !== undefined
  )
  if (chunks.length === 0) return

  if (dst.saveChunks) {
    await dst.saveChunks(chunks)
    return
  }

  for (let i = 0; i < chunks.length; i += COPY_BATCH_SIZE) {
    const slice = chunks.slice(i, i + COPY_BATCH_SIZE)
    await Promise.all(slice.map((c) => dst.save(c.key, c.data)))
  }
}
