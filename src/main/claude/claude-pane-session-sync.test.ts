import { describe, expect, it, vi } from 'vitest'
import {
  ClaudePaneSessionSync,
  type ClaudePaneSessionSyncDependencies
} from './claude-pane-session-sync'

function deps(
  overrides: Partial<ClaudePaneSessionSyncDependencies> = {}
): ClaudePaneSessionSyncDependencies & { record: ReturnType<typeof vi.fn> } {
  const record = vi.fn(() => true)
  return {
    listTargets: vi.fn(async () => [{ paneKey: 'tab:leaf', rootPid: 100 }]),
    foregroundClaudePid: vi.fn(async () => 200),
    readRegistry: vi.fn(async (pid: number) => ({ pid, sessionId: 'session-after-clear' })),
    sameProcess: vi.fn(async () => true),
    transcript: vi.fn(async (id: string) => `/projects/cwd/${id}.jsonl`),
    ...overrides,
    record
  }
}

describe('ClaudePaneSessionSync', () => {
  it("records the session the pane's Claude process registered", async () => {
    const d = deps()
    await new ClaudePaneSessionSync(d).syncOnce()
    expect(d.record).toHaveBeenCalledWith('tab:leaf', {
      key: 'session_id',
      id: 'session-after-clear',
      transcriptPath: '/projects/cwd/session-after-clear.jsonl'
    })
  })

  it('records nothing when no Claude leads the pane foreground', async () => {
    const d = deps({ foregroundClaudePid: vi.fn(async () => null) })
    await new ClaudePaneSessionSync(d).syncOnce()
    expect(d.record).not.toHaveBeenCalled()
  })

  it('ignores a registry record a recycled pid left behind', async () => {
    const d = deps({ sameProcess: vi.fn(async () => false) })
    await new ClaudePaneSessionSync(d).syncOnce()
    expect(d.record).not.toHaveBeenCalled()
  })

  it('waits for the transcript before naming a session to resume', async () => {
    const d = deps({ transcript: vi.fn(async () => null) })
    await new ClaudePaneSessionSync(d).syncOnce()
    expect(d.record).not.toHaveBeenCalled()
  })

  it('keeps going after one pane fails to read', async () => {
    const d = deps({
      listTargets: vi.fn(async () => [
        { paneKey: 'tab:a', rootPid: 1 },
        { paneKey: 'tab:b', rootPid: 2 }
      ]),
      readRegistry: vi.fn(async (pid: number) =>
        pid === 202 ? { pid, sessionId: 'b-session' } : null
      ),
      foregroundClaudePid: vi.fn(async (root: number) => root + 200)
    })
    await new ClaudePaneSessionSync(d).syncOnce()
    expect(d.record).toHaveBeenCalledTimes(1)
    expect(d.record).toHaveBeenCalledWith('tab:b', expect.objectContaining({ id: 'b-session' }))
  })
})

describe('ClaudePaneSessionSync before a quit', () => {
  it('records a session switched since the last pass', async () => {
    let current = 'before-clear'
    const d = deps({
      readRegistry: vi.fn(async (pid: number) => ({ pid, sessionId: current }))
    })
    const sync = new ClaudePaneSessionSync(d)
    await sync.syncOnce()
    current = 'after-clear'
    await sync.syncBeforeQuit(1_000)
    expect(d.record).toHaveBeenLastCalledWith(
      'tab:leaf',
      expect.objectContaining({ id: 'after-clear' })
    )
  })

  it('runs a fresh pass after one that read the registry before a /clear', async () => {
    let current = 'before-clear'
    let releaseTranscript: () => void = () => {}
    let firstTranscript = true
    const d = deps({
      readRegistry: vi.fn(async (pid: number) => ({ pid, sessionId: current })),
      transcript: vi.fn(async (id: string) => {
        if (firstTranscript) {
          firstTranscript = false
          await new Promise<void>((resolve) => {
            releaseTranscript = resolve
          })
        }
        return `/projects/cwd/${id}.jsonl`
      })
    })
    const sync = new ClaudePaneSessionSync(d)
    const inFlight = sync.syncOnce()
    await vi.waitFor(() => expect(d.readRegistry).toHaveBeenCalledTimes(1))
    current = 'after-clear'
    const quit = sync.syncBeforeQuit(5_000)
    releaseTranscript()
    await inFlight
    await quit
    expect(d.record).toHaveBeenLastCalledWith(
      'tab:leaf',
      expect.objectContaining({ id: 'after-clear' })
    )
  })

  it('never holds a quit past its bound', async () => {
    vi.useFakeTimers()
    try {
      const d = deps({ listTargets: vi.fn(() => new Promise<never>(() => {})) })
      const quit = new ClaudePaneSessionSync(d).syncBeforeQuit(1_500)
      await vi.advanceTimersByTimeAsync(1_500)
      await expect(quit).resolves.toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
