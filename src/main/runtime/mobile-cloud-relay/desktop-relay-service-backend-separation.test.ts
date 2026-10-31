import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeRpcServer } from '../runtime-rpc'
import type { MobilePairingConnectionContext } from '../runtime-rpc/runtime-rpc-pairing-types'
import type { RelayDeviceBinding } from './relay-revoke-outbox'

vi.mock('./relay-session-broker', () => {
  type Identity = { userId: string; profileId: string; organizationId: string }
  // Mirrors relayIdentityKey: the owner key the real broker derives from its identity.
  const ownerKey = ({ userId, profileId, organizationId }: Identity) =>
    `${userId}\0${profileId}\0${organizationId}`
  class RelaySessionBroker {
    readonly hostId = 'relay-host-1'
    readonly endpoint = { v: 1 as const, relayHostId: 'relay-host-1', cellUrl: 'https://cell' }
    readonly installCredential = vi.fn(async () => ({ v: 1, reqId: 'install-1' }))
    constructor(readonly ownerIdentityKey: string) {}
    isLive(): boolean {
      return true
    }
    closeNow(): void {}
    static connect = vi.fn(
      async (options: { identity: Identity }) => new RelaySessionBroker(ownerKey(options.identity))
    )
  }
  return { RelaySessionBroker }
})

import { DesktopRelayService } from './desktop-relay-service'
import { relayBackendOwnsBinding, type RelayAuthContext } from './relay-auth-identity'
import { selfHostedRelayAuthContext } from './self-hosted-relay-backend'

const OFFICIAL_OWNER = 'user-1\0profile-1\0org-1'
const SELF_HOSTED_CONTEXT = selfHostedRelayAuthContext({
  origin: 'https://relay.example.com',
  relayHostId: 'relay-host-1',
  accessKey: 'A'.repeat(43)
})
const SELF_HOSTED_OWNER = 'self-hosted\0relay-host-1\0https://relay.example.com'
const OFFICIAL_CONTEXT: RelayAuthContext = {
  identity: { userId: 'user-2', profileId: 'profile-2', organizationId: 'org-2' },
  accessToken: 'access-token',
  relayEntitled: true
}

const services: DesktopRelayService[] = []

function service(context: RelayAuthContext, relayBinding?: RelayDeviceBinding) {
  const setMobileRelayBinding = vi.fn(() => true)
  const device = { deviceId: 'device-1', scope: 'mobile', relayBinding }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the service reads only these runtime members.
  const runtimeRpc = {
    getE2EEKeypair: () => ({
      publicKey: new Uint8Array(32).fill(7),
      secretKey: new Uint8Array(32).fill(9),
      publicKeyB64: 'x'
    }),
    getMobileSocketWiring: () => ({ attachTransport: () => () => {} }),
    getRelayRevokeOutbox: () => ({ pendingFor: () => [], remove: vi.fn() }),
    getDeviceRegistry: () => ({
      listDevices: () => [device],
      getDevice: () => device,
      getMobilePairingConnectionMode: () => 'automatic'
    }),
    setMobileRelayBinding
  } as unknown as OrcaRuntimeRpcServer
  const relayService = new DesktopRelayService({
    backend: {
      provider: context.identity.userId === 'self-hosted' ? 'self-hosted' : 'official',
      endpoints: { relayDirectorUrl: 'https://relay.test', relayTokenEndpoint: 'https://t' },
      readContext: async () => context,
      regionPreference: false
    },
    userDataPath: '/tmp/orca-relay-separation-test',
    appVersion: '1.0.0',
    runtimeRpc,
    onStatus: () => {}
  })
  services.push(relayService)
  return { relayService, setMobileRelayBinding }
}

const direct: MobilePairingConnectionContext = {
  deviceId: 'device-1',
  connectionId: 'conn-1',
  transport: { transport: 'direct' }
}
const provision = { reqId: 'install-1', newResumeTokenHash: 'A'.repeat(43) }

function binding(ownerIdentityKey: string): RelayDeviceBinding {
  return { relayHostId: 'relay-host-1', relayDeviceId: 'device-1', ownerIdentityKey }
}

describe('Relay backend separation', () => {
  afterEach(() => {
    for (const relayService of services.splice(0)) {
      relayService.stop()
    }
  })

  it('does not serve or migrate a phone paired with Orca relay while self-hosted runs', async () => {
    const { relayService, setMobileRelayBinding } = service(
      SELF_HOSTED_CONTEXT,
      binding(OFFICIAL_OWNER)
    )

    await expect(relayService.getEndpoints(direct, {})).resolves.toEqual({ v: 1, relay: null })
    await expect(relayService.provisionRelay(direct, provision)).rejects.toThrow(
      'relay_backend_mismatch'
    )
    expect(setMobileRelayBinding).not.toHaveBeenCalled()
  })

  it('does not serve a phone paired with self-hosted relay while Orca relay runs', async () => {
    const { relayService, setMobileRelayBinding } = service(
      OFFICIAL_CONTEXT,
      binding(SELF_HOSTED_OWNER)
    )

    await expect(relayService.getEndpoints(direct, {})).resolves.toEqual({ v: 1, relay: null })
    await expect(relayService.provisionRelay(direct, provision)).rejects.toThrow(
      'relay_backend_mismatch'
    )
    expect(setMobileRelayBinding).not.toHaveBeenCalled()
  })

  it('serves a phone already bound to the selected self-hosted relay', async () => {
    const { relayService } = service(SELF_HOSTED_CONTEXT, binding(SELF_HOSTED_OWNER))

    await expect(relayService.getEndpoints(direct, {})).resolves.toMatchObject({
      relay: { relayHostId: 'relay-host-1' }
    })
  })

  it('binds an unbound phone to the selected backend', async () => {
    const { relayService, setMobileRelayBinding } = service(SELF_HOSTED_CONTEXT)

    await relayService.provisionRelay(direct, provision)
    expect(setMobileRelayBinding).toHaveBeenCalledWith('device-1', binding(SELF_HOSTED_OWNER))
  })
})

describe('relayBackendOwnsBinding', () => {
  it('keeps official account switches rebinding as before', () => {
    expect(relayBackendOwnsBinding(OFFICIAL_OWNER, 'user-2\0profile-2\0org-2')).toBe(true)
  })

  it('separates self-hosted origins from each other and from Orca relay', () => {
    const other = 'self-hosted\0relay-host-1\0https://other.example.com'
    expect(relayBackendOwnsBinding(SELF_HOSTED_OWNER, SELF_HOSTED_OWNER)).toBe(true)
    expect(relayBackendOwnsBinding(SELF_HOSTED_OWNER, other)).toBe(false)
    expect(relayBackendOwnsBinding(OFFICIAL_OWNER, SELF_HOSTED_OWNER)).toBe(false)
    expect(relayBackendOwnsBinding(SELF_HOSTED_OWNER, OFFICIAL_OWNER)).toBe(false)
  })
})
