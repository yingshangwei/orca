import { vi } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { RuntimeMobileSessionTerminalClientTab } from '../../shared/runtime-session-contracts'
import { AgentHookServer } from '../agent-hooks/server'
import { HerdrStatusBridge, type HerdrStatusBridgeDependencies } from './herdr-status-bridge'
import type { HerdrSnapshot } from './herdr-snapshot'
import type { HerdrSyncState } from './herdr-sync-state'

export function createHerdrStatusFixture(status = 'working') {
  const folder: FolderWorkspace = {
    id: 'herdr-folder',
    projectGroupId: 'herdr-group',
    name: 'Herdr agent',
    folderPath: '/project',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const tab: RuntimeMobileSessionTerminalClientTab = {
    type: 'terminal',
    id: 'herdr-tab::11111111-1111-4111-8111-111111111111',
    parentTabId: 'herdr-tab',
    leafId: '11111111-1111-4111-8111-111111111111',
    title: 'Agent · Herdr',
    terminal: 'orca-terminal',
    status: 'ready',
    isActive: false
  }
  const snapshot: HerdrSnapshot = {
    workspaces: [],
    tabs: [],
    panes: [
      {
        pane_id: 'w1:p1',
        terminal_id: 'term_original',
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        cwd: '/project',
        agent: 'claude',
        agent_session: { kind: 'id', value: 'session-1' },
        agent_status: status
      }
    ]
  }
  const state: HerdrSyncState = {
    version: 1,
    groups: {},
    bindings: { term_original: { folderId: folder.id, tabId: tab.id } }
  }
  const server = new AgentHookServer()
  const deps: HerdrStatusBridgeDependencies = {
    runtime: {
      listVisibleFolderWorkspaces: vi.fn(() => [folder]),
      listMobileSessionTabs: vi.fn(async (worktree) => ({
        worktree,
        publicationEpoch: 'test',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: null,
        tabs: [tab]
      }))
    },
    server,
    executable: vi.fn(async () => '/tools/herdr'),
    snapshot: vi.fn(async () => snapshot),
    load: vi.fn(async () => state),
    transcript: vi.fn(async (_agent, session) => `/history/${session}.jsonl`),
    onError: vi.fn()
  }
  return { bridge: new HerdrStatusBridge(deps), deps, server, snapshot, state, folder, tab }
}
