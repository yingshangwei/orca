import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHerdrStatusFixture } from '../../src/main/herdr/herdr-status-test-fixture'
import { toAgentStatusIpcPayload } from '../../src/main/agent-hooks/server/server-status-identity'
import { createGlobalSettingsFixture } from '../../src/shared/global-settings-test-fixture'
import { createTestStore, makeTab } from '@/store/slices/store-test-helpers'
import { createAgentStatusEventApplicator } from '@/hooks/ipc-events/agent-status-event-applicator'
import { resetAgentHookCompletionNotificationCoordinators } from '@/hooks/agent-hook-completion-notifications'
import { selectWorktreeAgentActivitySummary } from '@/components/sidebar/worktree-agent-activity-summary'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh
} from '../../src/shared/agent-status-freshness'

vi.mock('../../src/main/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../src/main/telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({}))
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('@/lib/desktop-notification-sound', () => ({ playDesktopNotificationSound: vi.fn() }))
vi.mock('@/lib/blocked-notification-fallback', () => ({
  showBlockedNotificationFallbackToast: vi.fn()
}))

const store = createTestStore()
const dispatch = vi.fn(async () => ({ delivered: true }))
let h: ReturnType<typeof createHerdrStatusFixture>
const workspaceId = 'folder:herdr-folder'
const paneKey = 'herdr-tab:11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  h = createHerdrStatusFixture()
  dispatch.mockClear()
  vi.stubGlobal('window', { api: { notifications: { dispatch, dismiss: vi.fn(async () => {}) } } })
  vi.stubGlobal('document', { visibilityState: 'hidden', hasFocus: () => false })
  store.setState({
    settings: { ...createGlobalSettingsFixture(), experimentalTerminalAttention: false },
    workspaceSessionReady: true,
    folderWorkspaces: [h.folder],
    projectGroups: [],
    activeWorktreeId: 'another-workspace',
    activeTabId: null,
    tabsByWorktree: {
      [workspaceId]: [
        makeTab({
          id: h.tab.parentTabId,
          worktreeId: workspaceId,
          ptyId: 'pty-herdr',
          title: 'Agent · Herdr'
        })
      ]
    },
    ptyIdsByTabId: { [h.tab.parentTabId]: ['pty-herdr'] },
    terminalLayoutsByTabId: {
      [h.tab.parentTabId]: {
        root: { type: 'leaf', leafId: h.tab.leafId },
        activeLeafId: h.tab.leafId,
        expandedLeafId: null,
        ptyIdsByLeafId: { [h.tab.leafId]: 'pty-herdr' }
      }
    },
    agentStatusByPaneKey: {},
    suppressedPtyExitIds: {},
    unreadAgentCompletionPanes: {},
    unreadTerminalTabs: {},
    unreadTerminalPanes: {},
    updateFolderWorkspace: async () => true
  })
  resetAgentHookCompletionNotificationCoordinators()
  const apply = createAgentStatusEventApplicator({
    pendingAgentStatusEvents: [],
    transientClearWatermarkByConnectionId: new Map(),
    enqueuePendingAgentStatus: () => {
      throw new Error('Herdr status lost its workspace')
    }
  })
  h.server.setListener((row) => {
    expect(apply(toAgentStatusIpcPayload(row))).toBe('applied')
  })
})

afterEach(() => {
  h.bridge.dispose()
  h.server.stop()
  resetAgentHookCompletionNotificationCoordinators()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function status(next: string): Promise<void> {
  h.snapshot.panes[0].agent_status = next
  await h.bridge.refresh()
  await vi.advanceTimersByTimeAsync(2_000)
}

describe('Herdr completion uses native workspace unread', () => {
  it.each(['claude', 'codex'])(
    'keeps a long-running %s visible as working without repeating completion',
    async (agent) => {
      h.snapshot.panes[0].agent = agent
      await status('working')
      const startedAt = store.getState().agentStatusByPaneKey[paneKey].stateStartedAt
      for (let minute = 0; minute < 65; minute++) {
        await vi.advanceTimersByTimeAsync(60_000)
        await h.bridge.refresh()
      }
      const entry = store.getState().agentStatusByPaneKey[paneKey]
      expect(entry.stateStartedAt).toBe(startedAt)
      expect(isAgentStatusFresh(entry)).toBe(true)
      expect(selectWorktreeAgentActivitySummary(store.getState(), workspaceId).hasLiveWorking).toBe(
        true
      )
      expect(dispatch).not.toHaveBeenCalled()
      expect(store.getState().folderWorkspaces[0].isUnread).toBe(false)

      await status('done')
      await status('done')
      expect(selectWorktreeAgentActivitySummary(store.getState(), workspaceId).hasLiveWorking).toBe(
        false
      )
      expect(dispatch).toHaveBeenCalledTimes(1)

      await status('working')
      vi.mocked(h.deps.snapshot).mockRejectedValueOnce(new Error('offline'))
      await vi.advanceTimersByTimeAsync(AGENT_STATUS_STALE_AFTER_MS + 1)
      await h.bridge.refresh()
      expect(isAgentStatusFresh(store.getState().agentStatusByPaneKey[paneKey])).toBe(false)
    }
  )

  it.each(['claude', 'codex'])(
    '%s marks a background completion, clears on reading, and does not repeat',
    async (agent) => {
      h.snapshot.panes[0].agent = agent
      await status('working')
      expect(store.getState().folderWorkspaces[0].isUnread).toBe(false)
      await status('done')
      expect(store.getState().folderWorkspaces[0].isUnread).toBe(true)
      expect(store.getState().unreadAgentCompletionPanes[paneKey]).toBe('agent-completion')
      expect(dispatch).toHaveBeenCalledTimes(1)
      store.getState().readOnScreenAttention(
        {
          workspaceIds: [workspaceId],
          targets: [{ worktreeId: workspaceId, tabId: h.tab.parentTabId }]
        },
        { screenArrived: true }
      )
      expect(store.getState().folderWorkspaces[0].isUnread).toBe(false)
      expect(store.getState().unreadAgentCompletionPanes).toEqual({})
      await status('done')
      expect(store.getState().folderWorkspaces[0].isUnread).toBe(false)
      expect(dispatch).toHaveBeenCalledTimes(1)
      await status('working')
      expect(store.getState().agentStatusByPaneKey[paneKey].providerSession?.id).toBe('session-1')
      await status('done')
      expect(store.getState().folderWorkspaces[0].isUnread).toBe(true)
      expect(dispatch).toHaveBeenCalledTimes(2)
    }
  )

  it('does not announce baseline or offline completion, but announces a new blocked state', async () => {
    await status('done')
    expect(dispatch).not.toHaveBeenCalled()
    await status('working')
    vi.mocked(h.deps.snapshot).mockRejectedValueOnce(new Error('offline'))
    await h.bridge.refresh()
    await status('done')
    expect(store.getState().folderWorkspaces[0].isUnread).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
    await status('working')
    await status('blocked')
    expect(store.getState().folderWorkspaces[0].isUnread).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('does not announce idle as a completed turn', async () => {
    await status('working')
    await status('idle')
    expect(store.getState().folderWorkspaces[0].isUnread).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
