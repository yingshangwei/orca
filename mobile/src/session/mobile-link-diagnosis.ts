import type { MobileLinkSnapshot } from './mobile-link-sampler'

// First guesses, to be calibrated against the device scenarios in
// docs/bug-reproductions/mobile-link-performance/README.md.
export const LINK_DESKTOP_BACKLOG_BYTES = 64 * 1024
export const LINK_DESKTOP_LOOP_P99_MS = 100
export const LINK_PAGE_FRAME_GAP_P95_MS = 50
export const LINK_PAGE_PENDING_AGE_MS = 500
export const LINK_SHELL_RTT_MS = 100
export const LINK_SLOW_RTT_MS = 400

/**
 * What a reading can show, strongest first. There is deliberately no "network" cause: nothing here
 * measures the network by itself, and a slow round trip with clean queues is only unexplained.
 *
 * Output the phone app holds stays out of this too: it is one instant's byte count, and bytes on
 * their way through look the same as bytes stuck, so only time-based readings name the phone.
 */
export type MobileLinkCause = 'output-backlog' | 'desktop-busy' | 'phone-busy' | 'link-slow'

export const MOBILE_LINK_CAUSE_LABELS: Readonly<Record<MobileLinkCause, string>> = {
  'output-backlog': 'Output backlog',
  'desktop-busy': 'Desktop busy',
  'phone-busy': 'Phone busy',
  'link-slow': 'Link slow, cause unknown'
}

export function diagnoseMobileLink(snapshot: MobileLinkSnapshot): MobileLinkCause[] {
  const { host, page, phase, rttMs, shell } = snapshot
  const causes: MobileLinkCause[] = []
  const outbound = host?.outbound
  if (
    outbound &&
    outbound.queuedBytes + outbound.socketBufferedBytes >= LINK_DESKTOP_BACKLOG_BYTES
  ) {
    causes.push('output-backlog')
  }
  if (host?.eventLoop && host.eventLoop.p99Ms >= LINK_DESKTOP_LOOP_P99_MS) {
    causes.push('desktop-busy')
  }
  if (
    (page?.frameGap && page.frameGap.p95Ms >= LINK_PAGE_FRAME_GAP_P95_MS) ||
    (page?.oldestPendingMs ?? 0) >= LINK_PAGE_PENDING_AGE_MS ||
    (shell?.rttMs ?? 0) >= LINK_SHELL_RTT_MS
  ) {
    causes.push('phone-busy')
  }
  const slow = phase === 'timed-out' || (rttMs !== null && rttMs >= LINK_SLOW_RTT_MS)
  if (slow && causes.length === 0) {
    causes.push('link-slow')
  }
  return causes
}
