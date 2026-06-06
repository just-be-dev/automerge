#!/usr/bin/env bun

/**
 * Generate release notes for a package version.
 *
 * Usage:
 *   bun scripts/release-notes.ts <package-name> <version>
 *   bun scripts/release-notes.ts automerge-cloudflare 0.0.1
 *
 * `package-name` is the short name (no scope). Scope is hard-coded to
 * @just-be/.
 */

import { $ } from "bun"

const SCOPE = "@just-be"
const DEFAULT_REPO = "just-be-dev/dockit"

interface PRDetails {
  number: number
  title: string
  files: Array<{ path: string }>
}

/** Check if any file in the PR touches the specified package directory. */
export function touchesPackage(
  files: Array<{ path: string }>,
  packageName: string,
): boolean {
  const packagePath = `packages/${packageName}/`
  return files.some((file) => file.path.startsWith(packagePath))
}

/** Get GitHub repo from the GITHUB_REPOSITORY env var or git remote. */
export async function getGitHubRepo(): Promise<string> {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY

  try {
    const result = await $`git remote get-url origin`.text()
    const match = result.trim().match(/github\.com[:/](.+?)(?:\.git)?$/)
    if (match && match[1]) return match[1]
  } catch (error) {
    console.error("Warning: Failed to get GitHub repo from git remote:", error)
  }

  return DEFAULT_REPO
}

/** Extract PR number from a commit subject like "foo (#123)". */
export function extractPRNumber(message: string): number | null {
  const match = message.match(/\(#(\d+)\)/)
  return match && match[1] ? parseInt(match[1], 10) : null
}

/** Find the most recent tag for this package before the current version. */
export async function findPreviousTag(
  packageName: string,
  currentVersion: string,
): Promise<string | null> {
  try {
    const fullPackageName = `${SCOPE}/${packageName}`
    const currentTag = `${fullPackageName}@${currentVersion}`

    const result = await $`git tag --list '${fullPackageName}@*' --sort=-version:refname`.text()
    const tags = result.trim().split("\n").filter(Boolean)

    const currentIndex = tags.indexOf(currentTag)
    if (currentIndex === -1) return tags[0] || null
    return tags[currentIndex + 1] || null
  } catch (error) {
    console.error("Warning: Failed to find previous tag:", error)
    return null
  }
}

/** Get PR numbers referenced in commits between two refs. */
export async function getPRNumbersBetweenRefs(
  previousRef: string | null,
  currentRef = "HEAD",
): Promise<number[]> {
  try {
    const range = previousRef ? `${previousRef}..${currentRef}` : currentRef
    const result = await $`git log --format='%s' ${range}`.text()
    const messages = result.trim().split("\n").filter(Boolean)

    const prNumbers = messages
      .map((msg) => extractPRNumber(msg))
      .filter((num): num is number => num !== null)

    return Array.from(new Set(prNumbers)).sort((a, b) => a - b)
  } catch (error) {
    console.error("Warning: Failed to get PR numbers between refs:", error)
    return []
  }
}

/** Fetch PR title + files via `gh pr view`. */
export async function fetchPRDetails(prNumbers: number[]): Promise<PRDetails[]> {
  const details: PRDetails[] = []

  for (const number of prNumbers) {
    try {
      const result = await $`gh pr view ${number} --json number,title,files`.text()
      const pr = JSON.parse(result)
      details.push({
        number: pr.number,
        title: pr.title,
        files: pr.files || [],
      })
    } catch (error) {
      console.error(`Warning: Failed to fetch details for PR #${number}:`, error)
    }
  }

  return details
}

/** Build the markdown release notes for one package version. */
export async function generateReleaseNotes(
  packageName: string,
  version: string,
  githubRepo: string,
): Promise<string> {
  const previousTag = await findPreviousTag(packageName, version)
  const prNumbers = await getPRNumbersBetweenRefs(previousTag, "HEAD")

  if (prNumbers.length === 0) {
    return `No changes since ${previousTag || "initial release"}.`
  }

  const allPRs = await fetchPRDetails(prNumbers)
  const relevantPRs = allPRs.filter((pr) => touchesPackage(pr.files, packageName))

  if (relevantPRs.length === 0) {
    return `No changes to this package since ${previousTag || "initial release"}.`
  }

  const lines: string[] = []
  lines.push(previousTag ? `## Changes since ${previousTag}` : "## Initial Release")
  lines.push("")

  for (const pr of relevantPRs) {
    lines.push(
      `- ${pr.title} ([#${pr.number}](https://github.com/${githubRepo}/pull/${pr.number}))`,
    )
  }

  if (previousTag) {
    lines.push("")
    lines.push("---")
    lines.push("")
    lines.push(
      `**Full Changelog**: https://github.com/${githubRepo}/compare/${previousTag}...${SCOPE}/${packageName}@${version}`,
    )
  }

  return lines.join("\n")
}

export async function main(): Promise<void> {
  const [packageName, version] = process.argv.slice(2)

  if (!packageName || !version) {
    console.error("Usage: bun scripts/release-notes.ts <package-name> <version>")
    console.error("Example: bun scripts/release-notes.ts automerge-cloudflare 0.0.1")
    process.exit(1)
  }

  console.log(`Generating release notes for ${SCOPE}/${packageName}@${version}...\n`)

  const githubRepo = await getGitHubRepo()
  const releaseNotes = await generateReleaseNotes(packageName, version, githubRepo)

  console.log(releaseNotes)
}

if (import.meta.main) {
  await main()
}
