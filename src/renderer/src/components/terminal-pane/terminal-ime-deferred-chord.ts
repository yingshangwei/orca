import {
  sendTerminalInputAfterComposition,
  type TerminalImeKeyIdentity
} from './terminal-ime-deferred-newline'

/**
 * Ceiling on the otherwise indefinite wait. Generous enough for a conversion candidate window,
 * which can stay open for seconds; a chord that outlives it is discarded rather than sent late,
 * because firing mid-preedit is the corruption the wait exists to prevent (#12871).
 */
export const TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS = 10_000

export type TerminalImeDeferredChordSender = {
  defer: (
    chord: TerminalImeKeyIdentity,
    terminalElement: HTMLElement | null | undefined,
    send: () => void
  ) => void
  absorbReplay: (chord: TerminalImeKeyIdentity) => boolean
  cancelPending: () => void
}

/**
 * Owns every chord held for a live composition so blur and pane teardown can drop them. An
 * unowned deferral has no exit when compositionend never arrives: its listeners outlive the pane
 * and a later composition flushes the stale chord against a rebound terminal.
 */
export function createTerminalImeDeferredChordSender(): TerminalImeDeferredChordSender {
  const pendingStops = new Set<() => void>()
  let replayableChord: TerminalImeKeyIdentity | null = null

  return {
    defer: (chord, terminalElement, send) => {
      replayableChord = { code: chord.code, timeStamp: chord.timeStamp }
      let abandonTimer: number | undefined
      let stopComposingWait: (() => void) | null = null
      const stopWaiting = (): void => {
        window.clearTimeout(abandonTimer)
        pendingStops.delete(stopWaiting)
        stopComposingWait?.()
      }
      abandonTimer = window.setTimeout(stopWaiting, TERMINAL_IME_DEFERRED_CHORD_ABANDON_MS)
      pendingStops.add(stopWaiting)
      stopComposingWait = sendTerminalInputAfterComposition(
        terminalElement,
        () => {
          stopWaiting()
          send()
        },
        { fallbackMs: null }
      )
    },
    absorbReplay: (chord) => {
      const owed = replayableChord
      replayableChord = null
      return owed?.code === chord.code && owed.timeStamp === chord.timeStamp
    },
    cancelPending: () => {
      replayableChord = null
      // Each stop removes itself; deleting the visited entry is safe for a Set iterator.
      for (const stopWaiting of pendingStops) {
        stopWaiting()
      }
      pendingStops.clear()
    }
  }
}
