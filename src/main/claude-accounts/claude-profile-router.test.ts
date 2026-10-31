import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { ClaudeProfileRouter } from './claude-profile-router'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(customDirectory = false) {
  const root = mkdtempSync(join(tmpdir(), 'orca-local-claude-router-'))
  roots.push(root)
  const userHome = join(root, 'user')
  const configDir = join(userHome, customDirectory ? 'claude-custom' : '.claude')
  mkdirSync(configDir, { recursive: true })
  const configFile = join(configDir, 'settings.json')
  writeFileSync(
    configFile,
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
        HTTPS_PROXY: 'http://127.0.0.1:6155'
      }
    })
  )
  const settings = getDefaultSettings(userHome)
  const runSetup = vi.fn(async () => {
    throw new Error('Profile provisioning is forbidden')
  })
  const dataRoot = join(root, 'orca')
  const router = new ClaudeProfileRouter({
    dataRoot,
    userHome,
    getSettings: () => settings,
    env: customDirectory ? { CLAUDE_CONFIG_DIR: configDir } : {},
    runSetup
  })
  return { settings, runSetup, router, configDir, configFile, dataRoot }
}

describe('Claude profile routing is locked to the local user', () => {
  it.each([false, true])(
    'keeps the local configuration without provisioning a profile (custom=%s)',
    async (custom) => {
      const f = fixture(custom)
      const before = readFileSync(f.configFile, 'utf8')
      f.router.publish()
      expect(await f.router.prepareLaunch()).toMatchObject({
        configDir: f.configDir,
        envPatch: {},
        provenance: 'system'
      })
      expect(f.router.launchEnv()).toEqual({})
      expect(f.router.terminalEnv({ runtime: 'host' })).toEqual({})
      expect(f.router.terminalEnv({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual({})
      expect(f.router.routesToAccount()).toBe(false)
      expect(f.runSetup).not.toHaveBeenCalled()
      expect(readFileSync(f.configFile, 'utf8')).toBe(before)
    }
  )

  it('rejects a stale managed-account selection without falling back or copying settings', async () => {
    const f = fixture()
    f.settings.activeClaudeManagedAccountId = 'old-account'
    await expect(f.router.prepareLaunch()).rejects.toThrow('cannot override the connection')
    expect(f.runSetup).not.toHaveBeenCalled()
    expect(existsSync(join(f.dataRoot, 'claude-profiles'))).toBe(false)
  })

  it('refuses account creation before creating a directory or reading credentials', async () => {
    const f = fixture()
    await expect(f.router.prepareAccount('new-account')).rejects.toThrow(
      'cannot override the connection'
    )
    expect(f.runSetup).not.toHaveBeenCalled()
    expect(existsSync(join(f.dataRoot, 'claude-profiles'))).toBe(false)
  })
})
