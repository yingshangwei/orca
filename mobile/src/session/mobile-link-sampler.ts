import type { MobileLinkProbeResult } from '../../../src/shared/mobile-link-probe-contract'
import type { TerminalPageOutputReading } from '../terminal/terminal-page-output-meter'

export const LINK_PROBE_INTERVAL_MS = 5_000
export const LINK_PROBE_DETAIL_INTERVAL_MS = 1_000
export const LINK_PROBE_TIMEOUT_MS = 5_000
export const LINK_SAMPLE_STALE_MS = 15_000
const RTT_WINDOW = 5

/** `sampledAt` is on the sampler's own clock; a reading past the stale bound is not published. */
export type MobileLinkShellReading = { rttMs: number; heldOutputBytes: number; sampledAt: number }

/**
 * - `off`: the sampler is not running, so nothing here describes the link right now.
 * - `unsupported`: this desktop has no probe. Page numbers may still be fresh.
 * - `measuring`: running, with no answer yet.
 * - `live`: the last probe answered.
 * - `timed-out`: the last probe got no answer within the timeout.
 * - `failed`: the last probe was refused or could not be sent.
 */
export type MobileLinkPhase = 'off' | 'unsupported' | 'measuring' | 'live' | 'timed-out' | 'failed'

export type MobileLinkSnapshot = {
  phase: MobileLinkPhase
  /** Median of the recent round trips; null once the newest of them has gone stale. */
  rttMs: number | null
  rttLastMs: number | null
  rttSamples: number
  /** When the host evidence below was read, on the sampler's own clock. */
  sampledAt: number | null
  host: MobileLinkProbeResult | null
  shell: MobileLinkShellReading | null
  shellAvailable: boolean
  page: TerminalPageOutputReading | null
}

export const MOBILE_LINK_OFF: MobileLinkSnapshot = {
  phase: 'off',
  rttMs: null,
  rttLastMs: null,
  rttSamples: 0,
  sampledAt: null,
  host: null,
  shell: null,
  shellAvailable: false,
  page: null
}

type SamplerDeps = {
  /** Null when this desktop does not advertise the probe, which is never asked then. */
  probeHost: ((timeoutMs: number) => Promise<MobileLinkProbeResult | null>) | null
  /** Null when this app build did not grant the verb. */
  probeShell: (() => Promise<{ heldOutputBytes: number }>) | null
  readPage: () => TerminalPageOutputReading
  now: () => number
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  onChange: (snapshot: MobileLinkSnapshot) => void
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null
  }
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null
}

/**
 * The foreground probe loop: one request at a time, the next one only after the last settled.
 *
 * Every number comes from one clock on this side, so nothing compares two machines' time. A reply
 * that lands after its timeout or after a stop is dropped, because its elapsed time belongs to a
 * round trip already reported, or to a connection this sampler no longer describes.
 *
 * The bridge has no deadline of its own, so a phone app probe that never answers stays the one in
 * flight until a stop: its last reading ages out, and no second request piles up behind it.
 */
export function createMobileLinkSampler(deps: SamplerDeps) {
  let running = false
  let detailed = false
  let inFlight: symbol | null = null
  let shellInFlight: symbol | null = null
  let phase: MobileLinkPhase = 'off'
  let rtts: number[] = []
  let sampledAt: number | null = null
  let host: MobileLinkProbeResult | null = null
  let shell: MobileLinkShellReading | null = null
  let nextTimer: ReturnType<typeof setTimeout> | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null
  let staleTimer: ReturnType<typeof setTimeout> | null = null
  let shellStaleTimer: ReturnType<typeof setTimeout> | null = null

  const clear = (timer: ReturnType<typeof setTimeout> | null): null => {
    if (timer !== null) {
      deps.clearTimer(timer)
    }
    return null
  }

  const isFresh = (at: number | null): boolean =>
    at !== null && deps.now() - at <= LINK_SAMPLE_STALE_MS

  const publish = (): void => {
    const fresh = isFresh(sampledAt)
    deps.onChange({
      phase,
      rttMs: fresh ? median(rtts) : null,
      rttLastMs: fresh ? (rtts.at(-1) ?? null) : null,
      rttSamples: fresh ? rtts.length : 0,
      sampledAt: fresh ? sampledAt : null,
      host: fresh ? host : null,
      shell: isFresh(shell?.sampledAt ?? null) ? shell : null,
      shellAvailable: deps.probeShell !== null,
      page: deps.readPage()
    })
  }

  const scheduleNext = (): void => {
    nextTimer = clear(nextTimer)
    if (running) {
      nextTimer = deps.setTimer(
        tick,
        detailed ? LINK_PROBE_DETAIL_INTERVAL_MS : LINK_PROBE_INTERVAL_MS
      )
    }
  }

  const settle = (probe: symbol, outcome: Exclude<MobileLinkPhase, 'off'>): void => {
    if (inFlight !== probe) {
      return
    }
    inFlight = null
    timeoutTimer = clear(timeoutTimer)
    phase = outcome
    publish()
    scheduleNext()
  }

  const recordSample = (result: MobileLinkProbeResult, rttMs: number): void => {
    // A gap past the stale bound ends the series: the median must not mix in what it had hidden.
    rtts = [...(isFresh(sampledAt) ? rtts : []), Math.round(rttMs)].slice(-RTT_WINDOW)
    host = result
    sampledAt = deps.now()
    staleTimer = clear(staleTimer)
    staleTimer = deps.setTimer(publish, LINK_SAMPLE_STALE_MS + 1)
  }

  const readShell = (): void => {
    const probeShell = deps.probeShell
    if (probeShell === null || shellInFlight !== null) {
      return
    }
    const probe = Symbol('link-shell-probe')
    shellInFlight = probe
    const startedAt = deps.now()
    void probeShell().then(
      ({ heldOutputBytes }) => {
        if (shellInFlight !== probe) {
          return
        }
        shellInFlight = null
        const answeredAt = deps.now()
        shell = {
          rttMs: Math.round(answeredAt - startedAt),
          heldOutputBytes,
          sampledAt: answeredAt
        }
        shellStaleTimer = clear(shellStaleTimer)
        shellStaleTimer = deps.setTimer(publish, LINK_SAMPLE_STALE_MS + 1)
      },
      () => {
        if (shellInFlight !== probe) {
          return
        }
        shellInFlight = null
        shell = null
        shellStaleTimer = clear(shellStaleTimer)
      }
    )
  }

  const tick = (): void => {
    nextTimer = null
    if (!running || inFlight !== null) {
      return
    }
    readShell()
    const probeHost = deps.probeHost
    if (probeHost === null) {
      publish()
      scheduleNext()
      return
    }
    const probe = Symbol('link-probe')
    inFlight = probe
    const startedAt = deps.now()
    timeoutTimer = deps.setTimer(() => settle(probe, 'timed-out'), LINK_PROBE_TIMEOUT_MS)
    probeHost(LINK_PROBE_TIMEOUT_MS).then(
      (result) => {
        if (inFlight !== probe) {
          return
        }
        if (result === null) {
          settle(probe, 'failed')
          return
        }
        recordSample(result, deps.now() - startedAt)
        settle(probe, 'live')
      },
      () => settle(probe, 'failed')
    )
  }

  return {
    start(): void {
      if (running) {
        return
      }
      running = true
      phase = deps.probeHost === null ? 'unsupported' : 'measuring'
      publish()
      tick()
    },

    /** Everything goes with the stop: the next start may be another host or a resumed phone. */
    stop(): void {
      running = false
      inFlight = null
      shellInFlight = null
      phase = 'off'
      rtts = []
      sampledAt = null
      host = null
      shell = null
      nextTimer = clear(nextTimer)
      timeoutTimer = clear(timeoutTimer)
      staleTimer = clear(staleTimer)
      shellStaleTimer = clear(shellStaleTimer)
      deps.onChange(MOBILE_LINK_OFF)
    },

    /** The details sheet samples faster, for exactly as long as it is open. */
    setDetailed(next: boolean): void {
      detailed = next
      if (next && running && inFlight === null) {
        nextTimer = clear(nextTimer)
        tick()
      }
    }
  }
}

export type MobileLinkSampler = ReturnType<typeof createMobileLinkSampler>
