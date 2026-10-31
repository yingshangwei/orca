import { describe, expect, it, vi } from 'vitest'
import { normalizeFolderWorkspaces } from '../../shared/folder-workspaces'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { RuntimeMobileSessionTerminalClientTab } from '../../shared/runtime-session-contracts'
import { HerdrSyncService, type HerdrSyncDependencies } from './herdr-sync'
import type { HerdrSnapshot } from './herdr-snapshot'
import type { HerdrSyncState } from './herdr-sync-state'

function group(
  id: string,
  name: string,
  parentGroupId: string | null,
  parentPath: string | null = null
): ProjectGroup {
  return {
    id,
    name,
    parentGroupId,
    parentPath,
    connectionId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function folder(
  id: string,
  projectGroupId: string,
  name: string,
  folderPath = '/project'
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name,
    folderPath,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

function terminal(index: number): RuntimeMobileSessionTerminalClientTab {
  const parentTabId = `tab-${index}`
  const leafId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
  return {
    type: 'terminal',
    id: `${parentTabId}::${leafId}`,
    parentTabId,
    leafId,
    title: 'Terminal',
    status: 'ready',
    terminal: `orca-terminal-${index}`,
    isActive: false
  }
}

function harness({ legacy = false } = {}) {
  const snapshot: HerdrSnapshot = {
    workspaces: [{ workspace_id: 'w1', label: 'Project' }],
    tabs: [{ tab_id: 'w1:t1', label: 'Notes', pane_count: 1 }],
    panes: [
      {
        pane_id: 'w1:p1',
        terminal_id: 'term_original',
        workspace_id: 'w1',
        tab_id: 'w1:t1',
        cwd: '/project',
        agent: 'claude',
        agent_status: 'working',
        agent_session: { kind: 'id', value: 'original-session' }
      }
    ]
  }
  const groups: ProjectGroup[] = legacy
    ? [group('root', 'Herdr', null), group('group', 'Project', 'root')]
    : []
  const folders: FolderWorkspace[] = legacy ? [folder('folder', 'group', 'Notes')] : []
  const tabs = new Map<string, RuntimeMobileSessionTerminalClientTab[]>()
  let state: HerdrSyncState = { version: 1, groups: {}, bindings: {} }
  let nextId = 0
  if (legacy) {
    folders[0].comment = '已连接 Herdr 原终端：w1:p1 / term_original\n原记录保持不变'
    tabs.set('id:folder:folder', [{ ...terminal(++nextId), customTitle: 'Notes · Herdr' }])
  }
  const runtime: HerdrSyncDependencies['runtime'] = {
    listVisibleProjectGroups: vi.fn(() => groups),
    listVisibleFolderWorkspaces: vi.fn(() => folders),
    listFolderWorkspaces: vi.fn(() => folders),
    createProjectGroup: vi.fn(async (input) => {
      const created = group(
        `group-${++nextId}`,
        input.name,
        input.parentGroupId ?? null,
        input.parentPath ?? null
      )
      groups.push(created)
      return created
    }),
    updateProjectGroup: vi.fn(async (id, update) => {
      const target = groups.find((entry) => entry.id === id)
      return target ? Object.assign(target, update) : null
    }),
    createFolderWorkspace: vi.fn(async (input) => {
      const created = folder(
        `folder-${++nextId}`,
        input.projectGroupId,
        input.name ?? '',
        input.folderPath ?? ''
      )
      folders.push(created)
      return created
    }),
    updateFolderWorkspace: vi.fn(async (id, update) => {
      const target = folders.find((entry) => entry.id === id)
      return target ? Object.assign(target, update) : null
    }),
    listMobileSessionTabs: vi.fn(async (worktree) => ({
      worktree,
      publicationEpoch: 'test',
      snapshotVersion: 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: tabs.get(worktree) ?? []
    })),
    createMobileSessionTerminal: vi.fn(async (worktree) => {
      const tab = terminal(++nextId)
      tabs.set(worktree, [...(tabs.get(worktree) ?? []), tab])
      return { tab, publicationEpoch: 'test', snapshotVersion: 1 }
    }),
    createTerminal: vi.fn(async (worktree = '', options) => {
      const tab = tabs.get(worktree)?.find((entry) => entry.parentTabId === options?.tabId)
      if (!tab?.terminal) {
        throw new Error('Missing original terminal')
      }
      return {
        handle: tab.terminal,
        worktreeId: worktree,
        title: tab.title,
        isReattach: true as const
      }
    }),
    readTerminal: vi.fn(async (handle) => ({
      handle,
      status: 'running' as const,
      tail: [],
      nextCursor: null,
      truncated: false
    })),
    inspectTerminalProcess: vi.fn(async () => ({
      foregroundProcess: 'herdr',
      hasChildProcesses: true
    })),
    renameTerminal: vi.fn(async (handle, title) => {
      const tab = [...tabs.values()].flat().find((entry) => entry.terminal === handle)
      if (!tab) {
        throw new Error('Missing terminal')
      }
      tab.customTitle = title
      return { handle, tabId: tab.parentTabId, title }
    })
  }
  const deps: HerdrSyncDependencies = {
    runtime,
    executable: vi.fn(async () => '/tools/herdr'),
    snapshot: vi.fn(async () => snapshot),
    closeTerminal: vi.fn(async (_executable, terminalId) => {
      snapshot.panes = snapshot.panes.filter((pane) => pane.terminal_id !== terminalId)
    }),
    load: vi.fn(async () => structuredClone(state)),
    save: vi.fn((value) => {
      state = structuredClone(value)
    }),
    transcript: vi.fn(async (_agent, id) => `/history/${id}.jsonl`),
    seedIdentity: vi.fn(),
    pause: async () => {}
  }
  return {
    service: new HerdrSyncService(deps),
    deps,
    runtime,
    snapshot,
    groups,
    folders,
    tabs,
    state: () => state
  }
}

describe('Herdr sync', () => {
  it('closes only the removed workspace and persists that decision across service restarts', async () => {
    const h = harness()
    h.snapshot.panes.push({
      ...h.snapshot.panes[0],
      pane_id: 'w1:p2',
      terminal_id: 'term_sibling'
    })
    await h.service.sync()
    const removed = h.state().bindings.term_original.folderId
    await h.service.closeFolderWorkspace(removed)
    h.folders.splice(
      h.folders.findIndex((entry) => entry.id === removed),
      1
    )
    expect(h.snapshot.panes.map((pane) => pane.terminal_id)).toEqual(['term_sibling'])
    expect(h.state().bindings.term_original.closed).toBe(true)

    h.snapshot.panes.push({ ...h.snapshot.panes[0], terminal_id: 'term_original' })
    const restarted = new HerdrSyncService(h.deps)
    expect(await restarted.sync()).toMatchObject({ added: 0, connected: 1, issues: [] })
    expect(h.folders).toHaveLength(1)
    expect(h.snapshot.panes.map((pane) => pane.terminal_id)).toEqual(['term_sibling'])
  })

  it('retries closing a closed binding whose source is still running', async () => {
    const h = harness()
    await h.service.sync()
    const [pane] = h.snapshot.panes
    await h.service.closeFolderWorkspace(h.folders[0].id)
    h.folders.length = 0
    h.snapshot.panes.push(pane)
    vi.mocked(h.deps.closeTerminal).mockRejectedValueOnce(new Error('Herdr unavailable'))

    expect(await h.service.sync()).toMatchObject({ added: 0, issues: [{ paneId: 'w1:p1' }] })
    expect(await new HerdrSyncService(h.deps).sync()).toMatchObject({ added: 0, issues: [] })
    expect(h.snapshot.panes).toEqual([])
    expect(h.folders).toEqual([])
  })

  it('suppresses a binding with a missing folder without closing or reimporting its source', async () => {
    const h = harness()
    await h.service.sync()
    const lost = h.folders.splice(0)
    expect(await h.service.sync()).toMatchObject({ added: 0, issues: [] })
    expect(await new HerdrSyncService(h.deps).sync()).toMatchObject({ added: 0, issues: [] })

    expect(h.state().bindings.term_original).toMatchObject({ suppressed: true })
    expect(h.state().bindings.term_original.closed).toBeUndefined()
    expect(h.deps.closeTerminal).not.toHaveBeenCalled()
    expect(h.snapshot.panes).toHaveLength(1)
    expect(h.folders).toEqual([])

    h.folders.push(...lost)
    expect(await new HerdrSyncService(h.deps).sync()).toMatchObject({ connected: 0, issues: [] })
    expect(h.deps.closeTerminal).not.toHaveBeenCalled()
  })

  it('suppresses a missing folder even while its pane is absent from Herdr', async () => {
    const h = harness()
    await h.service.sync()
    const lost = h.folders.splice(0)
    const panes = h.snapshot.panes.splice(0)
    await h.service.sync()
    h.folders.push(...lost)
    h.snapshot.panes.push(...panes)
    expect(await h.service.sync()).toMatchObject({ connected: 0, issues: [] })
    expect(h.state().bindings.term_original).toMatchObject({ suppressed: true })
  })

  it('closes the source when a restored folder of a suppressed binding is deleted', async () => {
    const h = harness()
    await h.service.sync()
    const lost = h.folders.splice(0)
    await h.service.sync()
    h.folders.push(...lost)

    await h.service.closeFolderWorkspace(lost[0].id)
    expect(h.snapshot.panes).toEqual([])
    expect(h.state().bindings.term_original.closed).toBe(true)
    expect(h.state().bindings.term_original.suppressed).toBeUndefined()
  })

  it('imports a folder that survives restart normalization, using the foreground cwd', async () => {
    const h = harness()
    h.snapshot.panes[0].foreground_cwd = '/project/app'
    await h.service.sync()
    const created = h.groups.find((entry) => entry.parentGroupId)
    expect(created?.parentPath).toBe('/project/app')
    expect(normalizeFolderWorkspaces(h.folders, h.groups).map((entry) => entry.id)).toEqual([
      h.folders[0].id
    ])
  })

  it('reports a new pane without a working directory instead of creating an empty group', async () => {
    const h = harness()
    h.snapshot.panes[0].cwd = ''
    expect(await h.service.sync()).toMatchObject({ added: 0, issues: [{ paneId: 'w1:p1' }] })
    expect(h.groups.filter((entry) => entry.parentGroupId)).toEqual([])
    expect(h.folders).toEqual([])
  })

  it('repairs an existing group with no path so its imported folders survive restart', async () => {
    const h = harness({ legacy: true })
    await h.service.sync()
    expect(h.groups.find((entry) => entry.id === 'group')?.parentPath).toBe('/project')
    expect(normalizeFolderWorkspaces(h.folders, h.groups)).toHaveLength(1)
    h.snapshot.panes[0].foreground_cwd = '/project/subdirectory'
    await h.service.sync()
    expect(h.groups.find((entry) => entry.id === 'group')?.parentPath).toBe('/project')
  })

  it('keeps the import intact when closing fails and can retry the deletion', async () => {
    const h = harness()
    await h.service.sync()
    const before = structuredClone(h.state())
    vi.mocked(h.deps.closeTerminal).mockRejectedValueOnce(new Error('Herdr unavailable'))
    await expect(h.service.closeFolderWorkspace(h.folders[0].id)).rejects.toThrow(
      'Herdr unavailable'
    )
    expect(h.state()).toEqual(before)
    expect(h.snapshot.panes).toHaveLength(1)
    await h.service.closeFolderWorkspace(h.folders[0].id)
    expect(h.snapshot.panes).toEqual([])
    expect(h.state().bindings.term_original.closed).toBe(true)
  })

  it('orders a deletion after an in-flight sync so stale saves cannot resurrect its binding', async () => {
    const h = harness()
    await h.service.sync()
    const removed = h.folders[0].id
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.mocked(h.deps.snapshot).mockImplementationOnce(async () => {
      entered()
      await gate
      return h.snapshot
    })
    const syncing = h.service.sync()
    await started
    const closing = h.service.closeFolderWorkspace(removed)
    expect(h.deps.closeTerminal).not.toHaveBeenCalled()
    release()
    await Promise.all([syncing, closing])
    h.folders.length = 0
    expect(h.state().bindings.term_original.closed).toBe(true)
    expect(await h.service.sync()).toMatchObject({ added: 0, issues: [] })
    expect(h.folders).toEqual([])
  })

  it('finishes a retried deletion without Herdr once its close was already confirmed', async () => {
    const h = harness()
    await h.service.sync()
    const removed = h.folders[0].id
    await h.service.closeFolderWorkspace(removed)
    vi.mocked(h.deps.executable).mockRejectedValue(new Error('Herdr was not found'))
    await expect(h.service.closeFolderWorkspace(removed)).resolves.toBeUndefined()
    expect(h.deps.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('does not recreate a folder whose project group is deleted during a sync', async () => {
    const h = harness()
    h.snapshot.panes.push({
      ...h.snapshot.panes[0],
      pane_id: 'w1:p2',
      terminal_id: 'term_sibling'
    })
    await h.service.sync()
    const removed = h.state().bindings.term_sibling.folderId
    vi.mocked(h.deps.transcript).mockImplementationOnce(async () => {
      h.folders.splice(
        h.folders.findIndex((entry) => entry.id === removed),
        1
      )
      return null
    })
    await h.service.sync()
    expect(h.runtime.createFolderWorkspace).toHaveBeenCalledTimes(2)
    expect(h.state().bindings.term_sibling.folderId).toBe(removed)

    await h.service.sync()
    expect(h.state().bindings.term_sibling.suppressed).toBe(true)
    expect(h.snapshot.panes).toHaveLength(2)
    expect(h.deps.closeTerminal).not.toHaveBeenCalled()
    expect(h.runtime.createFolderWorkspace).toHaveBeenCalledTimes(2)
  })

  it('does not treat a temporarily invisible catalog row as a deleted workspace', async () => {
    const h = harness()
    await h.service.sync()
    vi.mocked(h.runtime.listVisibleFolderWorkspaces).mockReturnValue([])
    await h.service.sync()
    expect(h.deps.closeTerminal).not.toHaveBeenCalled()
    expect(h.state().bindings.term_original.closed).toBeUndefined()
    expect(h.folders).toHaveLength(1)
    expect(h.runtime.createFolderWorkspace).toHaveBeenCalledTimes(1)
  })

  it('does not invoke Herdr for an unrelated folder deletion', async () => {
    const h = harness()
    await h.service.closeFolderWorkspace('ordinary-folder')
    expect(h.deps.executable).not.toHaveBeenCalled()
    expect(h.deps.closeTerminal).not.toHaveBeenCalled()
    expect(h.deps.save).not.toHaveBeenCalled()
  })

  it('adopts the existing migration and keeps the terminal while names and sessions change', async () => {
    const h = harness({ legacy: true })
    const before = structuredClone([...h.tabs.values()])
    expect(await h.service.sync()).toMatchObject({ connected: 1, reused: 1, added: 0, issues: [] })
    h.snapshot.tabs[0].label = 'Renamed in Herdr'
    h.snapshot.panes[0].agent_session = { kind: 'id', value: 'new-session' }
    expect(await h.service.sync()).toMatchObject({ connected: 1, reused: 1, added: 0, issues: [] })
    expect(h.runtime.createProjectGroup).not.toHaveBeenCalled()
    expect(h.runtime.createFolderWorkspace).not.toHaveBeenCalled()
    expect(h.runtime.createTerminal).not.toHaveBeenCalled()
    expect(h.runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
    expect(h.folders[0].name).toBe('Renamed in Herdr')
    expect([...h.tabs.values()][0][0].terminal).toBe(before[0][0].terminal)
    expect(h.deps.seedIdentity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        launchedAt: 0,
        resumeProviderSession: {
          key: 'session_id',
          id: 'new-session',
          transcriptPath: '/history/new-session.jsonl'
        }
      })
    )
    expect(h.snapshot.panes[0].agent_status).toBe('working')
  })

  it('coalesces concurrent clicks and repeats without creating duplicate folders or terminals', async () => {
    const h = harness()
    const first = h.service.sync()
    expect(h.service.sync()).toBe(first)
    expect(await first).toMatchObject({ added: 1, connected: 1, reused: 0, issues: [] })
    expect(await h.service.sync()).toMatchObject({ added: 0, connected: 1, reused: 1, issues: [] })
    expect(h.runtime.createFolderWorkspace).toHaveBeenCalledTimes(1)
    expect(h.runtime.createMobileSessionTerminal).toHaveBeenCalledTimes(1)
    expect(h.runtime.createMobileSessionTerminal).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        command: "'/tools/herdr' terminal attach 'term_original' --takeover",
        select: false,
        activate: false,
        resumeProviderSession: {
          key: 'session_id',
          id: 'original-session',
          transcriptPath: '/history/original-session.jsonl'
        }
      })
    )
  })

  it('adds a new Herdr pane while preserving a previously imported history that is now absent', async () => {
    const h = harness({ legacy: true })
    await h.service.sync()
    h.snapshot.panes[0] = { ...h.snapshot.panes[0], pane_id: 'w1:p2', terminal_id: 'term_new' }
    expect(await h.service.sync()).toMatchObject({ added: 1, connected: 1, issues: [] })
    expect(h.folders).toHaveLength(2)
    expect(Object.keys(h.state().bindings).sort()).toEqual(['term_new', 'term_original'])
  })

  it.each(['exited', 'restored without a PTY'])(
    'reconnects a %s process to its existing tab identity',
    async (state) => {
      const h = harness({ legacy: true })
      vi.mocked(h.runtime.readTerminal).mockResolvedValue({
        handle: 'orca-terminal-1',
        status: state === 'exited' ? 'exited' : 'running',
        tail: [],
        nextCursor: null,
        truncated: false
      })
      if (state !== 'exited') {
        vi.mocked(h.runtime.inspectTerminalProcess)
          .mockRejectedValueOnce(new Error('terminal_gone'))
          .mockResolvedValue({ foregroundProcess: 'login', hasChildProcesses: true })
      }
      expect(await h.service.sync()).toMatchObject({
        added: 0,
        connected: 1,
        reused: 0,
        issues: []
      })
      expect(h.runtime.createTerminal).toHaveBeenCalledWith(
        'id:folder:folder',
        expect.objectContaining({
          tabId: 'tab-1',
          leafId: '00000000-0000-4000-8000-000000000001',
          command: "'/tools/herdr' terminal attach 'term_original' --takeover"
        })
      )
      expect(h.runtime.createMobileSessionTerminal).not.toHaveBeenCalled()
    }
  )

  it('does not count a failed attachment as connected on this sync or the next click', async () => {
    const h = harness()
    vi.mocked(h.runtime.inspectTerminalProcess).mockResolvedValue({
      foregroundProcess: 'bash',
      hasChildProcesses: false
    })
    expect(await h.service.sync()).toMatchObject({ connected: 0, issues: [{ paneId: 'w1:p1' }] })
    expect(await h.service.sync()).toMatchObject({ connected: 0, issues: [{ paneId: 'w1:p1' }] })
    expect(h.runtime.createMobileSessionTerminal).toHaveBeenCalledTimes(1)
    expect(h.deps.seedIdentity).not.toHaveBeenCalled()
  })

  it('does not mutate the Orca catalog when Herdr is unavailable', async () => {
    const h = harness()
    vi.mocked(h.deps.snapshot).mockRejectedValue(new Error('Herdr is not running'))
    await expect(h.service.sync()).rejects.toThrow('Herdr is not running')
    expect(h.runtime.createProjectGroup).not.toHaveBeenCalled()
    expect(h.deps.save).not.toHaveBeenCalled()
  })
})
