import { useEffect, useMemo, useRef } from "react"
import type { AutomergeFs } from "@just-be/automerge-fs"
import { normalizePath } from "@just-be/automerge-fs"
import {
  FileTree,
  useFileTree,
  useFileTreeSelection,
} from "@pierre/trees/react"

interface Props {
  fs: AutomergeFs
  selectedFile: string | null
  onSelectFile: (path: string) => void
  refreshKey: number
  onRefresh: () => void
}

function toPierrePaths(fs: AutomergeFs): string[] {
  return fs
    .getAllPaths()
    .filter((p: string) => p !== "/")
    .map((p: string) => {
      const stripped = p.replace(/^\//, "")
      return fs.stat(p).isDirectory ? stripped + "/" : stripped
    })
}

const toFsPath = (pierrePath: string) =>
  "/" + pierrePath.replace(/\/$/, "")

const toPierrePath = (fsPath: string) => fsPath.replace(/^\//, "")

export function FileExplorer({
  fs,
  selectedFile,
  onSelectFile,
  refreshKey,
  onRefresh,
}: Props) {
  const initialPaths = useMemo(() => toPierrePaths(fs), [])

  const { model } = useFileTree({
    paths: initialPaths,
    initialExpansion: "open",
    initialSelectedPaths: selectedFile ? [toPierrePath(selectedFile)] : [],
  })

  const selection = useFileTreeSelection(model)
  const lastReportedPathRef = useRef<string | null>(selectedFile)

  useEffect(() => {
    const last = selection[selection.length - 1]
    if (!last || last.endsWith("/")) return
    const fsPath = toFsPath(last)
    if (fsPath === lastReportedPathRef.current) return
    lastReportedPathRef.current = fsPath
    onSelectFile(fsPath)
  }, [selection, onSelectFile])

  useEffect(() => {
    model.resetPaths(toPierrePaths(fs))
  }, [model, refreshKey, fs])

  const handleNewFile = async () => {
    const name = prompt("File name (e.g. notes/new.txt):")
    if (!name) return
    const path = normalizePath(name.startsWith("/") ? name : "/" + name)
    const parts = path.split("/").filter(Boolean)
    if (parts.length > 1) {
      const dir = "/" + parts.slice(0, -1).join("/")
      fs.mkdir(dir, { recursive: true })
    }
    await fs.writeFile(path, "")
    onRefresh()
    onSelectFile(path)
  }

  return (
    <>
      <FileTree model={model} className="file-tree" />
      <div className="tree-actions">
        <button onClick={handleNewFile}>+ New File</button>
      </div>
    </>
  )
}
