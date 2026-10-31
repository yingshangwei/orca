import { app, powerMonitor } from 'electron'
import { getOrcaCloudAuthConfig } from '../orca-profiles/profile-cloud-auth-config'
import { getProfileUserDataPath } from '../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import {
  DesktopRelayService,
  officialRelayBackend
} from '../runtime/mobile-cloud-relay/desktop-relay-service'
import { createDesktopRelayServiceInstaller } from '../runtime/mobile-cloud-relay/desktop-relay-service-installer'
import { deriveRelayHostId } from '../runtime/mobile-cloud-relay/relay-http-client'
import type { RelayBackendSelection } from '../runtime/mobile-cloud-relay/relay-backend-config-store'
import {
  createNoRedirectFetch,
  selfHostedRelayAuthContext,
  selfHostedRelayEndpoints
} from '../runtime/mobile-cloud-relay/self-hosted-relay-backend'
import type {
  MobileRelayBackendConfig,
  MobileRelayBackendUpdate,
  MobileRelayBackendUpdateResult
} from '../../shared/mobile-relay-backend'
import { publishDesktopRelayStatus } from './main-process-relay-status'
import { getRelayBackendConfigStore } from './main-process-relay-backend-store'
import { reconcileDesktopPushService } from './main-process-push-startup'
import { mainProcessState as state } from './main-process-state'

function createSelectedRelayService(runtimeRpc: OrcaRuntimeRpcServer): DesktopRelayService | null {
  const store = getRelayBackendConfigStore()
  const selection = store.readSelection()
  if (selection.status === 'unreadable') {
    // Fail closed: an unknown selection must not fall back to Orca's relay.
    console.warn('[relay] Relay backend configuration is unreadable; Relay stays off')
    return null
  }
  const common = {
    userDataPath: getProfileUserDataPath(),
    appVersion: app.getVersion(),
    runtimeRpc,
    onStatus: publishDesktopRelayStatus
  }
  if (selection.provider === 'official') {
    const cloudAuth = getOrcaCloudAuthConfig()
    return cloudAuth.configured
      ? new DesktopRelayService({
          ...common,
          backend: officialRelayBackend(cloudAuth.config, getProfileUserDataPath())
        })
      : null
  }
  const keypair = runtimeRpc.getE2EEKeypair()
  if (!keypair) {
    throw new Error('mobile_runtime_not_ready')
  }
  const { origin } = selection
  const relayHostId = deriveRelayHostId(keypair.publicKey)
  return new DesktopRelayService({
    ...common,
    backend: {
      provider: 'self-hosted',
      endpoints: selfHostedRelayEndpoints(origin),
      // Throws while the key cannot be unsealed, so the coordinator retries
      // instead of reporting a sign-out that never happened.
      readContext: async () =>
        selfHostedRelayAuthContext({
          origin,
          relayHostId,
          accessKey: store.readAccessKey(origin)
        }),
      regionPreference: false,
      fetch: createNoRedirectFetch()
    }
  })
}

// Registers the on-demand Relay installer and starts the first install, which
// waits for the persisted proxy itself, so it can run before the proxy lands.
export function startDesktopRelayService(runtimeRpc: OrcaRuntimeRpcServer): void {
  const installer = createDesktopRelayServiceInstaller({
    runtimeRpc,
    whenNetworkReady: state.initialProxyApplicationReady,
    isFenced: () => state.isQuitting,
    create: () => createSelectedRelayService(runtimeRpc),
    onInstalled: (service) => {
      state.desktopRelayService = service
    }
  })
  state.desktopRelayInstaller = installer
  runtimeRpc.setMobileRelayPairingProviderInstaller(() => installer.ensure())
  // Why: sleeping past relay-token expiry kills the broker with no retry
  // timer; resume is the moment that state becomes recoverable.
  powerMonitor.on('resume', () => state.desktopRelayService?.ensureLive())
  void installer.ensure()
}

function selectionIdentity(selection: RelayBackendSelection): string {
  if (selection.status === 'unreadable') {
    return 'unreadable'
  }
  return selection.provider === 'official'
    ? 'official'
    : `self-hosted\0${selection.origin}\0${selection.savedAt}`
}

export function getRelayBackendConfig(): MobileRelayBackendConfig {
  return getRelayBackendConfigStore().getConfig(state.runtimeRpc?.getE2EEPublicKey() ?? null)
}

// Only the selected backend runs. Switching never revokes paired phones: each
// keeps the binding of the backend it paired with and resumes when switched back.
export function updateRelayBackend(
  input: MobileRelayBackendUpdate
): MobileRelayBackendUpdateResult {
  const store = getRelayBackendConfigStore()
  const runtimeRpc = state.runtimeRpc
  const before = selectionIdentity(store.readSelection())
  const result = store.update(input, runtimeRpc?.getE2EEPublicKey() ?? null)
  if (!result.ok) {
    return result
  }
  if (selectionIdentity(store.readSelection()) !== before && runtimeRpc) {
    // Offers first: one minted for the old backend must not outlive the switch.
    runtimeRpc.invalidateMobilePairingOffers()
    state.desktopRelayService = null
    if (state.desktopRelayInstaller) {
      void state.desktopRelayInstaller.reconfigure()
    } else {
      publishDesktopRelayStatus('offline')
    }
    reconcileDesktopPushService(runtimeRpc)
  }
  state.mainWindow?.webContents.send('mobile:relayBackendChanged', result.config)
  return result
}
