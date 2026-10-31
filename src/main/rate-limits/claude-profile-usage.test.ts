import type * as Keychain from '../claude-accounts/keychain'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ keychain: vi.fn(), usage: vi.fn(), keychainService: vi.fn() }))
vi.mock('../macos-keychain/generic-password', () => ({
  readKeychainPassword: calls.keychainService
}))
vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: calls.keychain
}))
const profileRouter = vi.hoisted((): { userConfigDir?: string } => ({}))
const wslRouter = vi.hoisted(() => ({ accountUsagePreparation: vi.fn() }))
vi.mock('../claude-accounts/claude-profile-installed-router', () => ({
  getClaudeProfileRouter: () =>
    profileRouter.userConfigDir ? { userConfigDir: () => profileRouter.userConfigDir } : undefined,
  getClaudeWslProfileRouter: () => wslRouter
}))
vi.mock('./claude-oauth-usage-request', () => ({ fetchClaudeOAuthUsage: calls.usage }))
const runningDistros = vi.hoisted(() => ({
  filter: vi.fn(async (paths: readonly string[]) => [...paths])
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: runningDistros.filter
}))
vi.mock('@orca/process-host', () => ({
  spawnProcess: () => {
    throw new Error('Usage must not launch a process')
  },
  runProcess: () => {
    throw new Error('Usage must not launch a process')
  }
}))
import { fetchActiveClaudeRateLimits } from './claude-active-usage-fetch'
import {
  readClaudeOAuthCredentials,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
const roots: string[] = []
afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})
function profile() {
  const home = mkdtempSync(join(tmpdir(), 'claude-usage-'))
  roots.push(home)
  calls.keychain.mockResolvedValue(null)
  const options = {
    authPreparation: {
      configDir: home,
      envPatch: { CLAUDE_CONFIG_DIR: home },
      provenance: 'profile:fake'
    }
  }
  return { home, options }
}

it('reads only the requested scoped Keychain, with no unsuffixed fallback', async () => {
  const f = profile()
  await readClaudeOAuthCredentials({ credentialsFileConfigDir: f.home, keychainConfigDir: f.home })
  if (process.platform === 'darwin') {
    expect(calls.keychain.mock.calls).toEqual([[f.home]])
  } else {
    expect(calls.keychain).not.toHaveBeenCalled()
  }
})
it('strict Keychain lookup never falls back to the unsuffixed service', async () => {
  const f = profile()
  calls.keychainService.mockResolvedValue(null)
  const actual = await vi.importActual<typeof Keychain>('../claude-accounts/keychain')
  await actual.readActiveClaudeKeychainCredentialsStrict(f.home)
  expect(calls.keychainService).toHaveBeenCalled()
  for (const [service] of calls.keychainService.mock.calls) {
    expect(service).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/)
  }
  calls.keychainService.mockClear()
  calls.keychainService.mockRejectedValue(new Error('locked'))
  await expect(actual.readActiveClaudeKeychainCredentialsStrict(f.home)).rejects.toThrow('locked')
  expect(calls.keychainService).toHaveBeenCalledTimes(1)
})
it("reads System default's own CLAUDE_CONFIG_DIR Keychain item before the unsuffixed one", async () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-usage-inherited-'))
  roots.push(root)
  const inherited = join(root, 'own-claude-config')
  vi.stubEnv('CLAUDE_CONFIG_DIR', inherited)
  try {
    calls.keychain.mockResolvedValue(null)
    await readClaudeOAuthCredentials(
      resolveClaudeOAuthCredentialReadOptions({
        configDir: inherited,
        envPatch: {},
        provenance: 'system'
      })
    )
    expect(calls.keychain.mock.calls).toEqual(
      process.platform === 'darwin' ? [[inherited], [undefined]] : []
    )
  } finally {
    vi.unstubAllEnvs()
  }
  const managed = profile()
  calls.keychain.mockClear()
  expect(await fetchActiveClaudeRateLimits(managed.options)).toMatchObject({
    status: 'unavailable'
  })
  expect(calls.keychain).not.toHaveBeenCalled()
})

it("names System default's Keychain item from the login shell's CLAUDE_CONFIG_DIR a Dock launch lacks", () => {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '')
  profileRouter.userConfigDir = '/shell/claude-config'
  try {
    expect(
      resolveClaudeOAuthCredentialReadOptions({
        configDir: '/shell/claude-config',
        envPatch: {},
        provenance: 'system'
      })?.keychainConfigDir
    ).toBe('/shell/claude-config')
  } finally {
    profileRouter.userConfigDir = undefined
    vi.unstubAllEnvs()
  }
})
