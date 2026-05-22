import { describe, expect, it, beforeEach, mock } from "bun:test"
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo"
import { TieredStorageAdapter } from "./index.ts"

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
  if (key.length < prefix.length) return false
  return prefix.every((seg, i) => key[i] === seg)
}

describe("TieredStorageAdapter", () => {
  let hot: MemoryStorageAdapter
  let cold: MemoryStorageAdapter
  let adapter: TieredStorageAdapter

  beforeEach(() => {
    hot = new MemoryStorageAdapter()
    cold = new MemoryStorageAdapter()
    adapter = new TieredStorageAdapter(hot, cold)
  })

  it("returns undefined when neither tier has the key", async () => {
    expect(await adapter.load(["abc123", "snapshot", "h1"])).toBeUndefined()
  })

  it("reads from hot when present", async () => {
    const key = ["abc123", "snapshot", "h1"]
    await hot.save(key, new Uint8Array([1]))
    expect(await adapter.load(key)).toEqual(new Uint8Array([1]))
  })

  it("falls back to cold when hot is empty", async () => {
    const key = ["abc123", "snapshot", "h1"]
    await cold.save(key, new Uint8Array([2]))
    expect(await adapter.load(key)).toEqual(new Uint8Array([2]))
  })

  it("save writes to hot only", async () => {
    const key = ["abc123", "snapshot", "h1"]
    await adapter.save(key, new Uint8Array([3]))
    expect(await hot.load(key)).toEqual(new Uint8Array([3]))
    expect(await cold.load(key)).toBeUndefined()
  })

  it("remove deletes from both tiers", async () => {
    const key = ["abc123", "snapshot", "h1"]
    await hot.save(key, new Uint8Array([1]))
    await cold.save(key, new Uint8Array([1]))

    await adapter.remove(key)

    expect(await hot.load(key)).toBeUndefined()
    expect(await cold.load(key)).toBeUndefined()
    expect(await adapter.load(key)).toBeUndefined()
  })

  it("loadRange merges chunks from both tiers", async () => {
    await hot.save(["abc123", "incremental", "h1"], new Uint8Array([1]))
    await cold.save(["abc123", "incremental", "h2"], new Uint8Array([2]))

    const chunks = await adapter.loadRange(["abc123", "incremental"])
    expect(chunks).toHaveLength(2)
    const byKey = new Map(chunks.map((c) => [c.key.join("/"), c.data]))
    expect(byKey.get("abc123/incremental/h1")).toEqual(new Uint8Array([1]))
    expect(byKey.get("abc123/incremental/h2")).toEqual(new Uint8Array([2]))
  })

  it("loadRange: hot wins on key collision", async () => {
    const key = ["abc123", "snapshot", "h1"]
    await cold.save(key, new Uint8Array([1]))
    await hot.save(key, new Uint8Array([2]))

    const chunks = await adapter.loadRange(["abc123", "snapshot"])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.data).toEqual(new Uint8Array([2]))
  })

  it("removeRange propagates to both tiers", async () => {
    await hot.save(["abc123", "incremental", "h1"], new Uint8Array([1]))
    await cold.save(["abc123", "incremental", "h2"], new Uint8Array([2]))
    await cold.save(["abc123", "snapshot", "h3"], new Uint8Array([3]))

    await adapter.removeRange(["abc123", "incremental"])

    expect(await hot.loadRange(["abc123", "incremental"])).toHaveLength(0)
    expect(await cold.loadRange(["abc123", "incremental"])).toHaveLength(0)
    expect(await cold.load(["abc123", "snapshot", "h3"])).toEqual(
      new Uint8Array([3])
    )
  })

  it("flushToCold copies chunks under prefix from hot to cold", async () => {
    await hot.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await hot.save(["abc123", "incremental", "h2"], new Uint8Array([2]))

    await adapter.flushToCold(["abc123"])

    expect(await cold.load(["abc123", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    expect(await cold.load(["abc123", "incremental", "h2"])).toEqual(
      new Uint8Array([2])
    )
  })

  it("flushToCold uses cold.saveChunks fast path when present", async () => {
    const saveChunksSpy = mock((_chunks: Chunk[]) => Promise.resolve())
    const saveSpy = mock(() => Promise.resolve())

    class SpyCold extends MemoryStorageAdapter {
      saveChunks = saveChunksSpy
      override save = saveSpy
    }

    const spyCold = new SpyCold()
    const tiered = new TieredStorageAdapter(hot, spyCold)

    await hot.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await hot.save(["abc123", "incremental", "h2"], new Uint8Array([2]))

    await tiered.flushToCold(["abc123"])

    expect(saveChunksSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy).not.toHaveBeenCalled()
    const callChunks = saveChunksSpy.mock.calls[0]![0] as Chunk[]
    expect(callChunks).toHaveLength(2)
  })

  it("flushToCold is idempotent", async () => {
    await hot.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))

    await adapter.flushToCold(["abc123"])
    await adapter.flushToCold(["abc123"])

    const all = await cold.loadRange(["abc123"])
    expect(all).toHaveLength(1)
    expect(all[0]!.data).toEqual(new Uint8Array([1]))
  })

  it("flushToCold respects prefix", async () => {
    await hot.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await hot.save(["xyz789", "snapshot", "h2"], new Uint8Array([2]))

    await adapter.flushToCold(["abc123"])

    expect(await cold.load(["abc123", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    expect(await cold.load(["xyz789", "snapshot", "h2"])).toBeUndefined()
  })

  it("flushToCold no-ops when prefix matches nothing", async () => {
    await adapter.flushToCold(["nonexistent"])
    expect(await cold.loadRange(["nonexistent"])).toHaveLength(0)
  })

  it("hydrate copies chunks under prefix from cold to hot", async () => {
    await cold.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await cold.save(["abc123", "incremental", "h2"], new Uint8Array([2]))

    await adapter.hydrate(["abc123"])

    expect(await hot.load(["abc123", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    expect(await hot.load(["abc123", "incremental", "h2"])).toEqual(
      new Uint8Array([2])
    )
  })

  it("hydrate uses hot.saveChunks fast path when present", async () => {
    const saveChunksSpy = mock((_chunks: Chunk[]) => Promise.resolve())
    const saveSpy = mock(() => Promise.resolve())

    class SpyHot extends MemoryStorageAdapter {
      saveChunks = saveChunksSpy
      override save = saveSpy
    }

    const spyHot = new SpyHot()
    const tiered = new TieredStorageAdapter(spyHot, cold)

    await cold.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await cold.save(["abc123", "incremental", "h2"], new Uint8Array([2]))

    await tiered.hydrate(["abc123"])

    expect(saveChunksSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy).not.toHaveBeenCalled()
  })

  it("hydrate is idempotent and respects prefix", async () => {
    await cold.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await cold.save(["xyz789", "snapshot", "h2"], new Uint8Array([2]))

    await adapter.hydrate(["abc123"])
    await adapter.hydrate(["abc123"])

    expect(await hot.loadRange(["abc123"])).toHaveLength(1)
    expect(await hot.load(["xyz789", "snapshot", "h2"])).toBeUndefined()
  })

  it("evictFromHot removes from hot only, cold copy preserved", async () => {
    await hot.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await cold.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))

    await adapter.evictFromHot(["abc123"])

    expect(await hot.load(["abc123", "snapshot", "h1"])).toBeUndefined()
    expect(await cold.load(["abc123", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
    // adapter.load still resolves via cold fallthrough
    expect(await adapter.load(["abc123", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
  })

  it("evictFromHot respects prefix", async () => {
    await hot.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await hot.save(["xyz789", "snapshot", "h2"], new Uint8Array([2]))

    await adapter.evictFromHot(["abc123"])

    expect(await hot.load(["abc123", "snapshot", "h1"])).toBeUndefined()
    expect(await hot.load(["xyz789", "snapshot", "h2"])).toEqual(
      new Uint8Array([2])
    )
  })

  it("clearHot removes everything from hot, cold preserved", async () => {
    await hot.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await hot.save(["xyz789", "snapshot", "h2"], new Uint8Array([2]))
    await cold.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))

    await adapter.clearHot()

    expect(await hot.loadRange([])).toHaveLength(0)
    expect(await cold.load(["abc123", "snapshot", "h1"])).toEqual(
      new Uint8Array([1])
    )
  })

  it("clearHot uses hot.clearAll fast path when present", async () => {
    const clearAllSpy = mock(() => Promise.resolve())
    const removeRangeSpy = mock(() => Promise.resolve())

    class SpyHot extends MemoryStorageAdapter {
      clearAll = clearAllSpy
      override removeRange = removeRangeSpy
    }

    const spyHot = new SpyHot()
    const tiered = new TieredStorageAdapter(spyHot, cold)

    await tiered.clearHot()

    expect(clearAllSpy).toHaveBeenCalledTimes(1)
    expect(removeRangeSpy).not.toHaveBeenCalled()
  })

  it("edits after eviction layer on top of cold via loadRange merge", async () => {
    // Pre-existing chunks live only in cold (post-eviction state).
    await cold.save(["abc123", "snapshot", "h1"], new Uint8Array([1]))
    await cold.save(["abc123", "incremental", "h2"], new Uint8Array([2]))

    // New edit arrives — writes to hot only.
    await adapter.save(["abc123", "incremental", "h3"], new Uint8Array([3]))

    const chunks = await adapter.loadRange(["abc123"])
    expect(chunks).toHaveLength(3)
    expect(await hot.loadRange(["abc123"])).toHaveLength(1)
    expect(await cold.loadRange(["abc123"])).toHaveLength(2)
  })
})
