import React, { useState } from "react"
import type { AutomergeFs } from "@just-be/automerge-fs"
import { FileExplorer } from "./components/FileExplorer"
import { Editor } from "./components/Editor"
import "./App.css"

export function App({ fs }: { fs: AutomergeFs }) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const refresh = () => setRefreshKey((k) => k + 1)

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
        />
      </div>
      <div className="main">
        {selectedFile ? (
          <Editor key={selectedFile} fs={fs} path={selectedFile} />
        ) : (
          <div className="empty-state">
            <p>Select a file to edit</p>
          </div>
        )}
      </div>
    </div>
  )
}
