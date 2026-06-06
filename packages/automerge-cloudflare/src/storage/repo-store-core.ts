/**
 * Routing logic for the top-level Repo store.
 *
 * StorageKeys arriving here come in two flavors:
 *
 * 1. **Adapter-internal metadata** — single-segment keys like
 *    `["storage-adapter-id"]` that `automerge-repo` uses for its own
 *    bookkeeping, not for any particular document. These are forwarded to a
 *    {@link MetaStore} owned by the router itself.
 * 2. **Document-scoped chunks** — multi-segment keys whose first segment is a
 *    documentId (e.g. `[docId, "snapshot", contentHash]`). These are
 *    forwarded to that document's {@link DocStoreInterface}.
 *
 * Reads for documents the router has never seen short-circuit to
 * undefined/empty via {@link DocIndex} — without that gate, every
 * `find(unknownUrl)` would spin up an empty DocStoreDO and commit storage
 * for it.
 *
 * Independent of the Cloudflare Workers runtime so it can be unit-tested.
 *
 * @see RepoStoreDO for the DurableObject wrapper.
 */

import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"
import type { StorageOps } from "./types.ts"

/**
 * The subset of {@link DocStoreCore}/{@link DocStoreDO} that the router calls.
 * Implementations: a local {@link DocStoreCore} (tests), or a
 * {@link DurableObjectStub}`<DocStoreDO>` (production).
 */
export type DocStoreInterface = StorageOps

/**
 * Backing store for adapter-internal metadata: single-segment keys that
 * aren't scoped to any document. Canonical example: `["storage-adapter-id"]`,
 * the stable identity automerge-repo writes once and reads on subsequent
 * boots to detect adapter swaps.
 */
export type MetaStore = Pick<StorageOps, "load" | "save" | "remove">

/**
 * Authoritative index of documentIds the repo has stored at least one chunk
 * for. The router consults it before instantiating a per-doc store so that
 * a read for an unknown doc doesn't materialize an empty DurableObject.
 *
 * Writes call {@link DocIndex.add} as a side effect; the index never shrinks
 * here — explicit cleanup is a separate concern.
 */
export interface DocIndex {
  has(docId: string): Promise<boolean>
  add(docId: string): Promise<void>
}

export interface RepoStoreCoreOptions {
  resolve: (docId: string) => DocStoreInterface
  meta: MetaStore
  index: DocIndex
}

export class RepoStoreCore implements StorageAdapterInterface {
  #resolve: (docId: string) => DocStoreInterface
  #meta: MetaStore
  #index: DocIndex

  constructor(opts: RepoStoreCoreOptions) {
    this.#resolve = opts.resolve
    this.#meta = opts.meta
    this.#index = opts.index
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const first = requireDocId(key)
    if (key.length === 1) return this.#meta.load(key)
    if (!(await this.#index.has(first))) return undefined
    return this.#resolve(first).load(key)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const first = requireDocId(key)
    if (key.length === 1) return this.#meta.save(key, data)
    await this.#index.add(first)
    return this.#resolve(first).save(key, data)
  }

  async remove(key: StorageKey): Promise<void> {
    const first = requireDocId(key)
    if (key.length === 1) return this.#meta.remove(key)
    if (!(await this.#index.has(first))) return
    return this.#resolve(first).remove(key)
  }

  async loadRange(prefix: StorageKey): Promise<Chunk[]> {
    const first = requireDocId(prefix, "loadRange requires a documentId prefix")
    if (!(await this.#index.has(first))) return []
    return this.#resolve(first).loadRange(prefix)
  }

  async removeRange(prefix: StorageKey): Promise<void> {
    const first = requireDocId(
      prefix,
      "removeRange requires a documentId prefix"
    )
    if (!(await this.#index.has(first))) return
    return this.#resolve(first).removeRange(prefix)
  }

  /**
   * Atomic set-if-absent for **meta keys only** (single-segment keys handled
   * by the {@link MetaStore}). If `key` already has a value, returns it
   * unchanged; otherwise stores `value` and returns it. Useful for naming a
   * well-known root document URL exactly once across racing clients.
   *
   * Atomicity rests on the surrounding `RepoStoreDO` handling the meta
   * load/save synchronously (its SQLite ops don't open the DO's input gate),
   * so call this through a single `RepoStoreDO` stub if multiple writers may
   * race. Doc-scoped keys are rejected: routing them would mean an outgoing
   * RPC between the load and the save, during which the input gate opens and
   * a racing call could interleave.
   */
  async loadOrInit(key: StorageKey, value: Uint8Array): Promise<Uint8Array> {
    requireDocId(key)
    if (key.length !== 1) {
      throw new Error(
        "loadOrInit only supports single-segment meta keys — doc-scoped keys cannot be set atomically through the router"
      )
    }
    const existing = await this.load(key)
    if (existing !== undefined) return existing
    await this.save(key, value)
    return value
  }
}

function requireDocId(key: StorageKey, msg?: string): string {
  const first = key[0]
  if (typeof first !== "string" || first.length === 0) {
    throw new Error(msg ?? "StorageKey must start with a documentId segment")
  }
  return first
}
