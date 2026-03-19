/**
 * Example: Using AutomergeFs as an Effect FileSystem provider.
 *
 * Run with: bun run packages/automerge-fs/src/example.ts
 */

import { Effect } from "effect"
import { FileSystem } from "effect/FileSystem"
import { Repo } from "@automerge/automerge-repo"
import { makeFs } from "./effect"

// 1. Create the layer — just pass a Repo
const fs = makeFs({ repo: new Repo({ network: [] }) })

// 2. Write programs using the standard Effect FileSystem interface
const program = Effect.gen(function* () {
  const fs = yield* FileSystem

  // Create a project structure
  yield* fs.makeDirectory("/src/components", { recursive: true })

  // Write some files
  yield* fs.writeFileString("/src/index.ts", 'export { App } from "./components/App"\n')
  yield* fs.writeFileString(
    "/src/components/App.ts",
    'export const App = () => "Hello from AutomergeFs!"\n'
  )
  yield* fs.writeFileString("/README.md", "# My Project\n\nBuilt with AutomergeFs.\n")

  // Read them back
  const index = yield* fs.readFileString("/src/index.ts")
  console.log("index.ts:", index)

  // List directory contents
  const srcFiles = yield* fs.readDirectory("/src")
  console.log("src/:", srcFiles)

  const allFiles = yield* fs.readDirectory("/src", { recursive: true })
  console.log("src/ (recursive):", allFiles)

  // Stat a file
  const info = yield* fs.stat("/README.md")
  console.log("README.md type:", info.type, "size:", info.size)

  // Check existence
  const exists = yield* fs.exists("/src/index.ts")
  const missing = yield* fs.exists("/nope.txt")
  console.log("exists /src/index.ts:", exists, "exists /nope.txt:", missing)

  // Rename
  yield* fs.rename("/README.md", "/README.txt")
  const renamed = yield* fs.readFileString("/README.txt")
  console.log("renamed:", renamed)

  // Copy
  yield* fs.copy("/src", "/backup")
  const backupFiles = yield* fs.readDirectory("/backup", { recursive: true })
  console.log("backup/ (recursive):", backupFiles)

  // Clean up
  yield* fs.remove("/backup", { recursive: true })
  const backupGone = yield* fs.exists("/backup")
  console.log("backup removed:", !backupGone)
})

// 3. Run it
Effect.runPromise(Effect.provide(program, fs)).catch(console.error)
