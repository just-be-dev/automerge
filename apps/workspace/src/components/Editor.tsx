import React, { useEffect, useRef, useState } from "react"
import type { AutomergeFs } from "@just-be/automerge-fs"
import { EditorState } from "@codemirror/state"
import {
  EditorView,
  highlightSpecialChars,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightActiveLine,
  keymap,
} from "@codemirror/view"
import {
  defaultHighlightStyle,
  syntaxHighlighting,
  indentOnInput,
  bracketMatching,
  foldGutter,
  foldKeymap,
} from "@codemirror/language"
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands"
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search"
import {
  autocompletion,
  completionKeymap,
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete"
import { lintKeymap } from "@codemirror/lint"
import { automergeSyncPlugin } from "@automerge/automerge-codemirror"

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

        if (cancelled || !editorRoot.current) return

        const initial = handle.doc()?.content ?? ""

        const view = new EditorView({
          parent: editorRoot.current,
          state: EditorState.create({
            doc: initial,
            extensions: [
              highlightSpecialChars(),
              history(),
              foldGutter(),
              drawSelection(),
              dropCursor(),
              EditorState.allowMultipleSelections.of(true),
              indentOnInput(),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              bracketMatching(),
              closeBrackets(),
              autocompletion(),
              rectangularSelection(),
              crosshairCursor(),
              highlightActiveLine(),
              highlightSelectionMatches(),
              keymap.of([
                ...closeBracketsKeymap,
                ...defaultKeymap,
                ...searchKeymap,
                ...historyKeymap,
                ...foldKeymap,
                ...completionKeymap,
                ...lintKeymap,
              ]),
              EditorView.lineWrapping,
              automergeSyncPlugin({ handle, path: ["content"] }),
            ],
          }),
        })
        viewRef.current = view

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
