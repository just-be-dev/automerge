import "./polyfill.ts"
import { routeWebSocket } from "@just-be/automerge-cloudflare/network"
import type { Env } from "./automerge-do.ts"

export { AutomergeDO } from "./automerge-do.ts"
export { RepoStoreDO, DocStoreDO } from "@just-be/automerge-cloudflare/storage"

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
    // Set-if-absent. A racing client whose PUT lost discovers the winner via
    // the returned URL and adopts it instead of orphaning its own root doc.
    const existing = await repoStore.load(DEFAULT_ROOT_KEY)
    if (existing) {
      return Response.json({ url: new TextDecoder().decode(existing) })
    }
    await repoStore.save(DEFAULT_ROOT_KEY, new TextEncoder().encode(body.url))
    return Response.json({ url: body.url })
  }

  return new Response("method not allowed", {
    status: 405,
    headers: { Allow: "GET, PUT" },
  })
}
