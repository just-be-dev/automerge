import { describe, expect, it } from "bun:test"
import { Repo, type DocHandle } from "@automerge/automerge-repo"
import { AutomergeFs } from "./fs.ts"
import { InMemoryBlobStore } from "./blob-store.ts"
import {
  FileHandlerRegistry,
  parseDocType,
  formatDocType,
  type FileHandler,
  type TypedDoc,
  type FileHandlerLens,
} from "./file-handlers/index.ts"

function makeFs() {
  return AutomergeFs.create({
    repo: new Repo({ network: [] }),
    blobStore: new InMemoryBlobStore(),
  })
}

describe("AutomergeFs direct API", () => {
  it("writeFile and readFile round-trip text", async () => {
    const fs = makeFs()
    await fs.writeFile("/hello.txt", "world")
    const content = await fs.readFile("/hello.txt")
    expect(new TextDecoder().decode(content)).toBe("world")
  })

  it("mkdir recursive and readdir", async () => {
    const fs = makeFs()
    await fs.mkdir("/src/components", { recursive: true })
    await fs.writeFile("/src/components/App.ts", "export const App = 1")
    await fs.writeFile("/src/index.ts", "export { App } from './components/App'")

    const srcEntries = fs.readdir("/src")
    const names = srcEntries.map((e) => e.name).sort()
    expect(names).toEqual(["components", "index.ts"])
    expect(srcEntries.find((e) => e.name === "components")?.isDirectory).toBe(true)
    expect(srcEntries.find((e) => e.name === "index.ts")?.isFile).toBe(true)
  })

  it("stat returns correct metadata", async () => {
    const fs = makeFs()
    await fs.writeFile("/test.txt", "hello")
    const info = fs.stat("/test.txt")
    expect(info.isFile).toBe(true)
    expect(info.isDirectory).toBe(false)
    expect(info.size).toBe(5)
  })

  it("rename moves files", async () => {
    const fs = makeFs()
    await fs.writeFile("/hello.txt", "world")
    await fs.rename("/hello.txt", "/src-hello.txt")
    expect(fs.exists("/hello.txt")).toBe(false)
    const content = await fs.readFile("/src-hello.txt")
    expect(new TextDecoder().decode(content)).toBe("world")
  })

  it("rename into a subdirectory", async () => {
    const fs = makeFs()
    await fs.mkdir("/src", { recursive: true })
    await fs.writeFile("/hello.txt", "world")
    await fs.rename("/hello.txt", "/src/hello.txt")
    expect(fs.exists("/hello.txt")).toBe(false)
    const content = await fs.readFile("/src/hello.txt")
    expect(new TextDecoder().decode(content)).toBe("world")
  })

  it("exists returns true/false correctly", async () => {
    const fs = makeFs()
    await fs.writeFile("/yes.txt", "here")
    expect(fs.exists("/yes.txt")).toBe(true)
    expect(fs.exists("/no.txt")).toBe(false)
  })

  it("remove deletes a file", async () => {
    const fs = makeFs()
    await fs.writeFile("/del.txt", "bye")
    await fs.remove("/del.txt")
    expect(fs.exists("/del.txt")).toBe(false)
  })

  it("remove recursive deletes a directory tree", async () => {
    const fs = makeFs()
    await fs.mkdir("/a/b", { recursive: true })
    await fs.writeFile("/a/b/c.txt", "deep")
    await fs.remove("/a", { recursive: true })
    expect(fs.exists("/a")).toBe(false)
  })

  it("copy duplicates a file", async () => {
    const fs = makeFs()
    await fs.writeFile("/orig.txt", "data")
    await fs.copy("/orig.txt", "/dup.txt")
    const orig = new TextDecoder().decode(await fs.readFile("/orig.txt"))
    const dup = new TextDecoder().decode(await fs.readFile("/dup.txt"))
    expect(orig).toBe("data")
    expect(dup).toBe("data")
  })

  it("copy recursive duplicates a directory tree", async () => {
    const fs = makeFs()
    await fs.mkdir("/src", { recursive: true })
    await fs.writeFile("/src/a.ts", "a")
    await fs.writeFile("/src/b.ts", "b")
    await fs.copy("/src", "/backup")
    const entries = fs.readdir("/backup").map((e) => e.name).sort()
    expect(entries).toEqual(["a.ts", "b.ts"])
  })

  it("chmod updates file mode", async () => {
    const fs = makeFs()
    await fs.writeFile("/script.sh", "#!/bin/sh")
    fs.chmod("/script.sh", 0o755)
    expect(fs.stat("/script.sh").mode).toBe(0o755)
  })

  it("truncate shortens a file", async () => {
    const fs = makeFs()
    await fs.writeFile("/long.txt", "hello world")
    await fs.truncate("/long.txt", 5)
    const content = new TextDecoder().decode(await fs.readFile("/long.txt"))
    expect(content).toBe("hello")
  })

  it("writeFile overwrites existing content with updateText", async () => {
    const fs = makeFs()
    await fs.writeFile("/f.txt", "first")
    await fs.writeFile("/f.txt", "second")
    const content = new TextDecoder().decode(await fs.readFile("/f.txt"))
    expect(content).toBe("second")
  })

  it("binary files are stored via blob file handler", async () => {
    const fs = makeFs()
    const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80])
    await fs.writeFile("/bin.dat", binary)
    const read = await fs.readFile("/bin.dat")
    expect(read).toEqual(binary)
  })

  it("symlink and readlink round-trip", async () => {
    const fs = makeFs()
    await fs.writeFile("/target.txt", "hello")
    fs.symlink("/target.txt", "/link.txt")
    expect(fs.readlink("/link.txt")).toBe("/target.txt")
  })

  it("readFile follows symlinks", async () => {
    const fs = makeFs()
    await fs.writeFile("/real.txt", "content")
    fs.symlink("/real.txt", "/alias.txt")
    const content = new TextDecoder().decode(await fs.readFile("/alias.txt"))
    expect(content).toBe("content")
  })

  it("writeFile through symlink updates target", async () => {
    const fs = makeFs()
    await fs.writeFile("/real.txt", "original")
    fs.symlink("/real.txt", "/link.txt")
    await fs.writeFile("/link.txt", "updated")
    const content = new TextDecoder().decode(await fs.readFile("/real.txt"))
    expect(content).toBe("updated")
  })

  it("stat follows symlinks", async () => {
    const fs = makeFs()
    await fs.writeFile("/real.txt", "hello")
    fs.symlink("/real.txt", "/link.txt")
    const s = fs.stat("/link.txt")
    expect(s.isFile).toBe(true)
    expect(s.isSymbolicLink).toBe(false)
    expect(s.size).toBe(5)
  })

  it("lstat reports symlink type", async () => {
    const fs = makeFs()
    await fs.writeFile("/real.txt", "hello")
    fs.symlink("/real.txt", "/link.txt")
    const s = fs.lstat("/link.txt")
    expect(s.isSymbolicLink).toBe(true)
    expect(s.isFile).toBe(false)
  })

  it("symlink with relative target", async () => {
    const fs = makeFs()
    await fs.mkdir("/dir")
    await fs.writeFile("/dir/real.txt", "data")
    fs.symlink("real.txt", "/dir/link.txt")
    const content = new TextDecoder().decode(await fs.readFile("/dir/link.txt"))
    expect(content).toBe("data")
  })

  it("remove on symlink deletes the link not the target", async () => {
    const fs = makeFs()
    await fs.writeFile("/real.txt", "keep me")
    fs.symlink("/real.txt", "/link.txt")
    await fs.remove("/link.txt")
    expect(fs.exists("/link.txt")).toBe(false)
    expect(fs.exists("/real.txt")).toBe(true)
  })

  it("dangling symlink: exists returns false", async () => {
    const fs = makeFs()
    fs.symlink("/nonexistent", "/dangling")
    expect(fs.exists("/dangling")).toBe(false)
  })

  it("symlink chain is followed", async () => {
    const fs = makeFs()
    await fs.writeFile("/real.txt", "deep")
    fs.symlink("/real.txt", "/link1")
    fs.symlink("/link1", "/link2")
    const content = new TextDecoder().decode(await fs.readFile("/link2"))
    expect(content).toBe("deep")
  })

  it("hard link shares underlying data", async () => {
    const fs = makeFs()
    await fs.writeFile("/orig.txt", "shared data")
    fs.link("/orig.txt", "/hardlink.txt")
    const content = new TextDecoder().decode(await fs.readFile("/hardlink.txt"))
    expect(content).toBe("shared data")
  })

  it("hard link survives removal of original", async () => {
    const fs = makeFs()
    await fs.writeFile("/orig.txt", "persist")
    fs.link("/orig.txt", "/hardlink.txt")
    await fs.remove("/orig.txt")
    expect(fs.exists("/orig.txt")).toBe(false)
    const content = new TextDecoder().decode(await fs.readFile("/hardlink.txt"))
    expect(content).toBe("persist")
  })

  it("hard link sees writes through either path", async () => {
    const fs = makeFs()
    await fs.writeFile("/a.txt", "v1")
    fs.link("/a.txt", "/b.txt")
    await fs.writeFile("/b.txt", "v2")
    const contentA = new TextDecoder().decode(await fs.readFile("/a.txt"))
    const contentB = new TextDecoder().decode(await fs.readFile("/b.txt"))
    expect(contentA).toBe("v2")
    expect(contentB).toBe("v2")
  })

  it("hard link on directory throws EPERM", async () => {
    const fs = makeFs()
    await fs.mkdir("/dir")
    expect(() => fs.link("/dir", "/dir2")).toThrow("EPERM")
  })

  it("hard link on binary file survives removal of original", async () => {
    const fs = makeFs()
    const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80])
    await fs.writeFile("/bin.dat", binary)
    fs.link("/bin.dat", "/bin-link.dat")
    await fs.remove("/bin.dat")
    const read = await fs.readFile("/bin-link.dat")
    expect(read).toEqual(binary)
  })

  it("readdir includes symlinks", async () => {
    const fs = makeFs()
    await fs.mkdir("/dir")
    await fs.writeFile("/dir/file.txt", "x")
    fs.symlink("/dir/file.txt", "/dir/link.txt")
    const entries = fs.readdir("/dir")
    const link = entries.find((e) => e.name === "link.txt")
    expect(link?.isSymbolicLink).toBe(true)
    expect(link?.isFile).toBe(false)
  })
})

describe("file handler system", () => {
  it("text files are backed by automerge docs", async () => {
    const fs = makeFs()
    await fs.writeFile("/hello.txt", "world")
    const handle = await fs.getFileDocHandle("/hello.txt")
    expect(handle.doc()?.content).toBe("world")
  })

  it("binary files are backed by automerge docs with blobRef", async () => {
    const fs = makeFs()
    const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80])
    await fs.writeFile("/bin.dat", binary)
    const handle = await fs.getFileDocHandle("/bin.dat")
    expect(handle.doc()).toBeTruthy()
    const read = await fs.readFile("/bin.dat")
    expect(read).toEqual(binary)
  })

  it("overwriting a text file reuses the same doc", async () => {
    const fs = makeFs()
    await fs.writeFile("/f.txt", "first")
    const h1 = await fs.getFileDocHandle("/f.txt")
    await fs.writeFile("/f.txt", "second")
    const h2 = await fs.getFileDocHandle("/f.txt")
    expect(h1.url).toBe(h2.url)
    expect(h2.doc()?.content).toBe("second")
  })

  it("custom file handler matched by extension", async () => {
    interface JsonFileDoc extends TypedDoc { json: string }

    const jsonFileHandler: FileHandler<JsonFileDoc> = {
      type: "json",
      version: "v1",
      extensions: [".json"],

      async createDoc(repo, content) {
        const handle = repo.create<JsonFileDoc>()
        handle.change((doc) => {
          doc._type = "json.v1"
          doc.json = new TextDecoder().decode(content)
        })
        return handle
      },

      async write(handle, content) {
        const text = new TextDecoder().decode(content)
        handle.change((doc) => {
          doc.json = text
        })
      },

      async read(handle) {
        const doc = handle.doc()
        return new TextEncoder().encode(doc?.json ?? "")
      },

      async readDoc(doc) {
        return new TextEncoder().encode(doc?.json ?? "")
      },
    }

    const fs = AutomergeFs.create({
      repo: new Repo({ network: [] }),
      fileHandlers: [jsonFileHandler],
    })

    await fs.writeFile("/config.json", '{"key": "value"}')
    const content = new TextDecoder().decode(await fs.readFile("/config.json"))
    expect(content).toBe('{"key": "value"}')

    // Verify the custom doc shape
    const handle = await fs.getFileDocHandle("/config.json")
    const doc = handle.doc() as unknown as JsonFileDoc
    expect(doc.json).toBe('{"key": "value"}')
  })

  it("fileHandlerRegistry exposes registered handlers", () => {
    const fs = makeFs()
    const registry = fs.fileHandlerRegistry
    expect(registry.getByType("text")).toBeTruthy()
    expect(registry.getByType("blob")).toBeTruthy()
  })

  it("register file handler after creation", async () => {
    const fs = makeFs()

    interface CsvFileDoc extends TypedDoc { csv: string }

    fs.fileHandlerRegistry.register({
      type: "csv",
      version: "v1",
      extensions: [".csv"],
      async createDoc(repo, content) {
        const handle = repo.create<CsvFileDoc>()
        handle.change((doc) => {
          doc._type = "csv.v1"
          doc.csv = new TextDecoder().decode(content)
        })
        return handle
      },
      async write(handle: DocHandle<CsvFileDoc>, content) {
        handle.change((doc) => {
          doc.csv = new TextDecoder().decode(content)
        })
      },
      async read(handle: DocHandle<CsvFileDoc>) {
        return new TextEncoder().encode(handle.doc()?.csv ?? "")
      },
      async readDoc(doc: CsvFileDoc) {
        return new TextEncoder().encode(doc?.csv ?? "")
      },
    })

    await fs.writeFile("/data.csv", "a,b,c")
    const content = new TextDecoder().decode(await fs.readFile("/data.csv"))
    expect(content).toBe("a,b,c")
  })

  it("fs works without blob file handler (text only)", async () => {
    const fs = AutomergeFs.create({
      repo: new Repo({ network: [] }),
    })

    await fs.writeFile("/hello.txt", "world")
    const content = new TextDecoder().decode(await fs.readFile("/hello.txt"))
    expect(content).toBe("world")
  })

  it("_type field is present on created docs", async () => {
    const fs = makeFs()
    await fs.writeFile("/hello.txt", "world")
    const handle = await fs.getFileDocHandle("/hello.txt")
    const doc = handle.doc() as any
    expect(doc._type).toBe("text.v1")
  })

  it("_type field is present on blob docs", async () => {
    const fs = makeFs()
    const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80])
    await fs.writeFile("/bin.dat", binary)
    const handle = await fs.getFileDocHandle("/bin.dat")
    const doc = handle.doc() as any
    expect(doc._type).toBe("blob.v1")
  })

  it("fileType is stored on FsNode", async () => {
    const fs = makeFs()
    await fs.writeFile("/hello.txt", "world")
    // Access tree via root doc to check FsNode
    const paths = fs.getAllPaths()
    expect(paths).toContain("/hello.txt")
    // We can verify the fileType indirectly: overwriting with same content
    // should reuse the doc (same handler type detected via fileType)
    const h1 = await fs.getFileDocHandle("/hello.txt")
    await fs.writeFile("/hello.txt", "updated")
    const h2 = await fs.getFileDocHandle("/hello.txt")
    expect(h1.url).toBe(h2.url)
  })

  it("lens migration transforms v1 doc to v2 on read", async () => {
    // Set up a v1 handler
    interface NoteV1Doc extends TypedDoc { body: string }
    interface NoteV2Doc extends TypedDoc { body: string; title: string }

    const noteV1Handler: FileHandler<NoteV1Doc> = {
      type: "note",
      version: "v1",
      extensions: [".note"],

      async createDoc(repo, content) {
        const handle = repo.create<NoteV1Doc>()
        handle.change((doc) => {
          doc._type = "note.v1"
          doc.body = new TextDecoder().decode(content)
        })
        return handle
      },

      async write(handle, content) {
        handle.change((doc) => {
          doc.body = new TextDecoder().decode(content)
        })
      },

      async read(handle) {
        return new TextEncoder().encode(handle.doc()?.body ?? "")
      },

      async readDoc(doc) {
        return new TextEncoder().encode(doc?.body ?? "")
      },
    }

    // Create a file with v1
    const repo = new Repo({ network: [] })
    const fs1 = AutomergeFs.create({
      repo,
      fileHandlers: [noteV1Handler],
    })

    await fs1.writeFile("/doc.note", "hello world")

    // Now define v2 handler with lens from v1
    const v1ToV2Lens: FileHandlerLens = {
      from: "note.v1",
      to: "note.v2",
      forward(doc: any) {
        // Extract title from first line
        const lines = (doc.body ?? "").split("\n")
        return {
          ...doc,
          _type: "note.v2",
          title: lines[0] ?? "",
          body: lines.slice(1).join("\n") || doc.body,
        }
      },
      backward(doc: any) {
        return {
          ...doc,
          _type: "note.v1",
          body: doc.title ? `${doc.title}\n${doc.body}` : doc.body,
        }
      },
    }

    const noteV2Handler: FileHandler<NoteV2Doc> = {
      type: "note",
      version: "v2",
      extensions: [".note"],
      lenses: [v1ToV2Lens],

      async createDoc(repo, content) {
        const handle = repo.create<NoteV2Doc>()
        handle.change((doc) => {
          doc._type = "note.v2"
          const text = new TextDecoder().decode(content)
          const lines = text.split("\n")
          doc.title = lines[0] ?? ""
          doc.body = lines.slice(1).join("\n") || text
        })
        return handle
      },

      async write(handle, content) {
        const text = new TextDecoder().decode(content)
        const lines = text.split("\n")
        handle.change((doc) => {
          doc.title = lines[0] ?? ""
          doc.body = lines.slice(1).join("\n") || text
        })
      },

      async read(handle) {
        const doc = handle.doc()
        if (!doc) return new Uint8Array(0)
        return new TextEncoder().encode(doc.title ? `${doc.title}\n${doc.body}` : doc.body)
      },

      async readDoc(doc) {
        if (!doc) return new Uint8Array(0)
        return new TextEncoder().encode(doc.title ? `${doc.title}\n${doc.body}` : doc.body)
      },
    }

    // Load the same fs with v2 handler (replaces v1 for "note" type)
    const fs2 = await AutomergeFs.load({
      repo,
      rootDocUrl: fs1.rootDocUrl,
      fileHandlers: [noteV2Handler],
    })

    // Reading should trigger lens migration (pure transform, doc not mutated)
    const content = new TextDecoder().decode(await fs2.readFile("/doc.note"))
    // The v1 doc had body "hello world", lens forward extracts first line as title
    // and body becomes rest. Since there's only one line, body = "hello world" and title = "hello world"
    // readDoc produces "hello world\nhello world"
    expect(content).toBe("hello world\nhello world")

    // Verify the stored doc still has v1 _type (lens is pure, doesn't mutate)
    const handle = await fs2.getFileDocHandle("/doc.note")
    const rawDoc = handle.doc() as any
    expect(rawDoc._type).toBe("note.v1")
  })

  it("_type is preserved after overwriting text content", async () => {
    const fs = makeFs()
    await fs.writeFile("/f.txt", "first")
    await fs.writeFile("/f.txt", "second")
    const handle = await fs.getFileDocHandle("/f.txt")
    const doc = handle.doc() as any
    expect(doc._type).toBe("text.v1")
    expect(doc.content).toBe("second")
  })

  it("handler type change on overwrite creates new doc with correct _type", async () => {
    const fs = makeFs()
    // Write text first
    await fs.writeFile("/data.bin", "hello text")
    const h1 = await fs.getFileDocHandle("/data.bin")
    expect((h1.doc() as any)._type).toBe("text.v1")

    // Overwrite with binary — triggers handler change from text → blob
    const binary = new Uint8Array([0x00, 0x01, 0xff, 0xfe, 0x80])
    await fs.writeFile("/data.bin", binary)
    const h2 = await fs.getFileDocHandle("/data.bin")
    expect((h2.doc() as any)._type).toBe("blob.v1")
    expect(h1.url).not.toBe(h2.url)
  })

  it("rename preserves fileType — doc reuse still works after rename", async () => {
    const fs = makeFs()
    await fs.writeFile("/a.txt", "hello")
    const h1 = await fs.getFileDocHandle("/a.txt")
    await fs.rename("/a.txt", "/b.txt")

    // Overwrite at new path should reuse the doc (same handler type)
    await fs.writeFile("/b.txt", "updated")
    const h2 = await fs.getFileDocHandle("/b.txt")
    expect(h1.url).toBe(h2.url)
    expect(h2.doc()?.content).toBe("updated")
  })

  it("copy produces a new doc with _type set", async () => {
    const fs = makeFs()
    await fs.writeFile("/orig.txt", "content")
    await fs.copy("/orig.txt", "/dup.txt")
    const handle = await fs.getFileDocHandle("/dup.txt")
    const doc = handle.doc() as any
    expect(doc._type).toBe("text.v1")
    expect(doc.content).toBe("content")
  })

  it("hard link preserves fileType — doc reuse works via hard link", async () => {
    const fs = makeFs()
    await fs.writeFile("/orig.txt", "v1")
    fs.link("/orig.txt", "/linked.txt")

    // Write through hard link should reuse doc (same handler type via fileType)
    await fs.writeFile("/linked.txt", "v2")
    const hOrig = await fs.getFileDocHandle("/orig.txt")
    const hLink = await fs.getFileDocHandle("/linked.txt")
    expect(hOrig.url).toBe(hLink.url)
  })

  it("custom handler _type is stamped correctly", async () => {
    interface YamlFileDoc extends TypedDoc { yaml: string }

    const yamlHandler: FileHandler<YamlFileDoc> = {
      type: "yaml",
      version: "v1",
      extensions: [".yaml", ".yml"],
      async createDoc(repo, content) {
        const handle = repo.create<YamlFileDoc>()
        handle.change((doc) => {
          doc._type = "yaml.v1"
          doc.yaml = new TextDecoder().decode(content)
        })
        return handle
      },
      async write(handle, content) {
        handle.change((doc) => { doc.yaml = new TextDecoder().decode(content) })
      },
      async read(handle) {
        return new TextEncoder().encode(handle.doc()?.yaml ?? "")
      },
      async readDoc(doc) {
        return new TextEncoder().encode(doc?.yaml ?? "")
      },
    }

    const fs = AutomergeFs.create({
      repo: new Repo({ network: [] }),
      fileHandlers: [yamlHandler],
    })

    await fs.writeFile("/config.yaml", "key: value")
    const handle = await fs.getFileDocHandle("/config.yaml")
    expect((handle.doc() as any)._type).toBe("yaml.v1")

    // .yml extension also routes to same handler
    await fs.writeFile("/other.yml", "a: 1")
    const h2 = await fs.getFileDocHandle("/other.yml")
    expect((h2.doc() as any)._type).toBe("yaml.v1")
  })

  it("applyLenses returns null when versions already match", async () => {
    const fs = makeFs()
    await fs.writeFile("/f.txt", "hello")
    const handle = await fs.getFileDocHandle("/f.txt")
    const doc = handle.doc()
    const registry = fs.fileHandlerRegistry
    const handler = registry.getByType("text")!
    expect(registry.applyLenses(doc, handler)).toBeNull()
  })

  it("applyLenses returns null when handler has no lenses", async () => {
    const registry = new FileHandlerRegistry()

    const handler: FileHandler = {
      type: "test",
      version: "v2",
      extensions: [],
      async createDoc(repo) { return repo.create() },
      async write() {},
      async read() { return new Uint8Array(0) },
      async readDoc() { return new Uint8Array(0) },
    }
    registry.register(handler)

    // Doc has a different version but handler has no lenses
    const doc = { _type: "test.v1", data: "hello" }
    expect(registry.applyLenses(doc, handler)).toBeNull()
  })
})

describe("parseDocType and formatDocType", () => {
  it("parses a standard type tag", () => {
    expect(parseDocType("text.v1")).toEqual({ type: "text", version: "v1" })
  })

  it("parses a tag with dotted type name", () => {
    // e.g. "my.custom.handler.v3" → type: "my.custom.handler", version: "v3"
    expect(parseDocType("my.custom.handler.v3")).toEqual({ type: "my.custom.handler", version: "v3" })
  })

  it("throws on a tag with no dot", () => {
    expect(() => parseDocType("textv1")).toThrow("Invalid _type tag")
  })

  it("throws on a tag starting with a dot", () => {
    expect(() => parseDocType(".v1")).toThrow("Invalid _type tag")
  })

  it("formatDocType produces correct tag", () => {
    expect(formatDocType("text", "v1")).toBe("text.v1")
    expect(formatDocType("blob", "v2")).toBe("blob.v2")
  })

  it("round-trips through parse and format", () => {
    const tag = "custom.v42"
    const { type, version } = parseDocType(tag)
    expect(formatDocType(type, version)).toBe(tag)
  })
})

describe("FileHandlerRegistry", () => {
  it("resolveForRead throws when doc has no _type", () => {
    const registry = new FileHandlerRegistry()
    expect(() => registry.resolveForRead({ content: "hello" })).toThrow("No file handler matched")
  })

  it("resolveForRead throws when _type refers to unregistered handler", () => {
    const registry = new FileHandlerRegistry()
    expect(() => registry.resolveForRead({ _type: "unknown.v1" })).toThrow("No file handler matched")
  })

  it("getByType returns undefined for unregistered type", () => {
    const registry = new FileHandlerRegistry()
    expect(registry.getByType("nonexistent")).toBeUndefined()
  })

  it("later registration of same type wins", () => {
    const registry = new FileHandlerRegistry()

    const v1: FileHandler = {
      type: "test",
      version: "v1",
      extensions: [".test"],
      async createDoc(repo) { return repo.create() },
      async write() {},
      async read() { return new TextEncoder().encode("v1") },
      async readDoc() { return new TextEncoder().encode("v1") },
    }
    const v2: FileHandler = {
      type: "test",
      version: "v2",
      extensions: [".test"],
      async createDoc(repo) { return repo.create() },
      async write() {},
      async read() { return new TextEncoder().encode("v2") },
      async readDoc() { return new TextEncoder().encode("v2") },
    }

    registry.register(v1)
    registry.register(v2)

    const handler = registry.getByType("test")!
    expect(handler.version).toBe("v2")
  })

  it("resolveForWrite falls back to first handler when no extensions or sniff match", () => {
    const registry = new FileHandlerRegistry()

    const fallback: FileHandler = {
      type: "fallback",
      version: "v1",
      extensions: [],
      async createDoc(repo) { return repo.create() },
      async write() {},
      async read() { return new Uint8Array(0) },
      async readDoc() { return new Uint8Array(0) },
    }
    registry.register(fallback)

    const handler = registry.resolveForWrite("/no-ext", new TextEncoder().encode("hi"))
    expect(handler.type).toBe("fallback")
  })

  it("resolveForWrite throws when no handlers are registered", () => {
    const registry = new FileHandlerRegistry()
    expect(() =>
      registry.resolveForWrite("/test.txt", new TextEncoder().encode("hi"))
    ).toThrow("No file handler registered")
  })
})

describe("multi-hop lens migration", () => {
  // Helpers for a 3-version handler chain: v1 → v2 → v3
  interface DocV1 extends TypedDoc { value: number }
  interface DocV2 extends TypedDoc { value: number; label: string }
  interface DocV3 extends TypedDoc { value: number; label: string; tags: string[] }

  const v1ToV2: FileHandlerLens = {
    from: "counter.v1",
    to: "counter.v2",
    forward: (doc: any) => ({ ...doc, _type: "counter.v2", label: `item-${doc.value}` }),
    backward: (doc: any) => {
      const { label: _, ...rest } = doc
      return { ...rest, _type: "counter.v1" }
    },
  }

  const v2ToV3: FileHandlerLens = {
    from: "counter.v2",
    to: "counter.v3",
    forward: (doc: any) => ({ ...doc, _type: "counter.v3", tags: [doc.label] }),
    backward: (doc: any) => {
      const { tags: _, ...rest } = doc
      return { ...rest, _type: "counter.v2" }
    },
  }

  function makeCounterV1Handler(): FileHandler<DocV1> {
    return {
      type: "counter",
      version: "v1",
      extensions: [".cnt"],
      async createDoc(repo, content) {
        const handle = repo.create<DocV1>()
        handle.change((doc) => {
          doc._type = "counter.v1"
          doc.value = parseInt(new TextDecoder().decode(content)) || 0
        })
        return handle
      },
      async write(handle, content) {
        handle.change((doc) => { doc.value = parseInt(new TextDecoder().decode(content)) || 0 })
      },
      async read(handle) {
        return new TextEncoder().encode(String(handle.doc()?.value ?? 0))
      },
      async readDoc(doc) {
        return new TextEncoder().encode(String(doc?.value ?? 0))
      },
    }
  }

  function makeCounterV3Handler(): FileHandler<DocV3> {
    return {
      type: "counter",
      version: "v3",
      extensions: [".cnt"],
      lenses: [v1ToV2, v2ToV3],
      async createDoc(repo, content) {
        const handle = repo.create<DocV3>()
        handle.change((doc) => {
          doc._type = "counter.v3"
          const val = parseInt(new TextDecoder().decode(content)) || 0
          doc.value = val
          doc.label = `item-${val}`
          doc.tags = [`item-${val}`]
        })
        return handle
      },
      async write(handle, content) {
        const val = parseInt(new TextDecoder().decode(content)) || 0
        handle.change((doc) => {
          doc.value = val
          doc.label = `item-${val}`
          doc.tags = [`item-${val}`]
        })
      },
      async read(handle) {
        const doc = handle.doc()
        if (!doc) return new Uint8Array(0)
        return new TextEncoder().encode(`${doc.value}:${doc.tags.join(",")}`)
      },
      async readDoc(doc) {
        if (!doc) return new Uint8Array(0)
        return new TextEncoder().encode(`${doc.value}:${doc.tags.join(",")}`)
      },
    }
  }

  it("v1 doc is migrated through v2 to reach v3 via BFS", async () => {
    const repo = new Repo({ network: [] })

    // Create with v1
    const fs1 = AutomergeFs.create({ repo, fileHandlers: [makeCounterV1Handler()] })
    await fs1.writeFile("/count.cnt", "42")

    // Load with v3 (has lenses for v1→v2 and v2→v3)
    const fs3 = await AutomergeFs.load({
      repo,
      rootDocUrl: fs1.rootDocUrl,
      fileHandlers: [makeCounterV3Handler()],
    })

    const content = new TextDecoder().decode(await fs3.readFile("/count.cnt"))
    // v1 {value:42} → v2 {value:42, label:"item-42"} → v3 {value:42, label:"item-42", tags:["item-42"]}
    // readDoc produces "42:item-42"
    expect(content).toBe("42:item-42")
  })

  it("stored doc is not mutated by multi-hop lens", async () => {
    const repo = new Repo({ network: [] })

    const fs1 = AutomergeFs.create({ repo, fileHandlers: [makeCounterV1Handler()] })
    await fs1.writeFile("/count.cnt", "7")

    const fs3 = await AutomergeFs.load({
      repo,
      rootDocUrl: fs1.rootDocUrl,
      fileHandlers: [makeCounterV3Handler()],
    })

    // Read triggers lenses
    await fs3.readFile("/count.cnt")

    // Original doc untouched
    const handle = await fs3.getFileDocHandle("/count.cnt")
    const raw = handle.doc() as any
    expect(raw._type).toBe("counter.v1")
    expect(raw.value).toBe(7)
    expect(raw.label).toBeUndefined()
    expect(raw.tags).toBeUndefined()
  })

  it("backward lens migrates newer doc to older version", () => {
    const registry = new FileHandlerRegistry()

    // Register a v1 handler with the v1→v2 lens (so backward is available)
    const v1Handler: FileHandler = {
      type: "counter",
      version: "v1",
      extensions: [],
      lenses: [v1ToV2],
      async createDoc(repo) { return repo.create() },
      async write() {},
      async read() { return new Uint8Array(0) },
      async readDoc(doc: any) {
        return new TextEncoder().encode(String(doc?.value ?? 0))
      },
    }
    registry.register(v1Handler)

    // A v2 doc should be migrated backward to v1
    const v2Doc = { _type: "counter.v2", value: 10, label: "item-10" }
    const result = registry.applyLenses(v2Doc, v1Handler) as any
    expect(result).not.toBeNull()
    expect(result._type).toBe("counter.v1")
    expect(result.value).toBe(10)
    expect(result.label).toBeUndefined()
  })

  it("reading the same lensed file multiple times is idempotent", async () => {
    const repo = new Repo({ network: [] })

    const fs1 = AutomergeFs.create({ repo, fileHandlers: [makeCounterV1Handler()] })
    await fs1.writeFile("/count.cnt", "99")

    const fs3 = await AutomergeFs.load({
      repo,
      rootDocUrl: fs1.rootDocUrl,
      fileHandlers: [makeCounterV3Handler()],
    })

    const read1 = new TextDecoder().decode(await fs3.readFile("/count.cnt"))
    const read2 = new TextDecoder().decode(await fs3.readFile("/count.cnt"))
    const read3 = new TextDecoder().decode(await fs3.readFile("/count.cnt"))
    expect(read1).toBe("99:item-99")
    expect(read2).toBe(read1)
    expect(read3).toBe(read1)
  })
})
