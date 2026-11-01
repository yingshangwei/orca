import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn(() => ({})) } }))

let callbacks: MultiplexSubscriptionCallbacks = null
let resolvedHandle = 'terminal-1'
const { runtimeCall, latestSubscribePayload, emitSnapshot, resetRemoteRuntimeTransport } =
  createRemoteRuntimeTransportMocks({
    getCallbacks: () => callbacks,
    setCallbacks: (value) => {
      callbacks = value
    },
    getResolvedPaneHandle: () => resolvedHandle,
    setResolvedPaneHandle: (value) => {
      resolvedHandle = value
    }
  })

beforeEach(resetRemoteRuntimeTransport)
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function completeAttach(): Promise<void> {
  await vi.waitFor(() => expect(latestSubscribePayload()).toBeDefined())
  const { streamId } = latestSubscribePayload()
  callbacks?.onResponse({ ok: true, result: { type: 'subscribed', streamId } })
  emitSnapshot(streamId, 'prompt$ ')
}

describe('a WSL stopped refusal before runtime dispatch', () => {
  it('parks the first spawn without retrying and lets Start replay the request', async () => {
    const fallback = runtimeCall.getMockImplementation()
    let stopped = true
    let creates = 0
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.create') {
        creates += 1
        if (stopped) {
          return { ok: false, error: { code: 'wsl_host_stopped', message: 'Ubuntu is stopped.' } }
        }
      }
      return fallback?.(request)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('wsl:ubuntu', { worktreeId: 'wt-1' })
    try {
      const onError = vi.fn()
      await transport.connect({ url: '', callbacks: { onError } })
      expect(transport.getPtyId()).toBeNull()
      expect(transport.getRecoveryState?.()?.phase).toBe('disconnected')
      expect(onError).toHaveBeenCalledWith('Ubuntu is stopped.')
      expect(creates).toBe(1)
      vi.useFakeTimers()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(creates).toBe(1)
      vi.useRealTimers()

      stopped = false
      expect(transport.retryRecovery?.()).toBe(true)
      await completeAttach()
      await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
      expect(creates).toBe(2)
      expect(transport.getPtyId()).toBe('remote:wsl%3Aubuntu@@terminal-1')
    } finally {
      transport.destroy?.()
    }
  })

  it('parks a restored attachment and retries its original pane without creating another terminal', async () => {
    const fallback = runtimeCall.getMockImplementation()
    let stopped = true
    runtimeCall.mockImplementation(async (request: { method: string }) => {
      if (request.method === 'terminal.resolvePane' && stopped) {
        return { ok: false, error: { code: 'wsl_host_stopped', message: 'Ubuntu is stopped.' } }
      }
      return fallback?.(request)
    })
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('wsl:ubuntu', {
      worktreeId: 'wt-1',
      tabId: 'tab-1',
      leafId: 'pane:1'
    })
    try {
      transport.attach({ existingPtyId: 'remote:wsl%3Aubuntu@@terminal-1', callbacks: {} })
      await vi.waitFor(() => expect(transport.getRecoveryState?.()?.phase).toBe('disconnected'))
      stopped = false
      expect(transport.retryRecovery?.()).toBe(true)
      await completeAttach()
      await vi.waitFor(() => expect(transport.isConnected()).toBe(true))
      expect(transport.getPtyId()).toBe('remote:wsl%3Aubuntu@@terminal-1')
      expect(runtimeCall.mock.calls.some(([request]) => request.method === 'terminal.create')).toBe(
        false
      )
    } finally {
      transport.destroy?.()
    }
  })

  it('does not turn an unrelated terminal refusal into a replayable spawn', async () => {
    const fallback = runtimeCall.getMockImplementation()
    runtimeCall.mockImplementation(async (request: { method: string }) =>
      request.method === 'terminal.create'
        ? { ok: false, error: { code: 'permission_denied', message: 'Permission denied.' } }
        : fallback?.(request)
    )
    const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
    const transport = createRemoteRuntimePtyTransport('wsl:ubuntu', { worktreeId: 'wt-1' })
    try {
      await transport.connect({ url: '', callbacks: {} })
      expect(transport.retryRecovery?.()).toBe(false)
      await flushAsyncTicks()
      expect(
        runtimeCall.mock.calls.filter(([request]) => request.method === 'terminal.create')
      ).toHaveLength(1)
    } finally {
      transport.destroy?.()
    }
  })
})
