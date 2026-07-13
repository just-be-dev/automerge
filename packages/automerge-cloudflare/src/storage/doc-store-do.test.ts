import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
  setSystemTime,
} from "bun:test"
import { Database } from "bun:sqlite"
import { Repo } from "@automerge/automerge-repo"
import type { Chunk, DocumentId, StorageKey } from "@automerge/automerge-repo"
import { RepoStoreAdapter } from "./adapter.ts"

// The DurableObject base class is the only thing we use from cloudflare:workers,
// and we just want it to be a no-op super() target. Must be mocked before
// importing DO modules. Static imports cannot work here because they would load
// cloudflare:workers before bun:test installs this mock.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}))

const { DocStoreDO } = await import("./doc-store-do.ts")
const { RepoStoreDO } = await import("./repo-store-do.ts")

// ── Thin SqlStorage shim over bun:sqlite ──────────────────────────────

interface SqlStats {
  execs: number
  chunkUpserts: number
  chunkDeletes: number
  chunkDeleteRanges: number
  metaUpserts: number
  savedChunkBytes: number
}

function newSqlStats(): SqlStats {
  return {
    execs: 0,
    chunkUpserts: 0,
    chunkDeletes: 0,
    chunkDeleteRanges: 0,
    metaUpserts: 0,
    savedChunkBytes: 0,
  }
}

function makeSql(db: Database, stats?: SqlStats) {
  return {
    exec<T>(sql: string, ...params: unknown[]) {
      const stmt = db.query(sql)
      const isSelect = sql.trimStart().slice(0, 6).toUpperCase() === "SELECT"
      if (isSelect) {
        const rows = stmt.all(...(params as never[])) as T[]
        return { toArray: () => rows }
      }

      if (stats) {
        stats.execs++
        const normalizedSql = sql.replace(/\s+/g, " ").trim()
        if (normalizedSql.startsWith("INSERT INTO automerge_storage")) {
          stats.chunkUpserts++
          stats.savedChunkBytes += byteLength(params[1])
        } else if (
          normalizedSql.startsWith("DELETE FROM automerge_storage WHERE key =")
        ) {
          stats.chunkDeletes++
        } else if (
          normalizedSql.startsWith("DELETE FROM automerge_storage WHERE key LIKE")
        ) {
          stats.chunkDeleteRanges++
        } else if (normalizedSql === "DELETE FROM automerge_storage") {
          stats.chunkDeleteRanges++
        } else if (normalizedSql.startsWith("INSERT INTO automerge_meta")) {
          stats.metaUpserts++
        }
      }

      stmt.run(...(params as never[]))
      return { toArray: () => [] as T[] }
    },
  }
}

function byteLength(value: unknown): number {
  if (value instanceof Uint8Array) return value.byteLength
  if (value instanceof ArrayBuffer) return value.byteLength
  return 0
}

// ── In-memory R2 stand-in ─────────────────────────────────────────────

class MemoryR2 {
  objects = new Map<string, Uint8Array>()
  listCalls = 0
  #pageSize: number

  /** `pageSize` caps each `list` page to exercise cursor pagination. */
  constructor(pageSize = Number.POSITIVE_INFINITY) {
    this.#pageSize = pageSize
  }

  async get(key: string) {
    const v = this.objects.get(key)
    if (!v) return null
    return {
      arrayBuffer: async () =>
        v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength),
    }
  }

  async put(key: string, value: Uint8Array) {
    this.objects.set(key, new Uint8Array(value))
  }

  async delete(keys: string | string[]) {
    if (Array.isArray(keys)) {
      for (const k of keys) this.objects.delete(k)
    } else {
      this.objects.delete(keys)
    }
  }

  async list(opts: { prefix?: string; cursor?: string }) {
    this.listCalls++
    const prefix = opts.prefix ?? ""
    const all = Array.from(this.objects.keys())
      .filter((k) => k.startsWith(prefix))
      .sort()
    const start = opts.cursor ? Number(opts.cursor) : 0
    const page = all.slice(start, start + this.#pageSize)
    const truncated = start + page.length < all.length
    return {
      objects: page.map((key) => ({ key })),
      truncated,
      cursor: truncated ? String(start + page.length) : undefined,
    }
  }
}

// ── Mock DurableObjectState ───────────────────────────────────────────

function makeCtx(stats?: SqlStats) {
  const db = new Database(":memory:")
  let alarmTime: number | null = null
  const setAlarm = mock(async (t: number) => {
    alarmTime = t
  })
  const getAlarm = mock(async () => alarmTime)
  return {
    db,
    setAlarm,
    getAlarm,
    state: {
      storage: {
        sql: makeSql(db, stats),
        setAlarm,
        getAlarm,
      },
    },
  }
}

function countChunks(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM automerge_storage")
    .get() as { n: number }
  return row.n
}

function resetSqlStats(stats: SqlStats): void {
  stats.execs = 0
  stats.chunkUpserts = 0
  stats.chunkDeletes = 0
  stats.chunkDeleteRanges = 0
  stats.metaUpserts = 0
  stats.savedChunkBytes = 0
}

function sumChunkBytes(db: Database): number {
  const row = db
    .query("SELECT COALESCE(SUM(length(data)), 0) AS n FROM automerge_storage")
    .get() as { n: number }
  return row.n
}

function countChunksLike(db: Database, pattern: string): number {
  const row = db
    .query("SELECT COUNT(*) AS n FROM automerge_storage WHERE key LIKE ?")
    .get(pattern) as { n: number }
  return row.n
}

type BenchmarkWritePattern = "burst" | "flush-after-each-edit"

interface BenchDoc {
  counter: number
  entries: string[]
}

interface DocStoreCalls {
  save: number
  remove: number
  removeRange: number
  loadRange: number
}

interface CountedDocStore {
  load(key: StorageKey): Promise<Uint8Array | undefined>
  save(key: StorageKey, data: Uint8Array): Promise<void>
  remove(key: StorageKey): Promise<void>
  loadRange(prefix: StorageKey): Promise<Chunk[]>
  removeRange(prefix: StorageKey): Promise<void>
}

interface DocStoreRecord {
  db: Database
  sql: SqlStats
  calls: DocStoreCalls
  store: CountedDocStore
  r2?: MemoryR2
}

interface BenchmarkReport {
  updates: number
  pattern: BenchmarkWritePattern
  archiveBound: boolean
  docId: DocumentId
  docSaveCalls: number
  docRemoveCalls: number
  docRemoveRangeCalls: number
  docLoadRangeCalls: number
  chunkUpserts: number
  chunkDeletes: number
  chunkDeleteRanges: number
  metaUpserts: number
  savedChunkBytes: number
  liveChunks: number
  snapshotChunks: number
  incrementalChunks: number
  liveChunkBytes: number
  sqliteImageBytes: number
  r2Objects: number
  repoDocSavedEvents: number
  repoDocCompactedEvents: number
  finalCounter: number
}

function makeDocStoreNamespace(archiveBound: boolean) {
  const records = new Map<string, DocStoreRecord>()

  const namespace = {
    idFromName(name: string) {
      return name
    },
    get(docId: string) {
      const existing = records.get(docId)
      if (existing) return existing.store

      const sql = newSqlStats()
      const ctx = makeCtx(sql)
      const r2 = archiveBound ? new MemoryR2() : undefined
      const doc = new DocStoreDO(ctx.state as never, {
        AUTOMERGE_R2: r2 as never,
        AUTOMERGE_IDLE_FLUSH_MS: IDLE,
      })
      const calls: DocStoreCalls = {
        save: 0,
        remove: 0,
        removeRange: 0,
        loadRange: 0,
      }
      const store: CountedDocStore = {
        load: (key) => doc.load(key),
        save: async (key, data) => {
          calls.save++
          await doc.save(key, data)
        },
        remove: async (key) => {
          calls.remove++
          await doc.remove(key)
        },
        loadRange: async (prefix) => {
          calls.loadRange++
          return doc.loadRange(prefix)
        },
        removeRange: async (prefix) => {
          calls.removeRange++
          await doc.removeRange(prefix)
        },
      }
      const record: DocStoreRecord = { db: ctx.db, sql, calls, store, r2 }
      records.set(docId, record)
      return store
    },
  }

  return { namespace, records }
}

async function runDocDoAutomergeBenchmark(opts: {
  updates: number
  pattern: BenchmarkWritePattern
  archiveBound: boolean
}): Promise<BenchmarkReport> {
  const { namespace, records } = makeDocStoreNamespace(opts.archiveBound)
  const repoCtx = makeCtx()
  const repoStore = new RepoStoreDO(repoCtx.state as never, {
    AUTOMERGE_DOC_STORE: namespace as never,
  })
  const repo = new Repo({
    network: [],
    storage: new RepoStoreAdapter(repoStore as never),
    saveDebounceRate: 0,
  })
  const repoMetrics: Array<{ type: string }> = []
  repo.on("doc-metrics", (event) => repoMetrics.push(event))
  await repo.storageId()

  const handle = repo.create<BenchDoc>({ counter: 0, entries: [] })
  const docId = handle.documentId
  await repo.flush([docId])
  jest.clearAllTimers()

  const record = records.get(docId)
  if (!record) throw new Error(`DocStoreDO was not created for ${docId}`)
  resetSqlStats(record.sql)
  record.calls.save = 0
  record.calls.remove = 0
  record.calls.removeRange = 0
  record.calls.loadRange = 0
  repoMetrics.length = 0

  for (let i = 0; i < opts.updates; i++) {
    handle.change((doc) => {
      doc.counter += 1
      doc.entries.push(`${i.toString().padStart(4, "0")}: ${"x".repeat(64)}`)
    })
    if (opts.pattern === "flush-after-each-edit") {
      await repo.flush([docId])
      jest.clearAllTimers()
    }
  }

  await repo.flush([docId])
  jest.clearAllTimers()

  // Exercise the same doc-scoped read path consumers use after writes settle.
  const chunks = await repoStore.loadRange([docId])
  expect(chunks.length).toBe(countChunks(record.db))

  const finalDoc = handle.doc()
  await repo.shutdown()

  return {
    updates: opts.updates,
    pattern: opts.pattern,
    archiveBound: opts.archiveBound,
    docId,
    docSaveCalls: record.calls.save,
    docRemoveCalls: record.calls.remove,
    docRemoveRangeCalls: record.calls.removeRange,
    docLoadRangeCalls: record.calls.loadRange,
    chunkUpserts: record.sql.chunkUpserts,
    chunkDeletes: record.sql.chunkDeletes,
    chunkDeleteRanges: record.sql.chunkDeleteRanges,
    metaUpserts: record.sql.metaUpserts,
    savedChunkBytes: record.sql.savedChunkBytes,
    liveChunks: countChunks(record.db),
    snapshotChunks: countChunksLike(record.db, "%/snapshot/%"),
    incrementalChunks: countChunksLike(record.db, "%/incremental/%"),
    liveChunkBytes: sumChunkBytes(record.db),
    sqliteImageBytes: record.db.serialize().byteLength,
    r2Objects: record.r2?.objects.size ?? 0,
    repoDocSavedEvents: repoMetrics.filter((e) => e.type === "doc-saved")
      .length,
    repoDocCompactedEvents: repoMetrics.filter(
      (e) => e.type === "doc-compacted"
    ).length,
    finalCounter: finalDoc.counter,
  }
}

// ── Tests ─────────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000
const IDLE = 60_000

describe("DocStoreDO idle-flush alarm", () => {
  beforeEach(() => {
    setSystemTime(new Date(T0))
  })

  afterEach(() => {
    setSystemTime()
  })

  it("does not arm an alarm when no archive is bound", async () => {
    const ctx = makeCtx()
    const doc = new DocStoreDO(ctx.state as never, {})
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    expect(ctx.setAlarm).not.toHaveBeenCalled()
    // But the write itself still landed in the store.
    expect(countChunks(ctx.db)).toBe(1)
  })

  it("arms an alarm on the first write at now + idleFlushMs", async () => {
    const ctx = makeCtx()
    const r2 = new MemoryR2()
    const doc = new DocStoreDO(ctx.state as never, {
      AUTOMERGE_R2: r2 as never,
      AUTOMERGE_IDLE_FLUSH_MS: IDLE,
    })
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    expect(ctx.setAlarm).toHaveBeenCalledTimes(1)
    expect(ctx.setAlarm).toHaveBeenCalledWith(T0 + IDLE)
  })

  it("does not re-arm the alarm on subsequent writes within the window", async () => {
    const ctx = makeCtx()
    const r2 = new MemoryR2()
    const doc = new DocStoreDO(ctx.state as never, {
      AUTOMERGE_R2: r2 as never,
      AUTOMERGE_IDLE_FLUSH_MS: IDLE,
    })
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))

    setSystemTime(new Date(T0 + 10_000))
    await doc.save(["doc1", "incremental", "h2"], new Uint8Array([2]))

    expect(ctx.setAlarm).toHaveBeenCalledTimes(1)
  })

  it("alarm flushes the store to the archive when the doc is idle", async () => {
    const ctx = makeCtx()
    const r2 = new MemoryR2()
    const doc = new DocStoreDO(ctx.state as never, {
      AUTOMERGE_R2: r2 as never,
      AUTOMERGE_IDLE_FLUSH_MS: IDLE,
    })
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    expect(countChunks(ctx.db)).toBe(1)

    setSystemTime(new Date(T0 + IDLE + 1))
    await doc.alarm()

    expect(countChunks(ctx.db)).toBe(0)
    expect(r2.objects.size).toBe(1)
  })

  it("alarm reschedules itself when a later write extended the idle window", async () => {
    const ctx = makeCtx()
    const r2 = new MemoryR2()
    const doc = new DocStoreDO(ctx.state as never, {
      AUTOMERGE_R2: r2 as never,
      AUTOMERGE_IDLE_FLUSH_MS: IDLE,
    })
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    // Initial alarm: T0 + IDLE.

    // A second write within the window doesn't re-arm the alarm, but it
    // bumps the stored lastWrite to T0 + 30_000.
    setSystemTime(new Date(T0 + 30_000))
    await doc.save(["doc1", "incremental", "h2"], new Uint8Array([2]))

    // Alarm fires at T0 + IDLE; the doc is still considered "active" because
    // lastWrite (T0 + 30_000) + IDLE > now.
    setSystemTime(new Date(T0 + IDLE + 1))
    await doc.alarm()

    // The store is untouched; alarm rescheduled for lastWrite + IDLE.
    expect(countChunks(ctx.db)).toBe(2)
    expect(r2.objects.size).toBe(0)
    expect(ctx.setAlarm).toHaveBeenCalledTimes(2)
    expect(ctx.setAlarm.mock.calls[1]).toEqual([T0 + 30_000 + IDLE])
  })

  it("alarm is a no-op when no archive is bound", async () => {
    const ctx = makeCtx()
    const doc = new DocStoreDO(ctx.state as never, {})
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    await doc.alarm()
    expect(countChunks(ctx.db)).toBe(1)
    expect(ctx.setAlarm).not.toHaveBeenCalled()
  })

  it("falls back to the 7-day default when AUTOMERGE_IDLE_FLUSH_MS is unset", async () => {
    const ctx = makeCtx()
    const r2 = new MemoryR2()
    const doc = new DocStoreDO(ctx.state as never, {
      AUTOMERGE_R2: r2 as never,
    })
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))

    const SEVEN_DAYS = 1000 * 60 * 60 * 24 * 7
    expect(ctx.setAlarm).toHaveBeenCalledWith(T0 + SEVEN_DAYS)
  })

  it("accepts a numeric string for AUTOMERGE_IDLE_FLUSH_MS (wrangler [vars])", async () => {
    const ctx = makeCtx()
    const r2 = new MemoryR2()
    const doc = new DocStoreDO(ctx.state as never, {
      AUTOMERGE_R2: r2 as never,
      AUTOMERGE_IDLE_FLUSH_MS: "90000",
    })
    await doc.save(["doc1", "snapshot", "h1"], new Uint8Array([1]))
    expect(ctx.setAlarm).toHaveBeenCalledWith(T0 + 90_000)
  })
})

describe("SqliteStore prefix matching", () => {
  it("does not treat LIKE wildcards in key segments as wildcards", async () => {
    const ctx = makeCtx()
    const doc = new DocStoreDO(ctx.state as never, {})

    // Without ESCAPE, the `_` in "doc_1" would match any character and the
    // "docX1" rows would leak into doc_1's range ops.
    await doc.save(["doc_1", "snapshot", "h1"], new Uint8Array([1]))
    await doc.save(["docX1", "snapshot", "h2"], new Uint8Array([2]))
    await doc.save(["doc%1", "snapshot", "h3"], new Uint8Array([3]))

    const chunks = await doc.loadRange(["doc_1"])
    expect(chunks.map((c) => c.key)).toEqual([["doc_1", "snapshot", "h1"]])

    await doc.removeRange(["doc_1"])
    expect(countChunks(ctx.db)).toBe(2)
    expect(await doc.load(["docX1", "snapshot", "h2"])).toEqual(
      new Uint8Array([2])
    )
    expect(await doc.load(["doc%1", "snapshot", "h3"])).toEqual(
      new Uint8Array([3])
    )
  })
})

describe("R2Archive pagination", () => {
  it("hydrate follows list cursors across truncated pages", async () => {
    const ctx = makeCtx()
    const r2 = new MemoryR2(2) // 2 keys per page → 5 keys = 3 pages
    const doc = new DocStoreDO(ctx.state as never, {
      AUTOMERGE_R2: r2 as never,
    })

    for (let i = 0; i < 5; i++) {
      await r2.put(`doc1/snapshot/h${i}`, new Uint8Array([i]))
    }

    await doc.hydrate(["doc1"])

    expect(countChunks(ctx.db)).toBe(5)
    expect(r2.listCalls).toBe(3)
    expect(await doc.load(["doc1", "snapshot", "h4"])).toEqual(
      new Uint8Array([4])
    )
  })
})

describe("DocStoreDO Automerge storage benchmark", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: T0 })
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
  })

  it("reports doc-store writes and SQLite footprint for Automerge edits", async () => {
    const cases: Array<{
      updates: number
      pattern: BenchmarkWritePattern
      archiveBound: boolean
    }> = [
      { updates: 1, pattern: "flush-after-each-edit", archiveBound: false },
      { updates: 10, pattern: "flush-after-each-edit", archiveBound: false },
      { updates: 100, pattern: "flush-after-each-edit", archiveBound: false },
      { updates: 100, pattern: "burst", archiveBound: false },
      { updates: 100, pattern: "flush-after-each-edit", archiveBound: true },
    ]

    const reports: BenchmarkReport[] = []
    for (const spec of cases) {
      reports.push(await runDocDoAutomergeBenchmark(spec))
    }

    const rows = reports.map((r) => ({
      case: `${r.updates} ${
        r.pattern === "burst" ? "burst" : "flush"
      }${r.archiveBound ? "+r2" : ""}`,
      saves: r.docSaveCalls,
      ups: r.chunkUpserts,
      del: r.chunkDeletes,
      meta: r.metaUpserts,
      savedB: r.savedChunkBytes,
      savedEv: r.repoDocSavedEvents,
      compactEv: r.repoDocCompactedEvents,
      chunks: r.liveChunks,
      snap: r.snapshotChunks,
      inc: r.incrementalChunks,
      liveB: r.liveChunkBytes,
      sqliteB: r.sqliteImageBytes,
    }))

    console.log("DocStoreDO writes")
    console.table(
      rows.map(({ case: label, saves, ups, del, meta, savedB }) => ({
        case: label,
        saves,
        ups,
        del,
        meta,
        savedB,
      }))
    )
    console.log("DocStoreDO footprint")
    console.table(
      rows.map(({ case: label, chunks, snap, inc, liveB, sqliteB }) => ({
        case: label,
        chunks,
        snap,
        inc,
        liveB,
        sqliteB,
      }))
    )
    console.log("Automerge storage events")
    console.table(
      rows.map(({ case: label, savedEv, compactEv }) => ({
        case: label,
        savedEv,
        compactEv,
      }))
    )

    for (const report of reports) {
      expect(report.finalCounter).toBe(report.updates)
      expect(report.docSaveCalls).toBeGreaterThan(0)
      expect(report.chunkUpserts).toBeGreaterThan(0)
      expect(report.savedChunkBytes).toBeGreaterThan(0)
      expect(report.liveChunks).toBeGreaterThan(0)
      expect(report.liveChunkBytes).toBeGreaterThan(0)
      expect(report.sqliteImageBytes).toBeGreaterThanOrEqual(
        report.liveChunkBytes
      )
      expect(report.r2Objects).toBe(0)
      expect(report.docLoadRangeCalls).toBe(1)
    }

    const burst100 = reports.find(
      (r) =>
        r.updates === 100 && r.pattern === "burst" && r.archiveBound === false
    )
    const flushed100 = reports.find(
      (r) =>
        r.updates === 100 &&
        r.pattern === "flush-after-each-edit" &&
        r.archiveBound === false
    )
    const archived100 = reports.find(
      (r) =>
        r.updates === 100 &&
        r.pattern === "flush-after-each-edit" &&
        r.archiveBound === true
    )

    expect(burst100).toBeDefined()
    expect(flushed100).toBeDefined()
    expect(archived100).toBeDefined()
    expect(flushed100!.docSaveCalls).toBeGreaterThan(burst100!.docSaveCalls)
    expect(flushed100!.savedChunkBytes).toBeGreaterThan(
      burst100!.savedChunkBytes
    )
    expect(archived100!.metaUpserts).toBeGreaterThan(0)
  })
})
