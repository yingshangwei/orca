import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import type { OrcaRuntimeService } from './orca-runtime'
import type { LaunchedAgentForeground } from './launched-agent-foreground'

/** A shell back at its prompt turns bracketed paste on, and Orca's shell integration marks it. */
const SHELL_RETURN_MARKERS = ['\x1b[?2004', '\x1b]133;'] as const
const MARKER_CARRY_CHARS = Math.max(...SHELL_RETURN_MARKERS.map((marker) => marker.length)) - 1

export type LaunchedAgentWriteGuardRuntime = Pick<
  OrcaRuntimeService,
  'readLaunchedAgentForeground' | 'subscribeToTerminalData'
> &
  Partial<Pick<OrcaRuntimeService, 'launchedAgentHostProvesAgent'>>

export type LaunchedAgentWriteGuard = {
  beforeWrite: (ptyId: string) => Promise<void>
  dispose: () => void
}

/**
 * The check before each write of a launch prompt: the paste, its Enter, and Codex's second Enter.
 * A write needs a fresh read that finds the agent in front; a shell, or a host that cannot tell,
 * refuses it, since a ready signal alone can come from a shell back at its prompt. Once a read finds
 * the agent, later writes reuse it until the terminal shows a shell coming back to its prompt, so
 * Enter follows the paste on the desktop's timing instead of waiting out another process read.
 */
export function createLaunchedAgentWriteGuard(
  runtime: LaunchedAgentWriteGuardRuntime,
  agent: TuiAgent,
  /** `write-unless-shell`: on a host that cannot find the agent in front (Windows), only a shell
   *  proven in front refuses, so a caller that wrote there before keeps doing so. */
  { unprovableHost = 'refuse' }: { unprovableHost?: 'refuse' | 'write-unless-shell' } = {}
): LaunchedAgentWriteGuard {
  let disposed = false
  let current: {
    ptyId: string
    proven: boolean
    shellMayHaveReturned: boolean
    unsubscribe: () => void
  } | null = null
  const clearWatch = (): void => {
    const previous = current
    current = null
    previous?.unsubscribe()
  }
  const dispose = (): void => {
    disposed = true
    clearWatch()
  }
  const beforeWrite = async (ptyId: string): Promise<void> => {
    if (disposed) {
      throw new Error('request_aborted')
    }
    if (current?.ptyId === ptyId && current.proven && !current.shellMayHaveReturned) {
      return
    }
    clearWatch()
    let carry = ''
    const watch = { ptyId, proven: false, shellMayHaveReturned: false, unsubscribe: (): void => {} }
    current = watch
    // Subscribe before probing so shell return during the read cannot be missed.
    watch.unsubscribe = runtime.subscribeToTerminalData(ptyId, (data) => {
      const window = carry + data
      carry = window.slice(-MARKER_CARRY_CHARS)
      if (SHELL_RETURN_MARKERS.some((marker) => window.includes(marker))) {
        watch.shellMayHaveReturned = true
      }
    })
    try {
      const foreground: LaunchedAgentForeground = await runtime.readLaunchedAgentForeground(
        ptyId,
        agent
      )
      if (disposed || current !== watch) {
        throw new Error('request_aborted')
      }
      if (foreground === 'agent') {
        watch.proven = true
        return
      }
      clearWatch()
      if (
        foreground === 'shell' ||
        unprovableHost === 'refuse' ||
        runtime.launchedAgentHostProvesAgent?.(ptyId) !== false
      ) {
        throw new Error('agent_not_in_foreground')
      }
    } catch (error) {
      if (current === watch) {
        clearWatch()
      }
      throw error
    }
  }
  return { beforeWrite, dispose }
}

/**
 * The check before a worker start writes its brief into the agent it just launched, as a launch
 * prompt's write is checked; null for a terminal the caller supplied, which no launch put an agent in.
 */
export function createWorkerBriefWriteGuard(
  runtime: LaunchedAgentWriteGuardRuntime,
  agent: string | null | undefined,
  freshLaunch: boolean
): LaunchedAgentWriteGuard | null {
  return freshLaunch && isTuiAgent(agent)
    ? createLaunchedAgentWriteGuard(runtime, agent, { unprovableHost: 'write-unless-shell' })
    : null
}
