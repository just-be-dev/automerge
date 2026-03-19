import { describe, expect, it, beforeEach } from "bun:test"
import { Database, type SQLQueryBindings } from "bun:sqlite"
import { DOStorageAdapter } from "./index.ts"

function createMockStorage(): DurableObjectStorage {
  const db = new Database(":memory:")

  return {
    sql: {
      exec(query: string, ...bindings: SQLQueryBindings[]) {
        const stmt = db.prepare(query)
        if (query.trimStart().startsWith("SELECT")) {
          return { toArray: () => stmt.all(...bindings) }
        }
        stmt.run(...bindings)
        return { toArray: () => [] }
      },
    },
  } as unknown as DurableObjectStorage
}

describe("DOStorageAdapter", () => {
  let storage: DurableObjectStorage
  let adapter: DOStorageAdapter

  beforeEach(() => {
    storage = createMockStorage()
    adapter = new DOStorageAdapter(storage)
  })

  it("returns undefined for missing keys", async () => {
    expect(await adapter.load(["abc123", "snapshot", "h1"])).toBeUndefined()
  })

  it("saves and loads data", async () => {
    const key = ["abc123", "snapshot", "hash1"]
    const data = new Uint8Array([1, 2, 3, 4])
    await adapter.save(key, data)
    expect(await adapter.load(key)).toEqual(data)
  })

  it("removes data", async () => {
    const key = ["abc123", "snapshot", "hash1"]
    await adapter.save(key, new Uint8Array([1, 2, 3]))
    await adapter.remove(key)
    expect(await adapter.load(key)).toBeUndefined()
  })

  it("loads a range of keys by prefix", async () => {
    await adapter.save(["abc123", "incremental", "h1"], new Uint8Array([1]))
    await adapter.save(["abc123", "incremental", "h2"], new Uint8Array([2]))
    await adapter.save(["abc123", "snapshot", "h3"], new Uint8Array([3]))

    const chunks = await adapter.loadRange(["abc123", "incremental"])
    expect(chunks).toHaveLength(2)
    expect(chunks.map((c) => c.key)).toEqual(
      expect.arrayContaining([
        ["abc123", "incremental", "h1"],
        ["abc123", "incremental", "h2"],
      ])
    )
  })

  it("removes a range of keys by prefix", async () => {
    await adapter.save(["abc123", "incremental", "h1"], new Uint8Array([1]))
    await adapter.save(["abc123", "incremental", "h2"], new Uint8Array([2]))
    await adapter.save(["abc123", "snapshot", "h3"], new Uint8Array([3]))

    await adapter.removeRange(["abc123", "incremental"])

    const remaining = await adapter.loadRange(["abc123", "incremental"])
    expect(remaining).toHaveLength(0)

    expect(await adapter.load(["abc123", "snapshot", "h3"])).toEqual(
      new Uint8Array([3])
    )
  })
})
