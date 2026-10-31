import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import type { SecretStore } from '../../shared/secret-store'
import { RelayBackendConfigStore } from '../runtime/mobile-cloud-relay/relay-backend-config-store'
import { createRelaySecretStore } from './relay-keychain-secret-store'

vi.mock('@orca/process-host', () => ({ runProcessSync: vi.fn() }))

const ORIGIN = 'https://relay.example.com'
const ACCESS_KEY = 'A'.repeat(43)
const legacy: SecretStore = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error('legacy keychain withheld')
  },
  decryptString: vi.fn(() => {
    throw new Error('legacy keychain withheld')
  }),
  describeProtectionGap: () => 'withheld'
}

describe('no-dialog relay keychain storage', () => {
  let dir: string
  let nativeKey: Buffer
  let nativeAvailable: boolean

  function secretStore(platform: NodeJS.Platform = 'darwin'): SecretStore {
    return createRelaySecretStore({
      helperPath: '/native/relay-keychain',
      platform,
      legacy: () => legacy
    })
  }

  function store(): RelayBackendConfigStore {
    return new RelayBackendConfigStore(dir, { secretStore: secretStore() })
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-relay-keychain-'))
    nativeKey = randomBytes(32)
    nativeAvailable = true
    vi.mocked(legacy.decryptString).mockClear()
    vi.mocked(runProcessSync).mockImplementation((spec) => ({
      code: nativeAvailable ? 0 : 1,
      signal: null,
      stdout: '',
      stdoutBytes:
        nativeAvailable && spec.args?.[0] !== 'status' ? Buffer.from(nativeKey) : Buffer.alloc(0),
      stderr: '',
      timedOut: false
    }))
  })

  afterEach(() => {
    nativeKey.fill(0)
    rmSync(dir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('saves and reloads a sealed relay key while the old desktop keychain remains withheld', () => {
    expect(
      store().update(
        { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: ACCESS_KEY } },
        null
      ).ok
    ).toBe(true)
    const saved = readFileSync(join(dir, 'mobile-relay-backend.json'), 'utf8')
    const sealed = Buffer.from(JSON.parse(saved).selfHosted.accessKeyCiphertext, 'base64')
    expect(saved).not.toContain(ACCESS_KEY)
    expect(sealed.includes(ACCESS_KEY)).toBe(false)
    expect(store().readAccessKey(ORIGIN)).toBe(ACCESS_KEY)
    expect(legacy.decryptString).not.toHaveBeenCalled()
  })

  it('keeps the saved credential intact when the helper or keychain is unavailable', () => {
    store().update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: ACCESS_KEY } },
      null
    )
    const path = join(dir, 'mobile-relay-backend.json')
    const saved = readFileSync(path, 'utf8')
    nativeAvailable = false
    expect(() => store().readAccessKey(ORIGIN)).toThrow('self_hosted_access_key_unreadable')
    expect(
      store().update(
        { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: 'B'.repeat(43) } },
        null
      )
    ).toMatchObject({ ok: false, error: 'secret_protection_unavailable' })
    expect(readFileSync(path, 'utf8')).toBe(saved)
    expect(legacy.decryptString).not.toHaveBeenCalled()
  })

  it('rejects altered ciphertext and a replaced master key without trying legacy storage', () => {
    store().update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: ACCESS_KEY } },
      null
    )
    const path = join(dir, 'mobile-relay-backend.json')
    const saved = JSON.parse(readFileSync(path, 'utf8'))
    const sealed = Buffer.from(saved.selfHosted.accessKeyCiphertext, 'base64')
    sealed[sealed.length - 1] ^= 1
    writeFileSync(
      path,
      JSON.stringify({
        ...saved,
        selfHosted: { ...saved.selfHosted, accessKeyCiphertext: sealed.toString('base64') }
      })
    )
    expect(() => store().readAccessKey(ORIGIN)).toThrow('self_hosted_access_key_unreadable')
    writeFileSync(path, JSON.stringify(saved))
    nativeKey.fill(1)
    expect(() => store().readAccessKey(ORIGIN)).toThrow('self_hosted_access_key_unreadable')
    expect(legacy.decryptString).not.toHaveBeenCalled()
  })

  it('passes existing safeStorage ciphertext to the existing guarded store', () => {
    const oldCipher = Buffer.from('old-safeStorage-ciphertext')
    expect(() => secretStore().decryptString(oldCipher)).toThrow('legacy keychain withheld')
    expect(legacy.decryptString).toHaveBeenCalledWith(oldCipher)
  })

  it.each(['linux', 'win32'] as const)('preserves the existing %s secret store', (platform) => {
    expect(secretStore(platform)).toBe(legacy)
    expect(runProcessSync).not.toHaveBeenCalled()
  })

  it.each(['timeout', 'short-key', 'process-error'] as const)('fails closed on %s', (failure) => {
    vi.mocked(runProcessSync).mockImplementation(() => {
      if (failure === 'process-error') {
        throw new Error('ENOENT')
      }
      return {
        code: 0,
        signal: null,
        stdout: '',
        stdoutBytes: Buffer.alloc(8),
        stderr: '',
        timedOut: failure === 'timeout'
      }
    })
    expect(() => secretStore().encryptString(ACCESS_KEY)).toThrow()
  })
})
