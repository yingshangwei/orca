import type * as ChildProcess from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const processHost = vi.hoisted(() => ({ runProcess: vi.fn(), runProcessSync: vi.fn() }))
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  execFile: execFileMock
}))
vi.mock('@orca/process-host', () => processHost)
vi.mock('electron', () => ({ safeStorage: {}, app: {} }))
vi.mock('../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readCursorDesktopProfile: async () => ({ status: 'missing' })
}))

const { withholdKeychainForLocalDesktopBuild } = await import('./desktop-keychain-guard')
const { withholdUnreachableKeychainForServe } = await import('./serve-keychain-guard')
const { resetSafeStorageWithholdForTests, safeStorageWithheldReason } =
  await import('./keychain-withhold')
const { readKeychainPassword } = await import('../macos-keychain/generic-password')
const { readCursorAuthSession } = await import('../rate-limits/cursor-auth')
const { readAntigravityMacOSCredential, writeAntigravityMacOSCredential } =
  await import('../antigravity/native-macos-credentials')
const { getMacEncryptionKey } = await import('../browser/browser-cookie-key')
const { removeClaudeAccountFolder } = await import('../claude-accounts/claude-account-folder')

const originalPlatform = process.platform
let dir = ''

function jwt(sub: string): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'RS256' })}.${encode({ sub, exp: 2_000_000_000 })}.signature`
}

function withholdForLocalBuild(): void {
  withholdKeychainForLocalDesktopBuild({
    version: '1.4.214-local.123.abc',
    isPackaged: true,
    platform: 'darwin',
    warn: vi.fn()
  })
}

function answerSecurity(): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(null, 'value\n', '')
    return { kill: vi.fn() }
  })
  processHost.runProcessSync.mockReturnValue({ code: 0, timedOut: false, stdout: 'k\n' })
}

function expectNoSecuritySpawn(): void {
  expect(execFileMock).not.toHaveBeenCalled()
  expect(processHost.runProcess).not.toHaveBeenCalled()
  expect(processHost.runProcessSync).not.toHaveBeenCalled()
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  dir = mkdtempSync(join(tmpdir(), 'orca-keychain-withhold-'))
  execFileMock.mockReset()
  processHost.runProcess.mockReset()
  processHost.runProcessSync.mockReset()
})

afterEach(() => {
  resetSafeStorageWithholdForTests()
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
  rmSync(dir, { recursive: true, force: true })
})

describe("a local macOS build's security(1) launches", () => {
  it('fail fast without spawning security', async () => {
    withholdForLocalBuild()

    await expect(readKeychainPassword('cursor-access-token', 'cursor-user')).rejects.toThrow(
      'secrets_unavailable'
    )
    await expect(readAntigravityMacOSCredential()).rejects.toThrow('secrets_unavailable')
    await expect(
      writeAntigravityMacOSCredential(
        JSON.stringify({ auth_method: 'consumer', token: { access_token: 'synthetic' } })
      )
    ).rejects.toThrow('secrets_unavailable')
    expect(getMacEncryptionKey('Chrome Safe Storage', 'Chrome')).toBeNull()
    expectNoSecuritySpawn()
  })

  it('still remove a Claude account folder, leaving its keychain items untouched', async () => {
    withholdForLocalBuild()
    const dataRoot = join(dir, 'data')
    const profile = join(dataRoot, 'claude-profiles', 'a')
    mkdirSync(join(profile, 'home'), { recursive: true })

    await removeClaudeAccountFolder(dataRoot, 'a')

    expect(existsSync(profile)).toBe(false)
    expectNoSecuritySpawn()
  })

  it('leave the Cursor poll on its file login without an error banner', async () => {
    withholdForLocalBuild()
    const cliAuthPath = join(dir, 'auth.json')
    writeFileSync(cliAuthPath, JSON.stringify({ accessToken: jwt('auth0|user_file') }))

    const withFile = await readCursorAuthSession({
      cliAuthPath,
      cliConfigPath: join(dir, 'cli-config.json'),
      desktopStateDbPath: join(dir, 'state.vscdb')
    })
    expect(withFile).toMatchObject({ status: 'ok', session: { source: 'cli' } })

    const withoutCursor = await readCursorAuthSession({
      cliAuthPath: join(dir, 'missing.json'),
      cliConfigPath: join(dir, 'cli-config.json'),
      desktopStateDbPath: join(dir, 'state.vscdb')
    })
    expect(withoutCursor).toEqual({ status: 'missing' })
    expectNoSecuritySpawn()
  })

  it('still reach security when the run does not withhold the keychain', async () => {
    withholdKeychainForLocalDesktopBuild({
      version: '1.4.214',
      isPackaged: true,
      platform: 'darwin',
      warn: vi.fn()
    })
    answerSecurity()

    await expect(readKeychainPassword('svc', 'acct')).resolves.toBe('value')
    expect(getMacEncryptionKey('Chrome Safe Storage', 'Chrome')).not.toBeNull()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(processHost.runProcessSync).toHaveBeenCalledTimes(1)
  })
})

describe('headless serve with an unreachable keychain', () => {
  it('withholds safeStorage only, leaving security(1) reads as they were', async () => {
    await withholdUnreachableKeychainForServe({
      platform: 'darwin',
      probe: async () => ({ kind: 'unavailable', reason: 'no_default_keychain' }),
      warn: vi.fn()
    })
    expect(safeStorageWithheldReason()).not.toBeNull()
    answerSecurity()

    await expect(readKeychainPassword('svc', 'acct')).resolves.toBe('value')
    expect(getMacEncryptionKey('Chrome Safe Storage', 'Chrome')).not.toBeNull()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    expect(processHost.runProcessSync).toHaveBeenCalledTimes(1)
  })
})
