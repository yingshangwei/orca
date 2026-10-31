import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveMobileRelayEndpoint } from './mobile-relay-resume-director'
import { resolvePairingInviteThroughDirector } from './mobile-relay-invite-director'
import { connectMobileRelayForPairing } from './mobile-relay-physical-client'
import { connectMobileRelayRpcSession } from './mobile-relay-rpc-session'

const relay = {
  v: 1 as const,
  directorUrl: 'https://relay.example.com',
  cellUrl: 'https://relay.example.com',
  assignmentEpoch: 1,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const,
  inviteToken: 'A'.repeat(43),
  inviteExpiresAt: Date.now() + 300_000
}

afterEach(() => vi.unstubAllEnvs())

describe('self-hosted mobile origin boundary', () => {
  it.each(['https://10.0.0.1', 'https://relay.example.com:8443'])(
    'rejects pairing and resume dials to %s before creating a socket',
    (cellUrl) => {
      vi.stubEnv('EXPO_PUBLIC_ORCA_SELF_HOSTED_BUILD', '1')
      const createSocket = vi.fn()
      const common = {
        relay: { ...relay, cellUrl },
        deviceToken: 'device-token',
        desktopPublicKeyB64: 'unused',
        createSocket
      }
      expect(() => connectMobileRelayForPairing(common)).toThrow('relay_cell_origin_not_allowed')
      expect(() =>
        connectMobileRelayRpcSession({
          ...common,
          resumeToken: 'B'.repeat(43),
          resumeCredentialVersion: 1,
          resumeConfirmReqId: 'resume'
        })
      ).toThrow('relay_cell_origin_not_allowed')
      expect(createSocket).not.toHaveBeenCalled()
    }
  )

  it('accepts a same-origin resolve and rejects a foreign resolve in the self-hosted build', async () => {
    vi.stubEnv('EXPO_PUBLIC_ORCA_SELF_HOSTED_BUILD', '1')
    const resolve = (cellUrl: string) =>
      resolveMobileRelayEndpoint({
        relay,
        resumeToken: 'B'.repeat(43),
        fetchImpl: async () =>
          Response.json({ v: 1, cellUrl, assignmentEpoch: 2, leaseExpiresAt: Date.now() + 60_000 })
      })
    await expect(resolve(relay.directorUrl)).resolves.toMatchObject({ cellUrl: relay.directorUrl })
    await expect(resolve('https://10.0.0.1')).rejects.toThrow('relay_cell_origin_not_allowed')
    vi.stubEnv('EXPO_PUBLIC_ORCA_SELF_HOSTED_BUILD', '')
    await expect(resolve('https://official-cell.example.com')).resolves.toMatchObject({
      cellUrl: 'https://official-cell.example.com'
    })
  })

  it('rejects a foreign director move while pairing', async () => {
    vi.stubEnv('EXPO_PUBLIC_ORCA_SELF_HOSTED_BUILD', '1')
    const socket: {
      onopen: ((event: Event) => void) | null
      onmessage: ((event: { data: string }) => void) | null
      onerror: ((event: Event) => void) | null
      onclose: ((event: CloseEvent) => void) | null
      close: ReturnType<typeof vi.fn>
      send: ReturnType<typeof vi.fn>
    } = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      close: vi.fn(),
      send: vi.fn()
    }
    const resolving = resolvePairingInviteThroughDirector({
      relay,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture implements all callbacks exercised by the director.
      createSocket: () => socket as unknown as WebSocket
    })
    const receive = socket.onmessage
    if (!receive) {
      throw new Error('Director did not attach its message handler')
    }
    receive({
      data: JSON.stringify({
        type: 'relay-moved',
        v: 1,
        cellUrl: 'https://10.0.0.1',
        assignmentEpoch: 2
      })
    })
    await expect(resolving).rejects.toThrow('relay_cell_origin_not_allowed')
    expect(socket.close).toHaveBeenCalled()
  })
})
