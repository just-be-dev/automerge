/**
 * A {@link StorageAdapterInterface} implementation that delegates to a
 * {@link RepoStoreDO} over Durable Object RPC. This is the entry point
 * consumers wire into `new Repo({ storage })`.
 *
 * @example
 * ```ts
 * import { RepoStoreAdapter } from "@just-be/automerge-cloudflare/storage"
 *
 * export class MyAppDO extends DurableObject<Env> {
 *   #repo: Repo
 *
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env)
 *     const stub = env.AUTOMERGE_REPO_STORE.get(
 *       env.AUTOMERGE_REPO_STORE.idFromName("default")
 *     )
 *     this.#repo = new Repo({
 *       storage: new RepoStoreAdapter(stub),
 *       network: [...]
 *     })
 *   }
 * }
 * ```
 */

import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"
import type { RepoStoreDO } from "./repo-store-do.ts"
import type { StorageOps } from "./types.ts"

/**
 * The part of RepoStoreDO's RPC surface this adapter delegates to. Accepting
 * this interface (instead of a concrete `DurableObjectStub<RepoStoreDO>`)
 * keeps the adapter testable without the Workers runtime.
 *
 * Deliberately excludes `loadOrInit` — that RPC is an application-level
 * convenience, not part of automerge-repo's `StorageAdapterInterface`, so
 * the adapter never calls it.
 */
export type RepoStoreRpc = StorageOps

export class RepoStoreAdapter implements StorageAdapterInterface {
  #stub: RepoStoreRpc

  constructor(stub: DurableObjectStub<RepoStoreDO> | RepoStoreRpc) {
    this.#stub = stub as RepoStoreRpc
  }

  load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#stub.load(key)
  }

  save(key: StorageKey, data: Uint8Array): Promise<void> {
    return this.#stub.save(key, data)
  }

  remove(key: StorageKey): Promise<void> {
    return this.#stub.remove(key)
  }

  loadRange(prefix: StorageKey): Promise<Chunk[]> {
    return this.#stub.loadRange(prefix)
  }

  removeRange(prefix: StorageKey): Promise<void> {
    return this.#stub.removeRange(prefix)
  }
}
