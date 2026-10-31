import type { AgentHookServer } from '../agent-hooks/server'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { HerdrPane, HerdrSnapshot } from './herdr-snapshot'
import type { HerdrSyncState } from './herdr-sync-state'

type Observation = {
  paneKey: string
  terminal: string
  agent: 'claude' | 'codex'
  providerSession: AgentProviderSessionMetadata
}

export type HerdrStatusBridgeDependencies = {
  runtime: Pick<OrcaRuntimeService, 'listVisibleFolderWorkspaces' | 'listMobileSessionTabs'>
  server: Pick<AgentHookServer, 'ingestTerminalStatus'>
  executable: () => Promise<string>
  snapshot: (executable: string) => Promise<HerdrSnapshot>
  load: () => Promise<HerdrSyncState>
  transcript: (agent: 'claude' | 'codex', sessionId: string) => Promise<string | null>
  onError: (error: unknown) => void
}

export class HerdrStatusBridge {
  private readonly observed = new Map<string, Observation>()
  private pending: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private executable: string | undefined
  private disposed = false
  private failed = false

  constructor(private readonly deps: HerdrStatusBridgeDependencies) {}

  start(): void {
    if (this.timer || this.disposed) {
      return
    }
    const tick = async (): Promise<void> => {
      await this.refresh()
      if (!this.disposed) {
        this.timer = setTimeout(() => void tick(), 1_000)
        this.timer.unref()
      }
    }
    this.timer = setTimeout(() => void tick(), 0)
    this.timer.unref()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
    this.observed.clear()
  }

  refresh(): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (!this.pending) {
      this.pending = this.read()
        .then(() => {
          this.failed = false
        })
        .catch((error: unknown) => {
          this.observed.clear()
          this.executable = undefined
          if (!this.failed && !this.disposed) {
            this.deps.onError(error)
          }
          this.failed = true
        })
        .finally(() => {
          this.pending = null
        })
    }
    return this.pending
  }

  private async read(): Promise<void> {
    const state = await this.deps.load()
    const folders = new Set(
      this.deps.runtime
        .listVisibleFolderWorkspaces()
        .filter((folder) => !folder.connectionId)
        .map((folder) => folder.id)
    )
    const bindings = Object.entries(state.bindings).filter(
      ([, binding]) =>
        !binding.closed && !binding.suppressed && binding.tabId && folders.has(binding.folderId)
    )
    if (bindings.length === 0) {
      this.observed.clear()
      return
    }
    this.executable ??= await this.deps.executable()
    const snapshot = await this.deps.snapshot(this.executable)
    const panes = new Map(snapshot.panes.map((pane) => [pane.terminal_id, pane]))
    const retained = new Set<string>()
    for (const [terminalId, binding] of bindings) {
      if (this.disposed) {
        return
      }
      const pane = panes.get(terminalId)
      if (pane && (await this.observe(pane, binding))) {
        retained.add(terminalId)
      }
    }
    for (const terminalId of this.observed.keys()) {
      if (!retained.has(terminalId)) {
        this.observed.delete(terminalId)
      }
    }
  }

  private async observe(
    pane: HerdrPane,
    binding: HerdrSyncState['bindings'][string]
  ): Promise<boolean> {
    const agent = pane.agent
    const status = pane.agent_status
    if (
      (agent !== 'claude' && agent !== 'codex') ||
      pane.agent_session?.kind !== 'id' ||
      !pane.agent_session.value ||
      (status !== 'working' && status !== 'done' && status !== 'blocked' && status !== 'idle')
    ) {
      return false
    }
    const inventory = await this.deps.runtime.listMobileSessionTabs(`id:folder:${binding.folderId}`)
    const tab = inventory.tabs.find((tab) => tab.id === binding.tabId)
    if (tab?.type !== 'terminal' || !tab.terminal) {
      return false
    }
    const paneKey = makePaneKey(tab.parentTabId, tab.leafId)
    const previous = this.observed.get(pane.terminal_id)
    const sameSession =
      previous?.paneKey === paneKey &&
      previous.terminal === tab.terminal &&
      previous.agent === agent &&
      previous.providerSession.id === pane.agent_session.value
    let providerSession = sameSession ? previous.providerSession : undefined
    if (!providerSession) {
      const transcriptPath = await this.deps.transcript(agent, pane.agent_session.value)
      providerSession = {
        key: 'session_id',
        id: pane.agent_session.value,
        ...(transcriptPath ? { transcriptPath } : {})
      }
    }
    if (this.disposed) {
      return false
    }
    this.deps.server.ingestTerminalStatus({
      paneKey,
      tabId: tab.parentTabId,
      worktreeId: `folder:${binding.folderId}`,
      terminalHandle: tab.terminal,
      origin: 'herdr',
      providerSession,
      ...(!sameSession ? { isReplay: true as const } : {}),
      payload: {
        state: status === 'idle' ? 'done' : status,
        prompt: '',
        agentType: agent,
        ...(status === 'idle' ? { sessionBoundary: true } : {})
      }
    })
    this.observed.set(pane.terminal_id, {
      paneKey,
      terminal: tab.terminal,
      agent,
      providerSession
    })
    return true
  }
}
