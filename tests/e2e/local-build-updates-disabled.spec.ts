import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('local builds hide official update controls and reject update actions', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await electronApp.evaluate(({ app }) => {
    // The disposable development fixture uses the production local-build version format.
    app.getVersion = () => '1.4.214-local.updates-disabled-test'
  })
  await orcaPage.evaluate(async () => {
    const status = await window.api.updater.getStatus()
    const state = window.__store!.getState()
    await state.updateSettings({ uiLanguage: 'en' })
    state.setUpdateStatus(status)
    state.openSettingsTarget({ pane: 'general', repoId: null })
    state.openSettingsPage()
  })
  const panel = orcaPage.getByTestId('local-updates-disabled')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('Official updates and update notifications are disabled')
  await expect(panel.getByRole('button')).toHaveCount(0)
  await panel.screenshot({ path: testInfo.outputPath('local-updates-disabled.png') })

  const status = await orcaPage.evaluate(async () => {
    await window.api.updater.check()
    await window.api.updater.download()
    await window.api.updater.quitAndInstall()
    return window.api.updater.getStatus()
  })
  expect(status).toEqual({ state: 'idle', updatesDisabled: true })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
