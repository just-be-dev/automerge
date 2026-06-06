#!/usr/bin/env bun

/**
 * Publish a single workspace package to npm if its local version differs
 * from what's on the npm registry.
 *
 * Usage:
 *   bun scripts/publish-package.ts <short-name>
 *   bun scripts/publish-package.ts automerge-cloudflare
 *
 * `short-name` is the package directory name under `packages/`. The scope
 * is hard-coded to `@just-be/`.
 */

import { $ } from "bun"
import { appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { generateReleaseNotes, getGitHubRepo } from "./release-notes.ts"

const SCOPE = "@just-be"

export interface PublishResult {
  packageName: string
  localVersion: string
  npmVersion: string
  published: boolean
}

export interface PackageInfo {
  name: string
  version: string
}

export async function main(): Promise<void> {
  const [name] = process.argv.slice(2)

  if (!name) {
    console.error("Usage: bun scripts/publish-package.ts <short-name>")
    console.error("Example: bun scripts/publish-package.ts automerge-cloudflare")
    process.exit(1)
  }

  const packageName = `${SCOPE}/${name}`
  const packagePath = `packages/${name}`

  try {
    await publishPackage(packageName, packagePath)
  } catch (error) {
    console.error(`\nError publishing ${packageName}:`, error)
    process.exit(1)
  }
}

export async function getPackageInfo(packagePath: string): Promise<PackageInfo> {
  const packageJson = await Bun.file(join(packagePath, "package.json")).json()
  return { name: packageJson.name, version: packageJson.version }
}

/** Returns the npm-registry version of `packageName`, or "0.0.0" if not published. */
export async function getNpmVersion(packageName: string): Promise<string> {
  try {
    const result = await $`npm view ${packageName} version`.text()
    return result.trim()
  } catch {
    return "0.0.0"
  }
}

export function shouldPublish(localVersion: string, npmVersion: string): boolean {
  return localVersion !== npmVersion
}

export async function packPackage(packagePath: string): Promise<void> {
  await $`cd ${packagePath} && bun pm pack`
}

export async function findTarball(packagePath: string): Promise<string> {
  const files = await Array.fromAsync(new Bun.Glob("*.tgz").scan({ cwd: packagePath }))
  const first = files[0]
  if (!first) throw new Error("No tarball found after packing")
  return first
}

export async function publishToNpm(packagePath: string, tarball: string): Promise<void> {
  await $`cd ${packagePath} && npm publish ${tarball} --access public`
}

/** Tag + GitHub release with PR-derived notes. */
export async function createGitHubRelease(
  packageName: string,
  version: string,
): Promise<void> {
  const tag = `${packageName}@${version}`
  const releaseTitle = `${packageName} v${version}`
  const githubRepo = await getGitHubRepo()

  const packageNameWithoutScope = packageName.replace(`${SCOPE}/`, "")
  const releaseNotes = await generateReleaseNotes(
    packageNameWithoutScope,
    version,
    githubRepo,
  )

  // Use --notes-file to avoid shell-escaping issues with long notes
  const notesPath = join(tmpdir(), `release-notes-${Date.now()}.md`)
  await Bun.write(notesPath, releaseNotes)

  await $`gh release create ${tag} --title ${releaseTitle} --notes-file ${notesPath}`

  await Bun.file(notesPath).writer().end()
}

export async function writeGitHubOutputs(
  outputs: Record<string, string | boolean>,
): Promise<void> {
  if (!process.env.GITHUB_OUTPUT) return

  const lines = Object.entries(outputs)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")

  await appendFile(process.env.GITHUB_OUTPUT, `${lines}\n`)
}

export async function publishPackage(
  packageName: string,
  packagePath: string,
): Promise<PublishResult> {
  const packageInfo = await getPackageInfo(packagePath)
  const localVersion = packageInfo.version
  const npmVersion = await getNpmVersion(packageName)

  console.log(`\n${packageName}`)
  console.log(`   Local version: ${localVersion}`)
  console.log(`   NPM version:   ${npmVersion}`)

  await writeGitHubOutputs({ local_version: localVersion, npm_version: npmVersion })

  if (!shouldPublish(localVersion, npmVersion)) {
    console.log(`   Skipped (already published)`)
    await writeGitHubOutputs({ published: false })
    return { packageName, localVersion, npmVersion, published: false }
  }

  console.log(`   Publishing...`)

  await packPackage(packagePath)
  const tarball = await findTarball(packagePath)
  await publishToNpm(packagePath, tarball)
  await createGitHubRelease(packageName, localVersion)

  console.log(`   Published`)
  await writeGitHubOutputs({ published: true })

  return { packageName, localVersion, npmVersion, published: true }
}

if (import.meta.main) {
  await main()
}
