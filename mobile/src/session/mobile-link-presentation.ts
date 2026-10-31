import { diagnoseMobileLink, MOBILE_LINK_CAUSE_LABELS } from './mobile-link-diagnosis'
import { LINK_PROBE_TIMEOUT_MS, type MobileLinkSnapshot } from './mobile-link-sampler'

export const MOBILE_LINK_ROW_NOT_MEASURED = 'Not measured'

export type MobileLinkDetailRow = { label: string; value: string; note: string }

const TIMED_OUT_LABEL = `> ${LINK_PROBE_TIMEOUT_MS / 1_000} s`

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KiB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function roundTripLabel(snapshot: MobileLinkSnapshot): string | null {
  switch (snapshot.phase) {
    case 'live':
      return snapshot.rttMs === null ? '—' : `${snapshot.rttMs} ms`
    case 'timed-out':
      return TIMED_OUT_LABEL
    case 'measuring':
    case 'failed':
      return '—'
    case 'off':
    case 'unsupported':
      return null
  }
}

/** The header's few words: the round trip, then the strongest cause if a reading shows one. */
export function mobileLinkHeaderText(snapshot: MobileLinkSnapshot): string | null {
  const roundTrip = roundTripLabel(snapshot)
  const cause = diagnoseMobileLink(snapshot)[0]
  const parts = [roundTrip, cause ? MOBILE_LINK_CAUSE_LABELS[cause] : null]
  const shown = parts.filter((part) => part !== null)
  return shown.length > 0 ? shown.join(' · ') : null
}

function roundTripRow(snapshot: MobileLinkSnapshot): MobileLinkDetailRow {
  const note =
    'This page to the desktop process and back, including the phone app, encryption, relay and any queued output. It is not network time alone and not typing delay.'
  if (snapshot.phase === 'unsupported') {
    return {
      label: 'App round trip',
      value: MOBILE_LINK_ROW_NOT_MEASURED,
      note: 'Update the desktop app to measure this.'
    }
  }
  const value =
    snapshot.phase === 'live' && snapshot.rttLastMs !== null
      ? `${snapshot.rttMs} ms median · ${snapshot.rttLastMs} ms last · ${snapshot.rttSamples} samples`
      : (roundTripLabel(snapshot) ?? '—')
  return { label: 'App round trip', value, note }
}

function desktopQueueRow({ host }: MobileLinkSnapshot): MobileLinkDetailRow {
  const outbound = host?.outbound
  return {
    label: 'Desktop send queue',
    value: outbound
      ? `${formatBytes(outbound.queuedBytes)} queued · ${formatBytes(outbound.socketBufferedBytes)} in socket`
      : MOBILE_LINK_ROW_NOT_MEASURED,
    note: 'Output waiting ahead of this reply when the desktop read it. Bytes already in the operating system or the relay are not visible here.'
  }
}

function desktopLoopRow({ host }: MobileLinkSnapshot): MobileLinkDetailRow {
  const loop = host?.eventLoop
  return {
    label: 'Desktop main process delay',
    value: loop
      ? `p99 ${Math.round(loop.p99Ms)} ms · max ${Math.round(loop.maxMs)} ms`
      : MOBILE_LINK_ROW_NOT_MEASURED,
    note: 'How late the desktop process ran its timers since the last sample. It does not show why.'
  }
}

function pageFrameRow({ page }: MobileLinkSnapshot): MobileLinkDetailRow {
  const gap = page?.frameGap
  return {
    label: 'Page frame gap',
    value: gap ? `p95 ${gap.p95Ms} ms · max ${gap.maxMs} ms` : MOBILE_LINK_ROW_NOT_MEASURED,
    note: gap
      ? 'Time between page frames during output or scrolling in the last 10 s. Frames the GPU presented are not measured.'
      : 'Sampled only during output or scrolling.'
  }
}

function pagePendingRow({ page }: MobileLinkSnapshot): MobileLinkDetailRow {
  if (!page || page.documents === 0) {
    return {
      label: 'Waiting to parse',
      value: MOBILE_LINK_ROW_NOT_MEASURED,
      note: 'No terminal is open in this page.'
    }
  }
  const age = page.oldestPendingMs === null ? '' : ` · oldest ${page.oldestPendingMs} ms`
  const rate =
    page.receivedCharsPerSecond === null
      ? ''
      : ` · ${Math.round(page.receivedCharsPerSecond / 1024)} K chars/s in`
  return {
    label: 'Waiting to parse',
    value: `${Math.round(page.pendingChars / 1024)} K chars${age}${rate}`,
    note: 'Output the page has received and the terminal has not parsed yet. Output still on its way to the page is not included.'
  }
}

function phoneAppRow({ shell, shellAvailable }: MobileLinkSnapshot): MobileLinkDetailRow {
  if (!shellAvailable) {
    return {
      label: 'Phone app hop',
      value: MOBILE_LINK_ROW_NOT_MEASURED,
      note: 'Update the phone app to measure this.'
    }
  }
  return {
    label: 'Phone app hop',
    value: shell
      ? `${shell.rttMs} ms · ${formatBytes(shell.heldOutputBytes)} held`
      : MOBILE_LINK_ROW_NOT_MEASURED,
    note: 'This page to the phone app and back, and output the app held for the page at that moment. Held output is normal while output flows and is not a slowdown by itself.'
  }
}

export function mobileLinkDetailRows(snapshot: MobileLinkSnapshot): MobileLinkDetailRow[] {
  return [
    roundTripRow(snapshot),
    desktopQueueRow(snapshot),
    desktopLoopRow(snapshot),
    pageFrameRow(snapshot),
    pagePendingRow(snapshot),
    phoneAppRow(snapshot),
    {
      label: 'Mobile network alone',
      value: MOBILE_LINK_ROW_NOT_MEASURED,
      note: 'The phone-to-relay and relay-to-desktop legs are not separated.'
    }
  ]
}

/** The sentence over the rows: a named cause, or plainly that none was shown. */
export function mobileLinkSummary(snapshot: MobileLinkSnapshot): string {
  const causes = diagnoseMobileLink(snapshot)
  if (causes.length > 0) {
    return causes.map((cause) => MOBILE_LINK_CAUSE_LABELS[cause]).join(' · ')
  }
  if (snapshot.phase === 'failed') {
    return 'The last measurement could not be completed.'
  }
  return snapshot.phase === 'live' ? 'No slowdown shown by these readings.' : 'No reading yet.'
}
