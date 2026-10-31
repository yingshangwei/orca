import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS,
  LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS,
  startFirstWindowStartupServices
} from './first-window-startup-services'

describe('startFirstWindowStartupServices', () => {
  it('starts daemon and hook services concurrently before awaiting either', async () => {
    const events: string[] = []
    let resolveDaemon!: () => void
    let resolveHooks!: () => void

    const started = startFirstWindowStartupServices({
      startDaemonPtyProvider: () =>
        new Promise<void>((resolve) => {
          events.push('daemon-started')
          resolveDaemon = resolve
        }),
      startAgentHookServer: () =>
        new Promise<void>((resolve) => {
          events.push('hooks-started')
          resolveHooks = resolve
        }),
      onDaemonError: vi.fn(),
      onAgentHookServerError: vi.fn()
    })

    await Promise.resolve()
    expect(events).toEqual(['daemon-started', 'hooks-started'])

    let completed = false
    started.firstWindowReady.then(() => {
      completed = true
    })

    resolveDaemon()
    await Promise.resolve()
    expect(completed).toBe(false)

    resolveHooks()
    await started.firstWindowReady
    await started.localPtyReady
    await started.localPtyProviderReady
    expect(completed).toBe(true)
  })

  it('opens the provider gate when daemon startup finishes without waiting for hooks', async () => {
    let resolveDaemon!: () => void
    let resolveHooks!: () => void
    const started = startFirstWindowStartupServices({
      startDaemonPtyProvider: () =>
        new Promise<void>((resolve) => {
          resolveDaemon = resolve
        }),
      startAgentHookServer: () =>
        new Promise<void>((resolve) => {
          resolveHooks = resolve
        }),
      onDaemonError: vi.fn(),
      onAgentHookServerError: vi.fn()
    })
    await Promise.resolve()

    let allServicesReady = false
    void started.localPtyReady.then(() => {
      allServicesReady = true
    })
    resolveDaemon()
    await expect(started.localPtyProviderReady).resolves.toBeUndefined()
    expect(allServicesReady).toBe(false)

    resolveHooks()
    await started.localPtyReady
  })

  it('logs each service failure and still resolves the startup barrier', async () => {
    const onDaemonError = vi.fn()
    const onAgentHookServerError = vi.fn()

    const started = startFirstWindowStartupServices({
      startDaemonPtyProvider: () => Promise.reject(new Error('daemon failed')),
      startAgentHookServer: () => Promise.reject(new Error('hooks failed')),
      onDaemonError,
      onAgentHookServerError
    })

    await expect(started.firstWindowReady).resolves.toBeUndefined()
    await expect(started.localPtyReady).resolves.toBeUndefined()
    await expect(started.localPtyProviderReady).resolves.toBeUndefined()

    expect(onDaemonError).toHaveBeenCalledWith(expect.any(Error))
    expect(onAgentHookServerError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('logs synchronous service startup failures and still resolves the startup barrier', async () => {
    const onDaemonError = vi.fn()
    const onAgentHookServerError = vi.fn()

    const started = startFirstWindowStartupServices({
      startDaemonPtyProvider: () => {
        throw new Error('daemon sync failed')
      },
      startAgentHookServer: () => {
        throw new Error('hooks sync failed')
      },
      onDaemonError,
      onAgentHookServerError
    })

    await expect(started.firstWindowReady).resolves.toBeUndefined()
    await expect(started.localPtyReady).resolves.toBeUndefined()
    await expect(started.localPtyProviderReady).resolves.toBeUndefined()

    expect(onDaemonError).toHaveBeenCalledWith(expect.any(Error))
    expect(onAgentHookServerError).toHaveBeenCalledWith(expect.any(Error))
  })

  it('opens the first window at the window timeout without aborting a slow daemon or opening the PTY gate', async () => {
    vi.useFakeTimers()
    const onDaemonError = vi.fn()
    let daemonSignal: AbortSignal | undefined
    let resolveDaemon!: () => void

    try {
      const started = startFirstWindowStartupServices({
        startDaemonPtyProvider: (signal) => {
          daemonSignal = signal
          return new Promise<void>((resolve) => {
            resolveDaemon = resolve
          })
        },
        startAgentHookServer: () => Promise.resolve(),
        onDaemonError,
        onAgentHookServerError: vi.fn()
      })

      let ptyGateOpened = false
      void started.localPtyReady.then(() => {
        ptyGateOpened = true
      })

      await vi.advanceTimersByTimeAsync(FIRST_WINDOW_STARTUP_SERVICE_TIMEOUT_MS)
      await expect(started.firstWindowReady).resolves.toBeUndefined()

      // Why: opening the PTY gate before the daemon attempt finishes would
      // spawn non-restorable LocalPtyProvider fallback terminals (#5232).
      expect(ptyGateOpened).toBe(false)
      expect(daemonSignal?.aborted).toBe(false)
      expect(onDaemonError).not.toHaveBeenCalled()

      resolveDaemon()
      await expect(started.localPtyReady).resolves.toBeUndefined()
      await expect(started.localPtyProviderReady).resolves.toBeUndefined()
      expect(daemonSignal?.aborted).toBe(false)
      expect(onDaemonError).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails open the local PTY gate at the hard cap while aborting hung services', async () => {
    vi.useFakeTimers()
    const onDaemonError = vi.fn()
    const onAgentHookServerError = vi.fn()
    let daemonSignal: AbortSignal | undefined

    try {
      const started = startFirstWindowStartupServices({
        startDaemonPtyProvider: (signal) => {
          daemonSignal = signal
          return new Promise<void>(() => {})
        },
        startAgentHookServer: () => Promise.resolve(),
        onDaemonError,
        onAgentHookServerError
      })

      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS)
      await expect(started.firstWindowReady).resolves.toBeUndefined()
      await expect(started.localPtyReady).resolves.toBeUndefined()
      await expect(started.localPtyProviderReady).resolves.toBeUndefined()

      expect(onDaemonError).toHaveBeenCalledWith(expect.any(Error))
      expect(onAgentHookServerError).not.toHaveBeenCalled()
      expect(daemonSignal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why not vi.useFakeTimers: advancing fires a periodic timer once per interval the stall
  // swallowed, and setSystemTime shifts every deadline with the clock, so a stall either
  // looks like ordinary running time or never makes anything overdue. Neither is what the
  // turn that unblocks does.
  describe('across a synchronous main-thread stall', () => {
    const STALL_MS = 3 * 60_000
    let clock: ReturnType<typeof installTimerPhaseClock>

    beforeEach(() => {
      clock = installTimerPhaseClock()
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    })

    function startWithPendingDaemon() {
      const onDaemonError = vi.fn()
      let daemonSignal: AbortSignal | undefined
      let resolveDaemon!: () => void
      const started = startFirstWindowStartupServices({
        startDaemonPtyProvider: (signal) => {
          daemonSignal = signal
          return new Promise<void>((resolve) => {
            resolveDaemon = resolve
          })
        },
        startAgentHookServer: () => Promise.resolve(),
        onDaemonError,
        onAgentHookServerError: vi.fn()
      })
      let ptyGateOpened = false
      void started.localPtyReady.then(() => {
        ptyGateOpened = true
      })
      return {
        started,
        onDaemonError,
        daemonAborted: () => daemonSignal?.aborted,
        ptyGateOpened: () => ptyGateOpened,
        resolveDaemon: () => resolveDaemon()
      }
    }

    it('lets the daemon handshake queued behind the stall win over the overdue timers', async () => {
      const daemon = startWithPendingDaemon()
      await clock.settle()

      // A stall in the very first turn, then one in a later turn after the clocks have run.
      await clock.stall(STALL_MS)
      await clock.run(5_000)
      await clock.stall(STALL_MS)
      expect(daemon.daemonAborted()).toBe(false)
      expect(daemon.onDaemonError).not.toHaveBeenCalled()
      expect(daemon.ptyGateOpened()).toBe(false)

      // The I/O phase of the turn that unblocked: the daemon's hello arrives.
      daemon.resolveDaemon()
      await daemon.started.localPtyReady
      await daemon.started.localPtyProviderReady
      expect(daemon.daemonAborted()).toBe(false)
      expect(daemon.onDaemonError).not.toHaveBeenCalled()
      expect(clock.pendingTimers()).toBe(0)
    })

    it('still fails open once the loop has really run for the whole budget', async () => {
      const daemon = startWithPendingDaemon()
      await clock.settle()

      await clock.stall(STALL_MS)
      await clock.run(LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS - 5_000)
      expect(daemon.daemonAborted()).toBe(false)
      await clock.run(10_000)
      expect(daemon.ptyGateOpened()).toBe(true)
      expect(daemon.daemonAborted()).toBe(true)
      expect(daemon.onDaemonError).toHaveBeenCalledWith(expect.any(Error))
    })
  })
})

/**
 * Stands in for Node's timer phase. `run(ms)` lets time pass with the loop turning, firing
 * each timer at its deadline. `stall(ms)` lets it pass with the thread blocked, then fires
 * every overdue timer once in deadline order — which is what libuv does in the turn that
 * unblocks, ahead of that turn's I/O callbacks. A timer armed during that pass is due
 * relative to the post-stall time, so it waits for a later turn.
 */
function installTimerPhaseClock() {
  let now = 1_000_000
  let nextId = 0
  const timers = new Map<number, { due: number; callback: () => void }>()
  const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  vi.stubGlobal('setTimeout', (callback: () => void, delay = 0) => {
    nextId += 1
    timers.set(nextId, { due: now + Math.max(1, delay), callback })
    return nextId
  })
  vi.stubGlobal('clearTimeout', (id: number) => {
    timers.delete(id)
  })

  async function runTimerPhase(): Promise<void> {
    const overdue = [...timers.entries()]
      .filter(([, timer]) => timer.due <= now)
      .sort(([idA, a], [idB, b]) => a.due - b.due || idA - idB)
    for (const [id, timer] of overdue) {
      // An earlier callback in this pass may have cleared it.
      if (timers.get(id) !== timer) {
        continue
      }
      timers.delete(id)
      timer.callback()
      // Node drains microtasks after each timer callback.
      await settle()
    }
  }

  return {
    settle,
    pendingTimers: () => timers.size,
    async stall(ms: number): Promise<void> {
      now += ms
      await runTimerPhase()
    },
    async run(ms: number): Promise<void> {
      const end = now + ms
      for (;;) {
        const next = Math.min(...[...timers.values()].map((timer) => timer.due))
        if (next > end) {
          break
        }
        now = next
        await runTimerPhase()
      }
      now = end
    }
  }
}
