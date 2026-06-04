/**
 * Root export: the batteries-included {@link AutomergeDO}, which composes
 * the `./network` adapter with the `./storage` layer. Import the subpaths
 * directly when you only want one half:
 *
 * - `@just-be/automerge-cloudflare/storage` — DO storage (router + per-doc)
 * - `@just-be/automerge-cloudflare/network` — WebSocket network adapter
 */
export { AutomergeDO, type AutomergeDOEnv } from "./automerge-do.ts"
