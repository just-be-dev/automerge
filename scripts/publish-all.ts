#!/usr/bin/env bun

/**
 * Publish all @just-be/* workspace packages in topological dependency order.
 *
 * - Reads the workspace to discover packages (skipping `private: true`)
 * - Topologically sorts so upstream packages publish first
 * - Pre-flight checks that all internal @just-be/* dependencies exist on
 *   npm at the right version before publishing each package
 * - If a package fails to publish, all downstream dependents are skipped
 *
 * Usage:
 *   bun scripts/publish-all.ts
 */

import { join } from "node:path"
import {
  getNpmVersion,
  shouldPublish,
  publishPackage,
} from "./publish-package.ts"

const SCOPE = "@just-be"

interface WorkspacePackage {
  /** Short name, e.g. "automerge-cloudflare" */
  name: string
  /** Full scoped name, e.g. "@just-be/automerge-cloudflare" */
  packageName: string
  /** Path relative to repo root, e.g. "packages/automerge-cloudflare" */
  path: string
  /** Local version from package.json */
  version: string
  /** Scoped internal dependency names, e.g. ["@just-be/automerge-fs"] */
  internalDeps: string[]
}

/**
 * Discover all publishable @just-be/* packages and their internal deps.
 * Skips packages marked `private: true`.
 */
async function discoverPackages(): Promise<WorkspacePackage[]> {
  const packagesDir = "packages"
  const glob = new Bun.Glob("*/package.json")
  const packages: WorkspacePackage[] = []

  for await (const path of glob.scan({ cwd: packagesDir })) {
    const fullPath = join(packagesDir, path)
    const pkg = await Bun.file(fullPath).json()

    if (!pkg.name?.startsWith(`${SCOPE}/`)) continue
    if (pkg.private === true) continue

    const shortName = pkg.name.replace(`${SCOPE}/`, "")
    const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies }
    const internalDeps = Object.keys(allDeps).filter((d) => d.startsWith(`${SCOPE}/`))

    packages.push({
      name: shortName,
      packageName: pkg.name,
      path: join(packagesDir, shortName),
      version: pkg.version,
      internalDeps,
    })
  }

  return packages
}

/** Kahn's algorithm — returns packages in publish order (deps first). */
function topologicalSort(packages: WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map((p) => [p.packageName, p]))

  const inDegree = new Map(packages.map((p) => [p.packageName, 0]))
  for (const pkg of packages) {
    for (const dep of pkg.internalDeps) {
      if (byName.has(dep)) {
        inDegree.set(pkg.packageName, (inDegree.get(pkg.packageName) ?? 0) + 1)
      }
    }
  }

  const queue = packages
    .filter((p) => inDegree.get(p.packageName) === 0)
    .map((p) => p.packageName)
  const sorted: WorkspacePackage[] = []

  while (queue.length > 0) {
    const current = queue.shift()!
    sorted.push(byName.get(current)!)

    for (const pkg of packages) {
      if (pkg.internalDeps.includes(current) && byName.has(pkg.packageName)) {
        const newDegree = (inDegree.get(pkg.packageName) ?? 1) - 1
        inDegree.set(pkg.packageName, newDegree)
        if (newDegree === 0) queue.push(pkg.packageName)
      }
    }
  }

  if (sorted.length !== packages.length) {
    const missing = packages.filter((p) => !sorted.includes(p)).map((p) => p.packageName)
    throw new Error(`Circular dependency detected involving: ${missing.join(", ")}`)
  }

  return sorted
}

/**
 * Verify all internal deps for `pkg` are already on npm at the version
 * that the package depends on. Packages just published in this run are
 * trusted without re-querying npm.
 */
async function preflightCheck(
  pkg: WorkspacePackage,
  allPackages: Map<string, WorkspacePackage>,
  justPublished: Set<string>,
): Promise<{ ok: boolean; missing: string[] }> {
  const missing: string[] = []

  for (const dep of pkg.internalDeps) {
    const depPkg = allPackages.get(dep)
    if (!depPkg) continue
    if (justPublished.has(dep)) continue

    const requiredVersion = depPkg.version
    const npmVersion = await getNpmVersion(dep)
    if (npmVersion !== requiredVersion) {
      missing.push(`${dep}@${requiredVersion} (npm has ${npmVersion || "nothing"})`)
    }
  }

  return { ok: missing.length === 0, missing }
}

async function main(): Promise<void> {
  console.log("Discovering packages...\n")
  const packages = await discoverPackages()

  if (packages.length === 0) {
    console.log("No publishable packages found.")
    return
  }

  const sorted = topologicalSort(packages)

  console.log("Publish order:")
  for (const pkg of sorted) {
    const deps =
      pkg.internalDeps.length > 0 ? ` (depends on ${pkg.internalDeps.join(", ")})` : ""
    console.log(`  ${pkg.packageName}@${pkg.version}${deps}`)
  }
  console.log()

  const allPackages = new Map(sorted.map((p) => [p.packageName, p]))
  const justPublished = new Set<string>()
  const blocked = new Set<string>()
  let hasFailures = false

  for (const pkg of sorted) {
    console.log(`\n${"─".repeat(60)}`)
    console.log(`${pkg.packageName}@${pkg.version}`)

    const blockedBy = pkg.internalDeps.find((dep) => blocked.has(dep))
    if (blockedBy) {
      console.log(`  ⊘ Skipped — blocked by failed dependency ${blockedBy}`)
      blocked.add(pkg.packageName)
      hasFailures = true
      continue
    }

    const npmVersion = await getNpmVersion(pkg.packageName)
    console.log(`  Local: ${pkg.version}  npm: ${npmVersion}`)

    if (!shouldPublish(pkg.version, npmVersion)) {
      console.log(`  ⊘ Skipped — already published`)
      justPublished.add(pkg.packageName)
      continue
    }

    const preflight = await preflightCheck(pkg, allPackages, justPublished)
    if (!preflight.ok) {
      console.log(`  ✗ Pre-flight failed — missing dependencies:`)
      for (const m of preflight.missing) {
        console.log(`      ${m}`)
      }
      blocked.add(pkg.packageName)
      hasFailures = true
      continue
    }

    try {
      await publishPackage(pkg.packageName, pkg.path)
      justPublished.add(pkg.packageName)
      console.log(`  ✓ Published`)
    } catch (error) {
      console.error(`  ✗ Failed to publish:`, error)
      blocked.add(pkg.packageName)
      hasFailures = true
    }
  }

  console.log(`\n${"─".repeat(60)}`)
  console.log("Summary:")
  console.log(`  Published: ${justPublished.size}`)
  console.log(`  Blocked/Failed: ${blocked.size}`)

  if (blocked.size > 0) {
    console.log(`  Failed packages: ${Array.from(blocked).join(", ")}`)
  }

  if (hasFailures) process.exit(1)
}

await main()
