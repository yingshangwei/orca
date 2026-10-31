import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileLinkProbeResult } from '../../../src/shared/mobile-link-probe-contract'
import {
  createMobileLinkSampler,
  LINK_PROBE_DETAIL_INTERVAL_MS,
  LINK_PROBE_INTERVAL_MS,
  LINK_PROBE_TIMEOUT_MS,
  LINK_SAMPLE_STALE_MS,
  MOBILE_LINK_OFF,
  type MobileLinkSnapshot
} from './mobile-link-sampler'

const REPLY: MobileLinkProbeResult = {
  outbound: { queuedBytes: 0, queuedFrames: 0, socketBufferedBytes: 0 },
  eventLoop: { p99Ms: 3, maxMs: 9, windowMs: 5_000, samples: 400 }
}

const PAGE = {
  documents: 1,
  pendingChars: 0,
  oldestPendingMs: null,
  frameGap: null,
  receivedCharsPerSecond: null
}

/** Each probe stays open until the case answers it, on the fake clock. */
function harness(options: { supported?: boolean; shell?: boolean | 'by-hand' } = {}) {
  const answers: { resolve: (value: MobileLinkProbeResult | null) => void; reject: () => void }[] =
    []
  const shellAnswers: {
    resolve: (value: { heldOutputBytes: number }) => void
    reject: () => void
  }[] = []
  const snapshots: MobileLinkSnapshot[] = []
  const probeHost = vi.fn(
    (_timeoutMs: number) =>
      new Promise<MobileLinkProbeResult | null>((resolve, reject) => {
        answers.push({ resolve, reject: () => reject(new Error('not connected')) })
      })
  )
  const probeShell = vi.fn(async () =>
    options.shell === 'by-hand'
      ? new Promise<{ heldOutputBytes: number }>((resolve, reject) => {
          shellAnswers.push({ resolve, reject: () => reject(new Error('page gone')) })
        })
      : { heldOutputBytes: 2_048 }
  )
  const sampler = createMobileLinkSampler({
    probeHost: options.supported === false ? null : probeHost,
    probeShell: options.shell ? probeShell : null,
    readPage: () => PAGE,
    now: () => Date.now(),
    setTimer: (callback, ms) => setTimeout(callback, ms),
    clearTimer: (timer) => clearTimeout(timer),
    onChange: (snapshot) => snapshots.push(snapshot)
  })
  return {
    answers,
    latest: () => snapshots.at(-1) ?? MOBILE_LINK_OFF,
    probeHost,
    probeShell,
    sampler,
    async answer(index: number, value: MobileLinkProbeResult | null = REPLY) {
      answers[index]?.resolve(value)
      await vi.advanceTimersByTimeAsync(0)
    },
    async answerShell(index: number, heldOutputBytes = 2_048) {
      shellAnswers[index]?.resolve({ heldOutputBytes })
      await vi.advanceTimersByTimeAsync(0)
    },
    async refuseShell(index: number) {
      shellAnswers[index]?.reject()
      await vi.advanceTimersByTimeAsync(0)
    }
  }
}

describe('mobile link sampler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('measures the time to the reply, with no argument that could carry session data', async () => {
    const link = harness()
    link.sampler.start()
    expect(link.latest().phase).toBe('measuring')

    await vi.advanceTimersByTimeAsync(142)
    await link.answer(0)

    expect(link.probeHost).toHaveBeenCalledOnce()
    expect(link.probeHost).toHaveBeenCalledWith(LINK_PROBE_TIMEOUT_MS)
    expect(link.latest()).toMatchObject({
      phase: 'live',
      rttMs: 142,
      rttLastMs: 142,
      rttSamples: 1
    })
    expect(link.latest().host).toEqual(REPLY)
  })

  it('keeps one probe in flight, however long the last one takes', async () => {
    const link = harness()
    link.sampler.start()

    await vi.advanceTimersByTimeAsync(LINK_PROBE_TIMEOUT_MS - 1)
    expect(link.probeHost).toHaveBeenCalledOnce()

    await link.answer(0)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS - 1)
    expect(link.probeHost).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(link.probeHost).toHaveBeenCalledTimes(2)
  })

  it('samples faster only while the details are open', async () => {
    const link = harness()
    link.sampler.start()
    await link.answer(0)

    link.sampler.setDetailed(true)
    expect(link.probeHost).toHaveBeenCalledTimes(2)
    await link.answer(1)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_DETAIL_INTERVAL_MS)
    expect(link.probeHost).toHaveBeenCalledTimes(3)
    await link.answer(2)

    link.sampler.setDetailed(false)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_DETAIL_INTERVAL_MS)
    await link.answer(3)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_DETAIL_INTERVAL_MS)
    expect(link.probeHost).toHaveBeenCalledTimes(4)
  })

  it('reports a timeout, and does not let the late reply pass as a sample', async () => {
    const link = harness()
    link.sampler.start()

    await vi.advanceTimersByTimeAsync(LINK_PROBE_TIMEOUT_MS)
    expect(link.latest()).toMatchObject({ phase: 'timed-out', rttMs: null })

    await link.answer(0)
    expect(link.latest()).toMatchObject({ phase: 'timed-out', rttSamples: 0 })
  })

  it('reports a refused or unsendable probe as failed, not as zero', async () => {
    const link = harness()
    link.sampler.start()
    await link.answer(0, null)
    expect(link.latest()).toMatchObject({ phase: 'failed', rttMs: null })

    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS)
    link.answers[1]?.reject()
    await vi.advanceTimersByTimeAsync(0)
    expect(link.latest()).toMatchObject({ phase: 'failed', rttMs: null })
  })

  it('drops host evidence once it has gone stale rather than showing it as current', async () => {
    const link = harness()
    link.sampler.start()
    await link.answer(0)
    expect(link.latest().host).toEqual(REPLY)

    await vi.advanceTimersByTimeAsync(LINK_SAMPLE_STALE_MS + 1)

    expect(link.latest()).toMatchObject({ rttMs: null, rttSamples: 0, host: null })
  })

  it('stops probing when stopped, and ignores the reply still on its way', async () => {
    const link = harness()
    link.sampler.start()
    link.sampler.stop()

    await link.answer(0)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS * 4)

    expect(link.probeHost).toHaveBeenCalledOnce()
    expect(link.latest()).toEqual(MOBILE_LINK_OFF)
  })

  it('carries nothing across a stop into the next start', async () => {
    const link = harness()
    link.sampler.start()
    await vi.advanceTimersByTimeAsync(900)
    await link.answer(0)
    link.sampler.stop()

    link.sampler.start()

    expect(link.latest()).toMatchObject({
      phase: 'measuring',
      rttMs: null,
      rttSamples: 0,
      host: null
    })
  })

  it('never asks an older desktop, and still keeps the page readings current', async () => {
    const link = harness({ supported: false })
    link.sampler.start()
    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS * 2)

    expect(link.probeHost).not.toHaveBeenCalled()
    expect(link.latest()).toMatchObject({ phase: 'unsupported', rttMs: null, page: PAGE })
  })

  it('leaves the phone app hop unmeasured on an app that did not grant the verb', async () => {
    const link = harness()
    link.sampler.start()
    await link.answer(0)
    expect(link.latest()).toMatchObject({ shellAvailable: false, shell: null })
  })

  it('times the phone app hop separately when the app grants the verb', async () => {
    const link = harness({ shell: true })
    link.sampler.start()
    await link.answer(0)
    expect(link.latest()).toMatchObject({
      shellAvailable: true,
      shell: { heldOutputBytes: 2_048 }
    })
  })

  it('ages the phone app hop out while the next probe hangs, with no second probe', async () => {
    const link = harness({ shell: 'by-hand' })
    link.sampler.start()
    await link.answerShell(0)
    await link.answer(0)
    expect(link.latest().shell).toMatchObject({ heldOutputBytes: 2_048 })

    for (let sample = 1; sample <= 3; sample += 1) {
      await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS)
      await link.answer(sample)
    }
    expect(link.latest().shell).toMatchObject({ heldOutputBytes: 2_048 })

    await vi.advanceTimersByTimeAsync(1)

    expect(link.latest().shell).toBeNull()
    expect(link.latest()).toMatchObject({ phase: 'live', shellAvailable: true })
    expect(link.probeShell).toHaveBeenCalledTimes(2)
  })

  it('stops showing the phone app hop as soon as a probe of it is refused', async () => {
    const link = harness({ shell: 'by-hand' })
    link.sampler.start()
    await link.answerShell(0)
    await link.answer(0)

    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS)
    await link.refuseShell(1)
    await link.answer(1)

    expect(link.latest().shell).toBeNull()
  })

  it('never lets a phone app reply from before a stop into the next start', async () => {
    const link = harness({ shell: 'by-hand' })
    link.sampler.start()
    link.sampler.stop()
    link.sampler.start()
    expect(link.probeShell).toHaveBeenCalledTimes(2)

    await link.answerShell(0, 999)
    await link.answer(1)
    expect(link.latest().shell).toBeNull()

    await link.answerShell(1, 5)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS)
    await link.answer(2)
    expect(link.latest().shell).toMatchObject({ heldOutputBytes: 5 })
  })

  it('does not let an old refusal open a second probe in the next start', async () => {
    const link = harness({ shell: 'by-hand' })
    link.sampler.start()
    link.sampler.stop()
    link.sampler.start()

    await link.refuseShell(0)
    await link.answer(1)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS)

    expect(link.probeShell).toHaveBeenCalledTimes(2)
  })

  it('starts the median over after a gap, rather than mixing in what went stale', async () => {
    const link = harness()
    link.sampler.start()
    await vi.advanceTimersByTimeAsync(900)
    await link.answer(0)

    // Two timeouts: each probe takes the full timeout and the next waits out the interval.
    await vi.advanceTimersByTimeAsync((LINK_PROBE_TIMEOUT_MS + LINK_PROBE_INTERVAL_MS) * 2)
    expect(link.probeHost).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(LINK_PROBE_INTERVAL_MS)
    await vi.advanceTimersByTimeAsync(100)
    await link.answer(3)

    expect(link.latest()).toMatchObject({ rttMs: 100, rttLastMs: 100, rttSamples: 1 })
  })
})
