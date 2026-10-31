import { describe, expect, it, vi } from 'vitest'
import { handleTerminalBinaryFrame } from './rpc-client-terminal-binary-frame'
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from './terminal-stream-protocol'

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
      { terminalSnapshots: new Map(), getListener: () => listener }
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
      { terminalSnapshots: new Map(), getListener: () => listener }
    )

    expect(listener).not.toHaveBeenCalled()
  })
})
