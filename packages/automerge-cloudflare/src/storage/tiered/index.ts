/**
 * A {@link StorageAdapterInterface} implementation that wraps two adapters
 * into a hot/cold tiered store.
 *
 * - Reads fall through hot → cold; no implicit write-back. Use
 *   {@link TieredStorageAdapter.hydrate} to explicitly promote a doc into
 *   hot on activation.
 * - Writes go to hot only. Automerge chunks are additive and content-
 *   addressed, so new edits layer on top of cold chunks without needing
 *   to rehydrate the whole doc. The cold tier is populated explicitly via
 *   {@link TieredStorageAdapter.flushToCold}.
 * - Removals propagate to both tiers so the read fallback cannot resurrect
 *   deleted keys. This also means Automerge's compaction (which removes
 *   superseded chunks) cleans up cold automatically.
 *
 * Intended use: Durable Object storage as hot, R2 as cold.
 *
 * Lifecycle for an active doc:
 *   1. On first activation: `hydrate([docId])` — copy cold → hot.
 *   2. While active: edits write to hot only; `alarm()` periodically calls
 *      `flushToCold([docId])` to promote new chunks to R2.
 *   3. On idle: after a final `flushToCold`, release hot storage. For the
 *      "1 DO = 1 doc" pattern, prefer `clearHot()` — it routes to
 *      `ctx.storage.deleteAll()` and is cheaper than enumerating keys.
 *      For multi-doc-per-DO, use `evictFromHot([docId])` to target one
 *      doc. Cold copy remains for future activations.
 *
 * @example
 * ```ts
 * const storage = new TieredStorageAdapter(
 *   new DOStorageAdapter(this.ctx.storage),
 *   new R2StorageAdapter(this.env.BUCKET),
 * )
 *
 * async onConnect(docId: string) {
 *   await this.storage.hydrate([docId])
 *   this.activeDocs.add(docId)
 * }
 *
 * async alarm() {
 *   for (const docId of this.activeDocs) {
 *     await this.storage.flushToCold([docId])
 *   }
 *   if (this.activeDocs.size === 0) {
 *     // 1 DO = 1 doc: wipe everything and let the platform evict us.
 *     await this.storage.clearHot()
 *   }
 *   await this.ctx.storage.setAlarm(Date.now() + 60_000)
 * }
 * ```
 */

import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"

interface SupportsSaveChunks {
  saveChunks(chunks: Chunk[], batchSize?: number): Promise<void>
}

interface SupportsClearAll {
  clearAll(): Promise<void>
}

const FLUSH_BATCH_SIZE = 50

export class TieredStorageAdapter implements StorageAdapterInterface {
  private hot: StorageAdapterInterface
  private cold: StorageAdapterInterface

  constructor(hot: StorageAdapterInterface, cold: StorageAdapterInterface) {
    this.hot = hot
    this.cold = cold
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const hit = await this.hot.load(key)
    if (hit !== undefined) return hit
    return this.cold.load(key)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    await this.hot.save(key, data)
  }

  async remove(key: StorageKey): Promise<void> {
    await Promise.all([this.hot.remove(key), this.cold.remove(key)])
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const [hotChunks, coldChunks] = await Promise.all([
      this.hot.loadRange(keyPrefix),
      this.cold.loadRange(keyPrefix),
    ])

    const merged = new Map<string, Chunk>()
    for (const chunk of coldChunks) merged.set(JSON.stringify(chunk.key), chunk)
    for (const chunk of hotChunks) merged.set(JSON.stringify(chunk.key), chunk)
    return Array.from(merged.values())
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    await Promise.all([
      this.hot.removeRange(keyPrefix),
      this.cold.removeRange(keyPrefix),
    ])
  }

  /**
   * Copy chunks under `prefix` from hot to cold. Idempotent.
   * Uses `cold.saveChunks` when available (e.g. R2); otherwise loops with
   * batched concurrency.
   */
  async flushToCold(prefix: StorageKey): Promise<void> {
    await copyChunks(this.hot, this.cold, prefix)
  }

  /**
   * Copy chunks under `prefix` from cold to hot. Idempotent.
   * Intended for doc activation (e.g. first WebSocket connect) so that
   * subsequent reads stay hot. View-only access should skip this.
   */
  async hydrate(prefix: StorageKey): Promise<void> {
    await copyChunks(this.cold, this.hot, prefix)
  }

  /**
   * Remove chunks under `prefix` from hot only. Cold copy is preserved.
   * Caller is responsible for ordering: only evict after a successful
   * {@link flushToCold} for the same prefix, otherwise recent edits will
   * be lost.
   */
  async evictFromHot(prefix: StorageKey): Promise<void> {
    await this.hot.removeRange(prefix)
  }

  /**
   * Clear the entire hot tier. Cold is preserved.
   *
   * Uses `hot.clearAll()` when available (e.g. a DO storage adapter that
   * routes to `ctx.storage.deleteAll()`); otherwise falls back to
   * `removeRange([])`. Intended for the "1 DO = 1 doc" pattern: after a
   * final {@link flushToCold}, wipe the DO's storage so the platform can
   * reclaim it on idle.
   */
  async clearHot(): Promise<void> {
    if (hasClearAll(this.hot)) {
      await this.hot.clearAll()
      return
    }
    await this.hot.removeRange([])
  }
}

async function copyChunks(
  src: StorageAdapterInterface,
  dst: StorageAdapterInterface,
  prefix: StorageKey
): Promise<void> {
  const chunks = await src.loadRange(prefix)
  if (chunks.length === 0) return

  if (hasSaveChunks(dst)) {
    await dst.saveChunks(chunks)
    return
  }

  for (let i = 0; i < chunks.length; i += FLUSH_BATCH_SIZE) {
    const slice = chunks.slice(i, i + FLUSH_BATCH_SIZE)
    await Promise.all(
      slice.map((chunk) => dst.save(chunk.key, chunk.data!))
    )
  }
}

function hasSaveChunks(
  adapter: StorageAdapterInterface
): adapter is StorageAdapterInterface & SupportsSaveChunks {
  return typeof (adapter as Partial<SupportsSaveChunks>).saveChunks === "function"
}

function hasClearAll(
  adapter: StorageAdapterInterface
): adapter is StorageAdapterInterface & SupportsClearAll {
  return typeof (adapter as Partial<SupportsClearAll>).clearAll === "function"
}
