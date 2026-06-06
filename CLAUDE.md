# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

automerge-cloudflare — early-stage Bun monorepo. Workspace packages live in `packages/`.

### Packages

- `@just-be/automerge-cloudflare` (`packages/automerge-cloudflare`) — Automerge integrations for Cloudflare Workers. Exports:
  - `@just-be/automerge-cloudflare` (root) — `AutomergeDO`, a batteries-included per-document Durable Object composing the network + storage halves
  - `@just-be/automerge-cloudflare/storage` — two-tier Durable Object storage (`RepoStoreDO` router + `DocStoreDO` per-document) and the `RepoStoreAdapter` library wrapper
  - `@just-be/automerge-cloudflare/network` — WebSocket network adapter + Worker routing helper

Package naming convention: `@just-be/automerge-<runtime>` (e.g. `automerge-cloudflare`, `automerge-bun`).

## Toolchain

Bun (pinned to 1.3.10) is managed via `mise`. Use `mise` tasks for project commands and `bun` directly for runtime/package operations.

- **Install deps:** `bun install`
- **Add a dependency:** `bun add <package>`
- **Run a file:** `bun run <file>`
- **Test:** `mise test` (single file: `mise test -- path/to/file.test.ts`)
- **Build:** `mise build`
- **Type check:** `mise run typecheck` (uses `tsgo --build`)
- Bun automatically loads .env, so don't use dotenv.

## Bun API Preferences

- `Bun.serve()` for HTTP/WebSocket servers. Don't use `express` or `ws`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- Prefer `Bun.file` over `node:fs` readFile/writeFile.
- `Bun.$\`cmd\`` instead of execa.

## TypeScript

Uses native TypeScript compiler (`tsgo` via `@typescript/native-preview`). The repo uses composite project references:

- `tsconfig.base.json` — shared compiler options (`composite: true`, `declaration`, `declarationMap`). All packages extend this.
- `tsconfig.json` — solution-style root config (only `files: []` + `references`). Add each package here.
- Each package has its own `tsconfig.json` that extends `../../tsconfig.base.json` and declares its own `references`.

Strict mode enabled with `noUncheckedIndexedAccess` and `noImplicitOverride`. JSX configured as `react-jsx`. Module resolution is bundler mode with `verbatimModuleSyntax`.

For Bun API docs, see `node_modules/bun-types/docs/**.md`.
