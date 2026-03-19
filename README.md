# Dockit

A collection of packages for building and collaborating on documents.

## Packages

| Package | Description |
|---|---|
| [`@just-be/automerge-cloudflare`](packages/automerge-cloudflare) | Storage and network adapters for Cloudflare Workers |
| [`@just-be/automerge-fs`](packages/automerge-fs) | Virtual filesystem backed by Automerge CRDTs |

## Development

Requires [mise](https://mise.jdx.dev/) (manages Bun 1.3.10).

```sh
mist install         # install dependencies
mise test            # run tests
mise run typecheck   # type check with tsgo
```
