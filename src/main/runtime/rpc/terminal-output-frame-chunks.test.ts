import { describe, expect, it } from 'vitest'
import { TERMINAL_STREAM_CHUNK_BYTES } from '../../../shared/terminal-multiplex-flow-control'
import { TerminalStreamOpcode } from '../../../shared/terminal-stream-protocol'
import {
  iterateTerminalOutputFrameChunks,
  type TerminalOutputMeta
} from './terminal-output-frame-chunks'

const SURROGATE_PAIR = '\u{1f600}'
const LONE_HIGH = '\ud83d'

function seqPreservingMeta(data: string, seq: number): TerminalOutputMeta {
  return { seq, rawLength: data.length }
}

describe('terminal output frame chunks', () => {
  it('preserves legacy addition rounding for unsafe sequence values', () => {
    const data = 'x'.repeat(TERMINAL_STREAM_CHUNK_BYTES + 1)
    const seq = 9_007_199_254_740_994
    const meta = seqPreservingMeta(data, seq)

    const frames = [...iterateTerminalOutputFrameChunks(data, meta, 'span')]
    expect(frames.at(-1)?.seq).toBe(9_007_199_254_740_992)
  })

  it('keeps every emitted frame within the wire cap and reassembles to the input', () => {
    const data = `${'a'.repeat(200 * 1024)}${SURROGATE_PAIR.repeat(4096)}${LONE_HIGH}`
    const frames = [
      ...iterateTerminalOutputFrameChunks(data, seqPreservingMeta(data, 999_999), 'span')
    ]
    expect(frames.length).toBeGreaterThan(4)
    for (const frame of frames) {
      expect(frame.bytes.byteLength).toBeLessThanOrEqual(TERMINAL_STREAM_CHUNK_BYTES)
    }
    expect(Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes))).toString('utf8')).toBe(
      Buffer.from(new TextEncoder().encode(data)).toString('utf8')
    )
    // Seqs must be strictly increasing and end at the meta high-water mark.
    const seqs = frames.map((frame) => frame.seq!)
    expect(seqs.every((seq, index) => index === 0 || seq > seqs[index - 1]!)).toBe(true)
    expect(seqs.at(-1)).toBe(999_999)
  })

  it('emits exactly one frame when the payload fits the cap in bytes but not naively', () => {
    // 3-byte code points: 16384 code units = 49152 bytes = exactly the cap.
    const exact = '\u20ac'.repeat(TERMINAL_STREAM_CHUNK_BYTES / 3)
    expect(Buffer.byteLength(exact, 'utf8')).toBe(TERMINAL_STREAM_CHUNK_BYTES)
    expect([...iterateTerminalOutputFrameChunks(exact, undefined, 'span')]).toHaveLength(1)
    const overByOne = `${exact}a`
    expect(
      [...iterateTerminalOutputFrameChunks(overByOne, undefined, 'span')].length
    ).toBeGreaterThan(1)
  })

  describe('rewritten output', () => {
    const rewritten = { seq: 900, rawLength: 12, transformed: true }

    it('stays a span for the desktop multiplex', () => {
      const [frame] = iterateTerminalOutputFrameChunks('reset', rewritten, 'span')
      expect(frame?.opcode).toBe(TerminalStreamOpcode.OutputSpan)
    })

    it('is plain text for a phone, carrying the seq the span would have', () => {
      const frames = [...iterateTerminalOutputFrameChunks('\x1b[?1049l', rewritten, 'text')]
      expect(frames).toHaveLength(1)
      expect(frames[0]?.opcode).toBeUndefined()
      expect(frames[0]?.seq).toBe(900)
      expect(Buffer.from(frames[0]!.bytes).toString('utf8')).toBe('\x1b[?1049l')
    })

    it.each([0, 40])(
      'splits a large rewrite under the cap with the seq on the last frame only (raw delta %i)',
      (rawDelta) => {
        const data = 'y'.repeat(TERMINAL_STREAM_CHUNK_BYTES * 2 + 1)
        const frames = [
          ...iterateTerminalOutputFrameChunks(
            data,
            { seq: 5_000, rawLength: data.length + rawDelta, transformed: true },
            'text'
          )
        ]
        expect(frames.length).toBe(3)
        for (const frame of frames) {
          expect(frame.bytes.byteLength).toBeLessThanOrEqual(TERMINAL_STREAM_CHUNK_BYTES)
        }
        expect(frames.map((frame) => frame.seq)).toEqual([undefined, undefined, 5_000])
      }
    )

    it('sends a phone nothing when the rewrite stripped every byte', () => {
      expect([...iterateTerminalOutputFrameChunks('', rewritten, 'text')]).toEqual([])
    })
  })
})
