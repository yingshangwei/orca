import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toStoredMobileRelayHostOverlay } from './mobile-relay-host-overlay'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

const secureStoreMock = vi.hoisted(() => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn()
}))

const scheduleCleanupMock = vi.hoisted(() => vi.fn())
const cancelCleanupMock = vi.hoisted(() => vi.fn())
const recordCleanupIntentMock = vi.hoisted(() => vi.fn())
const platformMock = vi.hoisted(() => ({ OS: 'ios' }))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: asyncStorageMock
}))

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStoreMock
}))

vi.mock('react-native', () => ({
  Platform: platformMock
}))

vi.mock('./host-credential-cleanup', () => ({
  cancelPendingHostCredentialCleanup: (...args: unknown[]) => cancelCleanupMock(...args),
  recordHostCredentialCleanupIntent: (...args: unknown[]) => recordCleanupIntentMock(...args),
  scheduleHostCredentialCleanup: (...args: unknown[]) => scheduleCleanupMock(...args),
  retryPendingHostCredentialCleanups: vi.fn()
}))

import {
  loadHosts,
  resolvePairingHostIdentity,
  resetHostStoreForTests,
  savePairedHost
} from './host-store'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'

const HOSTS_STORAGE_KEY = 'orca:hosts'
const OVERLAY_STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
const HOST_ONE = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  publicKeyB64: 'key',
  lastConnected: 0
}
const HOST_TWO = {
  id: 'host-2',
  name: 'Host 2',
  endpoint: 'ws://127.0.0.1:2',
  publicKeyB64: 'key-2',
  lastConnected: 0
}
const HOST_ONE_RELAY = {
  v: 1 as const,
  directorUrl: 'https://relay.onorca.dev',
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 7,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
}
const SELF_HOSTED_RELAY = {
  ...HOST_ONE_RELAY,
  directorUrl: 'https://relay.example.com',
  cellUrl: 'https://relay-cell.example.com',
  assignmentEpoch: 1
}

describe('host-store relay backend scoping', () => {
  let storedHostsRaw: string
  let storedOverlayRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
    platformMock.OS = 'ios'
    resetMobileRelayHostOverlayStoreForTests()
    scheduleCleanupMock.mockReset()
    scheduleCleanupMock.mockResolvedValue(undefined)
    cancelCleanupMock.mockReset()
    cancelCleanupMock.mockResolvedValue(undefined)
    recordCleanupIntentMock.mockReset()
    recordCleanupIntentMock.mockResolvedValue(undefined)
    storedHostsRaw = JSON.stringify([HOST_ONE, HOST_TWO])
    storedOverlayRaw = null
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        return storedHostsRaw
      }
      if (key === OVERLAY_STORAGE_KEY) {
        return storedOverlayRaw
      }
      return null
    })
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        storedHostsRaw = raw
      } else if (key === OVERLAY_STORAGE_KEY) {
        storedOverlayRaw = raw
      }
    })
    secureStoreMock.setItemAsync.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockImplementation(async (key: string) =>
      key.endsWith(HOST_ONE.id) || key.endsWith(HOST_TWO.id) ? `token-${key.at(-1)}` : null
    )
  })

  function useKeychain(entries: Record<string, string>): Map<string, string> {
    const keychain = new Map(Object.entries(entries))
    secureStoreMock.setItemAsync.mockImplementation(async (key: string, value: string) => {
      keychain.set(key, value)
    })
    secureStoreMock.getItemAsync.mockImplementation(
      async (key: string) => keychain.get(key) ?? null
    )
    return keychain
  }

  it('keeps official and self-hosted pairings of one desktop as separate hosts', async () => {
    storedHostsRaw = JSON.stringify([HOST_ONE])
    storedOverlayRaw = JSON.stringify([toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY)])
    useKeychain({ 'orca.host-token.host-1': 'official-token' })

    const selfHosted = await resolvePairingHostIdentity(
      HOST_ONE.publicKeyB64,
      'host-self',
      SELF_HOSTED_RELAY.directorUrl
    )
    expect(selfHosted.id).toBe('host-self')
    await savePairedHost({
      ...HOST_ONE,
      ...selfHosted,
      deviceToken: 'self-token',
      relay: SELF_HOSTED_RELAY
    })
    // Why: a fresh process has no token cache, so both credentials must come back off the keychain.
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    const hosts = await loadHosts()

    expect(hosts.map(({ id, deviceToken, relay }) => ({ id, deviceToken, relay }))).toEqual([
      { id: HOST_ONE.id, deviceToken: 'official-token', relay: HOST_ONE_RELAY },
      { id: 'host-self', deviceToken: 'self-token', relay: SELF_HOSTED_RELAY }
    ])
    expect(recordCleanupIntentMock).not.toHaveBeenCalledWith(HOST_ONE.id)
    expect(scheduleCleanupMock).not.toHaveBeenCalledWith(HOST_ONE.id, expect.anything())
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
    await expect(
      resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-new', HOST_ONE_RELAY.directorUrl)
    ).resolves.toMatchObject({ id: HOST_ONE.id })
    await expect(
      resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-new', SELF_HOSTED_RELAY.directorUrl)
    ).resolves.toMatchObject({ id: 'host-self' })
  })

  it('collapses same-backend duplicates on re-pair without touching another backend', async () => {
    const duplicate = { ...HOST_TWO, id: 'host-duplicate', publicKeyB64: HOST_ONE.publicKeyB64 }
    const selfHosted = { ...HOST_TWO, id: 'host-self', publicKeyB64: HOST_ONE.publicKeyB64 }
    storedHostsRaw = JSON.stringify([HOST_ONE, duplicate, selfHosted])
    storedOverlayRaw = JSON.stringify([
      toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY),
      toStoredMobileRelayHostOverlay(duplicate.id, HOST_ONE_RELAY),
      toStoredMobileRelayHostOverlay(selfHosted.id, SELF_HOSTED_RELAY)
    ])

    await savePairedHost({ ...HOST_ONE, deviceToken: 'replacement-token', relay: HOST_ONE_RELAY })

    expect(JSON.parse(storedHostsRaw).map(({ id }: { id: string }) => id)).toEqual([
      HOST_ONE.id,
      selfHosted.id
    ])
    expect(scheduleCleanupMock).toHaveBeenCalledWith(duplicate.id, expect.any(Function))
    expect(recordCleanupIntentMock).not.toHaveBeenCalledWith(selfHosted.id)
    expect(JSON.parse(storedOverlayRaw!)).toEqual([
      toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY),
      toStoredMobileRelayHostOverlay(selfHosted.id, SELF_HOSTED_RELAY)
    ])
  })

  it('upgrades a lone pre-relay host in place for any backend', async () => {
    storedHostsRaw = JSON.stringify([HOST_ONE])

    await expect(
      resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-new', SELF_HOSTED_RELAY.directorUrl)
    ).resolves.toMatchObject({ id: HOST_ONE.id })
  })

  it('does not hand a pre-relay row to a backend once another backend owns the desktop', async () => {
    const legacy = { ...HOST_TWO, id: 'host-legacy', publicKeyB64: HOST_ONE.publicKeyB64 }
    storedHostsRaw = JSON.stringify([HOST_ONE, legacy])
    storedOverlayRaw = JSON.stringify([toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY)])

    await expect(
      resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-new', SELF_HOSTED_RELAY.directorUrl)
    ).resolves.toMatchObject({ id: 'host-new' })
    // A direct-only re-pair reuses the pre-relay row rather than stripping a backend's routing.
    await expect(
      resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-new')
    ).resolves.toMatchObject({ id: legacy.id })
  })

  it('adds a direct-only pairing beside a lone official host without stripping its relay', async () => {
    storedHostsRaw = JSON.stringify([HOST_ONE])
    storedOverlayRaw = JSON.stringify([toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY)])
    useKeychain({ 'orca.host-token.host-1': 'official-token' })

    const identity = await resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-direct')
    await savePairedHost({ ...HOST_ONE, ...identity, deviceToken: 'direct-token' })
    resetHostStoreForTests()
    resetMobileRelayHostOverlayStoreForTests()
    const hosts = await loadHosts()

    expect(identity.id).toBe('host-direct')
    expect(hosts.map(({ id, deviceToken, relay }) => ({ id, deviceToken, relay }))).toEqual([
      { id: HOST_ONE.id, deviceToken: 'official-token', relay: HOST_ONE_RELAY },
      { id: 'host-direct', deviceToken: 'direct-token', relay: undefined }
    ])
    expect(JSON.parse(storedOverlayRaw!)).toEqual([
      toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY)
    ])
    expect(recordCleanupIntentMock).not.toHaveBeenCalled()
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('adds a direct-only pairing beside two backends without removing either', async () => {
    const selfHosted = { ...HOST_TWO, id: 'host-self', publicKeyB64: HOST_ONE.publicKeyB64 }
    storedHostsRaw = JSON.stringify([HOST_ONE, selfHosted])
    storedOverlayRaw = JSON.stringify([
      toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY),
      toStoredMobileRelayHostOverlay(selfHosted.id, SELF_HOSTED_RELAY)
    ])

    const identity = await resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-direct')
    await savePairedHost({ ...HOST_ONE, ...identity, deviceToken: 'direct-token' })

    expect(identity.id).toBe('host-direct')
    expect(JSON.parse(storedHostsRaw).map(({ id }: { id: string }) => id)).toEqual([
      HOST_ONE.id,
      selfHosted.id,
      'host-direct'
    ])
    expect(recordCleanupIntentMock).not.toHaveBeenCalled()
    expect(JSON.parse(storedOverlayRaw!)).toHaveLength(2)
  })

  it.each([
    '{',
    JSON.stringify([{ hostId: HOST_ONE.id, relay: HOST_ONE_RELAY }]),
    JSON.stringify([
      toStoredMobileRelayHostOverlay(HOST_ONE.id, HOST_ONE_RELAY),
      toStoredMobileRelayHostOverlay(HOST_ONE.id, SELF_HOSTED_RELAY)
    ])
  ])('fails pairing closed on unreadable or ambiguous relay routing (%#)', async (unreadable) => {
    const selfHosted = { ...HOST_TWO, id: 'host-self', publicKeyB64: HOST_ONE.publicKeyB64 }
    storedHostsRaw = JSON.stringify([HOST_ONE, selfHosted])
    storedOverlayRaw = unreadable
    const hostsBefore = storedHostsRaw

    await expect(
      resolvePairingHostIdentity(HOST_ONE.publicKeyB64, 'host-new', SELF_HOSTED_RELAY.directorUrl)
    ).rejects.toThrow(/unreadable/)
    await expect(
      savePairedHost({ ...HOST_ONE, deviceToken: 'replacement-token', relay: HOST_ONE_RELAY })
    ).rejects.toThrow(/unreadable/)

    expect(storedHostsRaw).toBe(hostsBefore)
    expect(storedOverlayRaw).toBe(unreadable)
    expect(recordCleanupIntentMock).not.toHaveBeenCalled()
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })
})
