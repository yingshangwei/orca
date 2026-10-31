import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/global-settings-types'

const fakes = vi.hoisted(() => ({
  host: {
    prepareLaunch: async () => ({ runtime: 'host' }),
    publish: () => {},
    systemDefaultHome: () => '/host/.claude'
  },
  wsl: {
    prepareLaunch: async (distro: string) => ({ runtime: 'wsl', wslDistro: distro }),
    preparation: async (distro: string) => ({ runtime: 'wsl', wslDistro: distro }),
    publish: async (_distro: string): Promise<void> => {},
    runningDistros: async (): Promise<string[]> => []
  }
}))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/data/orca' })
}))
vi.mock('../wsl', () => ({
  getDefaultWslDistro: () => 'Ubuntu',
  getWslHome: (distro: string) => `/wsl/${distro}/home`
}))
vi.mock('./claude-profile-router', () => ({
  ClaudeProfileRouter: function ClaudeProfileRouter() {
    return fakes.host
  }
}))
vi.mock('./claude-profile-wsl-router', () => ({
  ClaudeWslProfileRouter: function ClaudeWslProfileRouter() {
    return fakes.wsl
  }
}))
vi.mock('./claude-profile-installed-router', () => ({
  installClaudeProfileRouter: () => {},
  installClaudeWslProfileRouter: () => {}
}))

import { ClaudeRuntimeAuthService } from './runtime-auth-service'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
function service(
  platformName: NodeJS.Platform,
  overrides: Partial<GlobalSettings> = {},
  isDistroRunning: (distro: string) => Promise<boolean> = async () => true
) {
  Object.defineProperty(process, 'platform', { configurable: true, value: platformName })
  const settings = { ...getDefaultSettings('/home/user'), ...overrides }
  return new ClaudeRuntimeAuthService({ getSettings: () => settings }, isDistroRunning)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  Object.defineProperty(process, 'platform', platform)
  vi.restoreAllMocks()
})

describe('ClaudeRuntimeAuthService', () => {
  it('skips a quota preparation for a stopped distro instead of booting it', async () => {
    const preparation = vi.spyOn(fakes.wsl, 'preparation')
    const auth = service('win32', {}, async () => false)
    await expect(
      auth.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toMatchObject({ usageError: 'WSL distro Ubuntu is not running.' })
    expect(preparation).not.toHaveBeenCalled()

    const running = service('win32')
    await expect(
      running.prepareForRateLimitFetch({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('keeps a stale WSL account setting on the host off Windows', async () => {
    const auth = service('darwin', { localAccountRuntime: 'wsl', localAccountWslDistro: 'Ubuntu' })
    expect(auth.getRuntimeConfigDir()).toBe('/host/.claude')
    await expect(auth.prepareForClaudeLaunch()).resolves.toEqual({ runtime: 'host' })
  })

  it('refuses a WSL Claude launch and account routing', async () => {
    const auth = service('win32')
    expect(() => auth.prepareForClaudeLaunch({ runtime: 'wsl', wslDistro: null })).toThrow(
      'cannot override the connection'
    )
    await expect(
      auth.syncForCurrentSelection({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).rejects.toThrow('cannot override the connection')
  })

  it('refuses managed account creation on every platform', async () => {
    for (const platformName of ['darwin', 'linux', 'win32'] as const) {
      const auth = service(platformName)
      await expect(auth.prepareAccountFolder('new-account', { runtime: 'host' })).rejects.toThrow(
        'cannot override the connection'
      )
    }
  })

  it('does not publish or provision WSL accounts at startup', async () => {
    const running = vi.spyOn(fakes.wsl, 'runningDistros')
    const publish = vi.spyOn(fakes.wsl, 'publish')
    const auth = service('win32')
    await auth.publishAll()
    expect(running).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
})
