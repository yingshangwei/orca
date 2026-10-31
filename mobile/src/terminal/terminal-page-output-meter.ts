import { nearestRankPercentile } from '../../../src/shared/nearest-rank-percentile'
import type { TerminalDocumentTerminal } from './document/document-terminal-shape'

const FRAME_WINDOW_MS = 10_000
const FRAME_SAMPLE_CAP = 1_200
const MIN_FRAME_SAMPLES = 20
const ACTIVITY_LINGER_MS = 2_000
export const PENDING_WRITE_CAP = 4_096

export type TerminalFrameGap = { p95Ms: number; maxMs: number; frames: number }

/** Sizes and durations only: a chunk's text is never kept past the call that counted it. */
export type TerminalPageOutputReading = {
  documents: number
  /** UTF-16 units handed to a document and not yet parsed by xterm. */
  pendingChars: number
  /** How long the oldest of those has been waiting, or null when nothing is. */
  oldestPendingMs: number | null
  /** Main-thread frame cadence, sampled only while output or a touch was active. */
  frameGap: TerminalFrameGap | null
  /** Units handed to documents per second since the previous read; null on the first. */
  receivedCharsPerSecond: number | null
}

export type TerminalDocumentOutputMeter = {
  queued: (chars: number) => void
  /** A write reached xterm. Call what this returns when xterm has parsed it. */
  beginParse: () => () => void
  reset: () => void
  activity: () => void
  detach: () => void
}

type MeterDeps = {
  now: () => number
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
}

/** `writes` is how many parses this entry waits for: more than one only past the cap. */
type PendingWrite = { chars: number; at: number; writes: number }

/**
 * How far the page's terminals are behind the output handed to them, and how late its frames run.
 *
 * The frame loop runs only around output or a touch, so an idle terminal keeps no rAF alive and
 * the number describes the moments that were actually being looked at. A frame here is the main
 * thread reaching rAF, not a frame the GPU presented.
 *
 * Writes reach xterm in the order they were queued, one at a time, so each parse settles the oldest
 * entry. A parse begun before a reset belongs to output the reset discarded and settles nothing.
 * Past the cap, new writes join the newest entry rather than dropping one, so every parse still has
 * its entry; such an entry leaves whole, and its age is its first write's.
 */
export function createTerminalPageOutputMeter(deps: MeterDeps) {
  const documents = new Set<PendingWrite[]>()
  let foregroundHolds = 0
  let receivedChars = 0
  let lastRead: { at: number; chars: number } | null = null
  let lastActivityAt = Number.NEGATIVE_INFINITY
  let lastFrameAt: number | null = null
  let frameHandle: number | null = null
  let gaps: { at: number; ms: number }[] = []

  const onFrame = (): void => {
    frameHandle = null
    const now = deps.now()
    if (lastFrameAt !== null) {
      gaps.push({ at: now, ms: now - lastFrameAt })
      if (gaps.length > FRAME_SAMPLE_CAP) {
        gaps = gaps.slice(-FRAME_SAMPLE_CAP)
      }
    }
    if (now - lastActivityAt < ACTIVITY_LINGER_MS) {
      lastFrameAt = now
      frameHandle = deps.requestFrame(onFrame)
    } else {
      lastFrameAt = null
    }
  }

  const noteActivity = (): void => {
    lastActivityAt = deps.now()
    if (foregroundHolds > 0 && frameHandle === null) {
      frameHandle = deps.requestFrame(onFrame)
    }
  }

  /** A page in the background has no frames to judge, and its gap on return is not a stall. */
  const restartFrameWindow = (): void => {
    gaps = []
    lastFrameAt = null
    lastRead = null
    if (frameHandle !== null) {
      deps.cancelFrame(frameHandle)
      frameHandle = null
    }
  }

  const readFrameGap = (now: number): TerminalFrameGap | null => {
    const recent = gaps.filter((gap) => now - gap.at <= FRAME_WINDOW_MS).map((gap) => gap.ms)
    if (recent.length < MIN_FRAME_SAMPLES) {
      return null
    }
    recent.sort((a, b) => a - b)
    return {
      p95Ms: Math.round(nearestRankPercentile(recent, 0.95) ?? 0),
      maxMs: Math.round(recent.at(-1) ?? 0),
      frames: recent.length
    }
  }

  return {
    attachDocument(): TerminalDocumentOutputMeter {
      const pending: PendingWrite[] = []
      let resets = 0
      documents.add(pending)
      return {
        queued(chars) {
          receivedChars += chars
          const newest = pending.at(-1)
          if (newest && pending.length >= PENDING_WRITE_CAP) {
            newest.chars += chars
            newest.writes += 1
          } else {
            pending.push({ chars, at: deps.now(), writes: 1 })
          }
          noteActivity()
        },
        beginParse() {
          const resetsAtStart = resets
          return () => {
            const oldest = pending[0]
            if (resetsAtStart !== resets || !oldest) {
              return
            }
            oldest.writes -= 1
            if (oldest.writes === 0) {
              pending.shift()
            }
          }
        },
        reset() {
          pending.length = 0
          resets += 1
        },
        activity: noteActivity,
        detach() {
          documents.delete(pending)
        }
      }
    },

    /**
     * Frames run only while a session is on screen to read them, and held rather than switched: a
     * stack transition mounts the incoming session before the outgoing one lets go.
     */
    holdForeground(): () => void {
      foregroundHolds += 1
      if (foregroundHolds === 1) {
        restartFrameWindow()
      }
      let held = true
      return () => {
        if (!held) {
          return
        }
        held = false
        foregroundHolds -= 1
        if (foregroundHolds === 0) {
          restartFrameWindow()
        }
      }
    },

    read(): TerminalPageOutputReading {
      const now = deps.now()
      let pendingChars = 0
      let oldestAt: number | null = null
      for (const pending of documents) {
        for (const write of pending) {
          pendingChars += write.chars
        }
        const head = pending[0]
        if (head && (oldestAt === null || head.at < oldestAt)) {
          oldestAt = head.at
        }
      }
      const elapsedMs = lastRead === null ? 0 : now - lastRead.at
      const received =
        lastRead !== null && elapsedMs > 0
          ? Math.round(((receivedChars - lastRead.chars) * 1_000) / elapsedMs)
          : null
      lastRead = { at: now, chars: receivedChars }
      return {
        documents: documents.size,
        pendingChars,
        oldestPendingMs: oldestAt === null ? null : Math.round(now - oldestAt),
        frameGap: readFrameGap(now),
        receivedCharsPerSecond: received
      }
    }
  }
}

export type TerminalPageOutputMeter = ReturnType<typeof createTerminalPageOutputMeter>

/**
 * Reports each finished parse to the meter, at the seam the page already owns.
 *
 * Wrapped here rather than in the document's write queue because that text is pinned token for
 * token against the native WebView program. Nothing in the wrapper keeps the data.
 */
export function meterTerminalWrites(
  terminal: TerminalDocumentTerminal,
  meter: Pick<TerminalDocumentOutputMeter, 'beginParse'>
): TerminalDocumentTerminal {
  const write = terminal.write.bind(terminal)
  terminal.write = (data, callback) => {
    const parsed = meter.beginParse()
    write(data, () => {
      parsed()
      callback?.()
    })
  }
  return terminal
}

export const pageTerminalOutputMeter = createTerminalPageOutputMeter({
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(() => callback()),
  cancelFrame: (handle) => cancelAnimationFrame(handle)
})
