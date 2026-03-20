import React, { useCallback, useRef, useState } from "react"

interface Props {
  onUpload: (name: string, data: Uint8Array) => void
}

export function PdfUpload({ onUpload }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)

  const handleFile = useCallback(
    (file: File) => {
      if (!file.name.endsWith(".pdf")) return
      file.arrayBuffer().then((buf) => {
        onUpload(file.name, new Uint8Array(buf))
      })
    },
    [onUpload],
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const file = e.dataTransfer.files[0]
      if (file) handleFile(file)
    },
    [handleFile],
  )

  return (
    <div
      className={`pdf-upload-zone ${dragOver ? "drag-over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".pdf"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handleFile(file)
        }}
      />
      <div className="pdf-upload-content">
        <span className="pdf-upload-icon">+</span>
        <span>Upload PDF</span>
      </div>
    </div>
  )
}
