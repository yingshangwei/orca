import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { AgentProviderSessionMetadata } from '../../shared/agent-session-resume'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import { readTerminalProcessRows } from '../runtime/terminal-foreground-group'

const SYNC_INTERVAL_MS = 15_000
/** Bounded: a quit must never wait on a stalled `ps`. */
export const CLAUDE_PANE_SESSION_QUIT_SYNC_MS = 1_500

/** One live Claude-held pane, as the hook store and the PTY inventory join on its pane key. */
export type ClaudePaneSessionTarget = { paneKey: string; rootPid: number }

export type ClaudeSessionRegistryRecord = { pid: number; sessionId: string; procStart?: string }

export type ClaudePaneSessionSyncDependencies = {
  /** Panes whose hook row Claude holds, with their PTY's root process. */
  listTargets: () => Promise<ClaudePaneSessionTarget[]>
  /** The pid of the Claude process in the pane's foreground, or null when none leads it. */
  foregroundClaudePid: (rootPid: number) => Promise<number | null>
  readRegistry: (pid: number) => Promise<ClaudeSessionRegistryRecord | null>
  /** Whether the registry record still describes that pid, not a recycled one. */
  sameProcess: (record: ClaudeSessionRegistryRecord) => Promise<boolean>
  transcript: (sessionId: string) => Promise<string | null>
  record: (paneKey: string, providerSession: AgentProviderSessionMetadata) => boolean
  onError?: (error: unknown) => void
}

/**
 * Keeps each Claude pane's resume session equal to the session its Claude process runs. The
 * fork turns Orca's Claude hook off, so nothing else tells Orca a session a pane started fresh
 * or `/clear`ed into, and a restart then resumed nothing or an older session.
 */
export class ClaudePaneSessionSync {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private disposed = false

  constructor(private readonly deps: ClaudePaneSessionSyncDependencies) {}

  start(): void {
    if (this.timer || this.disposed) {
      return
    }
    const tick = async (): Promise<void> => {
      await this.syncOnce()
      if (!this.disposed) {
        this.timer = setTimeout(() => void tick(), SYNC_INTERVAL_MS)
        this.timer.unref?.()
      }
    }
    this.timer = setTimeout(() => void tick(), 0)
    this.timer.unref?.()
  }

  dispose(): void {
    this.disposed = true
    clearTimeout(this.timer)
  }

  syncOnce(): Promise<void> {
    this.running ??= this.sync().finally(() => {
      this.running = undefined
    })
    return this.running
  }

  /** A fresh pass before a quit records what each pane resumes; bounded so a quit never hangs on it.
   *  Why fresh: a pass already running may have read a registry from before the last `/clear`. */
  async syncBeforeQuit(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const fresh = (this.running ?? Promise.resolve()).then(() => this.syncOnce())
    await Promise.race([
      fresh,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
        timer.unref?.()
      })
    ])
    clearTimeout(timer)
  }

  private async sync(): Promise<void> {
    try {
      for (const target of await this.deps.listTargets()) {
        if (this.disposed) {
          return
        }
        const pid = await this.deps.foregroundClaudePid(target.rootPid)
        const record = pid === null ? null : await this.deps.readRegistry(pid)
        if (!record || record.pid !== pid || !(await this.deps.sameProcess(record))) {
          continue
        }
        const transcriptPath = await this.deps.transcript(record.sessionId)
        if (this.disposed) {
          return
        }
        // Why only with a transcript: Claude writes it with the session's first message, and
        // `claude --resume` of an id with none fails ("No conversation found") to a bare shell. Until
        // then the pane's earlier conversation is the one a restart can still open, and a fresh
        // session has nothing in it to lose.
        if (transcriptPath) {
          this.deps.record(target.paneKey, {
            key: 'session_id',
            id: record.sessionId,
            transcriptPath
          })
        }
      }
    } catch (error) {
      this.deps.onError?.(error)
    }
  }
}

function claudeConfigDir(): string {
  return resolveAbsoluteDirOverride(process.env.CLAUDE_CONFIG_DIR, join(homedir(), '.claude'))
}

/** Claude's per-process session record, written at start and on every session switch. */
export async function readClaudeSessionRegistry(
  pid: number
): Promise<ClaudeSessionRegistryRecord | null> {
  try {
    const value: unknown = JSON.parse(
      await readFile(join(claudeConfigDir(), 'sessions', `${pid}.json`), 'utf8')
    )
    if (typeof value !== 'object' || value === null) {
      return null
    }
    const recordPid: unknown = Reflect.get(value, 'pid')
    const sessionId: unknown = Reflect.get(value, 'sessionId')
    const procStart: unknown = Reflect.get(value, 'procStart')
    if (typeof recordPid !== 'number' || typeof sessionId !== 'string' || !sessionId.trim()) {
      return null
    }
    return {
      pid: recordPid,
      sessionId: sessionId.trim(),
      ...(typeof procStart === 'string' ? { procStart } : {})
    }
  } catch {
    return null
  }
}

/** Claude writes `procStart` from `ps -o lstart=` in UTC; a recycled pid starts at another time. */
export async function claudeRegistryDescribesProcess(
  record: ClaudeSessionRegistryRecord
): Promise<boolean> {
  if (!record.procStart || process.platform !== 'darwin') {
    return true
  }
  try {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-p', String(record.pid), '-o', 'lstart='],
      env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C', LANG: 'C' },
      timeoutMs: 1_000,
      maxOutputBytes: 4_096
    })
    return result.code === 0 && result.stdout.trim() === record.procStart.trim()
  } catch {
    return false
  }
}

/** The foreground group's interactive Claude: the pane's own agent, never a `claude -p` child. */
export async function readForegroundClaudePid(rootPid: number): Promise<number | null> {
  const rows = await readTerminalProcessRows(rootPid)
  const root = rows?.find((row) => row.pid === rootPid)
  if (!rows || !root?.tpgid || root.tpgid <= 0) {
    return null
  }
  const claude = rows.find(
    (row) =>
      row.pgid === root.tpgid &&
      recognizeAgentProcessFromCommandLine(row.command)?.agent === 'claude'
  )
  return claude?.pid ?? null
}

/** Starts the sync against this host's hook store and local PTY inventory; POSIX hosts only. */
export function startClaudePaneSessionSync(deps: {
  statusRows: () => readonly {
    paneKey: string
    agentType?: string
    connectionId?: string | null
    structuredHost?: unknown
  }[]
  listPtys: () => Promise<readonly { paneKey?: string; rootProcessId?: number }[]>
  transcript: (sessionId: string) => Promise<string | null>
  record: (paneKey: string, providerSession: AgentProviderSessionMetadata) => boolean
}): ClaudePaneSessionSync | null {
  if (process.platform === 'win32') {
    return null
  }
  const sync = new ClaudePaneSessionSync({
    listTargets: async () => {
      const claudePanes = new Set(
        deps
          .statusRows()
          .filter((row) => row.agentType === 'claude' && !row.connectionId && !row.structuredHost)
          .map((row) => row.paneKey)
      )
      if (claudePanes.size === 0) {
        return []
      }
      return (await deps.listPtys()).flatMap((pty) =>
        pty.paneKey && pty.rootProcessId && claudePanes.has(pty.paneKey)
          ? [{ paneKey: pty.paneKey, rootPid: pty.rootProcessId }]
          : []
      )
    },
    foregroundClaudePid: readForegroundClaudePid,
    readRegistry: readClaudeSessionRegistry,
    sameProcess: claudeRegistryDescribesProcess,
    transcript: deps.transcript,
    record: deps.record,
    onError: (error) => console.warn('[claude] Could not refresh pane sessions:', error)
  })
  sync.start()
  return sync
}
