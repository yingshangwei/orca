import { useAppStore } from '../../store'
import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry,
  type AgentStatusState
} from '../../../../shared/agent-status-types'

/**
 * Hydrated nonterminal rows are only recovery evidence until a live hook event
 * confirms the turn. They must not make Native Chat look permanently busy.
 */
export function resolveNativeChatHookState(
  entry:
    | Pick<AgentStatusEntry, 'state' | 'workingMode' | 'updatedAt' | 'restoredUnconfirmed'>
    | undefined,
  now = Date.now()
): AgentStatusState | null {
  if (!entry || !isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)) {
    return null
  }
  return entry.state === 'working' && entry.workingMode === 'monitoring' ? null : entry.state
}

export function useNativeChatHookStatus(
  paneKey: string
): readonly [AgentStatusState | null, number | null, boolean] {
  // Primitive selectors avoid rerenders for unrelated status changes.
  const state = useAppStore((store) =>
    resolveNativeChatHookState(store.agentStatusByPaneKey[paneKey])
  )
  const stateStartedAt = useAppStore(
    (store) => store.agentStatusByPaneKey[paneKey]?.stateStartedAt ?? null
  )
  // Why: only children that started during the current parent working epoch can
  // keep the session working after lead completion. Prior-turn roster leftovers
  // (missed SubagentStop, pane reuse) must not veto settle forever.
  const hasWorkingSubagents = useAppStore((store) => {
    const entry = store.agentStatusByPaneKey[paneKey]
    const epochStart = entry?.stateStartedAt
    return (
      entry?.subagents?.some(
        (subagent) =>
          subagent.state === 'working' && (epochStart == null || subagent.startedAt >= epochStart)
      ) ?? false
    )
  })
  return [state, stateStartedAt, hasWorkingSubagents]
}
