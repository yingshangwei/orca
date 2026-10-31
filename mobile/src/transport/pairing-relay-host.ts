import type {
  DeviceCredentialInstalled,
  MobileRelayEndpoint
} from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayPairingJournal } from './mobile-relay-pairing-journal'
import { relayBackendOrigin } from './pairing-backend-scope'
import type { HostProfile } from './types'

export function relayHost(
  journal: MobileRelayPairingJournal,
  relay: MobileRelayEndpoint
): HostProfile {
  const host = journal.metadata.host
  return { ...host, deviceToken: journal.secrets.deviceToken, relay }
}

/** Why: the host id was chosen for the scanned backend; a desktop that switched provider must not repoint that card. */
export function assertRelayEndpointMatchesJournal(
  journal: MobileRelayPairingJournal,
  relay: MobileRelayEndpoint
): void {
  const expected = journal.metadata.relay
  if (
    relay.relayHostId !== expected.relayHostId ||
    relayBackendOrigin(relay.directorUrl) !== relayBackendOrigin(expected.directorUrl)
  ) {
    throw new Error('desktop relay endpoint does not match the scanned relay backend')
  }
}

export function assertCommittedInstall(
  status:
    | { state: 'not-found' }
    | { state: 'committed'; result: DeviceCredentialInstalled }
    | undefined,
  installed: DeviceCredentialInstalled
): void {
  if (
    !status ||
    status.state !== 'committed' ||
    JSON.stringify(status.result) !== JSON.stringify(installed)
  ) {
    throw new Error('relay credential install was not authoritatively reconciled')
  }
}
