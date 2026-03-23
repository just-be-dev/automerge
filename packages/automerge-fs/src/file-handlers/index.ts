/**
 * Generic file handler system for AutomergeFs.
 *
 * Every file in the filesystem is backed by an Automerge document. File handlers
 * define how content is read from and written to that document, and how to
 * match files to the right handler.
 *
 * Handler selection is "schema on read": the registry inspects the loaded doc at
 * read time to pick the right handler. No handler name is persisted in the tree.
 */

import type { Repo, DocHandle } from "@automerge/automerge-repo"

// =============================================================================
// FileHandler Interface
// =============================================================================

/**
 * A file handler defines how a particular kind of file is stored in and
 * retrieved from its backing Automerge document.
 *
 * `TDoc` is the shape of the Automerge document this handler uses.
 *
 * File handlers that need external resources (e.g. a blob store) should close
 * over them — the fs itself doesn't know about those dependencies.
 */
export interface FileHandler<TDoc = unknown> {
  /** Unique identifier for this handler (e.g. "text", "blob"). */
  readonly name: string

  /**
   * File extensions this handler handles, including the dot (e.g. [".png", ".jpg"]).
   * Return an empty array if this handler doesn't match by extension.
   */
  readonly extensions: readonly string[]

  /**
   * Read-time predicate. Called with the full file path and the loaded Automerge
   * doc to determine if this handler can read the document.
   * Extension filtering happens before this is called.
   *
   * Return `true` to claim this file for reading.
   */
  match?(path: string, doc: unknown): boolean

  /** Create a new Automerge document for this handler and write initial content. */
  createDoc(repo: Repo, content: Uint8Array): Promise<DocHandle<TDoc>>

  /** Write content into an existing Automerge document. */
  write(handle: DocHandle<TDoc>, content: Uint8Array): Promise<void>

  /** Read content from an Automerge document, returning raw bytes. */
  read(handle: DocHandle<TDoc>): Promise<Uint8Array>
}

// =============================================================================
// FileHandlerRegistry
// =============================================================================

export class FileHandlerRegistry {
  private handlers: FileHandler[] = []

  /** Register a file handler. Later registrations take priority over earlier ones. */
  register(handler: FileHandler): void {
    this.handlers.push(handler)
  }

  /**
   * Resolve which handler should read an existing doc (schema-on-read).
   *
   * Resolution order:
   * 1. If the file extension is claimed by any registered handler, only those
   *    handlers are considered as candidates.
   * 2. Otherwise all handlers are candidates.
   * 3. Among candidates (last registered first), the first whose `match(path, doc)`
   *    returns true (or has no `match`) is returned.
   * 4. Throws if nothing matches.
   */
  resolveForRead(path: string, doc: unknown): FileHandler {
    const ext = extname(path)
    const byExt = ext ? this.handlers.filter((h) => h.extensions.includes(ext)) : []

    const candidates = byExt.length > 0 ? byExt : this.handlers

    for (let i = candidates.length - 1; i >= 0; i--) {
      const fh = candidates[i]!
      if (!fh.match || fh.match(path, doc)) return fh
    }

    throw new Error(`No file handler matched for reading "${path}"`)
  }

  /**
   * Resolve which handler should write new content.
   *
   * Resolution order:
   * 1. File extension match (last registered wins).
   * 2. Path-based `match(path, undefined)` predicates (last registered wins).
   * 3. Sniff a small prefix to pick text vs blob handler.
   * 4. Falls back to the first registered handler (typically "text").
   */
  resolveForWrite(path: string, content: Uint8Array): FileHandler {
    const ext = extname(path)

    if (ext) {
      for (let i = this.handlers.length - 1; i >= 0; i--) {
        const fh = this.handlers[i]!
        if (fh.extensions.includes(ext)) return fh
      }
    }

    // Path-based matchers (handlers whose match() uses only the path)
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const fh = this.handlers[i]!
      if (fh.match?.(path, undefined)) return fh
    }

    // No handler claimed this file — sniff a small prefix to pick text vs blob
    const handlerName = looksLikeText(content) ? "text" : "blob"
    const handler = this.handlers.find((h) => h.name === handlerName)
    if (handler) return handler

    const fallback = this.handlers[0]
    if (!fallback) throw new Error(`No file handler registered for writing "${path}"`)
    return fallback
  }

  /** Look up a file handler by name. */
  get(name: string): FileHandler | undefined {
    return this.handlers.find((h) => h.name === name)
  }
}

// =============================================================================
// Re-exports
// =============================================================================

export { textFileHandler, type TextFileDoc } from "./text"
export { createBlobFileHandler, type BlobFileDoc } from "./blob"

// =============================================================================
// Helpers
// =============================================================================

function extname(path: string): string {
  const basename = path.split("/").pop() ?? ""
  const dotIndex = basename.lastIndexOf(".")
  if (dotIndex <= 0) return ""
  return basename.slice(dotIndex)
}

const textProbeDecoder = new TextDecoder("utf-8", { fatal: true })

function looksLikeText(content: Uint8Array): boolean {
  try {
    textProbeDecoder.decode(content.subarray(0, 512))
    return true
  } catch {
    return false
  }
}
