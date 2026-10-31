import type { OrcaCloudAuthConfig } from '../../orca-profiles/profile-cloud-auth-config'
import type { MobileRelayBackendProvider } from '../../../shared/mobile-relay-backend'
import { readRelayAuthContext } from './relay-auth-context'
import type { RelayAuthContext } from './relay-auth-identity'
import type { RelayBackendEndpoints } from './relay-session-broker-contract'

export type DesktopRelayBackend = {
  provider: MobileRelayBackendProvider
  endpoints: RelayBackendEndpoints
  readContext: () => Promise<RelayAuthContext | null>
  // Region probes and corrections exist only on Orca's hosted fleet.
  regionPreference: boolean
  fetch?: typeof globalThis.fetch
}

export function officialRelayBackend(
  authConfig: OrcaCloudAuthConfig,
  userDataPath: string
): DesktopRelayBackend {
  return {
    provider: 'official',
    endpoints: authConfig,
    readContext: () => readRelayAuthContext(authConfig, userDataPath),
    regionPreference: true
  }
}
