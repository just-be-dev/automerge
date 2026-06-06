/**
 * Per-document Durable Object that hosts an Automerge {@link Repo}, accepts
 * client WebSockets for sync, and persists chunks via a {@link RepoStoreDO}.
 *
 * Wire it into `wrangler.toml`:
 * ```toml
 * [[durable_objects.bindings]]
 * name = "AUTOMERGE_DO"
 * class_name = "AutomergeDO"
 * ```
 *
 * Then re-export it from your worker entry (Cloudflare requires DO classes
 * to be exported from the entry module):
 * ```ts
 * export { AutomergeDO } from "@just-be/automerge-cloudflare"
 * ```
 *
 * Subclass to customize the repo-store DO id or peer id:
 * ```ts
 * class MyAutomergeDO extends AutomergeDO {
 *   protected override repoStoreId() { return this.ctx.id.toString() }
 * }
 * ```
 */

import "./polyfill.ts"
import { DurableObject } from "cloudflare:workers"
import { Repo, type PeerId } from "@automerge/automerge-repo"
import { RepoStoreAdapter } from "./storage/adapter.ts"
import type { RepoStoreDO } from "./storage/repo-store-do.ts"
import { DONetworkAdapter } from "./network/index.ts"

export interface AutomergeDOEnv {
  AUTOMERGE_REPO_STORE: DurableObjectNamespace<RepoStoreDO>
}

export class AutomergeDO<
  Env extends AutomergeDOEnv = AutomergeDOEnv,
> extends DurableObject<Env> {
  protected network: DONetworkAdapter
  protected repo: Repo

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.network = new DONetworkAdapter(ctx)
    const stub = env.AUTOMERGE_REPO_STORE.get(
      env.AUTOMERGE_REPO_STORE.idFromName(this.repoStoreId())
    )
    this.repo = new Repo({
      network: [this.network],
      storage: new RepoStoreAdapter(stub),
      peerId: this.peerId(),
      isEphemeral: false,
    })
  }

  /** Repo-store DO name to use for storage. Default: `"default"`. */
  protected repoStoreId(): string {
    return "default"
  }

  /** Peer id advertised on the sync protocol. Default: `do-<ctx.id>`. */
  protected peerId(): PeerId {
    return `do-${this.ctx.id.toString()}` as PeerId
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 })
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  override webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): void {
    this.network.receiveMessage(ws, message)
  }

  override webSocketClose(ws: WebSocket): void {
    this.network.handleClose(ws)
  }

  override webSocketError(ws: WebSocket): void {
    this.network.handleClose(ws)
  }
}
