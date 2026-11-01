// @vitest-environment happy-dom

// The crash this guards: a ReferenceError raised while Monaco builds its editor takes down
// the workbench unless a boundary sits directly around the editor pane.

import { act, useEffect, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import { EditorEditFileSurface } from './EditorEditFileSurface'
import { scrollTopCache } from '@/lib/scroll-cache'
import type { OpenFile } from '@/store/slices/editor'
import type { useMarkdownDocuments } from './useMarkdownDocuments'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'

const reportCrashMock = vi.hoisted(() => vi.fn())
type EditorMountFailure = 'create' | 'on-mount' | null

const editorMounts = vi.hoisted((): { count: number; failure: EditorMountFailure } => ({
  count: 0,
  failure: null
}))

vi.mock('@/lib/react-error-boundary-reporting', () => ({
  reportReactErrorBoundaryCrash: reportCrashMock
}))

vi.mock('./MermaidBlock', () => ({ default: () => <div /> }))

vi.mock('./editor-lazy-views', async () => {
  const { default: MermaidViewer } = await import('./MermaidViewer')
  function MonacoEditorStub(): ReactElement {
    // Why: @monaco-editor/react calls editor.create() and then onMount from its own mount
    // effect, so both cited failures surface here — as a direct throw and as a callback throw.
    useEffect(() => {
      editorMounts.count += 1
      if (editorMounts.failure === 'create') {
        throw new ReferenceError('Cannot access uninitialized variable.')
      }
      if (editorMounts.failure === 'on-mount') {
        const onMount = (): void => {
          throw new TypeError('onMount wiring failed')
        }
        onMount()
      }
    }, [])
    return <div data-testid="monaco-editor" />
  }
  const unusedViewer = (): ReactElement => <div />
  return {
    MonacoEditor: MonacoEditorStub,
    CsvViewer: unusedViewer,
    ImageViewer: unusedViewer,
    IpynbViewer: unusedViewer,
    MermaidViewer
  }
})

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const PAGE_BOUNDARY_TITLE = 'The page boundary caught it'

const noMarkdownDocuments: MarkdownDocument[] = []
const openMarkdownDocument = async (): Promise<void> => {}
const markdownDocumentsStub: ReturnType<typeof useMarkdownDocuments> = {
  markdownDocuments: noMarkdownDocuments,
  openMarkdownDocument,
  onOpenDocLink: () => {},
  previewProps: { markdownDocuments: noMarkdownDocuments, onOpenDocument: openMarkdownDocument },
  mdSave: async () => false
}

const activeFile: OpenFile = {
  id: 'file-1',
  filePath: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  worktreeId: 'wt-1',
  language: 'typescript',
  isDirty: false,
  mode: 'edit'
}

function Harness({ mermaid = false, pane = 'view-state-1' } = {}): ReactElement {
  return (
    <RecoverableRenderErrorBoundary
      boundaryId="page.terminal"
      surface="page"
      title={PAGE_BOUNDARY_TITLE}
    >
      <div data-testid="page-sibling" />
      <EditorEditFileSurface
        activeFile={activeFile}
        viewStateScopeId="scope-1"
        editorViewStateKey={pane}
        diffViewStateKey="diff-view-state-1"
        pdfViewStateKey="pdf-view-state-1"
        pdfPreferenceKey="pdf-pref-1"
        fileContent={{ content: 'const a = 1\n', isBinary: false }}
        diffContent={undefined}
        editBuffer={undefined}
        activeConflictEntry={null}
        monacoLanguage="typescript"
        isMarkdown={false}
        isMermaid={mermaid}
        isCsv={false}
        isNotebook={false}
        mdViewMode={mermaid ? 'rich' : 'source'}
        inlineMarkdownRenderState={null}
        isChangesMode={false}
        sideBySide={false}
        showMarkdownTableOfContents={false}
        showMarkdownFrontmatter={false}
        onCloseMarkdownTableOfContents={() => {}}
        markdownAnnotationsEnabled={false}
        pendingEditorReveal={null}
        markdownDocuments={markdownDocumentsStub}
        getConflictNavigation={() => undefined}
        getMarkdownSourceLineOffset={() => 0}
        handleContentChange={() => {}}
        handleDirtyStateHint={() => {}}
        handleSave={async () => false}
        reloadContent={() => {}}
      />
    </RecoverableRenderErrorBoundary>
  )
}

describe('Monaco editor failure containment', () => {
  let root: Root | null = null
  let container: HTMLDivElement | null = null

  beforeEach(() => {
    reportCrashMock.mockReset()
    editorMounts.count = 0
    editorMounts.failure = null
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
    vi.restoreAllMocks()
  })

  function render(): void {
    act(() => {
      root?.render(<Harness />)
    })
  }

  function retryButton(): HTMLButtonElement {
    const button = container?.querySelector('button')
    if (!button) {
      throw new Error('expected the contained-failure retry button')
    }
    return button
  }

  it.each(['create', 'on-mount'] as const)(
    'contains a %s failure in the editor pane and still reports it',
    (failure) => {
      editorMounts.failure = failure
      render()

      expect(container?.textContent).not.toContain(PAGE_BOUNDARY_TITLE)
      expect(container?.querySelector('[data-testid="page-sibling"]')).not.toBeNull()
      expect(container?.querySelector('[data-testid="monaco-editor"]')).toBeNull()
      expect(container?.querySelector('[role="alert"]')).not.toBeNull()
      expect(reportCrashMock).toHaveBeenCalledTimes(1)
      expect(reportCrashMock.mock.calls[0]?.[0]).toMatchObject({
        boundaryId: 'editor.monaco',
        surface: 'code-editor'
      })
    }
  )

  it('remounts the editor when the contained failure is retried', () => {
    editorMounts.failure = 'create'
    render()
    expect(editorMounts.count).toBe(1)

    editorMounts.failure = null
    act(() => {
      retryButton().click()
    })

    expect(editorMounts.count).toBe(2)
    expect(container?.querySelector('[data-testid="monaco-editor"]')).not.toBeNull()
    expect(container?.textContent).not.toContain(PAGE_BOUNDARY_TITLE)
  })
})

it('restores independent diagram scroll positions for two panes showing the same file', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
  const viewport = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(100)
  scrollTopCache.clear()
  const panes = () => (
    <>
      <Harness mermaid pane="left-pane" />
      <Harness mermaid pane="right-pane" />
    </>
  )
  try {
    act(() => root.render(panes()))
    const [left, right] = container.querySelectorAll<HTMLElement>('.mermaid-viewer')
    expect(left).toBeDefined()
    expect(right).toBeDefined()
    left.scrollTop = 120
    right.scrollTop = 350
    act(() => root.render(null))
    expect(scrollTopCache.get('left-pane:mermaid-diagram')).toBe(120)
    expect(scrollTopCache.get('right-pane:mermaid-diagram')).toBe(350)

    act(() => root.render(panes()))
    const restored = [...container.querySelectorAll<HTMLElement>('.mermaid-viewer')]
    expect(restored.map((pane) => pane.scrollTop)).toEqual([120, 350])
  } finally {
    act(() => root.unmount())
    container.remove()
    height.mockRestore()
    viewport.mockRestore()
    scrollTopCache.clear()
  }
})
