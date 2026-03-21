import { describe, expect, it } from "bun:test"
import { Repo } from "@automerge/automerge-repo"
import { AutomergeFs, InMemoryBlobStore, createBlobFileHandler } from "@just-be/automerge-fs"
import { AutomergeFileSystem } from "./vfs"

function makeVfs() {
  const amfs = AutomergeFs.create({
    repo: new Repo({ network: [] }),
    fileHandlers: [createBlobFileHandler(new InMemoryBlobStore())],
  })
  return new AutomergeFileSystem(amfs)
}

describe("AutomergeFileSystem", () => {
  it("readFile / writeFile round-trip", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/hello.txt", "world")
    const bytes = await vfs.readFile("/hello.txt")
    expect(new TextDecoder().decode(bytes)).toBe("world")
  })

  it("readTextFile returns string", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/hello.txt", "world")
    expect(await vfs.readTextFile("/hello.txt")).toBe("world")
  })

  it("writeFile creates parent directories", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/a/b/c.txt", "deep")
    expect(await vfs.exists("/a")).toBe(true)
    expect(await vfs.exists("/a/b")).toBe(true)
    expect(await vfs.readTextFile("/a/b/c.txt")).toBe("deep")
  })

  it("readDir returns names", async () => {
    const vfs = makeVfs()
    await vfs.mkdir("/src")
    await vfs.writeFile("/src/a.ts", "a")
    await vfs.writeFile("/src/b.ts", "b")
    const names = (await vfs.readDir("/src")).sort()
    expect(names).toEqual(["a.ts", "b.ts"])
  })

  it("readDirWithTypes returns entries with isDirectory", async () => {
    const vfs = makeVfs()
    await vfs.mkdir("/src")
    await vfs.mkdir("/src/lib")
    await vfs.writeFile("/src/index.ts", "x")
    const entries = await vfs.readDirWithTypes("/src")
    const dir = entries.find((e) => e.name === "lib")
    const file = entries.find((e) => e.name === "index.ts")
    expect(dir?.isDirectory).toBe(true)
    expect(file?.isDirectory).toBe(false)
  })

  it("createDir throws if parent missing", async () => {
    const vfs = makeVfs()
    expect(vfs.createDir("/a/b")).rejects.toThrow()
  })

  it("mkdir creates recursively and is idempotent", async () => {
    const vfs = makeVfs()
    await vfs.mkdir("/a/b/c")
    expect(await vfs.exists("/a/b/c")).toBe(true)
    // Should not throw on existing directory
    await vfs.mkdir("/a/b/c")
  })

  it("exists returns false for missing paths", async () => {
    const vfs = makeVfs()
    expect(await vfs.exists("/nope")).toBe(false)
  })

  it("stat returns VirtualStat shape", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/f.txt", "hello")
    const s = await vfs.stat("/f.txt")
    expect(s.size).toBe(5)
    expect(s.isDirectory).toBe(false)
    expect(s.isSymbolicLink).toBe(false)
    expect(typeof s.mtimeMs).toBe("number")
    expect(typeof s.ctimeMs).toBe("number")
    expect(typeof s.atimeMs).toBe("number")
    expect(typeof s.birthtimeMs).toBe("number")
  })

  it("removeFile removes a file", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/rm.txt", "bye")
    await vfs.removeFile("/rm.txt")
    expect(await vfs.exists("/rm.txt")).toBe(false)
  })

  it("removeDir removes an empty directory", async () => {
    const vfs = makeVfs()
    await vfs.mkdir("/empty")
    await vfs.removeDir("/empty")
    expect(await vfs.exists("/empty")).toBe(false)
  })

  it("rename moves a file", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/old.txt", "data")
    await vfs.rename("/old.txt", "/new.txt")
    expect(await vfs.exists("/old.txt")).toBe(false)
    expect(await vfs.readTextFile("/new.txt")).toBe("data")
  })

  it("chmod updates mode", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/ch.txt", "x")
    await vfs.chmod("/ch.txt", 0o755)
    const s = await vfs.stat("/ch.txt")
    expect(s.mode).toBe(0o755)
  })

  it("truncate shortens a file", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/tr.txt", "abcdef")
    await vfs.truncate("/tr.txt", 3)
    expect(await vfs.readTextFile("/tr.txt")).toBe("abc")
  })

  it("symlink and readlink round-trip", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/target.txt", "hello")
    await vfs.symlink("/target.txt", "/link.txt")
    expect(await vfs.readlink("/link.txt")).toBe("/target.txt")
  })

  it("readFile follows symlinks", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/real.txt", "content")
    await vfs.symlink("/real.txt", "/alias.txt")
    expect(await vfs.readTextFile("/alias.txt")).toBe("content")
  })

  it("stat follows symlinks", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/real.txt", "hello")
    await vfs.symlink("/real.txt", "/link.txt")
    const s = await vfs.stat("/link.txt")
    expect(s.size).toBe(5)
    expect(s.isSymbolicLink).toBe(false)
  })

  it("lstat reports symlink type", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/real.txt", "hello")
    await vfs.symlink("/real.txt", "/link.txt")
    const s = await vfs.lstat("/link.txt")
    expect(s.isSymbolicLink).toBe(true)
  })

  it("hard link shares data", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/orig.txt", "shared")
    await vfs.link("/orig.txt", "/hardlink.txt")
    expect(await vfs.readTextFile("/hardlink.txt")).toBe("shared")
  })

  it("hard link survives removal of original", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/orig.txt", "persist")
    await vfs.link("/orig.txt", "/hardlink.txt")
    await vfs.removeFile("/orig.txt")
    expect(await vfs.exists("/orig.txt")).toBe(false)
    expect(await vfs.readTextFile("/hardlink.txt")).toBe("persist")
  })

  it("lstat on regular file reports isSymbolicLink false", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/l.txt", "x")
    const s = await vfs.lstat("/l.txt")
    expect(s.size).toBe(1)
    expect(s.isDirectory).toBe(false)
    expect(s.isSymbolicLink).toBe(false)
  })

  it("chown is a no-op on existing path", async () => {
    const vfs = makeVfs()
    await vfs.writeFile("/own.txt", "x")
    // Should not throw
    await vfs.chown("/own.txt", 1000, 1000)
  })

  it("chown throws on missing path", async () => {
    const vfs = makeVfs()
    expect(vfs.chown("/nope", 1000, 1000)).rejects.toThrow("ENOENT")
  })
})
