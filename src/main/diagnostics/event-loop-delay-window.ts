import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { MobileLinkEventLoopWindow } from '../../shared/mobile-link-probe-contract'
import { eventLoopDelayMs } from './event-loop-delay-probe'

const RESOLUTION_MS = 10
const IDLE_STOP_MS = 30_000

type DelayHistogram = Pick<
  ReturnType<typeof monitorEventLoopDelay>,
  'enable' | 'disable' | 'reset' | 'percentile' | 'max' | 'count'
>

type EventLoopDelayWindowDeps = {
  createHistogram: () => DelayHistogram
  now: () => number
}

/**
 * Event-loop delay between reads, armed by the first read and stopped when reads stop.
 *
 * On demand because the packaged app runs no delay probe: a desktop with no phone watching must not
 * pay a 10 ms timer for a number nobody reads. The first read answers null, as there is no window.
 */
export function createEventLoopDelayWindow(
  deps: EventLoopDelayWindowDeps = {
    createHistogram: () => monitorEventLoopDelay({ resolution: RESOLUTION_MS }),
    now: () => performance.now()
  }
): { read: () => MobileLinkEventLoopWindow | null } {
  let histogram: DelayHistogram | null = null
  let windowStartedAt = 0
  let idleStop: ReturnType<typeof setTimeout> | null = null

  const stop = (): void => {
    histogram?.disable()
    histogram = null
    idleStop = null
  }

  return {
    read() {
      if (idleStop !== null) {
        clearTimeout(idleStop)
      }
      idleStop = setTimeout(stop, IDLE_STOP_MS)
      idleStop.unref?.()
      const now = deps.now()
      if (histogram === null) {
        histogram = deps.createHistogram()
        histogram.enable()
        windowStartedAt = now
        return null
      }
      const samples = histogram.count
      const window = {
        p99Ms: eventLoopDelayMs(histogram.percentile(99), RESOLUTION_MS),
        maxMs: eventLoopDelayMs(histogram.max, RESOLUTION_MS),
        windowMs: Math.round(now - windowStartedAt),
        samples
      }
      histogram.reset()
      windowStartedAt = now
      return samples > 0 ? window : null
    }
  }
}
