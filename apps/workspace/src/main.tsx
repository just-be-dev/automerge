import React from "react"
import ReactDOM from "react-dom/client"
import { Repo } from "@automerge/automerge-repo"
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb"
import { App } from "./App"
import { AutomergeFs, InMemoryBlobStore, createBlobFileHandler } from "@just-be/automerge-fs"

const STORAGE_KEY = "automerge-fs-root-doc-url"

const repo = new Repo({
  network: [],
  storage: new IndexedDBStorageAdapter("automerge-fs"),
})

async function initFs(): Promise<AutomergeFs> {
  const savedUrl = localStorage.getItem(STORAGE_KEY)

  if (savedUrl) {
    try {
      return await AutomergeFs.load({
        repo,
        rootDocUrl: savedUrl,
        fileHandlers: [createBlobFileHandler(new InMemoryBlobStore())],
      })
    } catch {
      // Stored URL invalid — fall through to create fresh
      localStorage.removeItem(STORAGE_KEY)
    }
  }

  const fs = AutomergeFs.create({
    repo,
    fileHandlers: [createBlobFileHandler(new InMemoryBlobStore())],
  })

  localStorage.setItem(STORAGE_KEY, fs.rootDocUrl)

  // Seed example files on first run
  fs.mkdir("/docs", { recursive: true })
  fs.mkdir("/notes", { recursive: true })
  await Promise.all([
    fs.writeFile("/docs/welcome.txt", "Welcome to AutomergeFs!\n\nThis is a CRDT-backed virtual filesystem. Edit this document and your changes are persisted in an Automerge document with full version history."),
    fs.writeFile("/docs/readme.txt", "AutomergeFs provides a familiar filesystem API backed by Automerge CRDTs.\n\nEach text file is its own Automerge document, enabling character-level merging."),
    fs.writeFile("/notes/todo.txt", "Things to do:\n\n- Try editing this file\n- Create new files\n- Explore the directory tree"),
  ])

  return fs
}

initFs().then((fs) => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App fs={fs} />
    </React.StrictMode>,
  )
})
