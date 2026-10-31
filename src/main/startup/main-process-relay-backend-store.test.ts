import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MobileRelayBackendProvider } from '../../shared/mobile-relay-backend'
import type { RelayBackendSelection } from '../runtime/mobile-cloud-relay/relay-backend-config-store'

const { state, readSelection } = vi.hoisted(() => {
  const readSelection = vi.fn<() => RelayBackendSelection>(() => ({ status: 'unreadable' }))
  const state: {
    desktopRelayService: { provider: MobileRelayBackendProvider } | null
    relayBackendStore: { readSelection: typeof readSelection }
  } = { desktopRelayService: null, relayBackendStore: { readSelection } }
  return { state, readSelection }
})
vi.mock('./main-process-state', () => ({ mainProcessState: state }))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: vi.fn() }))

import { shouldPreserveRelayOnOrcaSignOut } from './main-process-relay-backend-store'

describe('Relay account sign-out ownership', () => {
  beforeEach(() => {
    readSelection.mockClear()
    state.desktopRelayService = null
  })

  it.each(['official', 'self-hosted'] as const)(
    'uses the running %s service without re-reading a temporarily unreadable file',
    (provider) => {
      state.desktopRelayService = { provider }
      expect(shouldPreserveRelayOnOrcaSignOut()).toBe(provider === 'self-hosted')
      expect(readSelection).not.toHaveBeenCalled()
    }
  )

  it('does not fence an unknown pending backend as an official account', () => {
    expect(shouldPreserveRelayOnOrcaSignOut()).toBe(true)
  })
})
