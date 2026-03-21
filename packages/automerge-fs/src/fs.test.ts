import { describe, expect, it } from "bun:test"
import { Repo, type DocHandle } from "@automerge/automerge-repo"
import { AutomergeFs } from "./fs"
import { InMemoryBlobStore } from "./blob-store"
import type { FileType, FileTypeContext } from "./file-types"

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

  it("binary files are stored in blob store", async () => {
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

describe("file type system", () => {
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
    // The file should have a doc handle now (not just a raw blobHash)
    const handle = await fs.getFileDocHandle("/bin.dat")
    expect(handle.doc()).toBeTruthy()
    // Round-trip the content
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

  it("custom file type matched by extension", async () => {
    interface JsonFileDoc { json: string }

    const jsonFileType: FileType<JsonFileDoc> = {
      name: "json",
      extensions: [".json"],

      async createDoc(repo, content) {
        const handle = repo.create<JsonFileDoc>()
        handle.change((doc) => {
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
    }

    const fs = AutomergeFs.create({
      repo: new Repo({ network: [] }),
      blobStore: new InMemoryBlobStore(),
      fileTypes: [jsonFileType],
    })

    await fs.writeFile("/config.json", '{"key": "value"}')
    const content = new TextDecoder().decode(await fs.readFile("/config.json"))
    expect(content).toBe('{"key": "value"}')

    // Verify the custom doc shape
    const handle = await fs.getFileDocHandle("/config.json")
    const doc = handle.doc() as unknown as JsonFileDoc
    expect(doc.json).toBe('{"key": "value"}')
  })

  it("custom file type matched by predicate", async () => {
    interface UpperFileDoc { upper: string }

    const upperFileType: FileType<UpperFileDoc> = {
      name: "upper",
      extensions: [],

      match(path: string) {
        return path.startsWith("/upper/")
      },

      async createDoc(repo, content) {
        const handle = repo.create<UpperFileDoc>()
        handle.change((doc) => {
          doc.upper = new TextDecoder().decode(content).toUpperCase()
        })
        return handle
      },

      async write(handle, content) {
        handle.change((doc) => {
          doc.upper = new TextDecoder().decode(content).toUpperCase()
        })
      },

      async read(handle) {
        return new TextEncoder().encode(handle.doc()?.upper ?? "")
      },
    }

    const fs = AutomergeFs.create({
      repo: new Repo({ network: [] }),
      blobStore: new InMemoryBlobStore(),
      fileTypes: [upperFileType],
    })

    fs.mkdir("/upper")
    await fs.writeFile("/upper/hello.txt", "world")
    const content = new TextDecoder().decode(await fs.readFile("/upper/hello.txt"))
    expect(content).toBe("WORLD")

    // A file outside /upper/ uses the default text type
    await fs.writeFile("/normal.txt", "world")
    const normal = new TextDecoder().decode(await fs.readFile("/normal.txt"))
    expect(normal).toBe("world")
  })

  it("fileTypeRegistry exposes registered types", () => {
    const fs = makeFs()
    const registry = fs.fileTypeRegistry
    expect(registry.get("text")).toBeTruthy()
    expect(registry.get("blob")).toBeTruthy()
  })

  it("register file type after creation", async () => {
    const fs = makeFs()

    interface CsvFileDoc { csv: string }

    fs.fileTypeRegistry.register({
      name: "csv",
      extensions: [".csv"],
      async createDoc(repo, content) {
        const handle = repo.create<CsvFileDoc>()
        handle.change((doc) => {
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
    })

    await fs.writeFile("/data.csv", "a,b,c")
    const content = new TextDecoder().decode(await fs.readFile("/data.csv"))
    expect(content).toBe("a,b,c")
  })
})
