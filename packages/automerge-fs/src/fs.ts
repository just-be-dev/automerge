/**
 * AutomergeFs — a virtual file system backed by Automerge CRDTs.
 *
 * Uses one Automerge document per text file with updateText() for
 * character-level CRDT merging. Binary files are stored in a BlobStore.
 * Directory tree structure is maintained in a single root document.
 */

import * as Automerge from "@automerge/automerge"
import { Repo, type DocHandle, type AutomergeUrl } from "@automerge/automerge-repo"
import type { BlobStore } from "./blob-store"

// =============================================================================
// Document Schema
// =============================================================================

interface FsRootDoc {
  tree: Record<string, TreeEntry>
}

interface TreeEntry {
  type: "file" | "directory"
  parent: string | null
  name: string
  metadata: {
    size: number
    mode: number
    mtime: number
    ctime: number
  }
  fileDocId?: string
  blobHash?: string
}

interface FileDoc {
  content: string
}

// =============================================================================
// AutomergeFsMultiDoc
// =============================================================================

export class AutomergeFsMultiDoc {
  private handle: DocHandle<FsRootDoc>
  private repo: Repo
  private blobStore: BlobStore
  private fileHandles: Map<string, DocHandle<FileDoc>> = new Map()

  private constructor(handle: DocHandle<FsRootDoc>, repo: Repo, blobStore: BlobStore) {
    this.handle = handle
    this.repo = repo
    this.blobStore = blobStore
  }

  static create(opts: { repo: Repo; blobStore: BlobStore }): AutomergeFsMultiDoc {
    const handle = opts.repo.create<FsRootDoc>()
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
    return new AutomergeFsMultiDoc(handle, opts.repo, opts.blobStore)
  }

  static async load(opts: {
    repo: Repo
    blobStore: BlobStore
    rootDocUrl: string
  }): Promise<AutomergeFsMultiDoc> {
    const handle = await opts.repo.find<FsRootDoc>(opts.rootDocUrl as AutomergeUrl)
    await handle.whenReady()
    return new AutomergeFsMultiDoc(handle, opts.repo, opts.blobStore)
  }

  get rootDocUrl(): string {
    return this.handle.url
  }

  // ===========================================================================
  // Path Helpers
  // ===========================================================================

  private normalizePath(path: string): string {
    if (path === "/") return "/"
    return path.replace(/\/+$/, "").replace(/\/+/g, "/")
  }

  private getParentPath(path: string): string {
    if (path === "/") return "/"
    const parts = path.split("/").filter((p) => p)
    if (parts.length === 1) return "/"
    return "/" + parts.slice(0, -1).join("/")
  }

  private getBasename(path: string): string {
    if (path === "/") return "/"
    const parts = path.split("/").filter((p) => p)
    return parts[parts.length - 1] ?? ""
  }

  // ===========================================================================
  // Entry Management
  // ===========================================================================

  private getEntry(path: string): TreeEntry | null {
    const normalized = this.normalizePath(path)
    const doc = this.handle.doc()
    return doc?.tree?.[normalized] ?? null
  }

  private setEntry(path: string, entry: TreeEntry): void {
    const normalized = this.normalizePath(path)
    this.handle.change((doc) => {
      if (!doc.tree) {
        doc.tree = {}
      }
      doc.tree[normalized] = entry
    })
  }

  private deleteEntry(path: string): void {
    const normalized = this.normalizePath(path)
    this.handle.change((doc) => {
      if (doc.tree) {
        delete doc.tree[normalized]
      }
    })
  }

  // ===========================================================================
  // Binary Detection
  // ===========================================================================

  private isBinary(bytes: Uint8Array): boolean {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      return false
    } catch {
      return true
    }
  }

  // ===========================================================================
  // File Handle Management
  // ===========================================================================

  private async getOrLoadFileHandle(docId: string): Promise<DocHandle<FileDoc>> {
    let handle = this.fileHandles.get(docId)
    if (handle) return handle
    handle = await this.repo.find<FileDoc>(docId as AutomergeUrl)
    await handle.whenReady()
    this.fileHandles.set(docId, handle)
    return handle
  }

  private createFileDoc(initialContent: string): DocHandle<FileDoc> {
    const handle = this.repo.create<FileDoc>()
    handle.change((doc) => {
      doc.content = initialContent
    })
    this.fileHandles.set(handle.url, handle)
    return handle
  }

  // ===========================================================================
  // Filesystem Operations
  // ===========================================================================

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.getEntry(path)
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }

    if (entry.blobHash) {
      const blob = await this.blobStore.get(entry.blobHash)
      if (!blob) {
        throw new Error(`Blob not found: ${entry.blobHash}`)
      }
      return blob
    }

    if (entry.fileDocId) {
      const handle = await this.getOrLoadFileHandle(entry.fileDocId)
      const doc = handle.doc()
      return new TextEncoder().encode(doc?.content ?? "")
    }

    return new Uint8Array(0)
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const normalized = this.normalizePath(path)
    const parentPath = this.getParentPath(normalized)

    const parent = this.getEntry(parentPath)
    if (!parent || parent.type !== "directory") {
      throw new Error(`ENOENT: no such file or directory: ${parentPath}`)
    }

    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content
    const size = bytes.length
    const binary = typeof content !== "string" && this.isBinary(bytes)

    const now = Date.now()
    const existing = this.getEntry(normalized)

    if (binary) {
      const blobHash = await this.createBlobHash(bytes)
      await this.blobStore.set(blobHash, bytes)

      if (existing?.fileDocId) {
        this.fileHandles.delete(existing.fileDocId)
      }

      this.setEntry(normalized, {
        type: "file",
        parent: parentPath,
        name: this.getBasename(normalized),
        metadata: {
          size,
          mode: existing?.metadata.mode ?? 0o644,
          mtime: now,
          ctime: existing?.metadata.ctime ?? now,
        },
        blobHash,
      })
    } else {
      const text =
        typeof content === "string" ? content : new TextDecoder().decode(bytes)

      let fileDocId: string

      if (existing?.fileDocId) {
        const handle = await this.getOrLoadFileHandle(existing.fileDocId)
        handle.change((doc) => {
          Automerge.updateText(doc, ["content"], text)
        })
        fileDocId = existing.fileDocId
      } else {
        const handle = this.createFileDoc(text)
        fileDocId = handle.url
      }

      if (existing?.blobHash) {
        await this.blobStore.delete(existing.blobHash)
      }

      this.setEntry(normalized, {
        type: "file",
        parent: parentPath,
        name: this.getBasename(normalized),
        metadata: {
          size,
          mode: existing?.metadata.mode ?? 0o644,
          mtime: now,
          ctime: existing?.metadata.ctime ?? now,
        },
        fileDocId,
      })
    }
  }

  stat(path: string): {
    size: number
    isFile: boolean
    isDirectory: boolean
    mode: number
    mtime: Date
    ctime: Date
  } {
    const entry = this.getEntry(path)
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    return {
      size: entry.metadata.size,
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      mode: entry.metadata.mode,
      mtime: new Date(entry.metadata.mtime),
      ctime: new Date(entry.metadata.ctime),
    }
  }

  readdir(path: string): Array<{ name: string; isFile: boolean; isDirectory: boolean }> {
    const normalized = this.normalizePath(path)
    const entry = this.getEntry(normalized)

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory: ${path}`)
    }

    const doc = this.handle.doc()
    const entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }> = []

    for (const [, entryData] of Object.entries(doc?.tree ?? {})) {
      if (entryData.parent === normalized) {
        entries.push({
          name: entryData.name,
          isFile: entryData.type === "file",
          isDirectory: entryData.type === "directory",
        })
      }
    }

    return entries
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const normalized = this.normalizePath(path)

    const existing = this.getEntry(normalized)
    if (existing) {
      if (existing.type === "directory") return
      throw new Error(`EEXIST: file already exists: ${path}`)
    }

    const parentPath = this.getParentPath(normalized)

    const parent = this.getEntry(parentPath)
    if (!parent) {
      if (options?.recursive) {
        await this.mkdir(parentPath, options)
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
      name: this.getBasename(normalized),
      metadata: {
        size: 0,
        mode: 0o755,
        mtime: now,
        ctime: now,
      },
    })
  }

  async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const normalized = this.normalizePath(path)
    const entry = this.getEntry(normalized)

    if (!entry) {
      if (options?.force) return
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    if (entry.type === "directory") {
      if (options?.recursive) {
        const children = this.readdir(normalized)
        for (const child of children) {
          const childPath =
            normalized === "/" ? `/${child.name}` : `${normalized}/${child.name}`
          await this.remove(childPath, options)
        }
      } else {
        const children = this.readdir(normalized)
        if (children.length > 0) {
          throw new Error(`ENOTEMPTY: directory not empty: ${path}`)
        }
      }
    }

    if (entry.type === "file" && entry.blobHash) {
      await this.blobStore.delete(entry.blobHash)
    }
    if (entry.type === "file" && entry.fileDocId) {
      this.fileHandles.delete(entry.fileDocId)
    }

    this.deleteEntry(normalized)
  }

  exists(path: string): boolean {
    return this.getEntry(path) !== null
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const srcEntry = this.getEntry(oldPath)
    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${oldPath}`)
    }

    if (srcEntry.type === "file") {
      const destNorm = this.normalizePath(newPath)
      const parentPath = this.getParentPath(destNorm)
      const parent = this.getEntry(parentPath)
      if (!parent || parent.type !== "directory") {
        throw new Error(`ENOENT: no such file or directory: ${parentPath}`)
      }

      const now = Date.now()
      const newEntry: TreeEntry = {
        type: srcEntry.type,
        parent: parentPath,
        name: this.getBasename(destNorm),
        metadata: {
          size: srcEntry.metadata.size,
          mode: srcEntry.metadata.mode,
          mtime: now,
          ctime: srcEntry.metadata.ctime,
        },
      }
      if (srcEntry.fileDocId) newEntry.fileDocId = srcEntry.fileDocId
      if (srcEntry.blobHash) newEntry.blobHash = srcEntry.blobHash

      this.setEntry(destNorm, newEntry)
      this.deleteEntry(oldPath)
    } else {
      // Move directory: reparent all children in a single Automerge change
      const srcNorm = this.normalizePath(oldPath)
      const destNorm = this.normalizePath(newPath)
      const destParent = this.getParentPath(destNorm)
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
            ? this.getParentPath(newP)
            : destParent

          doc.tree[newP] = {
            ...entry,
            parent: newParentPath,
            name: this.getBasename(newP),
          }
          delete doc.tree[p]
        }
      })
    }
  }

  async copy(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const srcEntry = this.getEntry(src)
    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory: ${src}`)
    }

    if (srcEntry.type === "file") {
      const content = await this.readFile(src)
      await this.writeFile(dest, content)
    } else if (srcEntry.type === "directory" && (options?.recursive ?? true)) {
      await this.mkdir(dest, { recursive: true })
      const children = this.readdir(src)
      const srcNorm = this.normalizePath(src)
      const destNorm = this.normalizePath(dest)
      for (const child of children) {
        const childSrc =
          srcNorm === "/" ? `/${child.name}` : `${srcNorm}/${child.name}`
        const childDest =
          destNorm === "/" ? `/${child.name}` : `${destNorm}/${child.name}`
        await this.copy(childSrc, childDest, options)
      }
    } else {
      throw new Error(`EISDIR: is a directory: ${src}`)
    }
  }

  chmod(path: string, mode: number): void {
    const normalized = this.normalizePath(path)
    const entry = this.getEntry(normalized)
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    this.handle.change((doc) => {
      if (doc.tree[normalized]) {
        doc.tree[normalized].metadata.mode = mode
      }
    })
  }

  utimes(path: string, _atime: number | Date, mtime: number | Date): void {
    const normalized = this.normalizePath(path)
    const entry = this.getEntry(normalized)
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }

    const mtimeMs = typeof mtime === "number" ? mtime : mtime.getTime()
    this.handle.change((doc) => {
      if (doc.tree[normalized]) {
        doc.tree[normalized].metadata.mtime = mtimeMs
      }
    })
  }

  async truncate(path: string, length = 0): Promise<void> {
    const normalized = this.normalizePath(path)
    const entry = this.getEntry(normalized)
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory: ${path}`)
    }
    if (entry.type !== "file") {
      throw new Error(`EISDIR: illegal operation on a directory: ${path}`)
    }

    if (length === 0) {
      await this.writeFile(normalized, "")
    } else {
      const content = await this.readFile(normalized)
      await this.writeFile(normalized, content.slice(0, length))
    }
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
      return (viewed as unknown as FileDoc).content ?? ""
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
  // Helpers
  // ===========================================================================

  private async createBlobHash(data: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
  }
}
