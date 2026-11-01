import React, { useCallback, useLayoutEffect, useRef } from 'react'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import MermaidBlock from './MermaidBlock'
import { useDocumentDarkTheme } from '@/hooks/use-document-dark-theme'

type MermaidViewerProps = {
  content: string
  scrollCacheKey: string
}

// Why: MermaidViewer is the full-file counterpart to MermaidBlock (which
// renders fenced mermaid blocks inside markdown). When a user opens a .mmd
// or .mermaid file in diagram mode, the entire file content is the diagram
// source — no markdown wrapper, no frontmatter, just mermaid syntax.
export default function MermaidViewer({
  content,
  scrollCacheKey
}: MermaidViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingScrollTopRef = useRef<number | undefined>(undefined)
  const renderCompleteRef = useRef(false)
  const restoreObserverRef = useRef<ResizeObserver | null>(null)
  const isDark = useDocumentDarkTheme()
  const diagramSource = content.trim()

  const cancelPendingScroll = useCallback(() => {
    pendingScrollTopRef.current = undefined
    restoreObserverRef.current?.disconnect()
    restoreObserverRef.current = null
  }, [])
  const restorePendingScroll = useCallback(() => {
    const container = rootRef.current
    const targetScrollTop = pendingScrollTopRef.current
    if (!container || targetScrollTop === undefined || container.clientHeight === 0) {
      return
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    if (!renderCompleteRef.current && maxScrollTop < targetScrollTop) {
      return
    }
    container.scrollTop = Math.min(targetScrollTop, maxScrollTop)
    cancelPendingScroll()
  }, [cancelPendingScroll])
  const onRenderComplete = useCallback(() => {
    renderCompleteRef.current = true
    restorePendingScroll()
  }, [restorePendingScroll])

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }

    let throttleTimer: ReturnType<typeof setTimeout> | null = null

    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        throttleTimer = null
      }, 150)
    }

    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      // Why: guard against writing 0 when the SVG has not rendered yet (e.g.,
      // StrictMode double-mount or quick tab switch before mermaid.render()
      // completes). Without this, a valid cached position gets clobbered.
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollCacheKey])

  useLayoutEffect(() => {
    const container = rootRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    pendingScrollTopRef.current = targetScrollTop
    renderCompleteRef.current = false
    if (!container || targetScrollTop === undefined) {
      return
    }
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(restorePendingScroll)
    restoreObserverRef.current = observer
    observer?.observe(container)
    // User scrolling wins over a restore that is still waiting on render or layout.
    const userScrollEvents = ['wheel', 'pointerdown', 'touchstart', 'keydown'] as const
    userScrollEvents.forEach((type) =>
      container.addEventListener(type, cancelPendingScroll, { passive: true })
    )
    restorePendingScroll()
    return () => {
      observer?.disconnect()
      cancelPendingScroll()
      renderCompleteRef.current = false
      userScrollEvents.forEach((type) => container.removeEventListener(type, cancelPendingScroll))
    }
  }, [scrollCacheKey, diagramSource, restorePendingScroll, cancelPendingScroll])

  return (
    <div ref={rootRef} className="mermaid-viewer h-full min-h-0 overflow-auto scrollbar-editor">
      <div className="mermaid-viewer-canvas">
        {/* DOMPurify strips foreignObject HTML labels; request native SVG text so labels survive sanitization. */}
        <MermaidBlock
          content={diagramSource}
          isDark={isDark}
          htmlLabels={false}
          onRenderComplete={onRenderComplete}
        />
      </div>
    </div>
  )
}
