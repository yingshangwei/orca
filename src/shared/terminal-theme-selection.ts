import type { ITheme } from '@xterm/xterm'
import type { GlobalSettings } from './global-settings-types'
import {
  TERMINAL_COLOR_OVERRIDES_SETTING,
  terminalColorOverridesForSlot,
  withTerminalColorOverrides,
  type TerminalColorOverrideSettings
} from './terminal-color-overrides'
import {
  normalizeTerminalCustomThemes,
  parseCustomTerminalThemeSelection,
  terminalCustomThemeToXtermTheme
} from './terminal-custom-themes'
import type { TerminalOscColorQueryReplyColors } from './terminal-osc-color-reply'
import { TERMINAL_THEME_CATALOG } from './terminal-themes'
import type { TerminalThemeMap } from './terminal-themes/types'

export const DEFAULT_TERMINAL_THEME_DARK = 'Ghostty Default Style Dark'
export const DEFAULT_TERMINAL_THEME_LIGHT = 'Builtin Tango Light'

export type TerminalThemeSelectionSettings = Pick<
  GlobalSettings,
  'theme' | 'terminalThemeDark' | 'terminalUseSeparateLightTheme' | 'terminalThemeLight'
>

export type TerminalThemeSelection = {
  mode: 'dark' | 'light'
  useLightVariant: boolean
  themeName: string
}

/** Which terminal theme the app's appearance settings select; one rule for the renderer and main. */
export function selectTerminalTheme(
  settings: TerminalThemeSelectionSettings,
  systemPrefersDark: boolean
): TerminalThemeSelection {
  const mode = settings.theme === 'system' ? (systemPrefersDark ? 'dark' : 'light') : settings.theme
  const useLightVariant = mode === 'light' && settings.terminalUseSeparateLightTheme
  const themeName = useLightVariant
    ? settings.terminalThemeLight || DEFAULT_TERMINAL_THEME_LIGHT
    : settings.terminalThemeDark || DEFAULT_TERMINAL_THEME_DARK
  return { mode, useLightVariant, themeName }
}

/** A selection names a user-imported theme or a built-in one; one lookup for both. */
export function lookupTerminalTheme(
  settings: Pick<GlobalSettings, 'terminalCustomThemes'> | undefined,
  selection: string
): TerminalThemeMap[string] | null {
  const customId = parseCustomTerminalThemeSelection(selection)
  const custom =
    customId && settings
      ? normalizeTerminalCustomThemes(settings.terminalCustomThemes).find(
          ({ id }) => id === customId
        )
      : undefined
  return custom
    ? terminalCustomThemeToXtermTheme(custom)
    : (TERMINAL_THEME_CATALOG[selection] ?? null)
}

export type TerminalPaletteSettings = TerminalThemeSelectionSettings &
  Pick<GlobalSettings, 'terminalCustomThemes'> &
  TerminalColorOverrideSettings

export type TerminalPalette = TerminalThemeSelection & { theme: ITheme | null }

/** The one place a mode's terminal palette is composed: its slot's theme (or that slot's default) plus the slot's overrides. */
export function resolveTerminalPalette(
  settings: TerminalPaletteSettings,
  systemPrefersDark: boolean
): TerminalPalette {
  const selection = selectTerminalTheme(settings, systemPrefersDark)
  const slot = selection.useLightVariant ? 'light' : 'dark'
  const base =
    lookupTerminalTheme(settings, selection.themeName) ??
    lookupTerminalTheme(
      settings,
      selection.useLightVariant ? DEFAULT_TERMINAL_THEME_LIGHT : DEFAULT_TERMINAL_THEME_DARK
    )
  return {
    ...selection,
    theme: base && withTerminalColorOverrides(base, terminalColorOverridesForSlot(settings, slot))
  }
}

/** An imported palette (Ghostty) merges into the slot painting the terminal once the import applies, so it shows. */
export function withImportedTerminalColorOverrides(
  settings: TerminalThemeSelectionSettings & TerminalColorOverrideSettings,
  diff: Partial<GlobalSettings>,
  systemPrefersDark: boolean
): Partial<GlobalSettings> {
  const { terminalColorOverrides: imported, ...rest } = diff
  if (!imported) {
    return diff
  }
  const { useLightVariant } = selectTerminalTheme({ ...settings, ...rest }, systemPrefersDark)
  const setting = TERMINAL_COLOR_OVERRIDES_SETTING[useLightVariant ? 'light' : 'dark']
  return { ...rest, [setting]: { ...settings[setting], ...imported } }
}

/**
 * The foreground/background the host's saved settings paint a terminal with, for answering
 * OSC 10/11 before (or without) a renderer. Opacity is ignored: a colour query reports the
 * opaque theme colour.
 */
export function resolveConfiguredTerminalColors(
  settings: TerminalPaletteSettings,
  systemPrefersDark: boolean
): TerminalOscColorQueryReplyColors {
  const { foreground, background } = resolveTerminalPalette(settings, systemPrefersDark).theme ?? {}
  return { ...(foreground ? { foreground } : {}), ...(background ? { background } : {}) }
}
