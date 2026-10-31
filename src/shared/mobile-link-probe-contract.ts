import { z } from 'zod'

export const MOBILE_LINK_PROBE_METHOD = 'mobile.linkProbe'

// Why: a phone probes only after this, so an older desktop never sees a timed refused request.
export const MOBILE_LINK_PROBE_RUNTIME_CAPABILITY = 'mobile.link-probe.v1' as const

const measurement = z.number().nonnegative()

/** This socket's replies and output ahead of the probe's own reply, read in the handler. */
export const MobileLinkOutboundEvidenceSchema = z.object({
  queuedBytes: measurement,
  queuedFrames: measurement,
  socketBufferedBytes: measurement
})

export type MobileLinkOutboundEvidence = z.infer<typeof MobileLinkOutboundEvidenceSchema>

/** Main-process event-loop delay since the previous probe, beyond the sampling interval. */
export const MobileLinkEventLoopWindowSchema = z.object({
  p99Ms: measurement,
  maxMs: measurement,
  windowMs: measurement,
  samples: measurement
})

export type MobileLinkEventLoopWindow = z.infer<typeof MobileLinkEventLoopWindowSchema>

// Numbers only: no terminal, workspace or device identity may ride this reply.
export const MobileLinkProbeResultSchema = z.object({
  outbound: MobileLinkOutboundEvidenceSchema.nullable(),
  eventLoop: MobileLinkEventLoopWindowSchema.nullable()
})

export type MobileLinkProbeResult = z.infer<typeof MobileLinkProbeResultSchema>
