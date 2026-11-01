import { useAppStore } from '@/store'
import { terminalShowsReplayedHistory } from '../replayed-history-terminals'
import { isWebTerminalSurfaceTabId } from '../../../../../shared/terminal-surface-id'
import { shouldRetainDisposedPaneSpawn } from './disposed-spawn-retention'
import { findColdRestoreResumeSource } from './cold-restore-resume-startup'
import { mainStartsPane } from './main-starts-pane'
import type { IpcPtyTransportOptions } from '../pty-transport-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** A split waiting on its inherited cwd, or remounted with handed-off keys; it holds keys as before. */
export function isDeferredSplitInputHold(session: ConnectPanePtySession): boolean {
  return Boolean(session.deps.cwdPromise || session.deps.preconnectInput?.length)
}

/**
 * Deferred splits and plain shells hold keys typed before their PTY binds (a first spawn can wait
 * seconds on the host).
 * Why not panes with startup work: held keys would flush ahead of the startup command or an agent
 * resume (sleeping record or live status entry), so a typed prompt would run as a shell command or
 * corrupt the launch line. A pane main starts is excluded too: main picks its launch, unseen here.
 */
function holdsInputUntilConnect(session: ConnectPanePtySession): boolean {
  if (isDeferredSplitInputHold(session)) {
    return true
  }
  const state = useAppStore.getState()
  return (
    !session.paneStartup &&
    !session.getSleepingRecordForPane(state) &&
    !findColdRestoreResumeSource(session, state) &&
    !mainStartsPane(session)
  )
}

/** New typing must not be promoted to a shell when this pane already shows an older session. */
function paneMayShowOldTerminal(session: ConnectPanePtySession, atBind: boolean): boolean {
  if (
    isWebTerminalSurfaceTabId(session.deps.tabId) ||
    terminalShowsReplayedHistory(session.pane.terminal)
  ) {
    return true
  }
  if (atBind) {
    return false
  }
  const state = useAppStore.getState()
  return Boolean(
    session.restoredPtyIdForTransport ||
    state.terminalLayoutsByTabId[session.deps.tabId]?.ptyIdsByLeafId?.[session.pane.leafId] ||
    terminalShowsOutput(session.pane.terminal)
  )
}

function terminalShowsOutput(terminal: ConnectPanePtySession['pane']['terminal']): boolean {
  const buffer = terminal.buffer?.active
  if (!buffer) {
    return false
  }
  if (buffer.baseY > 0) {
    return true
  }
  for (let row = 0; row < buffer.length; row += 1) {
    if (buffer.getLine(row)?.translateToString(true)) {
      return true
    }
  }
  return false
}

function keepsNewTerminalTypeAhead(session: ConnectPanePtySession, atBind: boolean): boolean {
  const state = useAppStore.getState()
  return (
    !session.paneStartup &&
    !session.getSleepingRecordForPane(state) &&
    !findColdRestoreResumeSource(session, state) &&
    !paneMayShowOldTerminal(session, atBind)
  )
}

/** The spawn/attach options a pane hands its PTY transport. */
export function buildPaneTransportOptions(session: ConnectPanePtySession): IpcPtyTransportOptions {
  const holdsInput = holdsInputUntilConnect(session)
  return {
    terminalKittyKeyboardProtocol:
      session.pane.terminal.options.vtExtensions?.kittyKeyboard === true,
    cwd: session.deps.cwd,
    ...(holdsInput
      ? {
          bufferInputUntilConnect: true,
          // Why: a resume source can land between mount and bind; keys must not flush ahead of it.
          releasePreconnectInput: () => holdsInputUntilConnect(session)
        }
      : {}),
    ...(holdsInput
      ? {
          keepTypeAheadForNewTerminal: (phase: 'connect' | 'bind') =>
            keepsNewTerminalTypeAhead(session, phase === 'bind')
        }
      : {}),
    ...(session.deps.preconnectInput?.length
      ? { preconnectInput: session.deps.preconnectInput }
      : {}),
    ...(session.deps.onPreconnectInput
      ? { onPreconnectInput: session.deps.onPreconnectInput }
      : {}),
    env: session.paneEnv,
    ...(session.paneStartup?.envToDelete ? { envToDelete: session.paneStartup.envToDelete } : {}),
    command: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.paneStartup?.command,
    startupCommandDelivery: session.shouldDeliverStartupViaTerminalPaste
      ? undefined
      : session.paneStartup?.startupCommandDelivery,
    executionHostId: session.executionHostId,
    worktreeId: session.deps.worktreeId,
    // Why: closes the SIGKILL race documented in INVESTIGATION.md by letting
    // main sync-flush the (worktreeId, tabId, leafId → ptyId) binding before
    // pty:spawn returns.
    tabId: session.deps.tabId,
    leafId: session.pane.leafId,
    ...(session.deps.placement ? { placement: session.deps.placement } : {}),
    activate: session.deps.isActiveRef.current && session.deps.isVisibleRef.current,
    ...(session.shellOverride ? { shellOverride: session.shellOverride } : {}),
    ...(session.projectRuntime ? { projectRuntime: session.projectRuntime } : {}),
    ...(session.terminalColorQueryReplies
      ? { terminalColorQueryReplies: session.terminalColorQueryReplies }
      : {}),
    ...(session.paneStartup?.launchConfig
      ? { launchConfig: session.paneStartup.launchConfig }
      : {}),
    ...(session.paneStartup?.resumeProviderSession
      ? { resumeProviderSession: session.paneStartup.resumeProviderSession }
      : {}),
    ...((session.paneStartup?.initialAgentStatus?.prompt ?? session.paneStartup?.draftPrompt)
      ? {
          agentPrompt:
            session.paneStartup?.initialAgentStatus?.prompt ?? session.paneStartup?.draftPrompt
        }
      : {}),
    ...(session.paneStartup?.initialAgentStatus?.prompt
      ? { agentPromptDelivery: 'auto-submit' as const }
      : session.paneStartup?.draftPrompt
        ? { agentPromptDelivery: 'draft' as const }
        : {}),
    ...(session.paneStartup?.agentArgsOverride !== undefined
      ? { agentArgsOverride: session.paneStartup.agentArgsOverride }
      : {}),
    ...(session.agentLaunchPreferences
      ? { agentLaunchPreferences: session.agentLaunchPreferences }
      : {}),
    ...(session.launchToken ? { launchToken: session.launchToken } : {}),
    ...(session.paneStartup?.launchAgent ? { launchAgent: session.paneStartup.launchAgent } : {}),
    ...(session.paneStartup?.agentLaunch ? { agentLaunch: session.paneStartup.agentLaunch } : {}),
    ...(session.paneStartup?.telemetry ? { telemetry: session.paneStartup.telemetry } : {}),
    onPtyExit: session.onExit,
    onPtySpawn: session.onPtySpawn,
    onPtyRebind: session.onPtyRebind,
    retainDisposedSpawn: () =>
      shouldRetainDisposedPaneSpawn(
        useAppStore.getState(),
        session.deps.worktreeId,
        session.deps.tabId,
        session.pane.leafId,
        session.executionHostId
      ),
    ...(session.mainSideEffectAuthority
      ? {}
      : {
          onTitleChange: session.onTitleChange,
          onBell: session.onBell,
          onAgentBecameIdle: session.onAgentBecameIdle,
          onAgentBecameWorking: session.onAgentBecameWorking,
          onAgentExited: session.onAgentExited
        }),
    // Why: local IPC terminals are now model-owned in main: OrcaRuntimeService
    // parses OSC 9999 before renderer delivery and forwards through the hook
    // server with local/SSH identity. Remote-runtime streams do not pass through
    // local main, so the renderer remains their status owner for now.
    ...(session.shouldOwnAgentStatusInRenderer
      ? { onAgentStatus: session.handleRendererOwnedAgentStatus }
      : {})
  }
}
