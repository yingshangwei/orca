import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import {
  mobileRelayBackendKey,
  type MobileRelayBackendConfig
} from '../../../../shared/mobile-relay-backend'

// Why module-level: Settings, the Mobile page and its pairing options mount
// together and must agree on which backend a QR would encode.
let snapshot: MobileRelayBackendConfig | null = null
let detach: (() => void) | null = null
const listeners = new Set<() => void>()

function publish(next: MobileRelayBackendConfig): void {
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

export function applyMobileRelayBackendConfig(config: MobileRelayBackendConfig): void {
  publish(config)
}

export async function refreshMobileRelayBackendConfig(): Promise<void> {
  try {
    const config = await window.api?.mobile?.getRelayBackendConfig?.()
    if (config) {
      publish(config)
    }
  } catch {
    // Keeps the last known config; the change event or next mount retries.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!detach) {
    detach = window.api?.mobile?.onRelayBackendChanged?.(publish) ?? (() => {})
    void refreshMobileRelayBackendConfig()
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      detach?.()
      detach = null
    }
  }
}

function getSnapshot(): MobileRelayBackendConfig | null {
  return snapshot
}

export type MobileRelayBackendState = {
  config: MobileRelayBackendConfig | null
  selfHosted: boolean
  /** Official: signed in. Self-hosted: origin and key saved. */
  relayReady: boolean
  /** Changes on any backend switch, so a QR for the previous backend is dropped. */
  relayBackendKey: string
}

export function useMobileRelayBackend(): MobileRelayBackendState {
  const config = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const signedIn = useAppStore((state) => state.orcaProfileAuthStatus?.state === 'connected')
  const selfHosted = config?.provider === 'self-hosted'
  const relayReady =
    config?.error === 'config_unreadable'
      ? false
      : config?.provider === 'self-hosted'
        ? config.selfHosted.configured
        : signedIn
  return { config, selfHosted, relayReady, relayBackendKey: mobileRelayBackendKey(config) }
}

export function _resetMobileRelayBackendForTests(): void {
  detach?.()
  detach = null
  listeners.clear()
  snapshot = null
}
