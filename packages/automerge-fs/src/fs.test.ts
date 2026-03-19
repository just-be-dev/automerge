import { describe, expect, it } from "bun:test"
import { Repo } from "@automerge/automerge-repo"
import { AutomergeFsMultiDoc } from "./fs"
import { InMemoryBlobStore } from "./blob-store"

function makeFs() {
  return AutomergeFsMultiDoc.create({
    repo: new Repo({ network: [] }),
    blobStore: new InMemoryBlobStore(),
  })
}

describe("AutomergeFsMultiDoc direct API", () => {
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
})
