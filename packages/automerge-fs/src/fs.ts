/**
 * AutomergeFs — a virtual file system backed by Automerge CRDTs.
 *
 * Every file is backed by an Automerge document. The shape of that document
 * depends on the file's handler — a pluggable FileHandlerRegistry controls how
 * content is read from / written to the backing doc.
 *
 * The built-in "text" handler stores content as a string with updateText() for
 * CRDT merging. Additional handlers (e.g. blob) can be registered via the
 * `fileHandlers` option.
 *
 * Directory tree structure is maintained in a single root document.
 */

import * as Automerge from "@automerge/automerge"
import { Repo, type DocHandle, type AutomergeUrl } from "@automerge/automerge-repo"
import { FileHandlerRegistry, type FileHandler, textFileHandler, type TextFileDoc, createBlobFileHandler } from "./file-handlers"
import type { BlobStore } from "./blob-store"

// =============================================================================
// Document Schema
// =============================================================================

interface FsTree {
  tree: Record<string, FsNode>
}

interface FsNode {
  type: "file" | "directory" | "symlink"
  parent: string | null
  name: string
  metadata: {
    size: number
    mode: number
    mtime: number
    ctime: number
  }
  fileDocId?: string
  symlinkTarget?: string
}

export interface StatInfo {
  size: number
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  mode: number
  mtime: Date
  ctime: Date
}

export interface DirEntry {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

// =============================================================================
// Path Helpers
// =============================================================================

export function normalizePath(path: string): string {
  if (path === "/") return "/"
  return path.replace(/\/+$/, "").replace(/\/+/g, "/")
}

function getParentPath(path: string): string {
  if (path === "/") return "/"
  const parts = path.split("/").filter((p) => p)
  if (parts.length === 1) return "/"
  return "/" + parts.slice(0, -1).join("/")
}

function getBasename(path: string): string {
  if (path === "/") return "/"
  const parts = path.split("/").filter((p) => p)
  return parts[parts.length - 1] ?? ""
}

export function joinPath(parent: string, child: string): string {
  return parent === "/" ? `/${child}` : `${parent}/${child}`
}

// =============================================================================
// AutomergeFs
// =============================================================================

function toStatInfo(entry: FsNode): StatInfo {
  return {
    size: entry.metadata.size,
    isFile: entry.type === "file",
    isDirectory: entry.type === "directory",
    isSymbolicLink: entry.type === "symlink",
    mode: entry.metadata.mode,
    mtime: new Date(entry.metadata.mtime),
    ctime: new Date(entry.metadata.ctime),
  }
}

export class AutomergeFs {
  private handle: DocHandle<FsTree>
  private repo: Repo
  private fileHandles: Map<string, DocHandle<any>> = new Map()
  private registry: FileHandlerRegistry

  private constructor(
    handle: DocHandle<FsTree>,
    repo: Repo,
    registry: FileHandlerRegistry,
  ) {
    this.handle = handle
    this.repo = repo
    this.registry = registry
  }

  private static buildRegistry(opts: { blobStore?: BlobStore; fileHandlers?: FileHandler[] }): FileHandlerRegistry {
    const registry = new FileHandlerRegistry()
    // Text first — it's the fallback default
    registry.register(textFileHandler)
    if (opts.blobStore) {
      registry.register(createBlobFileHandler(opts.blobStore))
    }
    if (opts.fileHandlers) {
      for (const fh of opts.fileHandlers) registry.register(fh)
    }
    return registry
  }

  static create(opts: {
    repo: Repo
    blobStore?: BlobStore
    fileHandlers?: FileHandler[]
  }): AutomergeFs {
    const handle = opts.repo.create<FsTree>()
    handle.change((doc) => {
      doc.tree = {}
      doc.tree["/"] = {
        type: "directory",
        parent: null,
        name: "/",
        metadata: {
          size: 0,
          mode: 0o755,
          mtime: Date.now(),
          ctime: Date.now(),
        },
      }
    })
    return new AutomergeFs(
      handle,
      opts.repo,
      AutomergeFs.buildRegistry(opts),
    )
  }

  static async load(opts: {
    repo: Repo
    rootDocUrl: string
    blobStore?: BlobStore
    fileHandlers?: FileHandler[]
  }): Promise<AutomergeFs> {
    const handle = await opts.repo.find<FsTree>(opts.rootDocUrl as AutomergeUrl)
    await handle.whenReady()
    return new AutomergeFs(
      handle,
      opts.repo,
      AutomergeFs.buildRegistry(opts),
    )
  }

  get rootDocUrl(): string {
    return this.handle.url
  }

  /** Access the file handler registry (e.g. to register handlers after creation). */
  get fileHandlerRegistry(): FileHandlerRegistry {
    return this.registry
  }

  // ===========================================================================
  // Symlink Resolution
  // ===========================================================================

  private static readonly MAX_SYMLINK_DEPTH = 40

  /**
   * Resolve a path by following any symlink at the final component.
   * Returns the resolved path and its (non-symlink) entry, or null if not found.
   * Throws ELOOP on symlink cycles.
   */
  private resolveEntry(path: string): { resolved: string; entry: FsNode } | null {
    let current = normalizePath(path)
    const seen = new Set<string>()

    for (let i = 0; i < AutomergeFs.MAX_SYMLINK_DEPTH; i++) {
      const entry = this.getEntry(current)
      if (!entry) return null
      if (entry.type !== "symlink" || !entry.symlinkTarget) {
        return { resolved: current, entry }
      }
      if (seen.has(current)) {
        throw new Error(`ELOOP: too many levels of symbolic links: ${path}`)
      }
      seen.add(current)
      const target = entry.symlinkTarget
      if (target.startsWith("/")) {
        current = normalizePath(target)
      } else {
        const parent = getParentPath(current)
        current = normalizePath(joinPath(parent, target))
      }
    }
    throw new Error(`ELOOP: too many levels of symbolic links: ${path}`)
  }

  // ===========================================================================
  // Entry Management
  // ===========================================================================

  private getEntry(path: string): FsNode | null {
    const normalized = normalizePath(path)
    const doc = this.handle.doc()
    return doc?.tree?.[normalized] ?? null
  }

  private setEntry(path: string, entry: FsNode): void {
    const normalized = normalizePath(path)
    this.handle.change((doc) => {
      if (!doc.tree) {
        doc.tree = {}
      }
      doc.tree[normalized] = entry
    })
  }

  private deleteEntry(path: string): void {
    const normalized = normalizePath(path)
    this.handle.change((doc) => {
      if (doc.tree) {
        delete doc.tree[normalized]
      }
    })
  }

  // ===========================================================================
  // File Handle Management
  // ===========================================================================

  private async getOrLoadFileHandle<T = any>(docId: string): Promise<DocHandle<T>> {
    let handle = this.fileHandles.get(docId)
    if (handle) return handle as DocHandle<T>
    handle = await this.repo.find<T>(docId as AutomergeUrl)
    await handle.whenReady()
    this.fileHandles.set(docId, handle)
    return handle as DocHandle<T>
  }

  // ===========================================================================
  // Filesystem Operations
  // ===========================================================================

  async readFile(path: string): Promise<Uint8Array> {
    const result = this.resolveEntry(path)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    const { entry, resolved } = result
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }

    if (entry.fileDocId) {
      const handle = await this.getOrLoadFileHandle(entry.fileDocId)
      const fh = this.registry.resolveForRead(resolved, handle.doc())
      return fh.read(handle)
    }

    return new Uint8Array(0)
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // If path points to an existing symlink, resolve it
    const existingRaw = this.getEntry(path)
    const normalized = existingRaw?.type === "symlink"
      ? (this.resolveEntry(path)?.resolved ?? normalizePath(path))
      : normalizePath(path)
    const parentPath = getParentPath(normalized)

    const parent = this.getEntry(parentPath)
    if (!parent || parent.type !== "directory") {
      throw new Error(`ENOENT: no such file or directory: ${parentPath}`)
    }

    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content
    const size = bytes.length

    const now = Date.now()
    const existing = this.getEntry(normalized)

    const metadata = {
      size,
      mode: existing?.metadata.mode ?? 0o644,
      mtime: now,
      ctime: existing?.metadata.ctime ?? now,
    }

    const fh = this.registry.resolveForWrite(normalized, bytes)

    if (existing?.fileDocId) {
      const handle = await this.getOrLoadFileHandle(existing.fileDocId)
      const existingFh = this.registry.resolveForRead(normalized, handle.doc())

      if (existingFh.name === fh.name) {
        // Same handler — update in place
        await fh.write(handle, bytes)

        this.setEntry(normalized, {
          type: "file",
          parent: parentPath,
          name: getBasename(normalized),
          metadata,
          fileDocId: existing.fileDocId,
        })
      } else {
        // Handler changed — create a new doc
        const newHandle = await fh.createDoc(this.repo, bytes)
        this.fileHandles.set(newHandle.url, newHandle)
        this.fileHandles.delete(existing.fileDocId)

        this.setEntry(normalized, {
          type: "file",
          parent: parentPath,
          name: getBasename(normalized),
          metadata,
          fileDocId: newHandle.url,
        })
      }
    } else {
      // New file — create doc
      const handle = await fh.createDoc(this.repo, bytes)
      this.fileHandles.set(handle.url, handle)

      this.setEntry(normalized, {
        type: "file",
        parent: parentPath,
        name: getBasename(normalized),
        metadata,
        fileDocId: handle.url,
      })
    }
  }

  stat(path: string): StatInfo {
    const result = this.resolveEntry(path)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    return toStatInfo(result.entry)
  }

  lstat(path: string): StatInfo {
    const entry = this.getEntry(path)
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    return toStatInfo(entry)
  }

  readdir(path: string): DirEntry[] {
    const result = this.resolveEntry(path)

    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    if (result.entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory: ${path}`)
    }

    const doc = this.handle.doc()
    const entries: DirEntry[] = []

    for (const [, entryData] of Object.entries(doc?.tree ?? {})) {
      if (entryData.parent === result.resolved) {
        entries.push({
          name: entryData.name,
          isFile: entryData.type === "file",
          isDirectory: entryData.type === "directory",
          isSymbolicLink: entryData.type === "symlink",
        })
      }
    }

    return entries
  }

  mkdir(path: string, options?: { recursive?: boolean }): void {
    const normalized = normalizePath(path)

    const existing = this.getEntry(normalized)
    if (existing) {
      if (existing.type === "directory") return
      throw new Error(`EEXIST: file already exists: ${path}`)
    }

    const parentPath = getParentPath(normalized)

    const parent = this.getEntry(parentPath)
    if (!parent) {
      if (options?.recursive) {
        this.mkdir(parentPath, options)
      } else {
        throw new Error(`ENOENT: no such file or directory: ${parentPath}`)
      }
    } else if (parent.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory: ${parentPath}`)
    }

    const now = Date.now()
    this.setEntry(normalized, {
      type: "directory",
      parent: parentPath,
      name: getBasename(normalized),
      metadata: {
        size: 0,
        mode: 0o755,
        mtime: now,
        ctime: now,
      },
    })
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const normalized = normalizePath(path)
    const entry = this.getEntry(normalized)

    if (!entry) {
      if (options?.force) return
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    if (entry.type === "directory") {
      if (options?.recursive) {
        const children = this.readdir(normalized)
        for (const child of children) {
          await this.remove(joinPath(normalized, child.name), options)
        }
      } else {
        const children = this.readdir(normalized)
        if (children.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty: ${path}`)
        }
      }
    }

    if (entry.type === "file" && entry.fileDocId) {
      if (!this.hasOtherFileDocRef(normalized, entry.fileDocId)) {
        this.fileHandles.delete(entry.fileDocId)
      }
    }

    this.deleteEntry(normalized)
  }

  exists(path: string): boolean {
    return this.resolveEntry(path) !== null
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const srcEntry = this.getEntry(oldPath)
    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${oldPath}`)
    }

    if (srcEntry.type === "file") {
      const destNorm = normalizePath(newPath)
      const parentPath = getParentPath(destNorm)
      const parent = this.getEntry(parentPath)
      if (!parent || parent.type !== "directory") {
        throw new Error(`ENOENT: no such file or directory: ${parentPath}`)
      }

      const now = Date.now()
      const newEntry: FsNode = {
        type: srcEntry.type,
        parent: parentPath,
        name: getBasename(destNorm),
        metadata: {
          size: srcEntry.metadata.size,
          mode: srcEntry.metadata.mode,
          mtime: now,
          ctime: srcEntry.metadata.ctime,
        },
      }
      if (srcEntry.fileDocId) newEntry.fileDocId = srcEntry.fileDocId

      this.setEntry(destNorm, newEntry)
      this.deleteEntry(oldPath)
    } else {
      // Move directory: reparent all children in a single Automerge change
      const srcNorm = normalizePath(oldPath)
      const destNorm = normalizePath(newPath)
      const destParent = getParentPath(destNorm)
      const parent = this.getEntry(destParent)
      if (!parent || parent.type !== "directory") {
        throw new Error(`ENOENT: no such file or directory: ${destParent}`)
      }

      this.handle.change((doc) => {
        const allPaths = Object.keys(doc.tree)
        const toMove = allPaths.filter(
          (p) => p === srcNorm || p.startsWith(srcNorm + "/")
        )

        for (const p of toMove) {
          const entry = doc.tree[p]!
          const relativePath = p === srcNorm ? "" : p.slice(srcNorm.length)
          const newP = destNorm + relativePath
          const newParentPath = relativePath
            ? getParentPath(newP)
            : destParent

          doc.tree[newP] = {
            ...entry,
            parent: newParentPath,
            name: getBasename(newP),
          }
          delete doc.tree[p]
        }
      })
    }
  }

  async copy(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const result = this.resolveEntry(src)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${src}`)
    }

    if (result.entry.type === "file") {
      const content = await this.readFile(result.resolved)
      await this.writeFile(dest, content)
    } else if (result.entry.type === "directory" && (options?.recursive ?? true)) {
      this.mkdir(dest, { recursive: true })
      const children = this.readdir(result.resolved)
      const srcNorm = result.resolved
      const destNorm = normalizePath(dest)
      for (const child of children) {
        await this.copy(joinPath(srcNorm, child.name), joinPath(destNorm, child.name), options)
      }
    } else {
      throw new Error(`EISDIR: is a directory: ${src}`)
    }
  }

  chmod(path: string, mode: number): void {
    const result = this.resolveEntry(path)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    const resolved = result.resolved
    this.handle.change((doc) => {
      const entry = doc.tree[resolved]
      if (entry) {
        entry.metadata.mode = mode
      }
    })
  }

  utimes(path: string, _atime: number | Date, mtime: number | Date): void {
    const result = this.resolveEntry(path)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    const resolved = result.resolved
    const mtimeMs = typeof mtime === "number" ? mtime : mtime.getTime()
    this.handle.change((doc) => {
      const entry = doc.tree[resolved]
      if (entry) {
        entry.metadata.mtime = mtimeMs
      }
    })
  }

  async truncate(path: string, length = 0): Promise<void> {
    const result = this.resolveEntry(path)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    if (result.entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }

    if (length === 0) {
      await this.writeFile(result.resolved, "")
    } else {
      const content = await this.readFile(result.resolved)
      await this.writeFile(result.resolved, content.slice(0, length))
    }
  }

  // ===========================================================================
  // Reference Counting
  // ===========================================================================

  /**
   * Check whether any tree entry OTHER than `excludePath` references the given
   * fileDocId. Used to decide if cleanup is safe on remove.
   */
  private hasOtherFileDocRef(excludePath: string, fileDocId: string): boolean {
    const doc = this.handle.doc()
    if (!doc?.tree) return false
    for (const [p, entry] of Object.entries(doc.tree)) {
      if (p !== excludePath && entry.fileDocId === fileDocId) return true
    }
    return false
  }

  // ===========================================================================
  // Symlink Operations
  // ===========================================================================

  symlink(target: string, linkPath: string): void {
    const normalized = normalizePath(linkPath)
    const parentPath = getParentPath(normalized)

    const parent = this.getEntry(parentPath)
    if (!parent || parent.type !== "directory") {
      throw new Error(`ENOENT: no such file or directory: ${parentPath}`)
    }

    const existing = this.getEntry(normalized)
    if (existing) {
      throw new Error(`EEXIST: file already exists: ${linkPath}`)
    }

    const now = Date.now()
    this.setEntry(normalized, {
      type: "symlink",
      parent: parentPath,
      name: getBasename(normalized),
      metadata: {
        size: target.length,
        mode: 0o777,
        mtime: now,
        ctime: now,
      },
      symlinkTarget: target,
    })
  }

  readlink(path: string): string {
    const entry = this.getEntry(path)
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    if (entry.type !== "symlink" || !entry.symlinkTarget) {
      throw new Error(`EINVAL: invalid argument: ${path}`)
    }
    return entry.symlinkTarget
  }

  /**
   * Create a hard link. Both paths share the same underlying fileDocId,
   * so writes through either path are visible through both, and removing one
   * does not affect the other.
   */
  link(existingPath: string, newPath: string): void {
    const result = this.resolveEntry(existingPath)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${existingPath}`)
    }
    if (result.entry.type !== "file") {
      throw new Error(`EPERM: operation not permitted on a directory: ${existingPath}`)
    }

    const normalized = normalizePath(newPath)
    const parentPath = getParentPath(normalized)

    const parent = this.getEntry(parentPath)
    if (!parent || parent.type !== "directory") {
      throw new Error(`ENOENT: no such file or directory: ${parentPath}`)
    }

    const existing = this.getEntry(normalized)
    if (existing) {
      throw new Error(`EEXIST: file already exists: ${newPath}`)
    }

    const now = Date.now()
    const newEntry: FsNode = {
      type: "file",
      parent: parentPath,
      name: getBasename(normalized),
      metadata: {
        size: result.entry.metadata.size,
        mode: result.entry.metadata.mode,
        mtime: now,
        ctime: result.entry.metadata.ctime,
      },
    }
    if (result.entry.fileDocId) newEntry.fileDocId = result.entry.fileDocId

    this.setEntry(normalized, newEntry)
  }

  // ===========================================================================
  // Version Control
  // ===========================================================================

  getRootHeads(): string[] {
    const doc = this.handle.doc()
    if (!doc) return []
    return [...Automerge.getHeads(doc)]
  }

  async getFileHeads(path: string): Promise<string[]> {
    const entry = this.getEntry(path)
    if (!entry?.fileDocId) return []
    const handle = await this.getOrLoadFileHandle(entry.fileDocId)
    const doc = handle.doc()
    if (!doc) return []
    return [...Automerge.getHeads(doc)]
  }

  async getFileHistory(
    path: string
  ): Promise<
    Array<{
      hash: string
      actor: string
      seq: number
      timestamp: number
      message: string | null
    }>
  > {
    const entry = this.getEntry(path)
    if (!entry?.fileDocId) return []
    const handle = await this.getOrLoadFileHandle(entry.fileDocId)
    const doc = handle.doc()
    if (!doc) return []
    const history = Automerge.getHistory(doc)
    return history.map((state) => ({
      hash: state.change.hash,
      actor: state.change.actor,
      seq: state.change.seq,
      timestamp: state.change.time,
      message: state.change.message ?? null,
    }))
  }

  async getFileAt(path: string, heads: string[]): Promise<string> {
    const entry = this.getEntry(path)
    if (!entry?.fileDocId) return ""
    const handle = await this.getOrLoadFileHandle(entry.fileDocId)
    const doc = handle.doc()
    if (!doc) return ""
    try {
      const viewed = Automerge.view(doc, heads as Automerge.Heads)
      return (viewed as unknown as TextFileDoc).content ?? ""
    } catch {
      return ""
    }
  }

  async diff(
    path: string,
    fromHeads: string[],
    toHeads: string[]
  ): Promise<Automerge.Patch[]> {
    const entry = this.getEntry(path)
    if (!entry?.fileDocId) return []
    const handle = await this.getOrLoadFileHandle(entry.fileDocId)
    const doc = handle.doc()
    if (!doc) return []
    try {
      return Automerge.diff(
        doc,
        fromHeads as Automerge.Heads,
        toHeads as Automerge.Heads
      )
    } catch {
      return []
    }
  }

  // ===========================================================================
  // Metadata
  // ===========================================================================

  getAllPaths(): string[] {
    const doc = this.handle.doc()
    if (!doc?.tree) return []
    return Object.keys(doc.tree)
  }

  // ===========================================================================
  // Document Access
  // ===========================================================================

  /**
   * Get the underlying Automerge DocHandle for a file.
   * Useful for integrating with editors like ProseMirror that need
   * direct access to the CRDT document.
   * Throws if the path doesn't exist or isn't a file.
   */
  async getFileDocHandle(path: string): Promise<DocHandle<TextFileDoc>> {
    const result = this.resolveEntry(path)
    if (!result) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    const { entry } = result
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }
    if (!entry.fileDocId) {
      throw new Error(`No document handle for file: ${path}`)
    }
    return this.getOrLoadFileHandle<TextFileDoc>(entry.fileDocId)
  }
}
