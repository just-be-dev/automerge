# @just-be/automerge-fs

A virtual filesystem backed by [Automerge](https://automerge.org/) CRDTs. Text files get character-level CRDT merging via `Automerge.updateText()`, binary files are stored in a pluggable blob store, and the directory tree lives in a single root Automerge document.

## Architecture

- **One Automerge document per text file** — enables fine-grained merging of concurrent edits
- **Root document** — maintains the full directory tree structure (paths, metadata, pointers to file docs / blob hashes)
- **BlobStore** — pluggable interface for binary file storage (ships with `InMemoryBlobStore`)

## Install

```sh
bun add @just-be/automerge-fs
```

## Usage

### Direct API

```ts
import { Repo } from "@automerge/automerge-repo"
import { AutomergeFsMultiDoc, InMemoryBlobStore } from "@just-be/automerge-fs"

const repo = new Repo({ network: [] })
const fs = AutomergeFsMultiDoc.create({
  repo,
  blobStore: new InMemoryBlobStore(),
})

await fs.writeFile("/hello.txt", "world")
const content = await fs.readFile("/hello.txt") // Uint8Array

await fs.mkdir("/src/components", { recursive: true })
await fs.rename("/hello.txt", "/src/hello.txt")

const entries = fs.readdir("/src") // [{ name, isFile, isDirectory }]
const info = fs.stat("/src/hello.txt") // { size, isFile, isDirectory, mode, mtime, ctime }
```

### Effect FileSystem provider

The `@just-be/automerge-fs/effect` export implements Effect's `FileSystem` interface, so any Effect program that uses `FileSystem` can be backed by Automerge with zero code changes.

```ts
import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Repo } from "@automerge/automerge-repo"
import { makeFs } from "@just-be/automerge-fs/effect"

const layer = makeFs({ repo: new Repo({ network: [] }) })

const program = Effect.gen(function* () {
  const fs = yield* FileSystem
  yield* fs.writeFileString("/hello.txt", "world")
  return yield* fs.readFileString("/hello.txt")
})

await Effect.runPromise(Effect.provide(program, layer))
```

For more control, compose the layer manually:

```ts
import { Layer } from "effect"
import { AutomergeFsFileSystem, AutomergeFsInstance } from "@just-be/automerge-fs/effect"

const layer = AutomergeFsFileSystem.pipe(
  Layer.provide(Layer.succeed(AutomergeFsInstance, myFsInstance))
)
```

## API

### `AutomergeFsMultiDoc`

| Method | Description |
|---|---|
| `create({ repo, blobStore })` | Create a new filesystem |
| `load({ repo, blobStore, rootDocUrl })` | Load an existing filesystem by its root document URL |
| `readFile(path)` | Read file contents as `Uint8Array` |
| `writeFile(path, content)` | Write a string or `Uint8Array` — auto-detects binary vs text |
| `stat(path)` | Get file/directory metadata |
| `readdir(path)` | List directory entries |
| `mkdir(path, options?)` | Create a directory (supports `{ recursive: true }`) |
| `remove(path, options?)` | Remove a file or directory (supports `{ recursive, force }`) |
| `rename(oldPath, newPath)` | Move/rename a file or directory |
| `copy(src, dest, options?)` | Copy a file or directory tree |
| `exists(path)` | Check if a path exists |
| `chmod(path, mode)` | Change file mode |
| `utimes(path, atime, mtime)` | Update modification time |
| `truncate(path, length?)` | Truncate a file |

### Version control

Each text file is its own Automerge document, so you get built-in version history:

```ts
const heads = await fs.getFileHeads("/hello.txt")
const history = await fs.getFileHistory("/hello.txt")
const oldContent = await fs.getFileAt("/hello.txt", someOlderHeads)
const patches = await fs.diff("/hello.txt", fromHeads, toHeads)
```

### BlobStore

Implement the `BlobStore` interface to use your own storage backend for binary files:

```ts
interface BlobStore {
  get(hash: string): Promise<Uint8Array | null>
  set(hash: string, data: Uint8Array): Promise<void>
  has(hash: string): Promise<boolean>
  delete(hash: string): Promise<void>
  list(): Promise<string[]>
}
```
