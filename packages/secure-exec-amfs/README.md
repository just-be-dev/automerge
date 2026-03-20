# @just-be/secure-exec-amfs

[`VirtualFileSystem`](https://github.com/rivet-dev/secure-exec) adapter backed by [`@just-be/automerge-fs`](../automerge-fs). Gives secure-exec sandboxes a CRDT-backed filesystem with character-level merge support for text files.

## Install

```sh
bun add @just-be/secure-exec-amfs
```

## Usage

```ts
import { AutomergeFs } from "@just-be/automerge-fs"
import { AutomergeFileSystem } from "@just-be/secure-exec-amfs"

const amfs = AutomergeFs.create()

const vfs = new AutomergeFileSystem(amfs)

// Use with secure-exec
import { execute } from "secure-exec"

await execute({
  fs: vfs,
  // ...
})
```

## Supported operations

All `VirtualFileSystem` methods are implemented:

| Method | Notes |
|---|---|
| `readFile`, `readTextFile` | Follows symlinks |
| `writeFile` | Creates parent directories automatically, follows symlinks |
| `readDir`, `readDirWithTypes` | Follows symlinks on the directory path |
| `createDir`, `mkdir` | `mkdir` is recursive |
| `exists`, `stat`, `lstat` | `stat` follows symlinks, `lstat` does not |
| `removeFile`, `removeDir` | Operates on the link itself, not the target |
| `rename` | Operates on the link itself, not the target |
| `symlink`, `readlink` | Full symlink support with chain resolution |
| `link` | Hard links share the underlying Automerge document |
| `chmod`, `utimes`, `truncate` | Follow symlinks |
| `chown` | No-op (uid/gid not tracked) |
