import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEventLoopDelayWindow } from './event-loop-delay-window'

function fakeHistogram() {
  return {
    enable: vi.fn(() => true),
    disable: vi.fn(() => true),
    reset: vi.fn(),
    percentile: vi.fn(() => 60e6),
    max: 210e6,
    count: 400
  }
}

describe('event-loop delay window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports nothing until a window exists, then the delay beyond the sampling interval', () => {
    const histogram = fakeHistogram()
    const clock = { ms: 1_000 }
    const window = createEventLoopDelayWindow({
      createHistogram: () => histogram,
      now: () => clock.ms
    })

    expect(window.read()).toBeNull()
    expect(histogram.enable).toHaveBeenCalledOnce()

    clock.ms = 6_000
    expect(window.read()).toEqual({ p99Ms: 50, maxMs: 200, windowMs: 5_000, samples: 400 })
    expect(histogram.reset).toHaveBeenCalledOnce()
  })

  it('stops the histogram once reads stop, so an unwatched desktop pays nothing', () => {
    const histogram = fakeHistogram()
    const window = createEventLoopDelayWindow({
      createHistogram: () => histogram,
      now: () => 0
    })

    window.read()
    vi.advanceTimersByTime(29_000)
    window.read()
    vi.advanceTimersByTime(29_000)
    expect(histogram.disable).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    expect(histogram.disable).toHaveBeenCalledOnce()
  })
})
