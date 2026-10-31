import type { RelayAuthContext } from './relay-auth-identity'
import { SELF_HOSTED_RELAY_USER_ID } from './relay-auth-identity'
import type { RelayBackendEndpoints } from './relay-session-broker-contract'

// A self-hosted relay runs director and cell as one combined service at its origin.
export function selfHostedRelayEndpoints(origin: string): RelayBackendEndpoints {
  return {
    relayDirectorUrl: origin,
    relayTokenEndpoint: `${origin}/v1/self-hosted/token`,
    relayCellOrigin: origin
  }
}

export function selfHostedRelayAuthContext(input: {
  origin: string
  relayHostId: string
  accessKey: string
}): RelayAuthContext {
  return {
    // Why origin in the identity: pairings, demand and revokes stay with the
    // relay that issued them when the user points this desktop elsewhere.
    identity: {
      userId: SELF_HOSTED_RELAY_USER_ID,
      profileId: input.relayHostId,
      organizationId: input.origin
    },
    accessToken: input.accessKey,
    relayEntitled: true
  }
}

/** A redirect would replay the access key to an origin the user never configured. */
export function createNoRedirectFetch(
  baseFetch: typeof globalThis.fetch = globalThis.fetch
): typeof globalThis.fetch {
  return (input, init) => baseFetch(input, { ...init, redirect: 'error' })
}
