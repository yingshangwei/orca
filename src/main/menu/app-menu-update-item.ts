import type { UpdateCheckOptions } from '../../shared/update-status-types'
import { isAppUpdateEnabled } from '../app-update-policy'
import { translateMain } from '../i18n/main-i18n'

export function createAppMenuUpdateItem(
  isMac: boolean,
  onCheckForUpdates: (options: UpdateCheckOptions) => void
): Electron.MenuItemConstructorOptions {
  return {
    label: translateMain('menu.checkForUpdates', 'Check for Updates...'),
    enabled: isAppUpdateEnabled(),
    click: (_menuItem, _window, event) => {
      const modifierClick = !event.triggeredByAccelerator
      const localBuild = isMac && modifierClick && event.altKey === true
      const includePerfPrerelease =
        !localBuild && modifierClick && (isMac ? event.metaKey === true : event.ctrlKey === true)
      const includePrerelease = !localBuild && modifierClick && event.shiftKey === true
      onCheckForUpdates({
        includePrerelease,
        includePerfPrerelease,
        ...(localBuild ? { localBuild: true } : {})
      })
    }
  }
}
