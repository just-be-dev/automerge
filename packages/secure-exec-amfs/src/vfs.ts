import type { AutomergeFs } from "@just-be/automerge-fs"
import type {
  VirtualFileSystem,
  VirtualStat,
  VirtualDirEntry,
} from "@secure-exec/core/internal/types"

export class AutomergeFileSystem implements VirtualFileSystem {
  private fs: AutomergeFs

  constructor(fs: AutomergeFs) {
    this.fs = fs
  }

  async readFile(path: string): Promise<Uint8Array> {
    return this.fs.readFile(path)
  }

  async readTextFile(path: string): Promise<string> {
    const bytes = await this.fs.readFile(path)
    return new TextDecoder().decode(bytes)
  }

  async readDir(path: string): Promise<string[]> {
    return this.fs.readdir(path).map((e) => e.name)
  }

  async readDirWithTypes(path: string): Promise<VirtualDirEntry[]> {
    return this.fs.readdir(path).map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory,
    }))
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // Create parent directories as needed per VirtualFileSystem contract
    const parent = path.replace(/\/[^/]+$/, "") || "/"
    if (parent !== "/" && !this.fs.exists(parent)) {
      this.fs.mkdir(parent, { recursive: true })
    }
    await this.fs.writeFile(path, content)
  }

  async createDir(path: string): Promise<void> {
    this.fs.mkdir(path)
  }

  async mkdir(path: string): Promise<void> {
    this.fs.mkdir(path, { recursive: true })
  }

  async exists(path: string): Promise<boolean> {
    return this.fs.exists(path)
  }

  async stat(path: string): Promise<VirtualStat> {
    const s = this.fs.stat(path)
    const mtimeMs = s.mtime.getTime()
    const ctimeMs = s.ctime.getTime()
    return {
      mode: s.mode,
      size: s.size,
      isDirectory: s.isDirectory,
      isSymbolicLink: false,
      atimeMs: mtimeMs,
      mtimeMs,
      ctimeMs,
      birthtimeMs: ctimeMs,
    }
  }

  async removeFile(path: string): Promise<void> {
    await this.fs.remove(path)
  }

  async removeDir(path: string): Promise<void> {
    await this.fs.remove(path)
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    await this.fs.rename(oldPath, newPath)
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    this.fs.symlink(target, linkPath)
  }

  async readlink(path: string): Promise<string> {
    return this.fs.readlink(path)
  }

  async lstat(path: string): Promise<VirtualStat> {
    const s = this.fs.lstat(path)
    const mtimeMs = s.mtime.getTime()
    const ctimeMs = s.ctime.getTime()
    return {
      mode: s.mode,
      size: s.size,
      isDirectory: s.isDirectory,
      isSymbolicLink: s.isSymbolicLink,
      atimeMs: mtimeMs,
      mtimeMs,
      ctimeMs,
      birthtimeMs: ctimeMs,
    }
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.fs.link(existingPath, newPath)
  }

  async chmod(path: string, mode: number): Promise<void> {
    this.fs.chmod(path, mode)
  }

  async chown(path: string, _uid: number, _gid: number): Promise<void> {
    if (!this.fs.exists(path)) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    // No-op: uid/gid not tracked in AutomergeFs
  }

  async utimes(path: string, atime: number, mtime: number): Promise<void> {
    this.fs.utimes(path, atime, mtime)
  }

  async truncate(path: string, length: number): Promise<void> {
    await this.fs.truncate(path, length)
  }
}
