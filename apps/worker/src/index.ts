import { AutomergeDO } from "@just-be/automerge-cloudflare"
import { routeWebSocket } from "@just-be/automerge-cloudflare/network"
import {
  RepoStoreDO,
  DocStoreDO,
} from "@just-be/automerge-cloudflare/storage"

export { AutomergeDO, RepoStoreDO, DocStoreDO }

interface Env {
  AUTOMERGE_DO: DurableObjectNamespace<AutomergeDO>
  AUTOMERGE_REPO_STORE: DurableObjectNamespace<RepoStoreDO>
  AUTOMERGE_DOC_STORE: DurableObjectNamespace<DocStoreDO>
}

const DEFAULT_ROOT_KEY = ["default-root"]

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname.startsWith("/ws")) {
      return routeWebSocket({
        request,
        namespace: env.AUTOMERGE_DO,
        getDocumentId: () => "default",
      })
    }

    if (url.pathname === "/default-root") {
      return handleDefaultRoot(request, env)
    }

    return new Response("automerge-worker", { status: 200 })
  },
} satisfies ExportedHandler<Env>

async function handleDefaultRoot(
  request: Request,
  env: Env
): Promise<Response> {
  const repoStore = env.AUTOMERGE_REPO_STORE.get(
    env.AUTOMERGE_REPO_STORE.idFromName("default")
  )

  if (request.method === "GET") {
    const data = await repoStore.load(DEFAULT_ROOT_KEY)
    return Response.json({
      url: data ? new TextDecoder().decode(data) : null,
    })
  }

  if (request.method === "PUT") {
    const body = (await request.json().catch(() => null)) as
      | { url?: unknown }
      | null
    if (!body || typeof body.url !== "string" || body.url.length === 0) {
      return new Response("expected { url: string }", { status: 400 })
    }
    const winner = await repoStore.loadOrInit(
      DEFAULT_ROOT_KEY,
      new TextEncoder().encode(body.url)
    )
    return Response.json({ url: new TextDecoder().decode(winner) })
  }

  return new Response("method not allowed", {
    status: 405,
    headers: { Allow: "GET, PUT" },
  })
}
