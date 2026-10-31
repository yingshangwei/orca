import { setTimeout } from 'node:timers/promises'
import type { HerdrSyncResult } from '../../shared/herdr-types'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import type { RuntimeMobileSessionTerminalClientTab } from '../../shared/runtime-session-contracts'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import { herdrAttachCommand } from './herdr-cli'
import type { HerdrPane, HerdrSnapshot } from './herdr-snapshot'
import type { HerdrSyncState } from './herdr-sync-state'

type SyncRuntime = Pick<
  OrcaRuntimeService,
  | 'listVisibleProjectGroups'
  | 'listVisibleFolderWorkspaces'
  | 'listFolderWorkspaces'
  | 'createProjectGroup'
  | 'updateProjectGroup'
  | 'createFolderWorkspace'
  | 'updateFolderWorkspace'
  | 'listMobileSessionTabs'
  | 'createMobileSessionTerminal'
  | 'createTerminal'
  | 'readTerminal'
  | 'inspectTerminalProcess'
  | 'renameTerminal'
>

export type HerdrSyncDependencies = {
  runtime: SyncRuntime
  executable: () => Promise<string>
  snapshot: (executable: string) => Promise<HerdrSnapshot>
  closeTerminal: (executable: string, terminalId: string) => Promise<void>
  load: () => Promise<HerdrSyncState>
  save: (state: HerdrSyncState) => void
  transcript: (agent: 'claude' | 'codex', sessionId: string) => Promise<string | null>
  seedIdentity: (args: {
    paneKey: string
    launchAgent: string
    resumeProviderSession: AgentProviderSessionMetadata
    worktreeId: string
    launchedAt: number
  }) => void
  pause?: () => Promise<void>
}

export class HerdrSyncService {
  private pending: Promise<HerdrSyncResult> | null = null
  private mutations: Promise<void> = Promise.resolve()

  constructor(private readonly deps: HerdrSyncDependencies) {}

  sync(): Promise<HerdrSyncResult> {
    if (!this.pending) {
      this.pending = this.enqueue(() => this.run()).finally(() => {
        this.pending = null
      })
    }
    return this.pending
  }

  closeFolderWorkspace(folderId: string): Promise<void> {
    return this.enqueue(async () => {
      const state = await this.deps.load()
      const bindings = Object.entries(state.bindings).filter(
        ([, binding]) => binding.folderId === folderId && !binding.closed
      )
      if (bindings.length === 0) {
        return
      }
      const executable = await this.deps.executable()
      for (const [terminalId, binding] of bindings) {
        await this.deps.closeTerminal(executable, terminalId)
        binding.closed = true
        delete binding.suppressed
        this.deps.save(state)
      }
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation)
    this.mutations = result.then(
      () => {},
      () => {}
    )
    return result
  }

  private async run(): Promise<HerdrSyncResult> {
    const executable = await this.deps.executable()
    const snapshot = await this.deps.snapshot(executable)
    const state = await this.deps.load()
    const result: HerdrSyncResult = {
      total: snapshot.panes.length,
      added: 0,
      connected: 0,
      reused: 0,
      issues: []
    }
    const folders = new Set(this.deps.runtime.listFolderWorkspaces().map((folder) => folder.id))
    const visibleFolders = new Set(
      this.deps.runtime.listVisibleFolderWorkspaces().map((folder) => folder.id)
    )
    // Why: a missing folder may be lost data rather than a deletion, so its source stays open.
    const lost = Object.values(state.bindings).filter(
      (binding) => !binding.closed && !binding.suppressed && !folders.has(binding.folderId)
    )
    if (lost.length > 0) {
      for (const binding of lost) {
        binding.suppressed = true
      }
      this.deps.save(state)
    }
    const activePanes: HerdrPane[] = []
    for (const pane of snapshot.panes) {
      const binding = state.bindings[pane.terminal_id]
      if (binding?.closed) {
        try {
          await this.deps.closeTerminal(executable, pane.terminal_id)
        } catch (error) {
          result.issues.push({
            paneId: pane.pane_id,
            message: error instanceof Error ? error.message : String(error)
          })
        }
      } else if (!binding || (!binding.suppressed && visibleFolders.has(binding.folderId))) {
        activePanes.push(pane)
      }
    }
    if (activePanes.length === 0) {
      return result
    }
    const runtime = this.deps.runtime
    const groups = runtime.listVisibleProjectGroups()
    let root =
      groups.find((group) => group.id === state.rootGroupId && !group.connectionId) ??
      groups.find((group) => group.name === 'Herdr' && !group.parentGroupId && !group.connectionId)
    if (!root) {
      root = await runtime.createProjectGroup({ name: 'Herdr', createdFrom: 'manual' })
    }
    state.rootGroupId = root.id
    this.deps.save(state)
    for (const pane of activePanes) {
      try {
        await this.syncPane(executable, snapshot, pane, state, result)
      } catch (error) {
        result.issues.push({
          paneId: pane.pane_id,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return result
  }

  private async syncPane(
    executable: string,
    snapshot: HerdrSnapshot,
    pane: HerdrPane,
    state: HerdrSyncState,
    result: HerdrSyncResult
  ): Promise<void> {
    const runtime = this.deps.runtime
    const sourceWorkspace = snapshot.workspaces.find(
      (workspace) => workspace.workspace_id === pane.workspace_id
    )
    if (!sourceWorkspace) {
      throw new Error('The Herdr workspace is no longer available.')
    }
    const sourceTab = snapshot.tabs.find((tab) => tab.tab_id === pane.tab_id)
    const name =
      (sourceTab?.label || pane.terminal_title_stripped || pane.pane_id) +
      (sourceTab && sourceTab.pane_count > 1 ? ` · ${pane.pane_id}` : '')
    const folders = runtime.listVisibleFolderWorkspaces()
    const groups = runtime.listVisibleProjectGroups()
    let binding = state.bindings[pane.terminal_id]
    let folder = folders.find((entry) => entry.id === binding?.folderId && !entry.connectionId)
    // Why: deleting a project group bypasses the queue; the next sync suppresses this binding.
    if (binding && !folder) {
      return
    }
    if (!folder) {
      folder = folders.find(
        (entry) =>
          !entry.connectionId &&
          groups.some(
            (group) =>
              group.id === entry.projectGroupId && group.parentGroupId === state.rootGroupId
          ) &&
          entry.comment
            ?.split('\n')
            .some(
              (line) =>
                line.startsWith('已连接 Herdr 原终端：') &&
                line.trim().endsWith(`/ ${pane.terminal_id}`)
            )
      )
    }
    const cwd = pane.foreground_cwd || pane.cwd
    if (!folder && !cwd) {
      throw new Error('This Herdr pane has no working directory to import.')
    }
    let group = groups.find(
      (entry) =>
        entry.id === (folder?.projectGroupId ?? state.groups[pane.workspace_id]) &&
        entry.parentGroupId === state.rootGroupId &&
        !entry.connectionId
    )
    if (!group) {
      group = await runtime.createProjectGroup({
        name: sourceWorkspace.label || pane.workspace_id,
        // Why: normalizeFolderWorkspaces drops folders of a group without a path on restart.
        parentPath: cwd,
        parentGroupId: state.rootGroupId,
        createdFrom: 'manual'
      })
    } else if (
      (group.name !== sourceWorkspace.label && sourceWorkspace.label) ||
      (!group.parentPath && cwd)
    ) {
      await runtime.updateProjectGroup(group.id, {
        ...(sourceWorkspace.label ? { name: sourceWorkspace.label } : {}),
        ...(!group.parentPath && cwd ? { parentPath: cwd } : {})
      })
    }
    state.groups[pane.workspace_id] = group.id
    this.deps.save(state)
    if (!folder) {
      folder = await runtime.createFolderWorkspace({
        projectGroupId: group.id,
        name,
        folderPath: cwd
      })
      result.added++
    } else if (folder.name !== name || folder.folderPath !== cwd) {
      await runtime.updateFolderWorkspace(folder.id, { name, folderPath: cwd })
    }
    binding = state.bindings[pane.terminal_id] = { ...binding, folderId: folder.id }
    this.deps.save(state)
    const worktree = `id:folder:${folder.id}`
    const inventory = await runtime.listMobileSessionTabs(worktree)
    let tab = inventory.tabs.find(
      (entry): entry is RuntimeMobileSessionTerminalClientTab =>
        entry.type === 'terminal' && entry.id === binding.tabId
    )
    if (!tab) {
      const candidates = inventory.tabs.filter(
        (entry): entry is RuntimeMobileSessionTerminalClientTab =>
          entry.type === 'terminal' && (entry.customTitle ?? entry.title).endsWith(' · Herdr')
      )
      if (candidates.length === 1) {
        tab = candidates[0]
      }
    }
    const agent: 'claude' | 'codex' | undefined =
      pane.agent === 'claude' || pane.agent === 'codex' ? pane.agent : undefined
    const sessionId =
      agent && pane.agent_session?.kind === 'id' ? pane.agent_session.value : undefined
    const transcriptPath = agent && sessionId ? await this.deps.transcript(agent, sessionId) : null
    const providerSession: AgentProviderSessionMetadata | undefined = sessionId
      ? {
          key: 'session_id',
          id: sessionId,
          ...(transcriptPath ? { transcriptPath } : {})
        }
      : undefined
    const launch = {
      cwd,
      command: herdrAttachCommand(executable, pane.terminal_id),
      startupCommandDelivery: 'shell-ready' as const,
      ...(agent ? { launchAgent: agent } : {}),
      ...(providerSession ? { resumeProviderSession: providerSession } : {})
    }
    let alive = false
    if (tab?.terminal) {
      alive = await runtime.readTerminal(tab.terminal, { limit: 1 }).then(
        (read) => read.status === 'running',
        () => false
      )
      if (alive) {
        const process = await runtime
          .inspectTerminalProcess(tab.terminal, { scanChildProcesses: true })
          .catch((error: unknown) => {
            if (error instanceof Error && error.message === 'terminal_gone') {
              return null
            }
            throw error
          })
        if (!process) {
          alive = false
        } else if (
          process.foregroundProcess !== 'herdr' &&
          !(process.foregroundProcess === 'login' && process.hasChildProcesses)
        ) {
          throw new Error(
            'This Orca terminal is no longer attached to Herdr. Close its Orca tab, then sync again.'
          )
        }
      }
    }
    let reattached = false
    if (tab && !alive) {
      const attached = await runtime.createTerminal(worktree, {
        ...launch,
        tabId: tab.parentTabId,
        leafId: tab.leafId,
        focus: false,
        presentation: 'background'
      })
      reattached = attached.isReattach === true
      const refreshed = await runtime.listMobileSessionTabs(worktree)
      tab = refreshed.tabs.find(
        (entry): entry is RuntimeMobileSessionTerminalClientTab =>
          entry.type === 'terminal' && entry.terminal === attached.handle
      )
    }
    if (!tab) {
      const created = await runtime.createMobileSessionTerminal(worktree, {
        ...launch,
        viewMode: transcriptPath && pane.agent_status !== 'blocked' ? 'chat' : 'terminal',
        activate: false,
        select: false,
        navigation: 'caller',
        clientMutationId: `herdr-sync-${pane.terminal_id}`
      })
      tab = created.tab
    }
    binding.tabId = tab.id
    this.deps.save(state)
    if (!tab.terminal) {
      throw new Error('The terminal connection is still starting. Sync again shortly.')
    }
    if (!alive) {
      let attached = false
      for (let attempt = 0; attempt < 20; attempt++) {
        const process = await runtime.inspectTerminalProcess(tab.terminal, {
          scanChildProcesses: true
        })
        if (
          process.foregroundProcess === 'herdr' ||
          (reattached && process.foregroundProcess === 'login' && process.hasChildProcesses)
        ) {
          attached = true
          break
        }
        await (this.deps.pause?.() ?? setTimeout(250))
      }
      if (!attached) {
        throw new Error('Herdr has not attached yet. Check this terminal for its error message.')
      }
    }
    if (agent && providerSession) {
      this.deps.seedIdentity({
        paneKey: makePaneKey(tab.parentTabId, tab.leafId),
        launchAgent: agent,
        resumeProviderSession: providerSession,
        worktreeId: `folder:${folder.id}`,
        launchedAt: 0
      })
    }
    const title = `${name} · Herdr`
    if ((tab.customTitle ?? tab.title) !== title) {
      await runtime.renameTerminal(tab.terminal, title)
    }
    result.connected++
    if (alive) {
      result.reused++
    }
  }
}
