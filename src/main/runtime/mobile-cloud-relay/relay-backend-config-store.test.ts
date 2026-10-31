import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { _resetSecretStoreForTests, setSecretStore } from '../../../shared/secret-store'
import { RelayBackendConfigStore } from './relay-backend-config-store'

const KEY_A = 'A'.repeat(43)
const KEY_B = `${'b'.repeat(42)}_`
const ORIGIN = 'https://relay.example.com'
const OTHER_ORIGIN = 'https://other.example.com'

const secrets = { available: true, decryptFails: false }

function installFakeSecretStore(): void {
  setSecretStore({
    isEncryptionAvailable: () => secrets.available,
    encryptString: (plain) => Buffer.from(`sealed:${Array.from(plain).toReversed().join('')}`),
    decryptString: (cipher) => {
      if (secrets.decryptFails) {
        throw new Error('keychain locked')
      }
      return Array.from(cipher.toString('utf8').slice('sealed:'.length)).toReversed().join('')
    },
    describeProtectionGap: () => null
  })
}

describe('RelayBackendConfigStore', () => {
  let dir: string
  let path: string
  let clock: number

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-relay-backend-'))
    path = join(dir, 'mobile-relay-backend.json')
    clock = 1_000
    secrets.available = true
    secrets.decryptFails = false
    installFakeSecretStore()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    _resetSecretStoreForTests()
  })

  function store(): RelayBackendConfigStore {
    return new RelayBackendConfigStore(dir, { now: () => clock })
  }

  it('defaults to the official backend', () => {
    expect(store().readSelection()).toEqual({ status: 'ok', provider: 'official' })
  })

  it('seals the key at rest and never returns it in the redacted config', () => {
    const result = store().update(
      { provider: 'self-hosted', selfHosted: { origin: `${ORIGIN}/`, accessKey: KEY_A } },
      'host-pub'
    )
    expect(result).toMatchObject({
      ok: true,
      config: {
        provider: 'self-hosted',
        selfHosted: { origin: ORIGIN, hasAccessKey: true, configured: true },
        hostPublicKeyB64: 'host-pub'
      }
    })
    expect(JSON.stringify(result)).not.toContain(KEY_A)
    expect(readFileSync(path, 'utf8')).not.toContain(KEY_A)
    // A fresh instance proves the key survives a restart through the sealed copy.
    expect(store().readAccessKey(ORIGIN)).toBe(KEY_A)
  })

  it('fails closed without writing when secret protection is unavailable', () => {
    secrets.available = false
    const result = store().update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: KEY_A } },
      null
    )
    expect(result).toMatchObject({ ok: false, error: 'secret_protection_unavailable' })
    expect(store().readSelection()).toEqual({ status: 'ok', provider: 'official' })
  })

  it('requires a new key for a new origin and never releases a key to another origin', () => {
    const configStore = store()
    configStore.update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: KEY_A } },
      null
    )
    expect(
      configStore.update({ provider: 'self-hosted', selfHosted: { origin: OTHER_ORIGIN } }, null)
    ).toMatchObject({ ok: false, error: 'access_key_required' })
    expect(() => configStore.readAccessKey(OTHER_ORIGIN)).toThrow(
      'self_hosted_access_key_unreadable'
    )
    expect(configStore.readSelection()).toMatchObject({ provider: 'self-hosted', origin: ORIGIN })
  })

  it('keeps self-hosted settings across a switch to official and back', () => {
    const configStore = store()
    configStore.update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: KEY_A } },
      null
    )
    expect(configStore.update({ provider: 'official' }, null)).toMatchObject({
      ok: true,
      config: { provider: 'official', selfHosted: { origin: ORIGIN, configured: true } }
    })
    expect(configStore.update({ provider: 'self-hosted' }, null)).toMatchObject({ ok: true })
    expect(configStore.readSelection()).toEqual({
      status: 'ok',
      provider: 'self-hosted',
      origin: ORIGIN,
      savedAt: 1_000
    })
    expect(configStore.readAccessKey(ORIGIN)).toBe(KEY_A)
  })

  it('refuses to select self-hosted before it is configured', () => {
    expect(store().update({ provider: 'self-hosted' }, null)).toMatchObject({
      ok: false,
      error: 'self_hosted_not_configured'
    })
  })

  it('rejects non-HTTPS origins and malformed keys', () => {
    const configStore = store()
    for (const origin of ['http://relay.example.com', `${ORIGIN}/path`, 'not a url']) {
      const result = configStore.update(
        { provider: 'self-hosted', selfHosted: { origin, accessKey: KEY_A } },
        null
      )
      expect(result).toMatchObject({ ok: false, error: 'invalid_origin' })
    }
    expect(
      configStore.update(
        { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: 'short' } },
        null
      )
    ).toMatchObject({ ok: false, error: 'invalid_access_key' })
    expect(
      configStore.update(
        {
          provider: 'self-hosted',
          selfHosted: { origin: 'http://127.0.0.1:8787', accessKey: KEY_A }
        },
        null
      )
    ).toMatchObject({ ok: true })
  })

  it('keeps an unreadable sealed key on disk after a failed read', () => {
    store().update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: KEY_A } },
      null
    )
    const before = readFileSync(path, 'utf8')
    secrets.decryptFails = true
    const configStore = store()
    expect(() => configStore.readAccessKey(ORIGIN)).toThrow('self_hosted_access_key_unreadable')
    expect(configStore.getConfig(null).error).toBe('access_key_unreadable')
    expect(readFileSync(path, 'utf8')).toBe(before)
    secrets.decryptFails = false
    expect(configStore.readAccessKey(ORIGIN)).toBe(KEY_A)
  })

  it('refuses partial updates over an unreadable file but allows an explicit replacement', () => {
    writeFileSync(path, '{not json')
    const configStore = store()
    expect(configStore.readSelection()).toEqual({ status: 'unreadable' })
    expect(configStore.getConfig(null).error).toBe('config_unreadable')
    expect(configStore.update({ provider: 'official' }, null)).toMatchObject({
      ok: false,
      error: 'config_unreadable'
    })
    expect(readFileSync(path, 'utf8')).toBe('{not json')
    clock = 2_000
    expect(
      configStore.update(
        { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: KEY_B } },
        null
      )
    ).toMatchObject({ ok: true })
    expect(configStore.readAccessKey(ORIGIN)).toBe(KEY_B)
  })

  it('allows an explicit reset to official after corrupt settings disable Relay', () => {
    writeFileSync(path, '{not json')
    const configStore = store()
    expect(configStore.update({ provider: 'official', resetUnreadable: true }, null)).toMatchObject(
      {
        ok: true,
        config: { provider: 'official', error: null }
      }
    )
    expect(store().readSelection()).toEqual({ status: 'ok', provider: 'official' })
  })

  it('replaces the key in place and changes savedAt so pairing state can follow', () => {
    const configStore = store()
    configStore.update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: KEY_A } },
      null
    )
    clock = 5_000
    configStore.update(
      { provider: 'self-hosted', selfHosted: { origin: ORIGIN, accessKey: KEY_B } },
      null
    )
    expect(configStore.readAccessKey(ORIGIN)).toBe(KEY_B)
    expect(configStore.readSelection()).toMatchObject({ savedAt: 5_000 })
  })
})
