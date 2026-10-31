import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOBILE_LINK_PROBE_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-link-probe-contract'
import { pageTerminalOutputMeter } from '../terminal/terminal-page-output-meter'
import { LINK_PROBE_INTERVAL_MS } from './mobile-link-sampler'
import { useMobileLinkMonitor, type MobileLinkMonitor } from './use-mobile-link-monitor'
import type { RpcResponse } from '../transport/types'

const appState = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
  currentState: 'active'
}))

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listeners.add(listener)
      return { remove: () => appState.listeners.delete(listener) }
    }
  }
}))

const focus = vi.hoisted(() => {
  const state: { leave: (() => void) | null } = { leave: null }
  return state
})

vi.mock('expo-router', async () => {
  const { useEffect } = await import('react')
  return {
    useFocusEffect: (effect: () => () => void) => {
      useEffect(() => {
        focus.leave = effect()
      }, [effect])
    }
  }
})

const REPLY: RpcResponse = {
  id: 'probe',
  ok: true,
  result: {
    outbound: { queuedBytes: 0, queuedFrames: 0, socketBufferedBytes: 0 },
    eventLoop: null
  },
  _meta: { runtimeId: 'runtime-1' }
}

function fakeClient() {
  const sendRequest = vi.fn(
    async (_method: string, _params?: unknown, _options?: unknown): Promise<RpcResponse> => REPLY
  )
  return { sendRequest }
}

type Props = Parameters<typeof useMobileLinkMonitor>[0]

const CONNECTED: Omit<Props, 'client'> = {
  hostId: 'host-1',
  connState: 'connected',
  hostCapabilities: [MOBILE_LINK_PROBE_RUNTIME_CAPABILITY],
  activeHandle: 'terminal-1'
}

describe('the session link monitor', () => {
  let renderer: ReactTestRenderer | null = null
  let monitor: MobileLinkMonitor | null = null

  function Probe(props: Props): null {
    monitor = useMobileLinkMonitor(props)
    return null
  }

  async function mount(props: Props): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Probe, props))
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  async function update(props: Props): Promise<void> {
    await act(async () => {
      renderer?.update(createElement(Probe, props))
      await vi.advanceTimersByTimeAsync(0)
    })
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    appState.currentState = 'active'
    appState.listeners.clear()
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    monitor = null
    vi.useRealTimers()
  })

  it('sends the probe method alone, so nothing reaches a terminal or an agent', async () => {
    const client = fakeClient()
    await mount({ ...CONNECTED, client })
    await advance(LINK_PROBE_INTERVAL_MS * 2)

    const methods = client.sendRequest.mock.calls.map(([method]) => method)
    expect(new Set(methods)).toEqual(new Set(['mobile.linkProbe']))
    expect(monitor?.getSnapshot().phase).toBe('live')
  })

  it('sends nothing to a desktop that does not advertise the capability', async () => {
    const client = fakeClient()
    await mount({ ...CONNECTED, client, hostCapabilities: ['mobile.tasks.v1'] })
    await advance(LINK_PROBE_INTERVAL_MS * 3)

    expect(client.sendRequest).not.toHaveBeenCalled()
    expect(monitor?.getSnapshot().phase).toBe('unsupported')
  })

  it('stops while the app is in the background and starts clean when it returns', async () => {
    const client = fakeClient()
    await mount({ ...CONNECTED, client })
    expect(monitor?.getSnapshot().phase).toBe('live')

    act(() => appState.listeners.forEach((listener) => listener('background')))
    const sent = client.sendRequest.mock.calls.length
    await advance(LINK_PROBE_INTERVAL_MS * 3)
    expect(client.sendRequest).toHaveBeenCalledTimes(sent)
    expect(monitor?.getSnapshot().phase).toBe('off')

    await act(async () => {
      appState.listeners.forEach((listener) => listener('active'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(client.sendRequest).toHaveBeenCalledTimes(sent + 1)
    expect(monitor?.getSnapshot().rttSamples).toBe(1)
  })

  it('stops while another screen covers the session', async () => {
    const client = fakeClient()
    await mount({ ...CONNECTED, client })

    act(() => focus.leave?.())

    expect(monitor?.getSnapshot().phase).toBe('off')
  })

  it('stops with no terminal on screen', async () => {
    const client = fakeClient()
    await mount({ ...CONNECTED, client, activeHandle: null })
    expect(client.sendRequest).not.toHaveBeenCalled()
  })

  it('stops the frame loop when the session goes away, activity or not', async () => {
    const requestFrame = vi.fn(() => 1)
    const cancelFrame = vi.fn()
    vi.stubGlobal('requestAnimationFrame', requestFrame)
    vi.stubGlobal('cancelAnimationFrame', cancelFrame)
    const terminal = pageTerminalOutputMeter.attachDocument()
    try {
      await mount({ ...CONNECTED, client: fakeClient() })
      terminal.activity()
      expect(requestFrame).toHaveBeenCalledOnce()

      act(() => renderer?.unmount())
      renderer = null

      expect(cancelFrame).toHaveBeenCalledWith(1)
      terminal.activity()
      expect(requestFrame).toHaveBeenCalledOnce()
    } finally {
      terminal.detach()
      vi.unstubAllGlobals()
    }
  })

  it('does not carry a reading across a reconnect', async () => {
    const client = fakeClient()
    await mount({ ...CONNECTED, client })
    expect(monitor?.getSnapshot().rttSamples).toBe(1)

    await update({ ...CONNECTED, client, connState: 'reconnecting' })
    expect(monitor?.getSnapshot()).toMatchObject({ phase: 'off', host: null, rttSamples: 0 })

    client.sendRequest.mockImplementation(() => new Promise(() => {}))
    await update({ ...CONNECTED, client })
    expect(monitor?.getSnapshot()).toMatchObject({ phase: 'measuring', host: null, rttSamples: 0 })
  })

  it('does not carry a reading to another host', async () => {
    const first = fakeClient()
    await mount({ ...CONNECTED, client: first })
    expect(monitor?.getSnapshot().rttSamples).toBe(1)

    const second = fakeClient()
    second.sendRequest.mockImplementation(() => new Promise(() => {}))
    await update({ ...CONNECTED, client: second, hostId: 'host-2' })

    expect(monitor?.getSnapshot()).toMatchObject({ phase: 'measuring', host: null, rttSamples: 0 })
  })

  it('tells only subscribers, so a sample cannot re-render the session route', async () => {
    const client = fakeClient()
    const renders = vi.fn()
    function Counted(props: Props): null {
      renders()
      useMobileLinkMonitor(props)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Counted, { ...CONNECTED, client }))
      await vi.advanceTimersByTimeAsync(0)
    })
    const settled = renders.mock.calls.length

    await advance(LINK_PROBE_INTERVAL_MS * 3)

    expect(client.sendRequest.mock.calls.length).toBeGreaterThan(1)
    expect(renders).toHaveBeenCalledTimes(settled)
  })
})
