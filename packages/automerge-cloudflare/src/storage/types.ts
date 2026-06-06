/**
 * The five StorageKey operations shared by every storage layer in this
 * package. Mirrors automerge-repo's {@link StorageAdapterInterface} method
 * set (sans construction concerns) so the same in-memory test doubles work
 * at every layer.
 *
 * The per-layer names ({@link DocStoreInterface}, {@link RepoStoreRpc},
 * {@link ChunkStore}, {@link MetaStore}) are aliases or extensions of this
 * single definition — they document *roles*, not different contracts.
 */

import type { Chunk, StorageKey } from "@automerge/automerge-repo"

export interface StorageOps {
  load(key: StorageKey): Promise<Uint8Array | undefined>
  save(key: StorageKey, data: Uint8Array): Promise<void>
  remove(key: StorageKey): Promise<void>
  loadRange(prefix: StorageKey): Promise<Chunk[]>
  removeRange(prefix: StorageKey): Promise<void>
}
