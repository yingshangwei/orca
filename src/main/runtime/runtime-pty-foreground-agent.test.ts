import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

vi.mock('./orca-runtime-core', () => ({ TERMINAL_INTERACTIVE_WAIT_PROBE_TIMEOUT_MS: 1_000 }))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture(
  getForegroundProcess: RuntimePtyController['getForegroundProcess'],
  confirmForegroundProcess?: RuntimePtyController['confirmForegroundProcess']
) {
  const controller: RuntimePtyController = {
    getForegroundProcess,
    confirmForegroundProcess,
    write: () => false,
    kill: () => false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: titleless identity only reads connection and optional agent evidence fields.
  let pty = { connected: true } as RuntimePtyWorktreeRecord
  const touchSnapshot = vi.fn()
  const agent = new RuntimePtyForegroundAgent({
    getController: () => controller,
    getPty: () => pty,
    touchSnapshot,
    finishDelayedSnapshot: vi.fn()
  })
  return {
    agent,
    touchSnapshot,
    getPty: () => pty,
    replacePty: () => {
      pty = { ...pty }
    }
  }
}

describe('titleless foreground identity lifetime', () => {
  it('does not let a retired foreground refresh write into a reused record or delete its successor', async () => {
    const firstRead = deferred<string | null>()
    const secondRead = deferred<string | null>()
    const read = vi
      .fn()
      .mockReturnValueOnce(firstRead.promise)
      .mockReturnValueOnce(secondRead.promise)
    const { agent, getPty, touchSnapshot } = fixture(read)
    const first = agent.refresh('same-pty')
    agent.forget('same-pty')
    const second = agent.refresh('same-pty')
    expect(read).toHaveBeenCalledTimes(2)

    firstRead.resolve('claude')
    await expect(first).resolves.toBe(false)
    expect(getPty().foregroundAgent).toBeUndefined()
    expect(touchSnapshot).not.toHaveBeenCalled()
    expect(agent.getPending('same-pty', 0)).toBe(second)

    secondRead.resolve('codex')
    await expect(second).resolves.toBe(true)
    expect(getPty().foregroundAgent).toBe('codex')
    expect(touchSnapshot).toHaveBeenCalledExactlyOnceWith('same-pty')
  })

  it('does not publish a foreground refresh after its PTY record is replaced', async () => {
    const read = deferred<string | null>()
    const { agent, replacePty, getPty, touchSnapshot } = fixture(() => read.promise)
    const pending = agent.refresh('same-pty')
    replacePty()
    read.resolve('claude')
    await expect(pending).resolves.toBe(false)
    expect(getPty().foregroundAgent).toBeUndefined()
    expect(touchSnapshot).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')(
    'cannot restore a retired generation from a late full scan',
    async () => {
      const oldScan = deferred<string | null>()
      const confirm = vi.fn().mockReturnValueOnce(oldScan.promise).mockResolvedValue('codex')
      const { agent } = fixture(async () => '2.1.310', confirm)

      const old = agent.identifyUnowned('same-pty', () => true)
      await vi.waitFor(() => expect(confirm).toHaveBeenCalledTimes(1))
      agent.forget('same-pty')
      oldScan.resolve('claude')

      await expect(old).resolves.toBeNull()
      await expect(agent.identifyUnowned('same-pty', () => true)).resolves.toBe('codex')
      expect(confirm).toHaveBeenCalledTimes(2)
    }
  )

  it('isolates a new read and pending identity from the old request finalizer', async () => {
    const firstRead = deferred<string | null>()
    const secondRead = deferred<string | null>()
    const read = vi.fn().mockReturnValueOnce(firstRead.promise).mockReturnValue(secondRead.promise)
    const { agent } = fixture(read)

    const first = agent.identifyUnowned('same-pty', () => true)
    agent.forget('same-pty')
    const second = agent.identifyUnowned('same-pty', () => true)
    expect(read).toHaveBeenCalledTimes(2)

    firstRead.resolve('claude')
    await expect(first).resolves.toBeNull()
    const sharedSecond = agent.identifyUnowned('same-pty', () => true)
    expect(read).toHaveBeenCalledTimes(2)

    secondRead.resolve('codex')
    await expect(second).resolves.toBe('codex')
    await expect(sharedSecond).resolves.toBe('codex')
  })

  it('ignores a foreground result after its PTY record was replaced', async () => {
    const read = deferred<string | null>()
    const { agent, replacePty } = fixture(() => read.promise)
    const identity = agent.identifyUnowned('same-pty', () => true)
    replacePty()
    read.resolve('claude')
    await expect(identity).resolves.toBeNull()
  })
})
