/**
 * Blob file handler.
 *
 * Stores binary data in a BlobStore and keeps a reference (hash) in the
 * Automerge document. The doc itself is lightweight — just a pointer.
 *
 * Use `createBlobFileHandler(blobStore)` to create an instance that closes
 * over the blob store. The fs itself doesn't know about blob storage.
 */

import type { Repo, DocHandle } from "@automerge/automerge-repo"
import type { BlobStore } from "../blob-store.ts"
import type { FileHandler, TypedDoc } from "./index.ts"

export interface BlobFileDoc extends TypedDoc {
  blobRef: string
}

async function createBlobHash(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
}

export function createBlobFileHandler(blobStore: BlobStore): FileHandler<BlobFileDoc> {
  return {
    type: "blob",
    version: "v1",
    extensions: [],

    async createDoc(repo: Repo, content: Uint8Array): Promise<DocHandle<BlobFileDoc>> {
      const hash = await createBlobHash(content)
      await blobStore.set(hash, content)

      const handle = repo.create<BlobFileDoc>()
      handle.change((doc) => {
        doc._type = "blob.v1"
        doc.blobRef = hash
      })
      return handle
    },

    async write(handle: DocHandle<BlobFileDoc>, content: Uint8Array): Promise<void> {
      const oldDoc = handle.doc()
      const oldHash = oldDoc?.blobRef

      const hash = await createBlobHash(content)
      await blobStore.set(hash, content)

      handle.change((doc) => {
        doc.blobRef = hash
      })

      if (oldHash && oldHash !== hash) {
        await blobStore.delete(oldHash)
      }
    },

    async read(handle: DocHandle<BlobFileDoc>): Promise<Uint8Array> {
      const doc = handle.doc()
      if (!doc?.blobRef) return new Uint8Array(0)

      const blob = await blobStore.get(doc.blobRef)
      if (!blob) {
        throw new Error(`Blob not found: ${doc.blobRef}`)
      }
      return blob
    },

    async readDoc(doc: BlobFileDoc): Promise<Uint8Array> {
      if (!doc?.blobRef) return new Uint8Array(0)

      const blob = await blobStore.get(doc.blobRef)
      if (!blob) {
        throw new Error(`Blob not found: ${doc.blobRef}`)
      }
      return blob
    },
  }
}
