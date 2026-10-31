import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { loadHosts, resetHostStoreForTests, savePairedHost } from './host-store'
import { resetMobileRelayHostOverlayStoreForTests } from './mobile-relay-host-overlay-store'

const HOSTS_STORAGE_KEY = 'orca:hosts'

describe('host-store pairing save after an Android encryption rejection', () => {
  const NEW_HOST = {
    id: 'host-1782629088232',
    name: 'Host 1',
    endpoint: 'ws://192.168.0.56:6769',
    publicKeyB64: 'desktop-key',
    lastConnected: 0,
    deviceToken: 'device-token'
  }
  // Why: the verbatim Android rejection from #6600 — expo maps a null-message GeneralSecurityException to this.
  const ENCRYPT_REJECTION = new Error(
    "Could not encrypt the value for key 'orca.host-token.host-1782629088232' under keychain 'key_v1'. Caused by: unknown"
  )
  const GENERATION_KEY = 'orca:pairing-keychain-generation'
  let storedHostsRaw: string
  let storedGenerationRaw: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetHostStoreForTests()
    platformMock.OS = 'android'
    resetMobileRelayHostOverlayStoreForTests()
    scheduleCleanupMock.mockReset()
    scheduleCleanupMock.mockResolvedValue(undefined)
    cancelCleanupMock.mockReset()
    cancelCleanupMock.mockResolvedValue(undefined)
    recordCleanupIntentMock.mockReset()
    recordCleanupIntentMock.mockResolvedValue(undefined)
    storedHostsRaw = '[]'
    storedGenerationRaw = null
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        return storedHostsRaw
      }
      // Why: the generation record is durable on device; a forgetful mock would fake a broken read path.
      return key === GENERATION_KEY ? storedGenerationRaw : null
    })
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === HOSTS_STORAGE_KEY) {
        storedHostsRaw = raw
      } else if (key === GENERATION_KEY) {
        storedGenerationRaw = raw
      }
    })
    secureStoreMock.deleteItemAsync.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockResolvedValue(null)
  })

  it('saves the host when the reported Android failure is alias-local (#6600)', async () => {
    const written = new Map<string | undefined, string>()
    // Why: simulate the unverified alias-local case; no affected physical device was available.
    secureStoreMock.setItemAsync.mockImplementation(
      async (_key: string, value: string, options?: { keychainService?: string }) => {
        if (options?.keychainService === undefined) {
          throw ENCRYPT_REJECTION
        }
        written.set(options.keychainService, value)
      }
    )

    await expect(savePairedHost(NEW_HOST)).resolves.toBeUndefined()

    expect(written.get('orca.pairing.v1')).toBe('device-token')
    expect(JSON.parse(storedHostsRaw)).toEqual([
      {
        id: NEW_HOST.id,
        name: NEW_HOST.name,
        endpoint: NEW_HOST.endpoint,
        publicKeyB64: NEW_HOST.publicKeyB64,
        lastConnected: NEW_HOST.lastConnected
      }
    ])
  })

  it('still surfaces the failure when no keystore alias can accept the token', async () => {
    secureStoreMock.setItemAsync.mockRejectedValue(ENCRYPT_REJECTION)

    await expect(savePairedHost(NEW_HOST)).rejects.toBe(ENCRYPT_REJECTION)
  })

  it('serves the rotated token to loadHosts so the saved host survives a relaunch', async () => {
    const written = new Map<string | undefined, string>()
    secureStoreMock.setItemAsync.mockImplementation(
      async (_key: string, value: string, options?: { keychainService?: string }) => {
        if (options?.keychainService === undefined) {
          throw ENCRYPT_REJECTION
        }
        written.set(options.keychainService, value)
      }
    )
    await savePairedHost(NEW_HOST)
    // Why: a fresh process has no token cache, so the host list has to come back off the rotated alias.
    resetHostStoreForTests()
    secureStoreMock.getItemAsync.mockImplementation(
      async (_key: string, options?: { keychainService?: string }) =>
        written.get(options?.keychainService) ?? null
    )

    const hosts = await loadHosts()

    expect(hosts).toHaveLength(1)
    expect(hosts[0]!.deviceToken).toBe('device-token')
  })
})
