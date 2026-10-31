import { createEventLoopDelayWindow } from '../../../diagnostics/event-loop-delay-window'
import {
  MOBILE_LINK_PROBE_METHOD,
  type MobileLinkProbeResult
} from '../../../../shared/mobile-link-probe-contract'
import { defineMethod } from '../core'

const mainEventLoopDelay = createEventLoopDelayWindow()

/**
 * The phone's link probe: a read of what is ahead of this reply and how late this process runs.
 *
 * Answered here and nowhere further, so it cannot reach a PTY or an agent and no model's time can
 * land in the round trip the phone measures around it.
 */
export const MOBILE_LINK_PROBE_METHODS = [
  defineMethod({
    name: MOBILE_LINK_PROBE_METHOD,
    permission: 'workspace',
    params: null,
    handler: async (_params, { mobileOutboundEvidence }): Promise<MobileLinkProbeResult> => ({
      outbound: mobileOutboundEvidence?.() ?? null,
      eventLoop: mainEventLoopDelay.read()
    })
  })
]
