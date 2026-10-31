import type { MobilePairingConnectionContext } from '../runtime-rpc/runtime-rpc-pairing-types'
import type { RelaySessionBroker } from './relay-session-broker'

export function assertRelayHost(
  context: MobilePairingConnectionContext,
  broker: Pick<RelaySessionBroker, 'hostId'>
): void {
  if (context.transport.transport === 'relay' && context.transport.relayHostId !== broker.hostId) {
    throw new Error('stale_relay_connection')
  }
}
