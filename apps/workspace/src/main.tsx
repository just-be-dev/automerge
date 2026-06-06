import React from "react"
import ReactDOM from "react-dom/client"
import { Repo } from "@automerge/automerge-repo"
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket"
import { App } from "./App"
import { AutomergeFs, InMemoryBlobStore } from "@just-be/automerge-fs"

const wsUrl = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`

const repo = new Repo({
  network: [new BrowserWebSocketClientAdapter(wsUrl)],
})

async function initFs(): Promise<AutomergeFs> {
  const existing = await fetchDefaultRoot()

  if (existing) {
    return AutomergeFs.load({
      repo,
      rootDocUrl: existing,
      blobStore: new InMemoryBlobStore(),
    })
  }

  // No default root yet — this client is (probably) the first across the
  // worker. Create locally, claim the slot, and only seed if we actually won.
  const fs = AutomergeFs.create({
    repo,
    blobStore: new InMemoryBlobStore(),
  })

  const claimed = await claimDefaultRoot(fs.rootDocUrl)
  if (claimed !== fs.rootDocUrl) {
    // Lost the race; adopt the winner's root and leave ours unseeded.
    return AutomergeFs.load({
      repo,
      rootDocUrl: claimed,
      blobStore: new InMemoryBlobStore(),
    })
  }

  fs.mkdir("/docs", { recursive: true })
  fs.mkdir("/notes", { recursive: true })
  await Promise.all([
    fs.writeFile(
      "/docs/welcome.txt",
      "Welcome to AutomergeFs!\n\nThis is a CRDT-backed virtual filesystem. Edit this document and your changes are persisted in an Automerge document with full version history."
    ),
    fs.writeFile(
      "/docs/readme.txt",
      "AutomergeFs provides a familiar filesystem API backed by Automerge CRDTs.\n\nEach text file is its own Automerge document, enabling character-level merging."
    ),
    fs.writeFile(
      "/notes/todo.txt",
      "Things to do:\n\n- Try editing this file\n- Create new files\n- Explore the directory tree"
    ),
  ])

  return fs
}

async function fetchDefaultRoot(): Promise<string | null> {
  const res = await fetch("/default-root")
  if (!res.ok) throw new Error(`GET /default-root: ${res.status}`)
  const body = (await res.json()) as { url: string | null }
  return body.url
}

async function claimDefaultRoot(url: string): Promise<string> {
  const res = await fetch("/default-root", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  })
  if (!res.ok) throw new Error(`PUT /default-root: ${res.status}`)
  const body = (await res.json()) as { url: string }
  return body.url
}

initFs().then((fs) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App fs={fs} />
    </React.StrictMode>
  )
})
