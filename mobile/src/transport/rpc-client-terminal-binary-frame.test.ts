import { describe, expect, it, vi } from 'vitest'
import { handleTerminalBinaryFrame } from './rpc-client-terminal-binary-frame'
import { TerminalUnreadableFrameResets } from './terminal-unreadable-frame-resets'
import { RpcClientTerminalStreamRouter } from './rpc-client-terminal-stream-router'
import {
  encodeTerminalStreamFrame,
  TERMINAL_STREAM_JSON_MAX_BYTES,
  TerminalStreamOpcode
} from '../../../src/shared/terminal-stream-protocol'

function encodeFrame(opcode: TerminalStreamOpcode, streamId: number, payload: unknown): Uint8Array {
  const body =
    typeof payload === 'string'
      ? new TextEncoder().encode(payload)
      : new TextEncoder().encode(JSON.stringify(payload))
  return encodeTerminalStreamFrame({
    opcode,
    streamId,
    seq: 1,
    payload: body
  })
}

describe('handleTerminalBinaryFrame', () => {
  it('routes terminal metadata frames to the stream listener', () => {
    const listener = vi.fn()

    handleTerminalBinaryFrame(
      encodeFrame(TerminalStreamOpcode.Metadata, 42, { cwd: '/repo/src' }),
      {
        terminalSnapshots: new Map(),
        unreadableFrames: new TerminalUnreadableFrameResets(),
        getListener: (streamId) => (streamId === 42 ? listener : undefined)
      }
    )

    expect(listener).toHaveBeenCalledWith({ type: 'metadata', streamId: 42, cwd: '/repo/src' })
  })

  it('delivers an older desktop output span as output instead of losing it', () => {
    const listener = vi.fn()

    handleTerminalBinaryFrame(
      encodeFrame(TerminalStreamOpcode.OutputSpan, 42, {
        data: '\u001b[?1049l',
        rawLength: 24,
        transformed: true
      }),
      {
        terminalSnapshots: new Map(),
        unreadableFrames: new TerminalUnreadableFrameResets(),
        getListener: () => listener
      }
    )

    expect(listener).toHaveBeenCalledWith({ type: 'data', streamId: 42, chunk: '\u001b[?1049l' })
  })

  it('delivers nothing for a span stripped to no text', () => {
    const listener = vi.fn()

    handleTerminalBinaryFrame(
      encodeFrame(TerminalStreamOpcode.OutputSpan, 42, {
        data: '',
        rawLength: 9,
        transformed: true
      }),
      {
        terminalSnapshots: new Map(),
        unreadableFrames: new TerminalUnreadableFrameResets(),
        getListener: () => listener
      }
    )

    expect(listener).not.toHaveBeenCalled()
  })

  it.each([{ data: 4 }, '{'])(
    'ends an unreadable span and discards its partial snapshot (%j)',
    (payload) => {
      const listener = vi.fn()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const terminalSnapshots = new Map([
        [42, { streamId: 42, meta: {}, chunks: ['partial snapshot'] }]
      ])
      try {
        handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.OutputSpan, 42, payload), {
          terminalSnapshots,
          unreadableFrames: new TerminalUnreadableFrameResets(),
          getListener: () => listener
        })
        expect(listener).toHaveBeenCalledWith(
          expect.objectContaining({ type: 'error', streamId: 42 })
        )
        expect(terminalSnapshots.has(42)).toBe(false)
      } finally {
        warn.mockRestore()
      }
    }
  )

  it('ends a stream on an unreadable frame, deferring resets inside the interval', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const listener = vi.fn()
      const resets = new TerminalUnreadableFrameResets()
      const options = {
        terminalSnapshots: new Map(),
        unreadableFrames: resets,
        getListener: () => listener
      }

      handleTerminalBinaryFrame(unreadableFrame(9), options)
      handleTerminalBinaryFrame(unreadableFrame(9), options)
      // Another pane hits one inside the interval: deferred, never dropped.
      handleTerminalBinaryFrame(unreadableFrame(10), options)
      handleTerminalBinaryFrame(unreadableFrame(11), options)
      resets.forget(11)
      expect(listener.mock.calls.map(([event]) => event)).toEqual([
        expect.objectContaining({ type: 'error', streamId: 9 })
      ])

      vi.advanceTimersByTime(30_000)

      expect(listener.mock.calls.map(([event]) => event)).toEqual([
        expect.objectContaining({ type: 'error', streamId: 9 }),
        expect.objectContaining({ type: 'error', streamId: 10 })
      ])
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it.each([
    ['malformed', '{'],
    ['oversized', JSON.stringify({ padding: 'x'.repeat(TERMINAL_STREAM_JSON_MAX_BYTES) })]
  ])('resets a stream whose snapshot metadata is %s', (_kind, payload) => {
    const listener = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const terminalSnapshots = new Map([
      [42, { streamId: 42, meta: {}, chunks: ['stale snapshot'] }]
    ])
    try {
      handleTerminalBinaryFrame(encodeFrame(TerminalStreamOpcode.SnapshotStart, 42, payload), {
        terminalSnapshots,
        unreadableFrames: new TerminalUnreadableFrameResets(),
        getListener: () => listener
      })
      expect(listener).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: 'error', streamId: 42 })
      )
      expect(terminalSnapshots.has(42)).toBe(false)
    } finally {
      warn.mockRestore()
    }
  })

  it('lets a released stream id that the host reuses be reset again', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const router = new RpcClientTerminalStreamRouter()
      const first = vi.fn()
      router.register('request-1', 5, first)
      router.handle(unreadableFrame(5))
      router.reset('request-1')
      vi.advanceTimersByTime(30_000)
      const second = vi.fn()
      router.register('request-2', 5, second)
      router.handle(unreadableFrame(5))

      expect(first).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', streamId: 5 }))
      expect(second).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', streamId: 5 }))
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })
})

function unreadableFrame(streamId: number): Uint8Array {
  const frame = encodeFrame(TerminalStreamOpcode.Output, streamId, 'text')
  // An opcode no build knows yet, as a newer host could send.
  frame[2] = 250
  return frame
}
