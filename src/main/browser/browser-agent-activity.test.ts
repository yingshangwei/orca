import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserAgentActivity } from './browser-agent-activity'
import { runWithActiveRpcCaller } from '../runtime/rpc/rpc-active-caller'

const PAGE = 'page-1'

describe('BrowserAgentActivity', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('tracks CLI work but not desktop, paired-device or unscoped calls', () => {
    const activity = new BrowserAgentActivity()
    for (const caller of [
      undefined,
      { kind: 'desktop' } as const,
      { kind: 'paired-device', deviceId: 'phone' } as const
    ]) {
      runWithActiveRpcCaller(caller, () => activity.beginCommand(PAGE)).end()
      expect(activity.isActive(PAGE)).toBe(false)
    }
    runWithActiveRpcCaller({ kind: 'local-cli' }, () => activity.beginCommand(PAGE)).end()
    expect(activity.isActive(PAGE)).toBe(true)
  })

  it('keeps queued work through the idle window, then clears after the last command settles', async () => {
    const activity = new BrowserAgentActivity()
    const command = () =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () => activity.beginCommand(PAGE))
    const first = command()
    const queued = command()
    await first.run(async () => undefined)
    first.end()
    vi.advanceTimersByTime(25_000)
    expect(activity.isActive(PAGE)).toBe(true)
    queued.end()
    vi.advanceTimersByTime(19_000)
    const next = command()
    next.end()
    vi.advanceTimersByTime(19_999)
    expect(activity.isActive(PAGE)).toBe(true)
    vi.advanceTimersByTime(1)
    expect(activity.isActive(PAGE)).toBe(false)
  })

  it('retiring a page prevents an old lease from expiring a new one', () => {
    const activity = new BrowserAgentActivity()
    const command = () =>
      runWithActiveRpcCaller({ kind: 'local-cli' }, () => activity.beginCommand(PAGE))
    const old = command()
    activity.end(PAGE)
    expect(activity.isActive(PAGE)).toBe(false)
    const current = command()
    old.end()
    vi.advanceTimersByTime(25_000)
    expect(activity.isActive(PAGE)).toBe(true)
    current.end()
    vi.advanceTimersByTime(20_000)
    expect(activity.isActive(PAGE)).toBe(false)
  })
})
