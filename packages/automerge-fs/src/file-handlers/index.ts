/**
 * Generic file handler system for AutomergeFs.
 *
 * Every file in the filesystem is backed by an Automerge document. File handlers
 * define how content is read from and written to that document.
 *
 * Each document stores a `_type` discriminator (e.g. "text.v1") that identifies
 * which handler and version created it. Version-aware handlers can provide lenses
 * for migrating between versions.
 */

import type { Repo, DocHandle } from "@automerge/automerge-repo"
import {
  type TypedDoc,
  type FileHandlerLens,
  parseDocType,
  formatDocType,
  applyLenses,
} from "./utils/lens"

// =============================================================================
// Re-exports from lens module
// =============================================================================

export { type TypedDoc, type FileHandlerLens, parseDocType, formatDocType, applyLenses } from "./utils/lens.ts"

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
  /** Type name for this handler (e.g. "text", "blob"). */
  readonly type: string

  /** Version string (e.g. "v1"). Combined with type → _type = "text.v1". */
  readonly version: string

  /**
   * File extensions this handler handles, including the dot (e.g. [".png", ".jpg"]).
   * Return an empty array if this handler doesn't match by extension.
   */
  readonly extensions: readonly string[]

  /** Optional lenses for migrating between versions. */
  readonly lenses?: readonly FileHandlerLens[]

  /** Create a new Automerge document for this handler and write initial content. */
  createDoc(repo: Repo, content: Uint8Array): Promise<DocHandle<TDoc>>

  /** Write content into an existing Automerge document. */
  write(handle: DocHandle<TDoc>, content: Uint8Array): Promise<void>

  /** Read content from an Automerge document, returning raw bytes. */
  read(handle: DocHandle<TDoc>): Promise<Uint8Array>

  /** Read from a plain doc value (used for lensed views). */
  readDoc(doc: TDoc): Promise<Uint8Array>
}

// =============================================================================
// FileHandlerRegistry
// =============================================================================

export class FileHandlerRegistry {
  private handlersByType: Map<string, FileHandler> = new Map()
  private extensionMap: Map<string, string> = new Map()
  private handlers: FileHandler[] = []

  /** Register a file handler. Later registrations take priority over earlier ones. */
  register(handler: FileHandler): void {
    this.handlers.push(handler)
    this.handlersByType.set(handler.type, handler)
    for (const ext of handler.extensions) {
      this.extensionMap.set(ext, handler.type)
    }
  }

  /**
   * Resolve which handler should read an existing doc.
   *
   * Reads the `_type` field from the doc, parses it, and looks up the handler
   * by type name. If the version differs from the handler's current version,
   * callers should use `applyLenses` to transform the doc.
   */
  resolveForRead(doc: unknown): FileHandler {
    const typed = doc as TypedDoc | null | undefined
    if (typed?._type) {
      const { type } = parseDocType(typed._type)
      const handler = this.handlersByType.get(type)
      if (handler) return handler
    }

    throw new Error(`No file handler matched for reading (doc _type: ${(doc as any)?._type ?? "missing"})`)
  }

  /**
   * Resolve which handler should write new content.
   *
   * Resolution order:
   * 1. File extension match via extensionMap.
   * 2. Sniff a small prefix to pick text vs blob handler.
   * 3. Falls back to the first registered handler (typically "text").
   */
  resolveForWrite(path: string, content: Uint8Array): FileHandler {
    const ext = extname(path)

    if (ext) {
      const typeName = this.extensionMap.get(ext)
      if (typeName) {
        const handler = this.handlersByType.get(typeName)
        if (handler) return handler
      }

      // Check handlers in reverse order for extension match
      for (let i = this.handlers.length - 1; i >= 0; i--) {
        const fh = this.handlers[i]!
        if (fh.extensions.includes(ext)) return fh
      }
    }

    // Sniff content to pick text vs blob
    const typeName = looksLikeText(content) ? "text" : "blob"
    const handler = this.handlersByType.get(typeName)
    if (handler) return handler

    const fallback = this.handlers[0]
    if (!fallback) throw new Error(`No file handler registered for writing "${path}"`)
    return fallback
  }

  /**
   * Apply lenses to transform a doc from its stored version to the handler's
   * current version. Returns a transformed view — does NOT mutate the stored doc.
   * Returns null if no lens path is found (versions already match or no lenses available).
   */
  applyLenses(doc: unknown, handler: FileHandler): unknown | null {
    const lenses = handler.lenses
    if (!lenses?.length) return null
    const targetTag = formatDocType(handler.type, handler.version)
    return applyLenses(doc, targetTag, lenses)
  }

  /** Look up a file handler by type name. */
  getByType(type: string): FileHandler | undefined {
    return this.handlersByType.get(type)
  }
}

// =============================================================================
// Re-exports
// =============================================================================

export { textFileHandler, type TextFileDoc } from "./text.ts"
export { createBlobFileHandler, type BlobFileDoc } from "./blob.ts"

// =============================================================================
// Internal Helpers
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
