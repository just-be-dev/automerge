# @just-be/automerge-cloudflare

[Automerge](https://automerge.org/) storage and network primitives for [Cloudflare Workers](https://developers.cloudflare.com/workers/).

Designed around a **one-Durable-Object-per-document** architecture with full hibernation support — clients stay connected while idle DOs sleep, with no billing for inactive time.

## Exports

| Subpath | Description |
|---|---|
| `@just-be/automerge-cloudflare/storage` | Two-tier Durable Object storage (top-level router + per-document store) with a client-side `StorageAdapterInterface` |
| `@just-be/automerge-cloudflare/network` | WebSocket network adapter + Worker routing helper |

## Architecture

Storage is split across **two** Durable Object classes plus a small client-side library:

- **`RepoStoreDO`** — top-level router. Implements automerge-repo's storage RPC surface; reads the documentId from each `StorageKey` (always `key[0]` per the [automerge-repo contract](https://github.com/automerge/automerge-repo/blob/main/packages/automerge-repo/src/storage/types.ts)) and forwards every call to that document's `DocStoreDO`. Stateless — no chunk data lives here.
- **`DocStoreDO`** — per-document store. One instance per documentId, named via `idFromName(docId)`. Owns the chunks for that doc. The *store* tier is the DO's own SQLite storage; the *archive* tier is an optional R2 bucket bound via env. Writes go to the store only; reads fall through store → archive; removals propagate to both; tiering lifecycle (`hydrate`, `flushToArchive`, `clearAll`) is exposed for use from an alarm or external coordinator.
- **`RepoStoreAdapter`** — the library wrapper. Implements automerge-repo's `StorageAdapterInterface` by delegating each call to a `RepoStoreDO` stub over DO RPC. This is what you hand to `new Repo({ storage })`.

Why two DO layers? The router gives the repo a single addressable stub (one binding for the consumer), while per-doc DOs keep each document's storage in its own DO — letting writes/reads stay strongly consistent with that document's writers and allowing per-document lifecycle without cross-doc coordination.

## Quick start

### 1. Define your application Durable Object

```ts
// src/do.ts
import { DurableObject } from "cloudflare:workers"
import { Repo } from "@automerge/automerge-repo"
import {
  RepoStoreAdapter,
  RepoStoreDO,
  DocStoreDO,
} from "@just-be/automerge-cloudflare/storage"
import { DONetworkAdapter } from "@just-be/automerge-cloudflare/network"

// Re-export the storage DOs so wrangler can bind them.
export { RepoStoreDO, DocStoreDO }

interface Env {
  AUTOMERGE_REPO_STORE: DurableObjectNamespace<RepoStoreDO>
  AUTOMERGE_DOC_STORE: DurableObjectNamespace<DocStoreDO>
  AUTOMERGE_R2?: R2Bucket
}

export class AutomergeDO extends DurableObject<Env> {
  #network = new DONetworkAdapter(this.ctx)
  #repo: Repo

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const stub = env.AUTOMERGE_REPO_STORE.get(
      env.AUTOMERGE_REPO_STORE.idFromName("default")
    )
    this.#repo = new Repo({
      network: [this.#network],
      storage: new RepoStoreAdapter(stub),
      peerId: `do-${this.ctx.id.toString()}` as any,
      isEphemeral: false,
    })
  }

  async fetch(request: Request): Promise<Response> {
    const { 0: client, 1: server } = new WebSocketPair()
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
    this.#network.receiveMessage(ws, message)
  }

  webSocketClose(ws: WebSocket) {
    this.#network.handleClose(ws)
  }

  webSocketError(ws: WebSocket) {
    this.#network.handleClose(ws)
  }
}
```

### 2. Route requests from your Worker

```ts
// src/index.ts
import { routeWebSocket } from "@just-be/automerge-cloudflare/network"

interface Env {
  AUTOMERGE_DO: DurableObjectNamespace
}

export { AutomergeDO } from "./do"
export { RepoStoreDO, DocStoreDO } from "./do"

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return routeWebSocket({ request, namespace: env.AUTOMERGE_DO })
  },
}
```

`routeWebSocket` uses the last URL path segment as the document ID (e.g. `/doc/abc123` routes to the DO named `abc123`). Pass a custom `getDocumentId` function to change this:

```ts
routeWebSocket({
  request,
  namespace: env.AUTOMERGE_DO,
  getDocumentId: (req) => new URL(req.url).searchParams.get("docId")!,
})
```

### 3. Configure wrangler

```toml
# wrangler.toml
name = "automerge-sync"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[durable_objects.bindings]]
name = "AUTOMERGE_DO"
class_name = "AutomergeDO"

[[durable_objects.bindings]]
name = "AUTOMERGE_REPO_STORE"
class_name = "RepoStoreDO"

[[durable_objects.bindings]]
name = "AUTOMERGE_DOC_STORE"
class_name = "DocStoreDO"

# Optional cold tier for the per-doc DOs.
[[r2_buckets]]
binding = "AUTOMERGE_R2"
bucket_name = "automerge-cold"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["AutomergeDO", "RepoStoreDO", "DocStoreDO"]
```

### 4. Connect from a client

Use the standard [`@automerge/automerge-repo-network-websocket`](https://github.com/automerge/automerge-repo/tree/main/packages/automerge-repo-network-websocket) client adapter, pointed at your Worker URL with the document ID in the path:

```ts
import { Repo } from "@automerge/automerge-repo"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"

const repo = new Repo({
  network: [new BrowserWebSocketClientAdapter("wss://your-worker.workers.dev/doc/abc123")],
})
```

## Archive tier (R2)

Bind `AUTOMERGE_R2` in the env of `DocStoreDO` to enable an archive tier. When present:

- **Writes** go to the store (DO SQLite) only.
- **Reads** check the store first, then fall through to the archive. Archive hits are **promoted into the store** so subsequent reads stay hot (lazy hydration).
- **Removes** propagate to both tiers so the read fallback can't resurrect deleted keys.

### Idle-flush alarm

When an archive is bound, `DocStoreDO` runs a per-doc alarm that flushes the whole store to the archive once the doc has been idle (no writes) for `AUTOMERGE_IDLE_FLUSH_MS` (default **7 days**). After a flush the chunks live only in R2; if the doc wakes up again, reads pull them back into the store on demand.

Configure via `[vars]` in `wrangler.toml`:

```toml
[vars]
AUTOMERGE_IDLE_FLUSH_MS = "604800000"  # 7 days (default)
```

Lifecycle methods on `DocStoreDO` (callable over DO RPC):

| Method | Description |
|---|---|
| `hydrate(prefix)` | Copy chunks under `prefix` from archive → store. Idempotent. |
| `flushToArchive(prefix)` | Move chunks under `prefix` from store → archive (copy then evict). Idempotent. |
| `clearAll()` | Wipe the whole store tier (uses SQL `DELETE FROM ...`). Archive preserved. |

To drop chunks without archiving them, call `removeRange(prefix)` — that's the normal `StorageAdapterInterface` op and it propagates to both tiers.

For most workloads the built-in idle-flush alarm is sufficient; the explicit `flushToArchive` / `hydrate` / `clearAll` RPCs are there for cases where you want to drive the lifecycle from outside the DO.

## Hibernation

The network adapter fully supports [Durable Object hibernation](https://developers.cloudflare.com/durable-objects/api/websockets/). When a DO hibernates:

- Client WebSocket connections are maintained by Cloudflare's infrastructure
- Peer identity is persisted on each WebSocket via `serializeAttachment`
- On wake-up, the adapter restores peer mappings from `ctx.getWebSockets()` and re-announces peers to the Repo so syncing resumes automatically

This means you only pay for compute time when messages are actually being exchanged.
