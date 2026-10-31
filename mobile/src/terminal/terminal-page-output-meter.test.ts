import { describe, expect, it, vi } from 'vitest'
import { terminalDocumentDouble } from './document/document-terminal-double.test-support'
import {
  createTerminalPageOutputMeter,
  meterTerminalWrites,
  PENDING_WRITE_CAP
} from './terminal-page-output-meter'

function meterHarness() {
  const clock = { ms: 0 }
  let frame: (() => void) | null = null
  const meter = createTerminalPageOutputMeter({
    now: () => clock.ms,
    requestFrame: (callback) => {
      frame = callback
      return 1
    },
    cancelFrame: () => {
      frame = null
    }
  })
  const releaseForeground = meter.holdForeground()
  return {
    clock,
    meter,
    releaseForeground,
    framePending: () => frame !== null,
    runFrames(count: number, gapMs: number) {
      for (let index = 0; index < count && frame; index += 1) {
        clock.ms += gapMs
        const next = frame
        frame = null
        next()
      }
    }
  }
}

describe('page terminal output meter', () => {
  it('counts what a document has not parsed, and how long the oldest has waited', () => {
    const { clock, meter } = meterHarness()
    const document = meter.attachDocument()

    document.queued(1_000)
    clock.ms = 40
    document.queued(500)
    clock.ms = 700

    expect(meter.read()).toMatchObject({ pendingChars: 1_500, oldestPendingMs: 700 })
    document.beginParse()()
    expect(meter.read()).toMatchObject({ pendingChars: 500, oldestPendingMs: 660 })
    document.beginParse()()
    expect(meter.read()).toMatchObject({ pendingChars: 0, oldestPendingMs: null })
  })

  it('does not let a parse from before a reset settle the output after it', () => {
    const { meter } = meterHarness()
    const document = meter.attachDocument()

    document.queued(100)
    const superseded = document.beginParse()
    document.reset()
    document.queued(64_000)
    superseded()

    expect(meter.read()).toMatchObject({ pendingChars: 64_000, oldestPendingMs: 0 })
  })

  it('keeps counting past the cap, so a parse never settles a newer write', () => {
    const { clock, meter } = meterHarness()
    const document = meter.attachDocument()
    const overflow = 2

    for (let index = 0; index < PENDING_WRITE_CAP + overflow; index += 1) {
      document.queued(1)
    }
    expect(meter.read().pendingChars).toBe(PENDING_WRITE_CAP + overflow)

    for (let index = 0; index < PENDING_WRITE_CAP; index += 1) {
      document.beginParse()()
    }
    clock.ms = 900
    document.queued(7)
    document.beginParse()()
    document.beginParse()()

    expect(meter.read()).toMatchObject({ pendingChars: 7, oldestPendingMs: 0 })
    document.beginParse()()
    expect(meter.read()).toMatchObject({ pendingChars: 0, oldestPendingMs: null })
  })

  it('leaves nothing behind when more writes than the cap all parse', () => {
    const { meter } = meterHarness()
    const document = meter.attachDocument()
    const writes = PENDING_WRITE_CAP * 2

    for (let index = 0; index < writes; index += 1) {
      document.queued(1)
    }
    for (let index = 0; index < writes; index += 1) {
      document.beginParse()()
    }

    expect(meter.read()).toMatchObject({ pendingChars: 0, oldestPendingMs: null })
  })

  it('forgets writes a replaced snapshot superseded, so a reset is not read as a stall', () => {
    const { meter } = meterHarness()
    const document = meter.attachDocument()

    document.queued(64_000)
    document.reset()

    expect(meter.read()).toMatchObject({ pendingChars: 0, oldestPendingMs: null })
  })

  it('stops counting a document that has gone', () => {
    const { meter } = meterHarness()
    const document = meter.attachDocument()

    document.queued(64_000)
    document.detach()

    expect(meter.read()).toMatchObject({ documents: 0, pendingChars: 0 })
  })

  it('runs frames only around activity and lets them stop when the terminal goes quiet', () => {
    const { framePending, meter, runFrames } = meterHarness()
    const document = meter.attachDocument()
    expect(framePending()).toBe(false)

    document.activity()
    expect(framePending()).toBe(true)
    runFrames(10, 16)
    expect(framePending()).toBe(true)

    runFrames(200, 16)
    expect(framePending()).toBe(false)
  })

  it('reports frame gaps only once there are enough frames to mean something', () => {
    const { meter, runFrames } = meterHarness()
    const document = meter.attachDocument()

    document.activity()
    runFrames(10, 16)
    expect(meter.read().frameGap).toBeNull()

    runFrames(60, 16)
    runFrames(20, 120)
    expect(meter.read().frameGap).toMatchObject({ p95Ms: 120, maxMs: 120 })
  })

  it('does not read time in the background as a long frame', () => {
    const { clock, meter, releaseForeground, runFrames } = meterHarness()
    const document = meter.attachDocument()

    document.activity()
    runFrames(40, 16)
    releaseForeground()
    clock.ms += 60_000
    meter.holdForeground()

    expect(meter.read().frameGap).toBeNull()
  })

  it('runs no frames once the last holder lets go, and not before', () => {
    const { framePending, meter, releaseForeground } = meterHarness()
    const document = meter.attachDocument()
    const releaseIncoming = meter.holdForeground()

    document.activity()
    releaseForeground()
    releaseForeground()
    expect(framePending()).toBe(true)

    releaseIncoming()
    expect(framePending()).toBe(false)

    document.activity()
    expect(framePending()).toBe(false)
  })

  it('keeps no output text anywhere a reading can reach', () => {
    const { meter } = meterHarness()
    const document = meter.attachDocument()
    const terminal = meterTerminalWrites(terminalDocumentDouble().terminal, document)

    document.queued('SECRET-OUTPUT'.length)
    terminal.write('SECRET-OUTPUT', vi.fn())
    document.queued('SECRET-OUTPUT'.length)

    expect(JSON.stringify(meter.read())).not.toContain('SECRET')
  })
})

describe('metered terminal writes', () => {
  it('reports the parse before the document continues, and passes the data through', () => {
    const double = terminalDocumentDouble()
    const written: string[] = []
    double.terminal.write = (data, callback) => {
      written.push(data)
      callback?.()
    }
    const order: string[] = []

    meterTerminalWrites(double.terminal, {
      beginParse: () => () => order.push('parsed')
    }).write('out', () => order.push('document'))

    expect(written).toEqual(['out'])
    expect(order).toEqual(['parsed', 'document'])
  })

  it('reports nothing until xterm finishes the chunk', () => {
    const double = terminalDocumentDouble()
    double.terminal.write = () => {}
    const parsed = vi.fn()

    meterTerminalWrites(double.terminal, { beginParse: () => parsed }).write('out')

    expect(parsed).not.toHaveBeenCalled()
  })
})
