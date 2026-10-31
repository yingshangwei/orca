import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const {
  appMock,
  autoUpdaterMock,
  fetchNudgeMock,
  chooseLocalBuildMock,
  powerMonitorOnMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('./ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

describe('local build update policy', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    vi.useFakeTimers()
  })

  afterEach(() => vi.useRealTimers())

  it.each(['1.4.214-local.123.abc', '1.4.214-rc.1.local.123.abc'])(
    'blocks startup, manual and remote updates for %s',
    async (version) => {
      appMock.getVersion.mockReturnValue(version)
      const updater = await loadUpdaterModule()
      updater.setupAutoUpdater(null, {
        installMode: 'supervised-headless-serve',
        getLastUpdateCheckAt: () => 0,
        getPendingUpdateNudgeId: () => 'old-official-campaign'
      })
      updater.checkForUpdates()
      updater.checkForUpdatesFromMenu()
      updater.checkForUpdatesFromMenu({ localBuild: true })
      updater.checkForUpdatesFromMenu({ channel: 'hourly', targetTag: 'v2.0.0' })
      updater.downloadUpdate()
      updater.quitAndInstall()
      appMock.emit('browser-window-focus')
      await vi.advanceTimersByTimeAsync(48 * 60 * 60 * 1000)

      expect(updater.getUpdateStatus()).toEqual({ state: 'idle', updatesDisabled: true })
      expect(updater.getRemoteServerUpdaterSnapshot('test-runtime')).toMatchObject({
        support: { automatic: false, installMode: 'supervised-headless-serve' },
        status: { state: 'idle', updatesDisabled: true }
      })
      expect(() => updater.checkForRemoteServerUpdate('test-runtime')).toThrow(
        'remote_update_manual_required'
      )
      expect(() => updater.downloadRemoteServerUpdate('test-runtime')).toThrow()
      expect(() => updater.installRemoteServerUpdate('test-runtime')).toThrow()
      await expect(updater.listAvailableReleaseBuilds('stable')).rejects.toThrow(
        'Updates are disabled'
      )
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
      expect(autoUpdaterMock.on).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(chooseLocalBuildMock).not.toHaveBeenCalled()
      expect(fetchNudgeMock).not.toHaveBeenCalled()
      expect(powerMonitorOnMock).not.toHaveBeenCalled()
      expect(appMock.quit).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    }
  )
})
