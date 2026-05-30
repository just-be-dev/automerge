import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
} from "bun:test"
import { Database } from "bun:sqlite"

// The DurableObject base class is the only thing we use from cloudflare:workers,
// and we just want it to be a no-op super() target. Must be mocked before
// importing DocStoreDO.
mock.module("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(_ctx: unknown, _env: unknown) {}
  },
}))

const { DocStoreDO } = await import("./doc-store-do.ts")

// ── Thin SqlStorage shim over bun:sqlite ──────────────────────────────

function makeSql(db: Database) {
  return {
    exec<T>(sql: string, ...params: unknown[]) {
      const stmt = db.query(sql)
      const isSelect = sql.trimStart().slice(0, 6).toUpperCase() === "SELECT"
      if (isSelect) {
        const rows = stmt.all(...(params as never[])) as T[]
        return { toArray: () => rows }
      }
      stmt.run(...(params as never[]))
      return { toArray: () => [] as T[] }
    },
  }
}

// ── In-memory R2 stand-in ─────────────────────────────────────────────

class MemoryR2 {
  objects = new Map<string, Uint8Array>()

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

  async list(opts: { prefix?: string }) {
    const prefix = opts.prefix ?? ""
    const objects = Array.from(this.objects.keys())
      .filter((k) => k.startsWith(prefix))
      .map((key) => ({ key }))
    return { objects, truncated: false as const }
  }
}

// ── Mock DurableObjectState ───────────────────────────────────────────

function makeCtx() {
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
        sql: makeSql(db),
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
