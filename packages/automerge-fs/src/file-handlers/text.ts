/**
 * Default text file handler.
 *
 * Stores file content as a string in the Automerge document using
 * `Automerge.updateText()` for character-level CRDT merging.
 */

import * as Automerge from "@automerge/automerge"
import type { Repo, DocHandle } from "@automerge/automerge-repo"
import type { FileHandler } from "./"

export interface TextFileDoc {
  content: string
}

export const textFileHandler: FileHandler<TextFileDoc> = {
  name: "text",
  extensions: [],

  match(_path: string, doc: unknown): boolean {
    return typeof (doc as any)?.content === "string"
  },

  async createDoc(repo: Repo, content: Uint8Array): Promise<DocHandle<TextFileDoc>> {
    const text = new TextDecoder().decode(content)
    const handle = repo.create<TextFileDoc>()
    handle.change((doc) => {
      doc.content = text
    })
    return handle
  },

  async write(handle: DocHandle<TextFileDoc>, content: Uint8Array): Promise<void> {
    const text = new TextDecoder().decode(content)
    handle.change((doc) => {
      Automerge.updateText(doc, ["content"], text)
    })
  },

  async read(handle: DocHandle<TextFileDoc>): Promise<Uint8Array> {
    const doc = handle.doc()
    return new TextEncoder().encode(doc?.content ?? "")
  },
}
