import { dirname, join } from 'node:path'
import { app } from 'electron'
import { createRelaySecretStore } from '../host/relay-keychain-secret-store'
import { getCanonicalUserDataPath } from '../persistence'
import { RelayBackendConfigStore } from '../runtime/mobile-cloud-relay/relay-backend-config-store'
import { mainProcessState as state } from './main-process-state'

// Why the canonical path: the selection belongs with the device registry whose
// relay bindings it decides, not with the active Orca profile.
export function getRelayBackendConfigStore(): RelayBackendConfigStore {
  state.relayBackendStore ??= new RelayBackendConfigStore(getCanonicalUserDataPath(), {
    secretStore: createRelaySecretStore({
      helperPath: app.isPackaged
        ? join(dirname(app.getPath('exe')), 'orca-relay-keychain')
        : join(app.getAppPath(), 'native/relay-keychain-macos/.build/release/orca-relay-keychain')
    })
  })
  return state.relayBackendStore
}

/** Account sign-out may only fence a service known to use that account. */
export function shouldPreserveRelayOnOrcaSignOut(): boolean {
  if (state.desktopRelayService) {
    return state.desktopRelayService.provider === 'self-hosted'
  }
  const selection = getRelayBackendConfigStore().readSelection()
  return selection.status === 'unreadable' || selection.provider === 'self-hosted'
}
