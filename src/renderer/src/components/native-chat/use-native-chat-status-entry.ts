import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { useAppStore } from '../../store'
import { findTabAgentEntry } from './native-chat-tab-agent-entry'

export function useNativeChatStatusEntry(
  terminalTabId: string,
  preferredPaneKey: string | undefined
) {
  const entry = useAppStore(
    useShallow((state) =>
      preferredPaneKey
        ? state.agentStatusByPaneKey[preferredPaneKey]
        : findTabAgentEntry(state.agentStatusByPaneKey, terminalTabId)
    )
  )
  const [sessionEntry, setSessionEntry] = useState<AgentStatusIpcPayload>()
  useEffect(() => {
    const api = window.api?.agentStatus
    if (!api) {
      return
    }
    let active = true
    let receivedUpdate = false
    const matchesPane = (paneKey: string) =>
      preferredPaneKey ? paneKey === preferredPaneKey : paneKey.startsWith(`${terminalTabId}:`)
    const unsubscribeSet = api.onSet((data) => {
      if (!matchesPane(data.paneKey) || data.programStatusOnly) {
        return
      }
      receivedUpdate = true
      setSessionEntry(data.providerSessionOnly && data.providerSession ? data : undefined)
    })
    const unsubscribeClear = api.onClear((data) => {
      if ('paneKey' in data && matchesPane(data.paneKey)) {
        receivedUpdate = true
        setSessionEntry(undefined)
      }
    })
    // Resume identities are intentionally absent from the live turn-status store.
    void api
      .getSnapshot()
      .then((snapshot) => {
        if (!active || receivedUpdate) {
          return
        }
        setSessionEntry(
          snapshot.find(
            (data) => matchesPane(data.paneKey) && data.providerSessionOnly && data.providerSession
          )
        )
      })
      .catch(() => {})
    return () => {
      active = false
      unsubscribeSet()
      unsubscribeClear()
    }
  }, [terminalTabId, preferredPaneKey])
  const sessionMatchesPane =
    sessionEntry &&
    (preferredPaneKey
      ? sessionEntry.paneKey === preferredPaneKey
      : sessionEntry.paneKey.startsWith(`${terminalTabId}:`))
  const resolvedEntry = entry ?? (sessionMatchesPane ? sessionEntry : undefined)
  return {
    entry: resolvedEntry,
    paneKey: preferredPaneKey ?? resolvedEntry?.paneKey ?? `${terminalTabId}:`
  }
}
