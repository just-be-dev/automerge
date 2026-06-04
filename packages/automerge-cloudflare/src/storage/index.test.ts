import { describe, expect, it, beforeEach, mock } from "bun:test"
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"
import { DocStoreCore } from "./doc-store-core.ts"
import {
  RepoStoreCore,
  type DocIndex,
  type DocStoreInterface,
  type MetaStore,
} from "./repo-store-core.ts"
import { RepoStoreAdapter } from "./adapter.ts"

// ── In-memory test adapter ────────────────────────────────────────────

class MemoryStorageAdapter implements StorageAdapterInterface {
  private map = new Map<string, Uint8Array>()

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.map.get(JSON.stringify(key))
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.map.set(JSON.stringify(key), data)
  }

  async remove(key: StorageKey): Promise<void> {
    this.map.delete(JSON.stringify(key))
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const out: Chunk[] = []
    for (const [k, data] of this.map) {
      const key = JSON.parse(k) as StorageKey
      if (matchesPrefix(key, keyPrefix)) out.push({ key, data })
    }
    return out
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    for (const k of [...this.map.keys()]) {
      const key = JSON.parse(k) as StorageKey
      if (matchesPrefix(key, keyPrefix)) this.map.delete(k)
    }
  }
}

function matchesPrefix(key: StorageKey, prefix: StorageKey): boolean {
  if (prefix.length === 0) return true
  if (key.length < prefix.length) return false
  return prefix.every((seg, i) => key[i] === seg)
}

class MemoryMetaStore implements MetaStore {
  private map = new Map<string, Uint8Array>()
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.map.get(key.join("/"))
  }
  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.map.set(key.join("/"), data)
  }
  async remove(key: StorageKey): Promise<void> {
    this.map.delete(key.join("/"))
  }
}

class MemoryDocIndex implements DocIndex {
  private set = new Set<string>()
  async has(docId: string): Promise<boolean> {
    return this.set.has(docId)
  }
  async add(docId: string): Promise<void> {
    this.set.add(docId)
  }
}

// ── DocStoreCore ──────────────────────────────────────────────────────

describe("DocStoreCore (no archive tier)", () => {
  let store: MemoryStorageAdapter
  let core: DocStoreCore

  beforeEach(() => {
    store = new MemoryStorageAdapter()
    core = new DocStoreCore(store)
  })

  it("save/load/remove round-trip", async () => {
    const key = ["doc1", "snapshot", "h1"]
    await core.save(key, new Uint8Array([1]))
    expect(await core.load(key)).toEqual(new Uint8Array([1]))
    await core.remove(key)
    expect(await core.load(key)).toBeUndefined()
  })

  it("loadRange returns chunks under prefix", async () => {
    await core.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    await core.save(["doc1", "incremental", "h2"], new Uint8Array([2]))

    const chunks = await core.loadRange(["doc1"])
    expect(chunks).toHaveLength(2)
  })

  it("hydrate/flushToArchive are no-ops without an archive tier", async () => {
    await core.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))

    await core.hydrate(["doc1"])
    await core.flushToArchive(["doc1"])

    // No archive to flush to — data stays in the store untouched.
    expect(await core.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
  })

  it("clearAll wipes everything when there is no archive tier", async () => {
    await core.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    await core.clearAll()
    expect(await core.load(["doc1", "snapshot", "h1"])).toBeUndefined()
  })
})

describe("DocStoreCore (with archive tier)", () => {
  let store: MemoryStorageAdapter
  let archive: MemoryStorageAdapter
  let core: DocStoreCore

  beforeEach(() => {
    store = new MemoryStorageAdapter()
    archive = new MemoryStorageAdapter()
    core = new DocStoreCore(store, archive)
  })

  it("writes go to the store only; reads fall through to the archive", async () => {
    await core.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    expect(await store.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    expect(await archive.load(["doc1", "snapshot", "h1"])).toBeUndefined()
  })

  it("flushToArchive moves store chunks to archive under the given prefix", async () => {
    await core.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    await core.flushToArchive(["doc1"])

    expect(await archive.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    // The store is emptied as part of the flush.
    expect(await store.load(["doc1", "snapshot", "h1"])).toBeUndefined()
    // Adapter still resolves the chunk via archive fallback.
    expect(await core.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
  })

  it("hydrate copies archive chunks back into the store", async () => {
    await archive.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    await core.hydrate(["doc1"])
    expect(await store.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
  })

  it("clearAll wipes the store only; archive is preserved", async () => {
    await core.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    await core.flushToArchive(["doc1"])
    await core.clearAll()

    expect(await store.load(["doc1", "snapshot", "h1"])).toBeUndefined()
    expect(await archive.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
  })

  it("load promotes an archive chunk into the store on a store miss", async () => {
    await archive.save(["doc1", "snapshot", "h1"], new Uint8Array([7]))
    expect(await store.load(["doc1", "snapshot", "h1"])).toBeUndefined()

    expect(await core.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([7])
    )
    // Now lives in the store too — subsequent reads bypass the archive.
    expect(await store.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([7])
    )
  })

  it("loadRange promotes archive-only chunks into the store", async () => {
    await archive.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    await archive.save(["doc1", "incremental", "h2"], new Uint8Array([2]))

    const chunks = await core.loadRange(["doc1"])
    expect(chunks).toHaveLength(2)

    expect(await store.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    expect(await store.load(["doc1", "incremental", "h2"])).toEqual(
      new Uint8Array([2])
    )
  })

  it("loadRange does not overwrite store data with a stale archive copy", async () => {
    // Same key in both tiers with diverged data (should never happen with
    // content-addressed chunks, but guards the merge semantics).
    await store.save(["doc1", "snapshot", "h1"], new Uint8Array([99]))
    await archive.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))

    await core.loadRange(["doc1"])
    expect(await store.load(["doc1", "snapshot", "h1"])).toEqual(
      new Uint8Array([99])
    )
  })
})

// ── RepoStoreCore ─────────────────────────────────────────────────────

function newRepo(
  resolve: (docId: string) => DocStoreInterface,
  opts: { meta?: MetaStore; index?: DocIndex } = {}
): RepoStoreCore {
  return new RepoStoreCore({
    resolve,
    meta: opts.meta ?? new MemoryMetaStore(),
    index: opts.index ?? new MemoryDocIndex(),
  })
}

describe("RepoStoreCore", () => {
  it("routes ops to the doc store identified by key[0]", async () => {
    const docStores = new Map<string, DocStoreCore>()
    const resolve = (docId: string): DocStoreInterface => {
      let store = docStores.get(docId)
      if (!store) {
        store = new DocStoreCore(new MemoryStorageAdapter())
        docStores.set(docId, store)
      }
      return store
    }

    const repo = newRepo(resolve)

    await repo.save(["docA", "snapshot", "h1"], new Uint8Array([1]))
    await repo.save(["docB", "snapshot", "h2"], new Uint8Array([2]))

    expect(await repo.load(["docA", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    expect(await repo.load(["docB", "snapshot", "h2"])).toEqual(
      new Uint8Array([2])
    )
    expect(docStores.size).toBe(2)
  })

  it("loadRange and removeRange route on the prefix's first segment", async () => {
    const resolveSpy = mock((_docId: string): DocStoreInterface => {
      return new DocStoreCore(new MemoryStorageAdapter())
    })
    // Pre-seed the index so the router doesn't short-circuit unknown docs.
    const index = new MemoryDocIndex()
    await index.add("docA")
    await index.add("docB")
    const repo = newRepo(resolveSpy, { index })

    await repo.loadRange(["docA", "snapshot"])
    await repo.removeRange(["docB", "incremental"])

    const calls = resolveSpy.mock.calls.map((c) => c[0])
    expect(calls).toEqual(["docA", "docB"])
  })

  it("throws on an empty key for single-chunk ops", async () => {
    const repo = newRepo(() => {
      throw new Error("should not resolve")
    })
    await expect(repo.load([])).rejects.toThrow("documentId")
    await expect(repo.save([], new Uint8Array())).rejects.toThrow("documentId")
    await expect(repo.remove([])).rejects.toThrow("documentId")
  })

  it("throws on an empty prefix for range ops", async () => {
    const repo = newRepo(() => {
      throw new Error("should not resolve")
    })
    await expect(repo.loadRange([])).rejects.toThrow("documentId")
    await expect(repo.removeRange([])).rejects.toThrow("documentId")
  })

  it("resolves the doc store on every call (no caching assumed)", async () => {
    const resolveSpy = mock(() => new DocStoreCore(new MemoryStorageAdapter()))
    const repo = newRepo(resolveSpy)

    // save adds docA to the index; subsequent load/remove pass the gate.
    await repo.save(["docA", "snapshot", "h1"], new Uint8Array([1]))
    await repo.load(["docA", "snapshot", "h1"])
    await repo.remove(["docA", "snapshot", "h1"])

    expect(resolveSpy).toHaveBeenCalledTimes(3)
  })
})

describe("RepoStoreCore meta routing (length-1 keys)", () => {
  it("routes length-1 load/save/remove to the meta store, not a doc store", async () => {
    const resolveSpy = mock(
      (_docId: string): DocStoreInterface => {
        throw new Error("resolve must not be called for length-1 keys")
      }
    )
    const meta = new MemoryMetaStore()
    const repo = newRepo(resolveSpy, { meta })

    const id = new TextEncoder().encode("bd0a39cb-7f73-4395-9174-e519e68cf4b0")
    await repo.save(["storage-adapter-id"], id)

    expect(await repo.load(["storage-adapter-id"])).toEqual(id)
    expect(await meta.load(["storage-adapter-id"])).toEqual(id)
    expect(resolveSpy).not.toHaveBeenCalled()

    await repo.remove(["storage-adapter-id"])
    expect(await repo.load(["storage-adapter-id"])).toBeUndefined()
  })

  it("does not add length-1 keys to the doc index", async () => {
    const index = new MemoryDocIndex()
    const repo = newRepo(
      () => {
        throw new Error("resolve must not be called")
      },
      { index }
    )

    await repo.save(["storage-adapter-id"], new Uint8Array([1]))
    expect(await index.has("storage-adapter-id")).toBe(false)
  })
})

describe("RepoStoreCore unknown-doc short-circuit", () => {
  it("load returns undefined for an unknown doc without resolving", async () => {
    const resolveSpy = mock(
      (_docId: string): DocStoreInterface => {
        throw new Error("resolve must not be called")
      }
    )
    const repo = newRepo(resolveSpy)

    expect(
      await repo.load(["never-written", "snapshot", "h1"])
    ).toBeUndefined()
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it("loadRange returns [] for an unknown doc without resolving", async () => {
    const resolveSpy = mock(
      (_docId: string): DocStoreInterface => {
        throw new Error("resolve must not be called")
      }
    )
    const repo = newRepo(resolveSpy)

    expect(await repo.loadRange(["never-written"])).toEqual([])
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it("remove and removeRange are no-ops for unknown docs", async () => {
    const resolveSpy = mock(
      (_docId: string): DocStoreInterface => {
        throw new Error("resolve must not be called")
      }
    )
    const repo = newRepo(resolveSpy)

    await repo.remove(["never-written", "snapshot", "h1"])
    await repo.removeRange(["never-written"])
    expect(resolveSpy).not.toHaveBeenCalled()
  })

  it("save populates the index so subsequent reads see the doc", async () => {
    const store = new MemoryStorageAdapter()
    const docCore = new DocStoreCore(store)
    const repo = newRepo(() => docCore)

    expect(await repo.load(["docA", "snapshot", "h1"])).toBeUndefined()

    await repo.save(["docA", "snapshot", "h1"], new Uint8Array([7]))
    expect(await repo.load(["docA", "snapshot", "h1"])).toEqual(
      new Uint8Array([7])
    )
    expect(await repo.loadRange(["docA"])).toHaveLength(1)
  })
})

describe("RepoStoreCore loadOrInit", () => {
  it("stores and returns the value when the key is absent", async () => {
    const meta = new MemoryMetaStore()
    const repo = newRepo(
      () => {
        throw new Error("resolve must not be called")
      },
      { meta }
    )

    const value = new TextEncoder().encode("automerge:abc123")
    expect(await repo.loadOrInit(["default-root"], value)).toEqual(value)
    expect(await meta.load(["default-root"])).toEqual(value)
  })

  it("returns the existing value unchanged when the key is present", async () => {
    const repo = newRepo(() => {
      throw new Error("resolve must not be called")
    })

    const first = new TextEncoder().encode("winner")
    const second = new TextEncoder().encode("loser")
    await repo.loadOrInit(["default-root"], first)
    expect(await repo.loadOrInit(["default-root"], second)).toEqual(first)
    expect(await repo.load(["default-root"])).toEqual(first)
  })

  it("rejects doc-scoped (multi-segment) keys", async () => {
    const repo = newRepo(() => {
      throw new Error("resolve must not be called")
    })

    await expect(
      repo.loadOrInit(["docA", "root"], new Uint8Array([1]))
    ).rejects.toThrow("single-segment")
  })

  it("rejects an empty key", async () => {
    const repo = newRepo(() => {
      throw new Error("resolve must not be called")
    })

    await expect(repo.loadOrInit([], new Uint8Array([1]))).rejects.toThrow(
      "documentId"
    )
  })
})

// ── RepoStoreAdapter ──────────────────────────────────────────────────

describe("RepoStoreAdapter", () => {
  it("delegates each StorageAdapterInterface method to the stub", async () => {
    const stub = {
      load: mock(() => Promise.resolve(new Uint8Array([1]))),
      save: mock(() => Promise.resolve()),
      remove: mock(() => Promise.resolve()),
      loadRange: mock(() => Promise.resolve([])),
      removeRange: mock(() => Promise.resolve()),
    }
    const adapter = new RepoStoreAdapter(stub)

    const key = ["docA", "snapshot", "h1"]
    const data = new Uint8Array([1])

    await adapter.load(key)
    await adapter.save(key, data)
    await adapter.remove(key)
    await adapter.loadRange(["docA"])
    await adapter.removeRange(["docA"])

    expect(stub.load).toHaveBeenCalledWith(key)
    expect(stub.save).toHaveBeenCalledWith(key, data)
    expect(stub.remove).toHaveBeenCalledWith(key)
    expect(stub.loadRange).toHaveBeenCalledWith(["docA"])
    expect(stub.removeRange).toHaveBeenCalledWith(["docA"])
  })

  it("returns values from the stub", async () => {
    const stub = {
      load: mock(() => Promise.resolve(new Uint8Array([42]))),
      save: mock(() => Promise.resolve()),
      remove: mock(() => Promise.resolve()),
      loadRange: mock(() =>
        Promise.resolve([
          { key: ["docA", "snapshot", "h1"], data: new Uint8Array([42]) },
        ])
      ),
      removeRange: mock(() => Promise.resolve()),
    }
    const adapter = new RepoStoreAdapter(stub)

    expect(await adapter.load(["docA", "snapshot", "h1"])).toEqual(
      new Uint8Array([42])
    )
    const chunks = await adapter.loadRange(["docA"])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.data).toEqual(new Uint8Array([42]))
  })
})

// ── End-to-end ────────────────────────────────────────────────────────

describe("RepoStoreAdapter → RepoStoreCore → DocStoreCore (in-memory)", () => {
  it("routes a full workflow across two documents", async () => {
    const docStores = new Map<string, DocStoreCore>()
    const resolve = (docId: string): DocStoreInterface => {
      let store = docStores.get(docId)
      if (!store) {
        store = new DocStoreCore(new MemoryStorageAdapter())
        docStores.set(docId, store)
      }
      return store
    }
    const repo = newRepo(resolve)
    const adapter = new RepoStoreAdapter(repo)

    await adapter.save(["docA", "snapshot", "h1"], new Uint8Array([1]))
    await adapter.save(["docA", "incremental", "h2"], new Uint8Array([2]))
    await adapter.save(["docB", "snapshot", "h3"], new Uint8Array([3]))

    expect(await adapter.loadRange(["docA"])).toHaveLength(2)
    expect(await adapter.loadRange(["docB"])).toHaveLength(1)

    await adapter.removeRange(["docA", "incremental"])
    expect(await adapter.loadRange(["docA"])).toHaveLength(1)

    // Per-doc DOs are isolated.
    expect(docStores.size).toBe(2)
  })

  it("stores adapter-id meta separately from per-doc state", async () => {
    const docStores = new Map<string, DocStoreCore>()
    const resolve = (docId: string): DocStoreInterface => {
      let store = docStores.get(docId)
      if (!store) {
        store = new DocStoreCore(new MemoryStorageAdapter())
        docStores.set(docId, store)
      }
      return store
    }
    const meta = new MemoryMetaStore()
    const repo = newRepo(resolve, { meta })
    const adapter = new RepoStoreAdapter(repo)

    const id = new TextEncoder().encode("uuid-here")
    await adapter.save(["storage-adapter-id"], id)
    await adapter.save(["docA", "snapshot", "h1"], new Uint8Array([1]))

    expect(await adapter.load(["storage-adapter-id"])).toEqual(id)
    // No DocStoreDO was spun up for the adapter id.
    expect(docStores.has("storage-adapter-id")).toBe(false)
    // Only one doc store was created, for docA.
    expect(Array.from(docStores.keys())).toEqual(["docA"])
  })
})
