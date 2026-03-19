import { describe, expect, it } from "bun:test"
import { Effect, Layer } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Repo } from "@automerge/automerge-repo"
import { AutomergeFsMultiDoc } from "./fs"
import { InMemoryBlobStore } from "./blob-store"
import { AutomergeFsFileSystem, AutomergeFsInstance, makeFs } from "./effect"

function makeTestLayer() {
  return Layer.succeed(
    AutomergeFsInstance,
    AutomergeFsMultiDoc.create({
      repo: new Repo({ network: [] }),
      blobStore: new InMemoryBlobStore(),
    })
  ).pipe((instanceLayer) => Layer.provide(AutomergeFsFileSystem, instanceLayer))
}

describe("AutomergeFs Effect FileSystem", () => {
  it("writeFileString and readFileString", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.writeFileString("/hello.txt", "world")
      return yield* fs.readFileString("/hello.txt")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result).toBe("world")
  })

  it("makeDirectory and readDirectory", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.makeDirectory("/src", { recursive: true })
      yield* fs.writeFileString("/src/a.ts", "const a = 1")
      yield* fs.writeFileString("/src/b.ts", "const b = 2")
      return yield* fs.readDirectory("/src")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result.sort()).toEqual(["a.ts", "b.ts"])
  })

  it("stat returns correct info", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.writeFileString("/test.txt", "hello")
      return yield* fs.stat("/test.txt")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result.type).toBe("File")
  })

  it("exists returns true for existing files", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.writeFileString("/exists.txt", "yes")
      const yes = yield* fs.exists("/exists.txt")
      const no = yield* fs.exists("/nope.txt")
      return { yes, no }
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result.yes).toBe(true)
    expect(result.no).toBe(false)
  })

  it("remove deletes files", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.writeFileString("/del.txt", "bye")
      yield* fs.remove("/del.txt")
      return yield* fs.exists("/del.txt")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result).toBe(false)
  })

  it("rename moves files", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.writeFileString("/old.txt", "content")
      yield* fs.rename("/old.txt", "/new.txt")
      const exists = yield* fs.exists("/old.txt")
      const content = yield* fs.readFileString("/new.txt")
      return { exists, content }
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result.exists).toBe(false)
    expect(result.content).toBe("content")
  })

  it("copy duplicates files", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.writeFileString("/orig.txt", "data")
      yield* fs.copy("/orig.txt", "/copy.txt")
      const orig = yield* fs.readFileString("/orig.txt")
      const copy = yield* fs.readFileString("/copy.txt")
      return { orig, copy }
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result.orig).toBe("data")
    expect(result.copy).toBe("data")
  })

  it("readDirectory recursive lists nested entries", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.makeDirectory("/src/components", { recursive: true })
      yield* fs.writeFileString("/src/index.ts", "export {}")
      yield* fs.writeFileString("/src/components/App.ts", "export const App = 1")
      return yield* fs.readDirectory("/src", { recursive: true })
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result.sort()).toEqual(["components", "components/App.ts", "index.ts"])
  })

  it("copy recursive duplicates a directory tree", async () => {
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.makeDirectory("/src", { recursive: true })
      yield* fs.writeFileString("/src/a.ts", "a")
      yield* fs.writeFileString("/src/b.ts", "b")
      yield* fs.copy("/src", "/backup")
      return yield* fs.readDirectory("/backup")
    })

    const result = await Effect.runPromise(
      Effect.provide(program, makeTestLayer())
    )
    expect(result.sort()).toEqual(["a.ts", "b.ts"])
  })

  it("makeFs convenience constructor works", async () => {
    const layer = makeFs({ repo: new Repo({ network: [] }) })

    const program = Effect.gen(function* () {
      const fs = yield* FileSystem
      yield* fs.writeFileString("/test.txt", "hello from makeFs")
      return yield* fs.readFileString("/test.txt")
    })

    const result = await Effect.runPromise(Effect.provide(program, layer))
    expect(result).toBe("hello from makeFs")
  })
})
