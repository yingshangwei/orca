// @vitest-environment happy-dom
import { beforeEach, expect, it } from 'vitest'
import { getStoredSettings, writeStoredSettings } from './web-preferences-store'
import { SETTINGS_STORAGE_KEY } from './web-storage'
import { webRuntimeState } from './web-runtime-session'

beforeEach(() => {
  window.localStorage.clear()
  webRuntimeState.activeEnvironment = null
})

it('preserves a legacy shared palette across browser reload and never recreates a cleared light slot', () => {
  const colors = { background: '#101010', foreground: '#eeeeee' }
  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      theme: 'system',
      terminalUseSeparateLightTheme: true,
      terminalColorOverrides: colors
    })
  )

  const migrated = getStoredSettings()
  expect(migrated.terminalColorOverrides).toEqual(colors)
  expect(migrated.terminalColorOverridesLight).toEqual(colors)
  expect(migrated.terminalColorOverridesSplit).toBe(true)
  expect(
    JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')
      .terminalColorOverridesSplit
  ).toBe(true)

  writeStoredSettings({ ...migrated, terminalColorOverridesLight: undefined })
  const reloaded = getStoredSettings()
  expect(reloaded.terminalColorOverrides).toEqual(colors)
  expect(reloaded.terminalColorOverridesLight).toBeUndefined()
})

it('does not copy a legacy dark-only palette into a separate light slot', () => {
  window.localStorage.setItem(
    SETTINGS_STORAGE_KEY,
    JSON.stringify({
      theme: 'dark',
      terminalUseSeparateLightTheme: true,
      terminalColorOverrides: { background: '#101010' }
    })
  )
  const migrated = getStoredSettings()
  expect(migrated.terminalColorOverrides).toEqual({ background: '#101010' })
  expect(migrated.terminalColorOverridesLight).toBeUndefined()
  expect(migrated.terminalColorOverridesSplit).toBe(true)
})
