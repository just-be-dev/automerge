import React, { useEffect, useRef, useState } from "react"
import type { AutomergeFs, FileDoc } from "@just-be/automerge-fs"
import { EditorState } from "prosemirror-state"
import { EditorView } from "prosemirror-view"
import { exampleSetup } from "prosemirror-example-setup"
import { init } from "@automerge/prosemirror"
import "prosemirror-example-setup/style/style.css"
import "prosemirror-menu/style/menu.css"
import "prosemirror-view/style/prosemirror.css"

interface Props {
  fs: AutomergeFs
  path: string
}

export function Editor({ fs, path }: Props) {
  const editorRoot = useRef<HTMLDivElement>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    let cancelled = false

    async function setup() {
      try {
        const handle = await fs.getFileDocHandle(path)
        await handle.whenReady()

        if (cancelled) return

        const { pmDoc: doc, schema, plugin } = init(handle, ["content"])
        const plugins = exampleSetup({ schema })
        plugins.push(plugin)

        if (editorRoot.current) {
          const view = new EditorView(editorRoot.current, {
            state: EditorState.create({ schema, plugins, doc }),
          })
          viewRef.current = view
        }

        setLoading(false)
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e))
          setLoading(false)
        }
      }
    }

    setup()

    return () => {
      cancelled = true
      if (viewRef.current) {
        viewRef.current.destroy()
        viewRef.current = null
      }
    }
  }, [fs, path])

  return (
    <div className="editor-container">
      <div className="editor-header">
        <span className="path">{path}</span>
      </div>
      {error ? (
        <div className="editor-loading">Error: {error}</div>
      ) : loading ? (
        <div className="editor-loading">Loading...</div>
      ) : null}
      <div className="editor-content" ref={editorRoot} />
    </div>
  )
}
