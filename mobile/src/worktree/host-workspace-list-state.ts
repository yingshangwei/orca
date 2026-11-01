import {
  isConnectionDialing,
  isConnectionOutage,
  type ConnectionVerdict
} from '../transport/connection-health'
import type { ConnectionState } from '../transport/types'

export type HostWorkspaceListStateInput = {
  connState: ConnectionState
  connectionVerdict: ConnectionVerdict
  worktreesLoaded: boolean
  displayCount: number
  sectionCount: number
  catalogError: string | null
}

// Why (STA-3123): one owner for the list's loading/failed/empty precedence, so a
// failed worktree.ps can never render as a healthy host with zero workspaces.
export function selectHostWorkspaceListState(
  input: HostWorkspaceListStateInput
): 'loading' | 'unreachable' | 'catalog-error' | 'empty' | null {
  const {
    connState,
    connectionVerdict,
    worktreesLoaded,
    displayCount,
    sectionCount,
    catalogError
  } = input
  // The auth banner owns refused pairings.
  if (connectionVerdict.kind === 'auth-failed') {
    return null
  }
  // An outage with nothing cached must say so; a spinner there never ends (STA-11382).
  if (
    displayCount === 0 &&
    (isConnectionOutage(connectionVerdict) ||
      (connState === 'disconnected' && !isConnectionDialing(connectionVerdict)))
  ) {
    return 'unreachable'
  }
  // Why: a blank disconnected list read as "no workspaces"; spin instead — the
  // header verdict owns escalating a long outage. auth-failed keeps its own UI.
  const pending =
    connState === 'connecting' ||
    connState === 'handshaking' ||
    connState === 'reconnecting' ||
    connState === 'disconnected'
  if (
    (pending && displayCount === 0) ||
    (connState === 'connected' && !worktreesLoaded && displayCount === 0 && !catalogError)
  ) {
    return 'loading'
  }
  if (connState !== 'connected') {
    return null
  }
  if (catalogError && displayCount === 0) {
    return 'catalog-error'
  }
  if (worktreesLoaded && sectionCount === 0) {
    return 'empty'
  }
  return null
}
