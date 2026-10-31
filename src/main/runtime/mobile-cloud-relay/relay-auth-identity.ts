import type { RelayIdentity } from './relay-session-broker-contract'

export type RelayAuthContext = {
  identity: RelayIdentity
  accessToken: string
  relayEntitled: boolean
}

export const SELF_HOSTED_RELAY_USER_ID = 'self-hosted'

// The one key that ties brokers, demand and revokes to the account that owns them.
export function relayIdentityKey(identity: RelayIdentity): string {
  return `${identity.userId}\0${identity.profileId}\0${identity.organizationId}`
}

function isSelfHostedRelayIdentityKey(key: string): boolean {
  return key.startsWith(`${SELF_HOSTED_RELAY_USER_ID}\0`)
}

/**
 * Whether a device bound under `bindingOwnerKey` may be served or rebound by the
 * broker owning `brokerOwnerKey`. Official account switches still rebind as
 * before; a phone never migrates between Orca's relay and a self-hosted one.
 */
export function relayBackendOwnsBinding(bindingOwnerKey: string, brokerOwnerKey: string): boolean {
  if (bindingOwnerKey === brokerOwnerKey) {
    return true
  }
  return (
    !isSelfHostedRelayIdentityKey(bindingOwnerKey) && !isSelfHostedRelayIdentityKey(brokerOwnerKey)
  )
}
