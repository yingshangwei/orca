import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

test('recovers relay settings and switches backends without exposing the saved key', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const userDataPath = await electronApp.evaluate(({ app }) => {
    // Avoid OS keychain prompts in this disposable app; unit tests cover sealing failures.
    Reflect.set(globalThis, Symbol.for('orca.host.secretStore'), {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(value, 'utf8'),
      decryptString: (value: Buffer) => value.toString('utf8'),
      describeProtectionGap: () => null
    })
    return app.getPath('userData')
  })
  const configPath = join(userDataPath, 'mobile-relay-backend.json')
  writeFileSync(configPath, '{invalid', { mode: 0o600 })

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.openSettingsTarget({ pane: 'mobile', repoId: null })
    state.openSettingsPage()
  })
  const panel = orcaPage.getByTestId('relay-backend-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByRole('alert')).toContainText('Relay settings can’t be read')
  await panel.getByRole('radio', { name: 'Orca', exact: true }).click()
  await expect
    .poll(async () =>
      orcaPage.evaluate(async () => (await window.api.mobile.getRelayBackendConfig?.())?.error)
    )
    .toBeNull()

  await panel.getByRole('radio', { name: 'Self-hosted', exact: true }).click()
  await panel.getByLabel('Relay URL', { exact: true }).fill('https://relay.example.com/path')
  const accessKey = 'A'.repeat(43)
  await panel.getByLabel('Access key', { exact: true }).fill(accessKey)
  await panel.getByRole('button', { name: 'Save and use', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('Enter an HTTPS origin')
  await panel.getByLabel('Relay URL', { exact: true }).fill('http://127.0.0.1:18787')
  await panel.getByRole('button', { name: 'Save and use', exact: true }).click()
  await expect
    .poll(async () =>
      orcaPage.evaluate(async () => (await window.api.mobile.getRelayBackendConfig?.())?.provider)
    )
    .toBe('self-hosted')
  await expect(panel.getByLabel('Access key', { exact: true })).toHaveValue('')
  const config = await orcaPage.evaluate(() => window.api.mobile.getRelayBackendConfig?.())
  expect(config?.selfHosted).toMatchObject({ configured: true, hasAccessKey: true })
  expect(JSON.stringify(config)).not.toContain(accessKey)
  expect(readFileSync(configPath, 'utf8')).not.toContain(accessKey)
  await panel.screenshot({ path: testInfo.outputPath('self-hosted-relay-settings.png') })

  await panel.getByRole('radio', { name: 'Orca', exact: true }).click()
  await expect
    .poll(async () =>
      orcaPage.evaluate(async () => (await window.api.mobile.getRelayBackendConfig?.())?.provider)
    )
    .toBe('official')
  await panel.getByRole('radio', { name: 'Self-hosted', exact: true }).click()
  await expect
    .poll(async () =>
      orcaPage.evaluate(async () => (await window.api.mobile.getRelayBackendConfig?.())?.provider)
    )
    .toBe('self-hosted')
  await expect(panel.getByLabel('Relay URL', { exact: true })).toHaveValue('http://127.0.0.1:18787')
  await expect(panel.getByLabel('Access key', { exact: true })).toHaveValue('')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible())
    )
  ).toBe(true)
})
