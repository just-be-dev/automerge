/**
 * Blob file type.
 *
 * Stores binary data in the BlobStore and keeps a reference (hash) in the
 * Automerge document. The doc itself is lightweight — just a pointer.
 */

import type { Repo, DocHandle } from "@automerge/automerge-repo"
import type { FileType, FileTypeContext } from "../file-types"

export interface BlobFileDoc {
  blobRef: string
}

async function createBlobHash(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export const blobFileType: FileType<BlobFileDoc> = {
  name: "blob",
  extensions: [],

  match(_path: string, content: Uint8Array): boolean {
    // Claim any file whose content is NOT valid UTF-8 (binary)
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(content)
      return false
    } catch {
      return true
    }
  },

  async createDoc(
    repo: Repo,
    content: Uint8Array,
    ctx: FileTypeContext,
  ): Promise<DocHandle<BlobFileDoc>> {
    const hash = await createBlobHash(content)
    await ctx.blobStore.set(hash, content)

    const handle = repo.create<BlobFileDoc>()
    handle.change((doc) => {
      doc.blobRef = hash
    })
    return handle
  },

  async write(
    handle: DocHandle<BlobFileDoc>,
    content: Uint8Array,
    ctx: FileTypeContext,
  ): Promise<void> {
    const oldDoc = handle.doc()
    const oldHash = oldDoc?.blobRef

    const hash = await createBlobHash(content)
    await ctx.blobStore.set(hash, content)

    handle.change((doc) => {
      doc.blobRef = hash
    })

    // Clean up old blob if hash changed
    if (oldHash && oldHash !== hash) {
      await ctx.blobStore.delete(oldHash)
    }
  },

  async read(
    handle: DocHandle<BlobFileDoc>,
    ctx: FileTypeContext,
  ): Promise<Uint8Array> {
    const doc = handle.doc()
    if (!doc?.blobRef) return new Uint8Array(0)

    const blob = await ctx.blobStore.get(doc.blobRef)
    if (!blob) {
      throw new Error(`Blob not found: ${doc.blobRef}`)
    }
    return blob
  },
}
