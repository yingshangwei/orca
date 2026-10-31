// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentStatusClearIpcPayload,
  AgentStatusIpcPayload
} from '../../../../shared/agent-status-types'
import { useAppStore } from '../../store'
import { useNativeChatStatusEntry } from './use-native-chat-status-entry'
import { resolveNativeChatSession } from './native-chat-pane-resolution'

const paneKey = 'tab-1:leaf-1'
function identity(agentType: 'claude' | 'codex', id: string): AgentStatusIpcPayload {
  return {
    paneKey,
    agentType,
    providerSessionOnly: true,
    providerSession: { key: 'session_id', id, transcriptPath: `/sessions/${id}.jsonl` },
    state: 'done',
    prompt: '',
    receivedAt: 1,
    stateStartedAt: 1,
    connectionId: null
  }
}

function mockBridge(snapshot: Promise<AgentStatusIpcPayload[]>) {
  let onSet: (data: AgentStatusIpcPayload) => void = () => {}
  let onClear: (data: AgentStatusClearIpcPayload) => void = () => {}
  const unsubscribeSet = vi.fn()
  const unsubscribeClear = vi.fn()
  vi.stubGlobal('api', {
    agentStatus: {
      getSnapshot: vi.fn(() => snapshot),
      onSet: (callback: typeof onSet) => {
        onSet = callback
        return unsubscribeSet
      },
      onClear: (callback: typeof onClear) => {
        onClear = callback
        return unsubscribeClear
      }
    }
  })
  return {
    set: (data: AgentStatusIpcPayload) => act(() => onSet(data)),
    clear: (data: AgentStatusClearIpcPayload) => act(() => onClear(data)),
    unsubscribeSet,
    unsubscribeClear
  }
}

describe('native chat resume identity', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    useAppStore.setState(useAppStore.getInitialState())
  })

  it.each(['claude', 'codex'] as const)(
    'opens a %s transcript without creating turn or recovery state',
    async (agent) => {
      useAppStore.setState(useAppStore.getInitialState())
      const stateBefore = useAppStore.getState()
      const bridge = mockBridge(Promise.resolve([identity(agent, 'restored-session')]))
      const { result, unmount } = renderHook(() => useNativeChatStatusEntry('tab-1', paneKey))
      await waitFor(() =>
        expect(result.current.entry?.providerSession?.id).toBe('restored-session')
      )
      expect(
        resolveNativeChatSession({
          paneKey: result.current.paneKey,
          agentStatusEntry: result.current.entry,
          ptyId: 'pty-1'
        })
      ).toMatchObject({
        agent,
        sessionId: 'restored-session',
        transcriptPath: '/sessions/restored-session.jsonl'
      })
      expect(useAppStore.getState()).toBe(stateBefore)
      bridge.clear({ paneKey: 'tab-1:other-leaf' })
      expect(result.current.entry?.providerSession?.id).toBe('restored-session')
      bridge.clear({ paneKey })
      expect(result.current.entry).toBeUndefined()
      unmount()
      expect(bridge.unsubscribeSet).toHaveBeenCalledOnce()
      expect(bridge.unsubscribeClear).toHaveBeenCalledOnce()
    }
  )

  it('keeps a live update when an older snapshot finishes afterward', async () => {
    const snapshot = Promise.withResolvers<AgentStatusIpcPayload[]>()
    const bridge = mockBridge(snapshot.promise)
    const { result } = renderHook(() => useNativeChatStatusEntry('tab-1', paneKey))
    bridge.set(identity('codex', 'new-session'))
    await act(async () => snapshot.resolve([identity('codex', 'old-session')]))
    expect(result.current.entry?.providerSession?.id).toBe('new-session')
    act(() =>
      useAppStore.setState({
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            agentType: 'claude',
            providerSession: { key: 'session_id', id: 'live-session' },
            state: 'working',
            prompt: '',
            updatedAt: 2,
            stateStartedAt: 2,
            stateHistory: []
          }
        }
      })
    )
    expect(result.current.entry?.providerSession?.id).toBe('live-session')
  })

  it('does not carry a session across split panes', async () => {
    mockBridge(Promise.resolve([identity('claude', 'left-session')]))
    const { result, rerender } = renderHook(({ key }) => useNativeChatStatusEntry('tab-1', key), {
      initialProps: { key: paneKey }
    })
    await waitFor(() => expect(result.current.entry?.providerSession?.id).toBe('left-session'))
    rerender({ key: 'tab-1:right-leaf' })
    expect(result.current.entry).toBeUndefined()
  })
})
