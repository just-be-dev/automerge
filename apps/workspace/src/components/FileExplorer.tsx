import React, { useMemo, useState } from "react"
import type { AutomergeFs } from "@just-be/automerge-fs"
import { normalizePath } from "@just-be/automerge-fs"

interface Props {
  fs: AutomergeFs
  selectedFile: string | null
  onSelectFile: (path: string) => void
  refreshKey: number
  onRefresh: () => void
}

interface TreeNode {
  name: string
  path: string
  isDirectory: boolean
  children: TreeNode[]
}

function buildTree(fs: AutomergeFs): TreeNode[] {
  const allPaths = fs.getAllPaths().filter((p) => p !== "/")
  const nodes: Map<string, TreeNode> = new Map()
  const roots: TreeNode[] = []

  // Sort so parents come before children
  allPaths.sort()

  for (const p of allPaths) {
    const stat = fs.stat(p)
    const parts = p.split("/").filter(Boolean)
    const name = parts[parts.length - 1]!
    const node: TreeNode = {
      name,
      path: p,
      isDirectory: stat.isDirectory,
      children: [],
    }
    nodes.set(p, node)

    const parentPath = "/" + parts.slice(0, -1).join("/")
    const normalizedParent = parentPath === "/" ? "/" : parentPath
    const parent = nodes.get(normalizedParent)
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  // Sort: directories first, then alphabetical
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const n of nodes) sortNodes(n.children)
  }
  sortNodes(roots)
  return roots
}

function TreeItem({
  node,
  depth,
  selectedFile,
  onSelectFile,
  expanded,
  onToggle,
}: {
  node: TreeNode
  depth: number
  selectedFile: string | null
  onSelectFile: (path: string) => void
  expanded: Set<string>
  onToggle: (path: string) => void
}) {
  const isOpen = expanded.has(node.path)

  return (
    <>
      <div
        className={`tree-item ${node.isDirectory ? "directory" : ""} ${selectedFile === node.path ? "selected" : ""}`}
        style={{ paddingLeft: 16 + depth * 16 }}
        onClick={() => {
          if (node.isDirectory) {
            onToggle(node.path)
          } else {
            onSelectFile(node.path)
          }
        }}
      >
        <span className="icon">
          {node.isDirectory ? (isOpen ? "\u25BE" : "\u25B8") : "\u25A1"}
        </span>
        {node.name}
      </div>
      {node.isDirectory &&
        isOpen &&
        node.children.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
    </>
  )
}

export function FileExplorer({ fs, selectedFile, onSelectFile, refreshKey, onRefresh }: Props) {
  const tree = useMemo(() => buildTree(fs), [fs, refreshKey])
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Expand all directories by default
    const dirs = new Set<string>()
    const walk = (nodes: TreeNode[]) => {
      for (const n of nodes) {
        if (n.isDirectory) {
          dirs.add(n.path)
          walk(n.children)
        }
      }
    }
    walk(tree)
    return dirs
  })

  const toggle = (path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const handleNewFile = async () => {
    const name = prompt("File name (e.g. notes/new.txt):")
    if (!name) return
    const path = normalizePath(name.startsWith("/") ? name : "/" + name)
    // Create parent dirs if needed
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
      <div className="file-tree">
        {tree.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            selectedFile={selectedFile}
            onSelectFile={onSelectFile}
            expanded={expanded}
            onToggle={toggle}
          />
        ))}
      </div>
      <div className="tree-actions">
        <button onClick={handleNewFile}>+ New File</button>
      </div>
    </>
  )
}
