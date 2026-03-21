/**
 * Generic file type system for AutomergeFs.
 *
 * Every file in the filesystem is backed by an Automerge document. File types
 * define how content is read from and written to that document, and how to
 * match files to the right handler.
 */

import type { Repo, DocHandle } from "@automerge/automerge-repo"
import type { BlobStore } from "./blob-store"

// =============================================================================
// FileType Interface
// =============================================================================

/** Context provided to file type read/write operations. */
export interface FileTypeContext {
  repo: Repo
  blobStore: BlobStore
}

/**
 * A file type defines how a particular kind of file is stored in and retrieved
 * from its backing Automerge document.
 *
 * `TDoc` is the shape of the Automerge document this file type uses.
 */
export interface FileType<TDoc = unknown> {
  /** Unique identifier for this file type (e.g. "text", "blob"). */
  readonly name: string

  /**
   * File extensions this type handles, including the dot (e.g. [".png", ".jpg"]).
   * Return an empty array if this type doesn't match by extension.
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

  /** Create a new Automerge document for this file type and write initial content. */
  createDoc(
    repo: Repo,
    content: Uint8Array,
    ctx: FileTypeContext,
  ): Promise<DocHandle<TDoc>>

  /** Write content into an existing Automerge document. */
  write(
    handle: DocHandle<TDoc>,
    content: Uint8Array,
    ctx: FileTypeContext,
  ): Promise<void>

  /** Read content from an Automerge document, returning raw bytes. */
  read(
    handle: DocHandle<TDoc>,
    ctx: FileTypeContext,
  ): Promise<Uint8Array>
}

// =============================================================================
// FileTypeRegistry
// =============================================================================

export class FileTypeRegistry {
  private types: FileType[] = []

  /** Register a file type. Later registrations take priority over earlier ones. */
  register(type: FileType): void {
    this.types.push(type)
  }

  /**
   * Resolve which file type should handle a given file.
   *
   * Resolution order:
   * 1. File extension match (most specific, checked in reverse registration order)
   * 2. Custom `match()` predicate (checked in reverse registration order)
   * 3. Falls back to the default type (first registered, typically "text")
   */
  resolve(path: string, content: Uint8Array): FileType {
    const ext = extname(path)

    // Check extensions first (most specific match)
    if (ext) {
      for (let i = this.types.length - 1; i >= 0; i--) {
        const ft = this.types[i]!
        if (ft.extensions.includes(ext)) return ft
      }
    }

    // Then custom matchers (reverse = last registered wins)
    for (let i = this.types.length - 1; i >= 0; i--) {
      const ft = this.types[i]!
      if (ft.match?.(path, content)) return ft
    }

    // Fall back to default (first registered)
    return this.types[0]!
  }

  /** Look up a file type by name. */
  get(name: string): FileType | undefined {
    return this.types.find((t) => t.name === name)
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
