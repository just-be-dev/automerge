import { ServiceMap } from "effect"

export interface BlobStore {
  get(hash: string): Promise<Uint8Array | null>
  set(hash: string, data: Uint8Array): Promise<void>
  has(hash: string): Promise<boolean>
  delete(hash: string): Promise<void>
  list(): Promise<string[]>
}

export class InMemoryBlobStore implements BlobStore {
  private store = new Map<string, Uint8Array>()

  async get(hash: string): Promise<Uint8Array | null> {
    return this.store.get(hash) ?? null
  }

  async set(hash: string, data: Uint8Array): Promise<void> {
    this.store.set(hash, data)
  }

  async has(hash: string): Promise<boolean> {
    return this.store.has(hash)
  }

  async delete(hash: string): Promise<void> {
    this.store.delete(hash)
  }

  async list(): Promise<string[]> {
    return [...this.store.keys()]
  }
}

export class BlobStoreTag extends ServiceMap.Service<BlobStoreTag, BlobStore>()(
  "@just-be/automerge-fs/BlobStore"
) {}
