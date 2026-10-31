import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  resolveMobilePairingConnectionMode,
  type MobilePairingConnectionMode
} from '../../../../shared/mobile-pairing-connection-mode'
import { useMobileRelayBackend } from './use-mobile-relay-backend'

/**
 * Selected pairing path, seeded from the persisted preference and whether the
 * selected Relay backend is usable, and re-synced when either changes. Shared by
 * MobilePage and MobilePane so the two surfaces cannot resolve the default differently.
 */
export function useMobilePairingConnectionMode(): [
  MobilePairingConnectionMode,
  React.Dispatch<React.SetStateAction<MobilePairingConnectionMode>>
] {
  const savedConnectionMode = useAppStore((s) => s.settings?.mobilePairingConnectionMode)
  const { relayReady } = useMobileRelayBackend()
  const [connectionMode, setConnectionMode] = useState<MobilePairingConnectionMode>(() =>
    resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn: relayReady })
  )
  useEffect(() => {
    setConnectionMode(
      resolveMobilePairingConnectionMode(savedConnectionMode, { signedIn: relayReady })
    )
  }, [savedConnectionMode, relayReady])
  return [connectionMode, setConnectionMode]
}
