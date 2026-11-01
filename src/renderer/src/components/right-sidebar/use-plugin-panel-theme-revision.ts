import { useEffect, useRef, useState } from 'react'
import { buildPanelDesignTokenCss, currentPanelColorScheme } from './plugin-panel-design-token-css'

/** The exact shell inputs; anything else on the root must not rebuild the frame. */
function readPanelThemeSnapshot(): string {
  return `${currentPanelColorScheme()}|${buildPanelDesignTokenCss()}`
}

/** Changes only when the values baked into the panel shell actually change. */
export function usePluginPanelThemeRevision(): number {
  const [revision, setRevision] = useState(0)
  // Compare baked shell values: unrelated root-style writes must not remount iframes and destroy panel state.
  const snapshotRef = useRef<string | null>(null)
  useEffect(() => {
    snapshotRef.current ??= readPanelThemeSnapshot()
    const observer = new MutationObserver(() => {
      const snapshot = readPanelThemeSnapshot()
      if (snapshot === snapshotRef.current) {
        return
      }
      snapshotRef.current = snapshot
      setRevision((current) => current + 1)
    })
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style']
    })
    return () => observer.disconnect()
  }, [])
  return revision
}
