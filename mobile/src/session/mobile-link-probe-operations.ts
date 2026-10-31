import {
  MOBILE_LINK_PROBE_METHOD,
  MobileLinkProbeResultSchema,
  type MobileLinkProbeResult
} from '../../../src/shared/mobile-link-probe-contract'
import { defineRpcOperation, runRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'

const mobileLinkProbe = defineRpcOperation({
  name: 'mobile.link-probe',
  method: MOBILE_LINK_PROBE_METHOD,
  acceptance: 'object-result-or-null',
  barrier: 'on-settle',
  read: rpcResultVariant('link-probe', MobileLinkProbeResultSchema)
})

/**
 * One probe, or null when the host refused or answered something unreadable.
 *
 * `failWhenDisconnected`: a reply replayed after a reconnect would time the outage, not the link.
 */
export function requestMobileLinkProbe(
  client: UnvalidatedRpcRequestPort,
  timeoutMs: number
): Promise<MobileLinkProbeResult | null> {
  return runRpcOperation(client, mobileLinkProbe, undefined, {
    timeoutMs,
    failWhenDisconnected: true
  })
}
