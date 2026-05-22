# @just-be/automerge-cloudflare

[Automerge](https://automerge.org/) storage and network adapters for [Cloudflare Workers](https://developers.cloudflare.com/workers/).

Designed around a **one-Durable-Object-per-document** architecture with full hibernation support — clients stay connected while idle DOs sleep, with no billing for inactive time.

## Exports

| Subpath | Description |
|---|---|
| `@just-be/automerge-cloudflare/storage/do` | Durable Object transactional storage adapter |
| `@just-be/automerge-cloudflare/storage/r2` | R2 object storage adapter |
| `@just-be/automerge-cloudflare/storage/d1` | D1 SQLite database adapter |
| `@just-be/automerge-cloudflare/storage/tiered` | Hot/cold tiered adapter (e.g. DO + R2) |
| `@just-be/automerge-cloudflare/network` | WebSocket network adapter + Worker routing helper |

## Quick start

### 1. Define your Durable Object

```ts
// src/do.ts
import { Repo } from "@automerge/automerge-repo"
import { DOStorageAdapter } from "@just-be/automerge-cloudflare/storage/do"
import { DONetworkAdapter } from "@just-be/automerge-cloudflare/network"

export class AutomergeDO extends DurableObject {
  #network = new DONetworkAdapter(this.ctx)
  #repo = new Repo({
    network: [this.#network],
    storage: new DOStorageAdapter(this.ctx.storage),
    peerId: `do-${this.ctx.id.toString()}` as any,
    isEphemeral: false,
  })

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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return routeWebSocket({ request, namespace: env.AUTOMERGE_DO })
  },
}
```

By default, `routeWebSocket` uses the last URL path segment as the document ID (e.g. `/doc/abc123` routes to the DO named `abc123`). Pass a custom `getDocumentId` function to change this:

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

[[migrations]]
tag = "v1"
new_classes = ["AutomergeDO"]
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

## Storage adapters

All three storage adapters implement automerge-repo's `StorageAdapterInterface`. They use the same key layout (the first two characters of the document ID are used as a shard prefix), so data written by one adapter can be read by another.

### Durable Object storage

Best for the one-DO-per-document pattern. Strongly consistent, co-located with the DO, no extra bindings needed.

```ts
import { DOStorageAdapter } from "@just-be/automerge-cloudflare/storage/do"

const storage = new DOStorageAdapter(ctx.storage)
```

### R2

Best for bulk/archival storage, large documents, or when you need data accessible outside Workers.

```ts
import { R2StorageAdapter } from "@just-be/automerge-cloudflare/storage/r2"

const storage = new R2StorageAdapter(env.BUCKET)

// Optional: namespace keys under a prefix
const storage = new R2StorageAdapter(env.BUCKET, { prefix: "automerge/" })
```

### D1

Best when you want to query document metadata alongside automerge data using SQL.

```ts
import { D1StorageAdapter } from "@just-be/automerge-cloudflare/storage/d1"

const storage = new D1StorageAdapter(env.DB)
```

The table `automerge_storage` is created automatically on first use.

### Tiered storage

Pairs a fast "hot" adapter with a cheaper "cold" adapter. Live Repo writes hit only the hot tier so per-change syncs stay low-latency; an explicit `flushToCold([docId])` call (typically from a DO `alarm()`) promotes chunks to durable, externally-readable storage. Reads fall through hot → cold; removals propagate to both. This is the recommended pattern for long-lived documents that would otherwise grow against the 10 GB DO storage cap.

```ts
import { Repo } from "@automerge/automerge-repo"
import { DOStorageAdapter } from "@just-be/automerge-cloudflare/storage/do"
import { R2StorageAdapter } from "@just-be/automerge-cloudflare/storage/r2"
import { TieredStorageAdapter } from "@just-be/automerge-cloudflare/storage/tiered"

export class AutomergeDO extends DurableObject<Env> {
  #hot = new DOStorageAdapter(this.ctx.storage)
  #cold = new R2StorageAdapter(this.env.BUCKET)
  #storage = new TieredStorageAdapter(this.#hot, this.#cold)
  #activeDocs = new Set<string>()

  #repo = new Repo({
    storage: this.#storage,
    // ...network, peerId, etc.
  })

  async alarm() {
    for (const docId of this.#activeDocs) {
      await this.#storage.flushToCold([docId])
    }
    await this.ctx.storage.setAlarm(Date.now() + 60_000)
  }
}
```

Notes:
- Writes go only to hot — cold is updated solely by `flushToCold`.
- Deletes propagate to both tiers so the read fallback can't resurrect them.
- Tracking which doc IDs need flushing is the user's responsibility (e.g. a `Set` in DO state or an index in D1).
- To free hot capacity after a flush, call `hotAdapter.removeRange([docId])` directly on the underlying adapter.

## Hibernation

The network adapter fully supports [Durable Object hibernation](https://developers.cloudflare.com/durable-objects/api/websockets/). When a DO hibernates:

- Client WebSocket connections are maintained by Cloudflare's infrastructure
- Peer identity is persisted on each WebSocket via `serializeAttachment`
- On wake-up, the adapter restores peer mappings from `ctx.getWebSockets()` and re-announces peers to the Repo so syncing resumes automatically

This means you only pay for compute time when messages are actually being exchanged.
