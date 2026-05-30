import { DurableObject } from "cloudflare:workers"
import { Repo, type PeerId } from "@automerge/automerge-repo"
import {
  RepoStoreAdapter,
  type RepoStoreDO,
  type DocStoreDO,
} from "@just-be/automerge-cloudflare/storage"
import { DONetworkAdapter } from "@just-be/automerge-cloudflare/network"

export interface Env {
  AUTOMERGE_DO: DurableObjectNamespace<AutomergeDO>
  AUTOMERGE_REPO_STORE: DurableObjectNamespace<RepoStoreDO>
  AUTOMERGE_DOC_STORE: DurableObjectNamespace<DocStoreDO>
}

export class AutomergeDO extends DurableObject<Env> {
  #network: DONetworkAdapter
  #repo: Repo

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.#network = new DONetworkAdapter(ctx)
    const stub = env.AUTOMERGE_REPO_STORE.get(
      env.AUTOMERGE_REPO_STORE.idFromName("default")
    )
    this.#repo = new Repo({
      network: [this.#network],
      storage: new RepoStoreAdapter(stub),
      peerId: `do-${ctx.id.toString()}` as PeerId,
      isEphemeral: false,
    })
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
    this.#network.receiveMessage(ws, message)
  }

  override webSocketClose(ws: WebSocket): void {
    this.#network.handleClose(ws)
  }

  override webSocketError(ws: WebSocket): void {
    this.#network.handleClose(ws)
  }
}
