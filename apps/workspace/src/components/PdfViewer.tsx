import React, { useCallback, useEffect, useRef, useState } from "react"
import type { AutomergeFs } from "@just-be/automerge-fs"
import type { DocHandle } from "@automerge/automerge-repo"
import { getDocumentProxy } from "unpdf"

/** Overlay doc stored alongside the PDF in automerge-fs */
export interface OverlayField {
  id: string
  page: number
  /** Position as fraction of page dimensions (0–1) */
  x: number
  y: number
  w: number
  h: number
  value: string
  type: "text" | "checkbox"
}

export interface PdfOverlayDoc {
  fields: Record<string, OverlayField>
}

interface Props {
  fs: AutomergeFs
  path: string
}

const OVERLAY_SUFFIX = ".overlay.json"
const SCALE = 1.5

export function PdfViewer({ fs, path }: Props) {
  const [pageImages, setPageImages] = useState<string[]>([])
  const [pageDimensions, setPageDimensions] = useState<
    { width: number; height: number }[]
  >([])
  const [fields, setFields] = useState<Record<string, OverlayField>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editingField, setEditingField] = useState<string | null>(null)
  const overlayHandleRef = useRef<DocHandle<PdfOverlayDoc> | null>(null)
  const containerRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const overlayPath = path + OVERLAY_SUFFIX

  // Load PDF and render pages
  useEffect(() => {
    let cancelled = false

    async function loadPdf() {
      try {
        const data = await fs.readFile(path)
        const pdf = await getDocumentProxy(new Uint8Array(data))

        const images: string[] = []
        const dims: { width: number; height: number }[] = []

        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i)
          const viewport = page.getViewport({ scale: SCALE })

          const canvas = document.createElement("canvas")
          canvas.width = viewport.width
          canvas.height = viewport.height
          const ctx = canvas.getContext("2d")!

          await page.render({ canvasContext: ctx, viewport }).promise

          images.push(canvas.toDataURL())
          dims.push({
            width: viewport.width,
            height: viewport.height,
          })
        }

        if (!cancelled) {
          setPageImages(images)
          setPageDimensions(dims)
        }

        pdf.destroy()
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
        }
      }
    }

    loadPdf()
    return () => {
      cancelled = true
    }
  }, [fs, path])

  // Load or create overlay doc
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | undefined

    async function loadOverlay() {
      try {
        // Check if overlay file exists, create if not
        if (!fs.exists(overlayPath)) {
          const initial: PdfOverlayDoc = { fields: {} }
          await fs.writeFile(overlayPath, JSON.stringify(initial))
        }

        const handle = await fs.getFileDocHandle(overlayPath)
        await handle.whenReady()
        overlayHandleRef.current = handle as any

        const readFields = () => {
          const doc = handle.docSync()
          if (!doc) return
          try {
            const parsed: PdfOverlayDoc = JSON.parse(doc.content)
            if (!cancelled) setFields(parsed.fields ?? {})
          } catch {
            // Content not valid JSON yet
          }
        }

        readFields()
        unsub = handle.on("change", readFields) as any

        if (!cancelled) setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }
    }

    loadOverlay()
    return () => {
      cancelled = true
      unsub?.()
    }
  }, [fs, overlayPath])

  const saveOverlay = useCallback(
    async (updated: Record<string, OverlayField>) => {
      const overlay: PdfOverlayDoc = { fields: updated }
      await fs.writeFile(overlayPath, JSON.stringify(overlay))
    },
    [fs, overlayPath],
  )

  // Add field on double-click
  const handlePageDoubleClick = useCallback(
    (pageIndex: number, e: React.MouseEvent<HTMLDivElement>) => {
      const container = containerRefs.current.get(pageIndex)
      if (!container) return

      const rect = container.getBoundingClientRect()
      const x = (e.clientX - rect.left) / rect.width
      const y = (e.clientY - rect.top) / rect.height

      const id = crypto.randomUUID()
      const field: OverlayField = {
        id,
        page: pageIndex,
        x,
        y,
        w: 0.2,
        h: 0.03,
        value: "",
        type: "text",
      }

      const updated = { ...fields, [id]: field }
      setFields(updated)
      setEditingField(id)
      saveOverlay(updated)
    },
    [fields, saveOverlay],
  )

  const handleFieldChange = useCallback(
    (id: string, value: string) => {
      const updated = {
        ...fields,
        [id]: { ...fields[id]!, value },
      }
      setFields(updated)
      saveOverlay(updated)
    },
    [fields, saveOverlay],
  )

  const handleCheckboxToggle = useCallback(
    (id: string) => {
      const field = fields[id]!
      const value = field.value === "true" ? "false" : "true"
      const updated = {
        ...fields,
        [id]: { ...field, value },
      }
      setFields(updated)
      saveOverlay(updated)
    },
    [fields, saveOverlay],
  )

  const handleDeleteField = useCallback(
    (id: string) => {
      const { [id]: _, ...rest } = fields
      setFields(rest)
      setEditingField(null)
      saveOverlay(rest)
    },
    [fields, saveOverlay],
  )

  const handleFieldTypeToggle = useCallback(
    (id: string) => {
      const field = fields[id]!
      const newType = field.type === "text" ? "checkbox" : "text"
      const updated = {
        ...fields,
        [id]: {
          ...field,
          type: newType,
          value: newType === "checkbox" ? "false" : "",
          w: newType === "checkbox" ? 0.025 : 0.2,
          h: newType === "checkbox" ? 0.025 : 0.03,
        },
      }
      setFields(updated)
      saveOverlay(updated)
    },
    [fields, saveOverlay],
  )

  if (error) {
    return (
      <div className="editor-container">
        <div className="editor-header">
          <span className="path">{path}</span>
        </div>
        <div className="editor-loading">Error: {error}</div>
      </div>
    )
  }

  if (loading || pageImages.length === 0) {
    return (
      <div className="editor-container">
        <div className="editor-header">
          <span className="path">{path}</span>
        </div>
        <div className="editor-loading">Loading PDF...</div>
      </div>
    )
  }

  return (
    <div className="editor-container">
      <div className="editor-header">
        <span className="path">{path}</span>
        <span className="pdf-hint">Double-click to add a form field</span>
      </div>
      <div className="pdf-pages">
        {pageImages.map((src, pageIndex) => {
          const dim = pageDimensions[pageIndex]!
          const pageFields = Object.values(fields).filter(
            (f) => f.page === pageIndex,
          )

          return (
            <div
              key={pageIndex}
              className="pdf-page-wrapper"
              ref={(el) => {
                if (el) containerRefs.current.set(pageIndex, el)
              }}
              style={{
                width: dim.width,
                height: dim.height,
                position: "relative",
              }}
              onDoubleClick={(e) => handlePageDoubleClick(pageIndex, e)}
            >
              <img
                src={src}
                className="pdf-page-image"
                alt={`Page ${pageIndex + 1}`}
                draggable={false}
              />
              {pageFields.map((field) => (
                <OverlayFieldEl
                  key={field.id}
                  field={field}
                  isEditing={editingField === field.id}
                  onFocus={() => setEditingField(field.id)}
                  onBlur={() => setEditingField(null)}
                  onChange={handleFieldChange}
                  onCheckboxToggle={handleCheckboxToggle}
                  onDelete={handleDeleteField}
                  onToggleType={handleFieldTypeToggle}
                  containerWidth={dim.width}
                  containerHeight={dim.height}
                />
              ))}
              <div className="pdf-page-number">Page {pageIndex + 1}</div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function OverlayFieldEl({
  field,
  isEditing,
  onFocus,
  onBlur,
  onChange,
  onCheckboxToggle,
  onDelete,
  onToggleType,
  containerWidth,
  containerHeight,
}: {
  field: OverlayField
  isEditing: boolean
  onFocus: () => void
  onBlur: () => void
  onChange: (id: string, value: string) => void
  onCheckboxToggle: (id: string) => void
  onDelete: (id: string) => void
  onToggleType: (id: string) => void
  containerWidth: number
  containerHeight: number
}) {
  const left = field.x * containerWidth
  const top = field.y * containerHeight
  const width = field.w * containerWidth
  const height = field.h * containerHeight

  return (
    <div
      className={`overlay-field ${isEditing ? "editing" : ""}`}
      style={{
        position: "absolute",
        left,
        top,
        width,
        height,
      }}
    >
      {field.type === "checkbox" ? (
        <div
          className="overlay-checkbox"
          onClick={(e) => {
            e.stopPropagation()
            onCheckboxToggle(field.id)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onFocus={onFocus}
          onBlur={onBlur}
          tabIndex={0}
        >
          {field.value === "true" ? "\u2713" : ""}
        </div>
      ) : (
        <input
          className="overlay-input"
          type="text"
          value={field.value}
          placeholder="..."
          onFocus={onFocus}
          onBlur={onBlur}
          onChange={(e) => onChange(field.id, e.target.value)}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      )}
      {isEditing && (
        <div className="overlay-field-actions">
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              onToggleType(field.id)
            }}
            title={`Switch to ${field.type === "text" ? "checkbox" : "text"}`}
          >
            {field.type === "text" ? "\u2610" : "T"}
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault()
              onDelete(field.id)
            }}
            title="Delete field"
          >
            \u00d7
          </button>
        </div>
      )}
    </div>
  )
}
