import { getOrcaPushGatewayUrl } from '../orca-profiles/profile-cloud-auth-config'
import { DesktopPushService } from '../runtime/push/desktop-push-service'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { getRelayBackendConfigStore } from './main-process-relay-backend-store'
import { mainProcessState as state } from './main-process-state'

let pushStartupReached = false

// Why: background push rides Orca's official gateway, so a self-hosted relay
// (or a selection we cannot read) must not depend on it.
function officialPushAllowed(): boolean {
  const selection = getRelayBackendConfigStore().readSelection()
  return selection.status === 'ok' && selection.provider === 'official'
}

// Why: deliberately not gated on cloud sign-in like the relay is — the push gateway
// authenticates with the host keypair, so an accountless host registers phones on
// exactly the same path. The runtime is read from shared state because both launch
// modes have already stored it there; threading it as a parameter would push the
// launch module past its line budget for no gain.
export function startDesktopPushService(runtimeRpc: OrcaRuntimeRpcServer): void {
  pushStartupReached = true
  const runtime: OrcaRuntimeService | null = state.runtime
  if (!runtime) {
    console.warn('[push] Background push startup skipped: runtime not started')
    return
  }
  if (!officialPushAllowed()) {
    console.warn('[push] Background push off: a self-hosted Relay backend is selected')
    return
  }
  try {
    const pushService = DesktopPushService.create({
      runtime,
      runtimeRpc,
      gatewayUrl: getOrcaPushGatewayUrl()
    })
    pushService?.start()
    state.desktopPushService = pushService
  } catch (error) {
    console.warn(
      '[push] Background push startup unavailable:',
      error instanceof Error ? error.message : String(error)
    )
  }
}

/** Follows a Relay backend switch; never starts push ahead of the launch-time proxy gate. */
export function reconcileDesktopPushService(runtimeRpc: OrcaRuntimeRpcServer): void {
  if (!officialPushAllowed()) {
    state.desktopPushService?.stop()
    state.desktopPushService = null
    return
  }
  if (pushStartupReached && !state.desktopPushService) {
    startDesktopPushService(runtimeRpc)
  }
}
