import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronSafeStorage = vi.hoisted(() => ({
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn(() => Buffer.from('sealed')),
  decryptString: vi.fn(() => 'plain')
}))
vi.mock('electron', () => ({ safeStorage: electronSafeStorage, app: {} }))
const home = vi.hoisted(() => ({ path: '' }))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => home.path
}))

const { withholdKeychainForLocalDesktopBuild } = await import('./desktop-keychain-guard')
const { isLocalBuildVersion } = await import('../app-update-policy')
const {
  guardedSafeStorage,
  resetSafeStorageWithholdForTests,
  safeStorageWithheldReason,
  withholdSafeStorage
} = await import('./safe-storage-availability')
const { ProtectedSecretPersistence } = await import('../protected-secret-persistence')
const { _resetSecretStoreForTests, setSecretStore } = await import('../../shared/secret-store')
const { ElectronSecretStore } = await import('./electron-secret-store')
const { createEncryptedApiKeyFileStore } =
  await import('../credentials/encrypted-api-key-file-store')
const { writeEncryptedCredential } = await import('../integration-credential-file')
const { saveZcodePlanApiKey, getZcodePlanApiKeyPath } =
  await import('../zcode/zcode-plan-api-key-store')
const { saveMiniMaxSessionCookie, getMiniMaxCookiePath } =
  await import('../minimax/minimax-cookie-store')
const { saveOpenAiSpeechApiKey, getOpenAiKeyPath } = await import('../speech/openai-api-key-store')

const LOCAL_VERSION = '1.4.214-local.123.abc'

function expectNoKeychainCall(): void {
  expect(electronSafeStorage.isEncryptionAvailable).not.toHaveBeenCalled()
  expect(electronSafeStorage.encryptString).not.toHaveBeenCalled()
  expect(electronSafeStorage.decryptString).not.toHaveBeenCalled()
}

function guard(
  overrides: Partial<Parameters<typeof withholdKeychainForLocalDesktopBuild>[0]> = {}
): void {
  withholdKeychainForLocalDesktopBuild({
    version: LOCAL_VERSION,
    isPackaged: true,
    platform: 'darwin',
    warn: vi.fn(),
    ...overrides
  })
}

beforeEach(() => {
  home.path = mkdtempSync(join(tmpdir(), 'orca-keychain-guard-'))
  mkdirSync(join(home.path, '.orca'))
  setSecretStore(new ElectronSecretStore())
  electronSafeStorage.isEncryptionAvailable.mockClear()
  electronSafeStorage.encryptString.mockClear()
  electronSafeStorage.decryptString.mockClear()
})

afterEach(() => {
  resetSafeStorageWithholdForTests()
  rmSync(home.path, { recursive: true, force: true })
})

afterAll(() => _resetSecretStoreForTests())

describe('withholdKeychainForLocalDesktopBuild', () => {
  it('keeps a local macOS build from making any keychain call', () => {
    guard()

    expect(safeStorageWithheldReason()).toContain(LOCAL_VERSION)
    const store = new ElectronSecretStore()
    expect(store.isEncryptionAvailable()).toBe(false)
    expect(store.describeProtectionGap()).toContain('new secrets cannot be saved')
    expect(() => guardedSafeStorage.decryptString(Buffer.from('x'))).toThrow(
      'secrets_unavailable'
    )
    expect(() => guardedSafeStorage.encryptString('x')).toThrow('secrets_unavailable')
    expectNoKeychainCall()
  })

  it('leaves official builds, dev runs, other platforms, and a mock keychain alone', () => {
    guard({ version: '1.4.214' })
    guard({ version: '1.4.214-rc.1' })
    guard({ isPackaged: false })
    guard({ platform: 'linux' })
    guard({ usesMockKeychain: true })
    expect(safeStorageWithheldReason()).toBeNull()
  })

  it('recognises the version shapes the local build pipeline stamps', () => {
    expect(isLocalBuildVersion('1.4.214-local.123.abc')).toBe(true)
    expect(isLocalBuildVersion('1.4.214-rc.1.local.123.abc')).toBe(true)
    expect(isLocalBuildVersion('1.4.214')).toBe(false)
    expect(isLocalBuildVersion('1.4.214-rc.1')).toBe(false)
  })

  it('keeps sealed settings on disk byte-for-byte', () => {
    guard()
    const persistence = new ProtectedSecretPersistence()
    const sealed = Buffer.from('v10-existing-ciphertext').toString('base64')

    expect(persistence.decryptWithStatus('settings.httpProxyUrl', sealed)).toEqual({
      plaintext: '',
      status: 'unavailable'
    })
    // An unrelated save re-encodes the slot: it must write back the old ciphertext, not '' or plaintext.
    expect(persistence.encrypt('settings.httpProxyUrl', '')).toMatchObject({
      blob: sealed,
      degraded: true
    })
    // A new value is withheld too, never written in its place.
    expect(persistence.encrypt('settings.httpProxyUrl', 'http://new-proxy:8080')).toMatchObject({
      blob: sealed,
      degraded: true
    })
    expectNoKeychainCall()
  })
})

describe('secret writers while the local build withholds the keychain', () => {
  const apiKeyStore = createEncryptedApiKeyFileStore({
    fileName: 'guard-test-api-key.enc',
    envelopePrefix: 'orca-guard-test-api-key:v1:',
    providerLabel: 'Guard test',
    logScope: 'guard-test'
  })
  const linearTokenPath = (): string => join(home.path, '.orca', 'linear-token.enc')
  const writers: [string, () => string, () => void][] = [
    [
      'encrypted API key file store',
      () => apiKeyStore.envelopeFile().path,
      () => apiKeyStore.save('sk-new-key')
    ],
    [
      'integration credential file',
      linearTokenPath,
      () => writeEncryptedCredential('Linear', linearTokenPath(), 'lin_new')
    ],
    ['GLM Coding Plan key', getZcodePlanApiKeyPath, () => saveZcodePlanApiKey('glm-new-key')],
    ['MiniMax cookie', getMiniMaxCookiePath, () => saveMiniMaxSessionCookie('session=new')],
    ['OpenAI speech key', getOpenAiKeyPath, () => saveOpenAiSpeechApiKey('sk-new-speech')]
  ]

  it.each(writers)('%s refuses to overwrite a sealed secret with plaintext', (_, path, save) => {
    const sealed = Buffer.concat([Buffer.from('v10'), Buffer.from([0x00, 0xff, 0x13, 0x37])])
    writeFileSync(path(), sealed, { mode: 0o600 })
    guard()

    expect(save).toThrow('secrets_unavailable')
    expect(readFileSync(path()).equals(sealed)).toBe(true)
    expectNoKeychainCall()
  })

  it.each(writers)('%s refuses to create a plaintext secret', (_, path, save) => {
    guard()

    expect(save).toThrow('secrets_unavailable')
    expect(existsSync(path())).toBe(false)
  })

  it.each(writers)('%s keeps the plaintext fallback for other withholds', (_, path, save) => {
    // Headless serve with an unreachable keychain keeps its existing behavior.
    withholdSafeStorage('the macOS login keychain did not answer')

    save()
    expect(existsSync(path())).toBe(true)
    expectNoKeychainCall()
  })
})
