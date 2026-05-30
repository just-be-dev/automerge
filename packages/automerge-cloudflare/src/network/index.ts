/**
 * A Cloudflare Workers network adapter for automerge-repo.
 *
 * Designed for a one-DO-per-document architecture with hibernation support:
 *
 * 1. A Worker receives WebSocket upgrade requests with the document ID in the URL.
 * 2. It forwards the WebSocket to a Durable Object identified by that document ID.
 * 3. Inside the DO, a {@link DONetworkAdapter} bridges each client WebSocket
 *    to the automerge-repo {@link Repo}.
 * 4. When the DO hibernates, peer-to-socket mappings are persisted via
 *    WebSocket attachments and restored on wake-up.
 *
 * The Worker entry point uses {@link routeWebSocket} to handle routing.
 * The DO uses {@link DONetworkAdapter} as its network adapter.
 */

import {
  NetworkAdapter,
  cbor,
  type Message,
  type PeerId,
  type PeerMetadata,
} from "@automerge/automerge-repo"

// ── Wire protocol ───────────────────────────────────────────────────

interface JoinMessage {
  type: "join"
  senderId: PeerId
  peerMetadata: PeerMetadata
}

interface PeerMessage {
  type: "peer"
  senderId: PeerId
  peerMetadata: PeerMetadata
  targetId: PeerId
}

type ClientMessage = JoinMessage | Message

function isJoinMessage(msg: ClientMessage): msg is JoinMessage {
  return msg.type === "join"
}

/** Data persisted on each WebSocket via serializeAttachment. */
interface SocketAttachment {
  peerId: PeerId
  peerMetadata: PeerMetadata
}

// ── DONetworkAdapter ────────────────────────────────────────────────

/**
 * Network adapter that runs inside a Durable Object, managing WebSocket
 * connections from clients for a single document. Supports hibernation —
 * peer-to-socket mappings are persisted via WebSocket attachments and
 * restored from `ctx.getWebSockets()` on wake-up.
 *
 * Usage:
 * ```ts
 * export class AutomergeDO extends DurableObject {
 *   #adapter = new DONetworkAdapter(this.ctx)
 *   #repo = new Repo({
 *     network: [this.#adapter],
 *     storage: new RepoStoreAdapter(env.AUTOMERGE_REPO_STORE.get(...)),
 *   })
 *
 *   async fetch(request: Request): Promise<Response> {
 *     const { 0: client, 1: server } = new WebSocketPair()
 *     this.ctx.acceptWebSocket(server)
 *     return new Response(null, { status: 101, webSocket: client })
 *   }
 *
 *   webSocketMessage(ws: WebSocket, message: ArrayBuffer | string) {
 *     this.#adapter.receiveMessage(ws, message)
 *   }
 *
 *   webSocketClose(ws: WebSocket) {
 *     this.#adapter.handleClose(ws)
 *   }
 *
 *   webSocketError(ws: WebSocket) {
 *     this.#adapter.handleClose(ws)
 *   }
 * }
 * ```
 */
export class DONetworkAdapter extends NetworkAdapter {
  #ctx: DurableObjectState
  #sockets = new Map<PeerId, WebSocket>()
  #peerIds = new Map<WebSocket, PeerId>()

  constructor(ctx: DurableObjectState) {
    super()
    this.#ctx = ctx
  }

  isReady(): boolean {
    return true
  }

  whenReady(): Promise<void> {
    return Promise.resolve()
  }

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId
    this.peerMetadata = peerMetadata
    this.#restore()
  }

  send(message: Message): void {
    if (!("targetId" in message) || !message.targetId) return

    const socket = this.#sockets.get(message.targetId)
    if (!socket) return

    const encoded = cbor.encode(message)
    socket.send(encoded)
  }

  /**
   * Called from the DO's `webSocketMessage` handler.
   */
  receiveMessage(ws: WebSocket, data: ArrayBuffer | string): void {
    if (typeof data === "string") return

    let message: ClientMessage
    try {
      message = cbor.decode(new Uint8Array(data))
    } catch {
      ws.close(1002, "invalid message")
      return
    }

    if (isJoinMessage(message)) {
      const { senderId, peerMetadata } = message

      // Clean up any existing connection for this peer
      const existing = this.#sockets.get(senderId)
      if (existing && existing !== ws) {
        this.#peerIds.delete(existing)
        this.emit("peer-disconnected", { peerId: senderId })
      }

      this.#track(ws, senderId, peerMetadata)

      // Respond with our peer info
      const response: PeerMessage = {
        type: "peer",
        senderId: this.peerId!,
        peerMetadata: this.peerMetadata!,
        targetId: senderId,
      }
      ws.send(cbor.encode(response))

      // Notify the repo
      this.emit("peer-candidate", { peerId: senderId, peerMetadata })
    } else {
      this.emit("message", message)
    }
  }

  /**
   * Called from the DO's `webSocketClose` or `webSocketError` handler.
   */
  handleClose(ws: WebSocket): void {
    const peerId = this.#peerIds.get(ws)
    if (peerId) {
      this.#sockets.delete(peerId)
      this.#peerIds.delete(ws)
      this.emit("peer-disconnected", { peerId })
    }
  }

  /**
   * Called by the Repo to disconnect from all peers.
   */
  disconnect(): void {
    for (const [peerId] of this.#sockets) {
      this.emit("peer-disconnected", { peerId })
    }
    this.#sockets.clear()
    this.#peerIds.clear()
  }

  /**
   * Restore peer-to-socket mappings from hibernated WebSocket attachments.
   * Called during `connect()` which runs when the Repo initializes (including
   * after a hibernation wake-up).
   */
  #restore(): void {
    const websockets = this.#ctx.getWebSockets()
    for (const ws of websockets) {
      const attachment = ws.deserializeAttachment() as SocketAttachment | null
      if (!attachment) continue

      const { peerId, peerMetadata } = attachment
      this.#sockets.set(peerId, ws)
      this.#peerIds.set(ws, peerId)

      // Re-announce peers to the repo so it can resume syncing
      this.emit("peer-candidate", { peerId, peerMetadata })
    }
  }

  #track(ws: WebSocket, peerId: PeerId, peerMetadata: PeerMetadata): void {
    this.#sockets.set(peerId, ws)
    this.#peerIds.set(ws, peerId)

    const attachment: SocketAttachment = { peerId, peerMetadata }
    ws.serializeAttachment(attachment)
  }
}

// ── Worker routing helper ───────────────────────────────────────────

export interface RouteWebSocketOptions {
  /** The incoming request. */
  request: Request

  /** The DO namespace binding for the automerge DOs. */
  namespace: DurableObjectNamespace

  /**
   * Extract the document ID from the request. Defaults to using the last
   * path segment of the URL (e.g. `/doc/abc123` → `"abc123"`).
   */
  getDocumentId?: (request: Request) => string
}

/**
 * Worker-level helper that upgrades a request to a WebSocket and forwards
 * it to the Durable Object for the given document.
 *
 * Usage in a Worker:
 * ```ts
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return routeWebSocket({ request, namespace: env.AUTOMERGE_DO })
 *   }
 * }
 * ```
 */
export async function routeWebSocket(
  options: RouteWebSocketOptions
): Promise<Response> {
  const { request, namespace } = options

  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 })
  }

  const getDocumentId =
    options.getDocumentId ?? defaultGetDocumentId
  const documentId = getDocumentId(request)

  const id = namespace.idFromName(documentId)
  const stub = namespace.get(id)
  return stub.fetch(request)
}

function defaultGetDocumentId(request: Request): string {
  const url = new URL(request.url)
  const segments = url.pathname.split("/").filter(Boolean)
  const last = segments[segments.length - 1]
  if (!last) throw new Error("No document ID found in URL path")
  return last
}
