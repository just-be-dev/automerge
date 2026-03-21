/**
 * Generic file handler system for AutomergeFs.
 *
 * Every file in the filesystem is backed by an Automerge document. File handlers
 * define how content is read from and written to that document, and how to
 * match files to the right handler.
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
   * Optional predicate for matching files beyond extension checks.
   * Called when no extension match is found (or to override extension matching).
   *
   * Receives the file path and the raw content being written.
   * Return `true` to claim this file.
   */
  match?(path: string, content: Uint8Array): boolean

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
   * Resolve which file handler should handle a given file.
   *
   * Resolution order:
   * 1. File extension match (most specific, checked in reverse registration order)
   * 2. Custom `match()` predicate (checked in reverse registration order)
   * 3. Falls back to the default handler (first registered, typically "text")
   */
  resolve(path: string, content: Uint8Array): FileHandler {
    const ext = extname(path)

    // Check extensions first (most specific match)
    if (ext) {
      for (let i = this.handlers.length - 1; i >= 0; i--) {
        const fh = this.handlers[i]!
        if (fh.extensions.includes(ext)) return fh
      }
    }

    // Then custom matchers (reverse = last registered wins)
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const fh = this.handlers[i]!
      if (fh.match?.(path, content)) return fh
    }

    // Fall back to default (first registered)
    return this.handlers[0]!
  }

  /** Look up a file handler by name. */
  get(name: string): FileHandler | undefined {
    return this.handlers.find((h) => h.name === name)
  }
}

// =============================================================================
// Helpers
// =============================================================================

function extname(path: string): string {
  const basename = path.split("/").pop() ?? ""
  const dotIndex = basename.lastIndexOf(".")
  if (dotIndex <= 0) return ""
  return basename.slice(dotIndex)
}
