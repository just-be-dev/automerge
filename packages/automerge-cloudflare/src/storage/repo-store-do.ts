/**
 * Top-level Durable Object that fronts an entire Automerge repo's storage.
 *
 * Receives StorageKey ops over DO RPC and routes them through
 * {@link RepoStoreCore}:
 *
 * - single-segment keys (adapter-internal metadata such as
 *   `["storage-adapter-id"]`) land in this DO's own SQLite (`repo_meta`);
 * - multi-segment keys are forwarded to the per-document {@link DocStoreDO}
 *   identified by `key[0]`.
 *
 * This DO also maintains a `repo_docs` index of every documentId it has
 * stored a chunk for. Reads for unknown docs short-circuit without
 * instantiating a `DocStoreDO`, which on production Cloudflare would
 * otherwise commit billable SQLite storage per spurious lookup.
 *
 * The expected `wrangler.toml` shape:
 * ```toml
 * [[durable_objects.bindings]]
 * name = "AUTOMERGE_REPO_STORE"
 * class_name = "RepoStoreDO"
 *
 * [[durable_objects.bindings]]
 * name = "AUTOMERGE_DOC_STORE"
 * class_name = "DocStoreDO"
 * ```
 *
 * Consumers should generally not call this DO directly — instead, wrap a
 * stub of it with {@link RepoStoreAdapter} and hand that to `new Repo(...)`.
 */

import { DurableObject } from "cloudflare:workers"
import type { Chunk, StorageKey } from "@automerge/automerge-repo"
import type { DocStoreDO } from "./doc-store-do.ts"
import {
  RepoStoreCore,
  type DocIndex,
  type DocStoreInterface,
  type MetaStore,
} from "./repo-store-core.ts"

const META_TABLE = "repo_meta"
const DOCS_TABLE = "repo_docs"

export interface RepoStoreEnv {
  AUTOMERGE_DOC_STORE: DurableObjectNamespace<DocStoreDO>
}

export class RepoStoreDO<
  Env extends RepoStoreEnv = RepoStoreEnv,
> extends DurableObject<Env> {
  #core: RepoStoreCore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
        key TEXT PRIMARY KEY,
        data BLOB NOT NULL
      )`
    )
    sql.exec(
      `CREATE TABLE IF NOT EXISTS ${DOCS_TABLE} (
        doc_id TEXT PRIMARY KEY
      )`
    )

    this.#core = new RepoStoreCore({
      resolve: (docId) => {
        const id = env.AUTOMERGE_DOC_STORE.idFromName(docId)
        return env.AUTOMERGE_DOC_STORE.get(id) as unknown as DocStoreInterface
      },
      meta: new SqliteMetaStore(sql),
      index: new SqliteDocIndex(sql),
    })
  }

  load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.#core.load(key)
  }

  save(key: StorageKey, data: Uint8Array): Promise<void> {
    return this.#core.save(key, data)
  }

  remove(key: StorageKey): Promise<void> {
    return this.#core.remove(key)
  }

  loadRange(prefix: StorageKey): Promise<Chunk[]> {
    return this.#core.loadRange(prefix)
  }

  removeRange(prefix: StorageKey): Promise<void> {
    return this.#core.removeRange(prefix)
  }

  loadOrInit(key: StorageKey, value: Uint8Array): Promise<Uint8Array> {
    return this.#core.loadOrInit(key, value)
  }
}

class SqliteMetaStore implements MetaStore {
  #sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.#sql = sql
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const row = this.#sql
      .exec<{ data: ArrayBuffer }>(
        `SELECT data FROM ${META_TABLE} WHERE key = ?`,
        key.join("/")
      )
      .toArray()[0]
    if (!row) return undefined
    return new Uint8Array(row.data)
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.#sql.exec(
      `INSERT INTO ${META_TABLE} (key, data) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET data = excluded.data`,
      key.join("/"),
      data
    )
  }

  async remove(key: StorageKey): Promise<void> {
    this.#sql.exec(`DELETE FROM ${META_TABLE} WHERE key = ?`, key.join("/"))
  }
}

class SqliteDocIndex implements DocIndex {
  #sql: SqlStorage

  constructor(sql: SqlStorage) {
    this.#sql = sql
  }

  async has(docId: string): Promise<boolean> {
    const row = this.#sql
      .exec<{ n: number }>(
        `SELECT 1 AS n FROM ${DOCS_TABLE} WHERE doc_id = ? LIMIT 1`,
        docId
      )
      .toArray()[0]
    return row !== undefined
  }

  async add(docId: string): Promise<void> {
    this.#sql.exec(
      `INSERT INTO ${DOCS_TABLE} (doc_id) VALUES (?) ON CONFLICT DO NOTHING`,
      docId
    )
  }
}
