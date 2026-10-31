import { describe, expect, it } from 'vitest'
import {
  diagnoseMobileLink,
  LINK_DESKTOP_BACKLOG_BYTES,
  LINK_DESKTOP_LOOP_P99_MS,
  LINK_PAGE_FRAME_GAP_P95_MS,
  LINK_PAGE_PENDING_AGE_MS,
  LINK_SHELL_RTT_MS,
  LINK_SLOW_RTT_MS
} from './mobile-link-diagnosis'
import {
  mobileLinkDetailRows,
  mobileLinkHeaderText,
  mobileLinkSummary,
  MOBILE_LINK_ROW_NOT_MEASURED
} from './mobile-link-presentation'
import { MOBILE_LINK_OFF, type MobileLinkSnapshot } from './mobile-link-sampler'

const CLEAN_PAGE = {
  documents: 1,
  pendingChars: 0,
  oldestPendingMs: null,
  frameGap: { p95Ms: 17, maxMs: 33, frames: 120 },
  receivedCharsPerSecond: 0
}

function reading(overrides: Partial<MobileLinkSnapshot> = {}): MobileLinkSnapshot {
  return {
    phase: 'live',
    rttMs: 120,
    rttLastMs: 120,
    rttSamples: 5,
    sampledAt: 1,
    host: {
      outbound: { queuedBytes: 0, queuedFrames: 0, socketBufferedBytes: 0 },
      eventLoop: { p99Ms: 5, maxMs: 12, windowMs: 5_000, samples: 400 }
    },
    shell: null,
    shellAvailable: false,
    page: CLEAN_PAGE,
    ...overrides
  }
}

function withQueue(queuedBytes: number, socketBufferedBytes = 0): MobileLinkSnapshot {
  const eventLoop = reading().host?.eventLoop ?? null
  return reading({
    host: { outbound: { queuedBytes, queuedFrames: 1, socketBufferedBytes }, eventLoop }
  })
}

describe('diagnosing a link reading', () => {
  it('names nothing when every reading is clean', () => {
    expect(diagnoseMobileLink(reading())).toEqual([])
  })

  it('names output backlog from what is queued ahead of the reply, at the boundary', () => {
    expect(diagnoseMobileLink(withQueue(LINK_DESKTOP_BACKLOG_BYTES - 1))).toEqual([])
    expect(diagnoseMobileLink(withQueue(LINK_DESKTOP_BACKLOG_BYTES))).toEqual(['output-backlog'])
    expect(diagnoseMobileLink(withQueue(0, LINK_DESKTOP_BACKLOG_BYTES))).toEqual(['output-backlog'])
  })

  it('counts both desktop queues together', () => {
    const half = LINK_DESKTOP_BACKLOG_BYTES / 2
    expect(diagnoseMobileLink(withQueue(half, half))).toEqual(['output-backlog'])
  })

  it('names a late desktop process', () => {
    const outbound = reading().host?.outbound ?? null
    const late = (p99Ms: number) =>
      reading({
        host: { outbound, eventLoop: { p99Ms, maxMs: p99Ms, windowMs: 5_000, samples: 9 } }
      })
    expect(diagnoseMobileLink(late(LINK_DESKTOP_LOOP_P99_MS - 1))).toEqual([])
    expect(diagnoseMobileLink(late(LINK_DESKTOP_LOOP_P99_MS))).toEqual(['desktop-busy'])
  })

  it('names the phone when its frames run late, whatever the round trip says', () => {
    const page = {
      ...CLEAN_PAGE,
      frameGap: { p95Ms: LINK_PAGE_FRAME_GAP_P95_MS, maxMs: 300, frames: 120 }
    }
    expect(diagnoseMobileLink(reading({ page, rttMs: 60 }))).toEqual(['phone-busy'])
  })

  it('names the phone when the page cannot parse what already reached it', () => {
    const waiting = (oldestPendingMs: number) =>
      reading({ page: { ...CLEAN_PAGE, pendingChars: 90_000, oldestPendingMs } })
    expect(diagnoseMobileLink(waiting(LINK_PAGE_PENDING_AGE_MS - 1))).toEqual([])
    expect(diagnoseMobileLink(waiting(LINK_PAGE_PENDING_AGE_MS))).toEqual(['phone-busy'])
  })

  it('names the phone from the time of the app hop where a new app can measure it', () => {
    const hop = (rttMs: number) => reading({ shell: { rttMs, heldOutputBytes: 0, sampledAt: 1 } })
    expect(diagnoseMobileLink(hop(LINK_SHELL_RTT_MS))).toEqual(['phone-busy'])
    expect(diagnoseMobileLink(hop(LINK_SHELL_RTT_MS - 1))).toEqual([])
  })

  it('shows output the app holds without calling it a slowdown, however much', () => {
    const held = reading({
      shell: { rttMs: 4, heldOutputBytes: 8 * 1024 * 1024, sampledAt: 1 },
      shellAvailable: true
    })

    expect(diagnoseMobileLink(held)).toEqual([])
    expect(mobileLinkSummary(held)).toBe('No slowdown shown by these readings.')
    const hopRow = mobileLinkDetailRows(held).find((row) => row.label === 'Phone app hop')
    expect(hopRow?.value).toBe('4 ms · 8.0 MiB held')
  })

  it('reports every cause shown, strongest first', () => {
    const backlog = withQueue(LINK_DESKTOP_BACKLOG_BYTES)
    const page = { ...CLEAN_PAGE, oldestPendingMs: LINK_PAGE_PENDING_AGE_MS }
    expect(diagnoseMobileLink({ ...backlog, page })).toEqual(['output-backlog', 'phone-busy'])
  })

  it('calls a slow round trip with clean queues unexplained, never the network', () => {
    const slow = reading({ rttMs: LINK_SLOW_RTT_MS })
    expect(diagnoseMobileLink(reading({ rttMs: LINK_SLOW_RTT_MS - 1 }))).toEqual([])
    expect(diagnoseMobileLink(slow)).toEqual(['link-slow'])
    expect(mobileLinkHeaderText(slow)).toBe('400 ms · Link slow, cause unknown')
    expect(mobileLinkSummary(slow)).not.toMatch(/network/i)
  })

  it('does not call the link slow when a measured cause already explains the round trip', () => {
    const backlog = { ...withQueue(LINK_DESKTOP_BACKLOG_BYTES), rttMs: 2_000 }
    expect(diagnoseMobileLink(backlog)).toEqual(['output-backlog'])
  })

  it('treats a timeout with no evidence as unexplained', () => {
    const timedOut = reading({ phase: 'timed-out', rttMs: null, rttLastMs: null, host: null })
    expect(diagnoseMobileLink(timedOut)).toEqual(['link-slow'])
    expect(mobileLinkHeaderText(timedOut)).toBe('> 5 s · Link slow, cause unknown')
  })

  it('names no desktop cause from a desktop that cannot report one', () => {
    const old = reading({ phase: 'unsupported', rttMs: null, rttLastMs: null, host: null })
    expect(diagnoseMobileLink(old)).toEqual([])
    expect(mobileLinkHeaderText(old)).toBeNull()
  })
})

describe('what the header and details say', () => {
  it('shows the round trip alone while nothing is wrong', () => {
    expect(mobileLinkHeaderText(reading())).toBe('120 ms')
  })

  it('shows a dash rather than a number while there is no answer', () => {
    expect(mobileLinkHeaderText(reading({ phase: 'measuring', rttMs: null }))).toBe('—')
    expect(mobileLinkHeaderText(reading({ phase: 'failed', rttMs: null }))).toBe('—')
  })

  it('shows nothing while the sampler is off', () => {
    expect(mobileLinkHeaderText(MOBILE_LINK_OFF)).toBeNull()
  })

  it('names every unmeasured segment instead of filling it in', () => {
    const rows = mobileLinkDetailRows(
      reading({ phase: 'unsupported', rttMs: null, rttLastMs: null, host: null, page: null })
    )
    const value = (label: string) => rows.find((row) => row.label === label)?.value
    for (const label of [
      'App round trip',
      'Desktop send queue',
      'Desktop main process delay',
      'Page frame gap',
      'Waiting to parse',
      'Phone app hop',
      'Mobile network alone'
    ]) {
      expect(value(label), label).toBe(MOBILE_LINK_ROW_NOT_MEASURED)
    }
  })

  it('says the round trip is not network time', () => {
    const [roundTrip] = mobileLinkDetailRows(reading())
    expect(roundTrip?.note).toContain('not network time alone')
  })
})
