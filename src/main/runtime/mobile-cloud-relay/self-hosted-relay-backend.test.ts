import { describe, expect, it, vi } from 'vitest'
import { deriveRelayHostId, exchangeRelayAuthorization } from './relay-http-client'
import {
  createNoRedirectFetch,
  selfHostedRelayAuthContext,
  selfHostedRelayEndpoints
} from './self-hosted-relay-backend'
import { relayIdentityKey } from './relay-auth-identity'

const ACCESS_KEY = 'A'.repeat(43)
const keypair = {
  publicKey: new Uint8Array(32).fill(3),
  secretKey: new Uint8Array(32).fill(4),
  publicKeyB64: 'host-public-key'
}

describe('self-hosted relay backend', () => {
  it('exchanges the access key at its own origin without following redirects', async () => {
    const baseFetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ relayToken: 'relay-jwt', expiresAt: 1_700_000_000_000 }))
    )
    const endpoints = selfHostedRelayEndpoints('https://relay.example.com')

    await expect(
      exchangeRelayAuthorization({
        endpoint: endpoints.relayTokenEndpoint,
        accessToken: ACCESS_KEY,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the exchange reads only the public key fields.
        keypair: keypair as never,
        fetch: createNoRedirectFetch(baseFetch)
      })
    ).resolves.toEqual({ relayToken: 'relay-jwt', expiresAt: 1_700_000_000_000 })

    const [url, init] = baseFetch.mock.calls[0]!
    expect(url).toBe('https://relay.example.com/v1/self-hosted/token')
    expect(init?.redirect).toBe('error')
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${ACCESS_KEY}`)
    expect(JSON.parse(String(init?.body))).toEqual({
      relayHostId: deriveRelayHostId(keypair.publicKey),
      hostPublicKeyB64: 'host-public-key'
    })
    expect(endpoints.relayDirectorUrl).toBe('https://relay.example.com')
  })

  it('gives each relay origin its own owner identity', () => {
    const at = (origin: string) =>
      relayIdentityKey(
        selfHostedRelayAuthContext({ origin, relayHostId: 'host', accessKey: ACCESS_KEY }).identity
      )
    expect(at('https://a.example.com')).not.toBe(at('https://b.example.com'))
  })
})
