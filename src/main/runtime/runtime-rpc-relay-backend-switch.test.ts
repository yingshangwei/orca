import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

vi.mock('../git/worktree', () => {
  const worktrees = [
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/foo',
      isBare: false,
      isMainWorktree: false
    }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

describe('OrcaRuntimeRpcServer Relay backend switch', () => {
  it('drops an in-flight offer from the previous Relay backend after a switch', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    let resolveOld: (() => void) | undefined
    const oldMint = new Promise<void>((resolve) => {
      resolveOld = resolve
    })
    const pairingRelayFor =
      (ownerIdentityKey: string, wait?: Promise<void>) => async (relayDeviceId: string) => {
        await wait
        return {
          relay: {
            v: 1 as const,
            directorUrl: 'https://relay.example.com',
            cellUrl: 'https://cell.example.com',
            assignmentEpoch: 7,
            relayHostId: 'AbCdEf0123_-xyZ9',
            inviteToken: 'A'.repeat(43),
            inviteExpiresAt: Date.now() + 60_000,
            e2eeFraming: 2 as const
          },
          binding: { relayHostId: 'AbCdEf0123_-xyZ9', relayDeviceId, ownerIdentityKey }
        }
      }
    const oldCreate = vi.fn(pairingRelayFor('user\0profile\0org', oldMint))
    const newCreate = vi.fn(pairingRelayFor('self-hosted\0host\0https://relay.example.com'))
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay: oldCreate,
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })

    await server.start()
    try {
      const stale = server.createMobilePairingOffer({ address: '100.64.1.20' })
      await vi.waitFor(() => expect(oldCreate).toHaveBeenCalledOnce())
      server.invalidateMobilePairingOffers()
      server.setMobileRelayPairingProvider({
        createPairingRelay: newCreate,
        onDeviceRevokeQueued,
        getEndpoints: vi.fn(),
        provisionRelay: vi.fn()
      })
      // Same address: without invalidation this would coalesce onto the stale request.
      const fresh = server.createMobilePairingOffer({ address: '100.64.1.20' })
      resolveOld?.()
      await expect(stale).resolves.toMatchObject({
        available: false,
        relayFailure: { code: 'relay_request_superseded' }
      })
      await expect(fresh).resolves.toMatchObject({ available: true })
      expect(newCreate).toHaveBeenCalledOnce()
      expect(
        server
          .getDeviceRegistry()
          ?.listDevices()
          .filter((device) => device.scope === 'mobile')
          .map((device) => device.relayBinding?.ownerIdentityKey)
      ).toEqual(['self-hosted\0host\0https://relay.example.com'])
    } finally {
      await server.stop()
    }
  })

  it('invalidates an issued Relay QR on a backend switch while preserving paired and LAN credentials', async () => {
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath: mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-')),
      enableWebSocket: true,
      wsPort: 0
    })
    const onDeviceRevokeQueued = vi.fn()
    server.setMobileRelayPairingProvider({
      createPairingRelay: async (relayDeviceId) => ({
        relay: {
          v: 1,
          directorUrl: 'https://relay.example.com',
          cellUrl: 'https://cell.example.com',
          assignmentEpoch: 7,
          relayHostId: 'AbCdEf0123_-xyZ9',
          inviteToken: 'A'.repeat(43),
          inviteExpiresAt: Date.now() + 60_000,
          e2eeFraming: 2
        },
        binding: {
          relayHostId: 'AbCdEf0123_-xyZ9',
          relayDeviceId,
          ownerIdentityKey: 'user\0profile\0org'
        }
      }),
      onDeviceRevokeQueued,
      getEndpoints: vi.fn(),
      provisionRelay: vi.fn()
    })
    await server.start()
    try {
      const registry = server.getDeviceRegistry()
      const paired = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      if (!registry || !paired.available) {
        throw new Error('Pairing unavailable')
      }
      registry.updateLastSeen(paired.deviceId)
      const pairedDevice = registry.getDevice(paired.deviceId)
      const pending = await server.createMobilePairingOffer({ address: '100.64.1.20' })
      if (!pending.available) {
        throw new Error('Pairing unavailable')
      }
      const pendingToken = registry.getDevice(pending.deviceId)?.token
      if (!pendingToken || !pairedDevice?.token) {
        throw new Error('Pairing token unavailable')
      }

      server.invalidateMobilePairingOffers()

      expect(registry.validateToken(pendingToken)).toBeNull()
      expect(registry.getDevice(pending.deviceId)).toBeNull()
      expect(registry.getDevice(paired.deviceId)).toEqual(pairedDevice)
      expect(registry.validateToken(pairedDevice.token)?.deviceId).toBe(paired.deviceId)
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()

      const local = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      if (!local.available) {
        throw new Error('LAN pairing unavailable')
      }
      const localDevice = registry.getDevice(local.deviceId)
      server.invalidateMobilePairingOffers()
      expect(registry.getDevice(local.deviceId)).toEqual(localDevice)
      expect(onDeviceRevokeQueued).toHaveBeenCalledOnce()
    } finally {
      await server.stop()
    }
  })
})
