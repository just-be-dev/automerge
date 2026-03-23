/**
 * Effect FileSystem provider backed by AutomergeFs.
 *
 * Implements Effect v4's FileSystem interface using Automerge CRDTs
 * as the storage backend, providing a virtual filesystem with built-in
 * version control and CRDT merging.
 */

import { Effect, Layer, Option, ServiceMap, Stream } from "effect"
import { FileSystem, make as makeFileSystem, Size, type File as FsFile } from "effect/FileSystem"
import { systemError, badArgument, type PlatformError } from "effect/PlatformError"
import type { Repo } from "@automerge/automerge-repo"
import { AutomergeFs, normalizePath, joinPath } from "./fs"
import { InMemoryBlobStore, type BlobStore } from "./blob-store"
import type { FileHandler } from "./file-handlers"

// =============================================================================
// Service Tags
// =============================================================================

export class BlobStoreTag extends ServiceMap.Service<BlobStoreTag, BlobStore>()(
  "@just-be/automerge-fs/BlobStore"
) {}

export class AutomergeFsInstance extends ServiceMap.Service<
  AutomergeFsInstance,
  AutomergeFs
>()("@just-be/automerge-fs/Instance") {}

// =============================================================================
// Error helpers
// =============================================================================

const notFound = (method: string, path: string): PlatformError =>
  systemError({
    _tag: "NotFound",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: `no such file or directory: ${path}`,
  })

const badArg = (method: string, description: string): PlatformError =>
  badArgument({
    module: "FileSystem",
    method,
    description,
  })

const toSysError = (method: string, path: string, e: unknown): PlatformError => {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes("ENOENT") || msg.includes("not found")) {
    return notFound(method, path)
  }
  if (msg.includes("EEXIST") || msg.includes("already exists")) {
    return systemError({
      _tag: "AlreadyExists",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description: msg,
    })
  }
  if (
    msg.includes("EISDIR") ||
    msg.includes("is a directory") ||
    msg.includes("ENOTDIR") ||
    msg.includes("not a directory") ||
    msg.includes("ENOTEMPTY")
  ) {
    return systemError({
      _tag: "BadResource",
      module: "FileSystem",
      method,
      pathOrDescriptor: path,
      description: msg,
    })
  }
  return systemError({
    _tag: "Unknown",
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: msg,
    cause: e,
  })
}

// =============================================================================
// FileSystem Layer
// =============================================================================

/**
 * Creates an Effect FileSystem layer backed by AutomergeFs.
 *
 * Usage:
 * ```ts
 * import { Effect, Layer, ServiceMap } from "effect"
 * import { FileSystem } from "effect/FileSystem"
 * import { AutomergeFsFileSystem, AutomergeFsInstance } from "@just-be/automerge-fs/effect"
 *
 * const program = Effect.gen(function* () {
 *   const fs = yield* FileSystem
 *   yield* fs.writeFileString("/hello.txt", "world")
 *   const content = yield* fs.readFileString("/hello.txt")
 * })
 *
 * const layer = AutomergeFsFileSystem.pipe(
 *   Layer.provide(Layer.succeed(AutomergeFsInstance, myFsInstance))
 * )
 *
 * Effect.runPromise(Effect.provide(program, layer))
 * ```
 */
export const AutomergeFsFileSystem: Layer.Layer<FileSystem, never, AutomergeFsInstance> =
  Layer.effect(
    FileSystem,
    Effect.gen(function* () {
      const amfs = yield* AutomergeFsInstance

      let tempCounter = 0
      const tempPath = (options?: { prefix?: string; suffix?: string; directory?: string }) => {
        const prefix = options?.prefix ?? "tmp-"
        const suffix = options?.suffix ?? ""
        const dir = options?.directory ?? "/tmp"
        return `${dir}/${prefix}${Date.now()}-${tempCounter++}${suffix}`
      }

      return makeFileSystem({
        access: (path) =>
          Effect.try({
            try: () => {
              if (!amfs.exists(path)) throw new Error(`ENOENT: ${path}`)
            },
            catch: () => notFound("access", path),
          }),

        copy: (fromPath, toPath) =>
          Effect.tryPromise({
            try: () => amfs.copy(fromPath, toPath, { recursive: true }),
            catch: (e) => toSysError("copy", fromPath, e),
          }),

        copyFile: (fromPath, toPath) =>
          Effect.tryPromise({
            try: async () => {
              const content = await amfs.readFile(fromPath)
              await amfs.writeFile(toPath, content)
            },
            catch: (e) => toSysError("copyFile", fromPath, e),
          }),

        chmod: (path, mode) =>
          Effect.try({
            try: () => amfs.chmod(path, mode),
            catch: (e) => toSysError("chmod", path, e),
          }),

        chown: (path) =>
          Effect.try({
            try: () => {
              if (!amfs.exists(path)) throw new Error(`ENOENT: ${path}`)
            },
            catch: (e) => toSysError("chown", path, e),
          }),

        link: (existingPath, newPath) =>
          Effect.try({
            try: () => amfs.link(existingPath, newPath),
            catch: (e) => toSysError("link", existingPath, e),
          }),

        makeDirectory: (path, options) =>
          Effect.try({
            try: () => amfs.mkdir(path, options),
            catch: (e) => toSysError("makeDirectory", path, e),
          }),

        makeTempDirectory: (options) =>
          Effect.sync(() => tempPath(options)).pipe(
            Effect.tap((path) =>
              Effect.try({
                try: () => amfs.mkdir(path, { recursive: true }),
                catch: (e) => toSysError("makeTempDirectory", path, e),
              })
            )
          ),

        makeTempDirectoryScoped: (options) =>
          Effect.acquireRelease(
            Effect.sync(() => tempPath(options)).pipe(
              Effect.tap((path) =>
                Effect.try({
                  try: () => amfs.mkdir(path, { recursive: true }),
                  catch: (e) => toSysError("makeTempDirectoryScoped", path, e),
                })
              )
            ),
            (path) =>
              Effect.tryPromise({
                try: () => amfs.remove(path, { recursive: true, force: true }),
                catch: () => void 0,
              }).pipe(Effect.ignore)
          ),

        makeTempFile: (options) =>
          Effect.gen(function* () {
            const path = tempPath(options)
            const dir = options?.directory ?? "/tmp"
            yield* Effect.try({
              try: () => amfs.mkdir(dir, { recursive: true }),
              catch: (e) => toSysError("makeTempFile", path, e),
            })
            yield* Effect.tryPromise({
              try: () => amfs.writeFile(path, ""),
              catch: (e) => toSysError("makeTempFile", path, e),
            })
            return path
          }),

        makeTempFileScoped: (options) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const path = tempPath(options)
              const dir = options?.directory ?? "/tmp"
              yield* Effect.try({
                try: () => amfs.mkdir(dir, { recursive: true }),
                catch: (e) => toSysError("makeTempFileScoped", path, e),
              })
              yield* Effect.tryPromise({
                try: () => amfs.writeFile(path, ""),
                catch: (e) => toSysError("makeTempFileScoped", path, e),
              })
              return path
            }),
            (path) =>
              Effect.tryPromise({
                try: () => amfs.remove(path, { force: true }),
                catch: () => void 0,
              }).pipe(Effect.ignore)
          ),

        open: (_path, _options) =>
          Effect.fail(
            badArg(
              "open",
              "file descriptors are not supported in AutomergeFs; use readFile/writeFile instead"
            )
          ),

        readDirectory: (path, options) =>
          Effect.try({
            try: () =>
              options?.recursive
                ? collectRecursive(amfs, path)
                : amfs.readdir(path).map((e) => e.name),
            catch: (e) => toSysError("readDirectory", path, e),
          }),

        readFile: (path) =>
          Effect.tryPromise({
            try: () => amfs.readFile(path),
            catch: (e) => toSysError("readFile", path, e),
          }),

        readLink: (path) =>
          Effect.try({
            try: () => amfs.readlink(path),
            catch: (e) => toSysError("readLink", path, e),
          }),

        realPath: (path) => Effect.succeed(normalizePath(path)),

        remove: (path, options) =>
          Effect.tryPromise({
            try: () => amfs.remove(path, options),
            catch: (e) => toSysError("remove", path, e),
          }),

        rename: (oldPath, newPath) =>
          Effect.tryPromise({
            try: () => amfs.rename(oldPath, newPath),
            catch: (e) => toSysError("rename", oldPath, e),
          }),

        stat: (path) =>
          Effect.try({
            try: () => {
              const s = amfs.stat(path)
              return {
                type: s.isFile ? "File" : s.isDirectory ? "Directory" : "Unknown",
                mtime: Option.some(s.mtime),
                atime: Option.none(),
                birthtime: Option.some(s.ctime),
                dev: 0,
                ino: Option.none(),
                mode: s.mode,
                nlink: Option.none(),
                uid: Option.none(),
                gid: Option.none(),
                rdev: Option.none(),
                size: Size(s.size),
                blksize: Option.none(),
                blocks: Option.none(),
              } satisfies FsFile.Info
            },
            catch: (e) => toSysError("stat", path, e),
          }),

        symlink: (target, linkPath) =>
          Effect.try({
            try: () => amfs.symlink(target, linkPath),
            catch: (e) => toSysError("symlink", linkPath, e),
          }),

        truncate: (path, length) =>
          Effect.tryPromise({
            try: () => amfs.truncate(path, length != null ? Number(length) : 0),
            catch: (e) => toSysError("truncate", path, e),
          }),

        utimes: (path, atime, mtime) =>
          Effect.try({
            try: () => amfs.utimes(path, atime, mtime),
            catch: (e) => toSysError("utimes", path, e),
          }),

        watch: (_path) =>
          Stream.fail(badArg("watch", "watch is not supported in AutomergeFs")),

        writeFile: (path, data) =>
          Effect.tryPromise({
            try: () => amfs.writeFile(path, data),
            catch: (e) => toSysError("writeFile", path, e),
          }),
      })
    })
  )

// =============================================================================
// Convenience constructor
// =============================================================================

/**
 * Creates a self-contained FileSystem layer backed by Automerge.
 *
 * ```ts
 * import { Effect } from "effect"
 * import { FileSystem } from "effect/FileSystem"
 * import { Repo } from "@automerge/automerge-repo"
 * import { makeFs } from "@just-be/automerge-fs/effect"
 *
 * const repo = new Repo({ network: [] })
 * const layer = makeFs({ repo }).pipe(
 *   Layer.provide(InMemoryBlobStoreLayer)
 * )
 *
 * const program = Effect.gen(function* () {
 *   const fs = yield* FileSystem
 *   yield* fs.writeFileString("/hello.txt", "world")
 *   return yield* fs.readFileString("/hello.txt")
 * })
 *
 * Effect.runPromise(Effect.provide(program, layer))
 * ```
 */
export const makeFs = (opts: {
  repo: Repo
  fileHandlers?: FileHandler[]
}): Layer.Layer<FileSystem, never, BlobStoreTag> =>
  Layer.provide(
    AutomergeFsFileSystem,
    Layer.effect(
      AutomergeFsInstance,
      Effect.gen(function* () {
        const blobStore = yield* BlobStoreTag
        return AutomergeFs.create({
          repo: opts.repo,
          blobStore,
          fileHandlers: opts.fileHandlers,
        })
      })
    )
  )

export const InMemoryBlobStoreLayer: Layer.Layer<BlobStoreTag> =
  Layer.succeed(BlobStoreTag, new InMemoryBlobStore())

// =============================================================================
// Helpers
// =============================================================================

function collectRecursive(
  amfs: AutomergeFs,
  path: string,
  prefix = ""
): string[] {
  const entries = amfs.readdir(path)
  const result: string[] = []
  const normalized = normalizePath(path)

  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    result.push(relative)
    if (entry.isDirectory) {
      result.push(...collectRecursive(amfs, joinPath(normalized, entry.name), relative))
    }
  }

  return result
}
