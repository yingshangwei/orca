import { ipcMain } from 'electron'
import type {
  MobileRelayBackendConfig,
  MobileRelayBackendUpdate,
  MobileRelayBackendUpdateResult
} from '../../shared/mobile-relay-backend'
import { isTrustedUIRenderer } from './ui'

export type MobileRelayBackendHandlerDependencies = {
  getConfig: () => MobileRelayBackendConfig
  update: (input: MobileRelayBackendUpdate) => MobileRelayBackendUpdateResult
}

// Why: the renderer is outside the trust boundary; only exact, typed fields reach main.
export function parseMobileRelayBackendUpdate(value: unknown): MobileRelayBackendUpdate | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const provider: unknown = Reflect.get(value, 'provider')
  const selfHosted: unknown = Reflect.get(value, 'selfHosted')
  const resetUnreadable: unknown = Reflect.get(value, 'resetUnreadable')
  if (provider !== 'official' && provider !== 'self-hosted') {
    return null
  }
  if (resetUnreadable !== undefined && (resetUnreadable !== true || provider !== 'official')) {
    return null
  }
  if (selfHosted === undefined) {
    return { provider, ...(resetUnreadable === true ? { resetUnreadable: true as const } : {}) }
  }
  if (resetUnreadable !== undefined) {
    return null
  }
  if (typeof selfHosted !== 'object' || selfHosted === null) {
    return null
  }
  const origin: unknown = Reflect.get(selfHosted, 'origin')
  const accessKey: unknown = Reflect.get(selfHosted, 'accessKey')
  if (typeof origin !== 'string' || (accessKey !== undefined && typeof accessKey !== 'string')) {
    return null
  }
  return {
    provider,
    selfHosted: { origin, ...(accessKey ? { accessKey } : {}) }
  }
}

export function registerMobileRelayBackendHandlers(
  dependencies: MobileRelayBackendHandlerDependencies
): void {
  ipcMain.handle('mobile:getRelayBackendConfig', (event) =>
    isTrustedUIRenderer(event.sender) ? dependencies.getConfig() : null
  )
  ipcMain.handle('mobile:updateRelayBackend', (event, args: unknown) => {
    if (!isTrustedUIRenderer(event.sender)) {
      return null
    }
    const input = parseMobileRelayBackendUpdate(args)
    if (!input) {
      return { ok: false, error: 'invalid_origin', config: dependencies.getConfig() }
    }
    return dependencies.update(input)
  })
}
