import React, { useCallback, useState } from "react"
import type { AutomergeFs } from "@just-be/automerge-fs"
import { normalizePath } from "@just-be/automerge-fs"
import { FileExplorer } from "./components/FileExplorer"
import { Editor } from "./components/Editor"
import { PdfViewer } from "./components/PdfViewer"
import { PdfUpload } from "./components/PdfUpload"
import "./App.css"

function isPdf(path: string) {
  return path.toLowerCase().endsWith(".pdf")
}

export function App({ fs }: { fs: AutomergeFs }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const refresh = () => setRefreshKey((k) => k + 1)

  const handlePdfUpload = useCallback(
    async (name: string, data: Uint8Array) => {
      const path = normalizePath("/docs/" + name)
      const dir = path.split("/").slice(0, -1).join("/")
      if (dir && dir !== "/") fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path, data)
      refresh()
      setSelectedFile(path)
    },
    [fs],
  )

  const renderMain = () => {
    if (!selectedFile) {
      return (
        <div className="empty-state">
          <PdfUpload onUpload={handlePdfUpload} />
          <p>Select a file or upload a PDF</p>
        </div>
      )
    }

    if (isPdf(selectedFile)) {
      return <PdfViewer key={selectedFile} fs={fs} path={selectedFile} />
    }

    return <Editor key={selectedFile} fs={fs} path={selectedFile} />
  }

  return (
    <div className="app">
      <div className="sidebar">
        <div className="sidebar-header">
          <h2>Files</h2>
        </div>
        <FileExplorer
          fs={fs}
          selectedFile={selectedFile}
          onSelectFile={setSelectedFile}
          refreshKey={refreshKey}
          onRefresh={refresh}
          onPdfUpload={handlePdfUpload}
        />
      </div>
      <div className="main">{renderMain()}</div>
    </div>
  )
}
