// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMobilePairingQrInvalidation } from './use-mobile-pairing-qr-invalidation'

function setup() {
  const hasGeneratedRef = { current: true }
  const pairingRequestIdRef = { current: 1 }
  const regenerate = vi.fn()
  const setPairQrDataUrl = vi.fn()
  const hook = renderHook(
    ({ relayBackendKey }: { relayBackendKey: string }) =>
      useMobilePairingQrInvalidation({
        connectionMode: 'automatic',
        signedIn: true,
        relayBackendKey,
        pairLoading: false,
        hasGeneratedRef,
        pairingRequestIdRef,
        setPairQrDataUrl,
        setPairQrSize: vi.fn(),
        setPairingUrl: vi.fn(),
        setPairingQrError: vi.fn(),
        setPairLoading: vi.fn(),
        regenerate
      }),
    { initialProps: { relayBackendKey: 'official' } }
  )
  return { hook, regenerate, setPairQrDataUrl, pairingRequestIdRef }
}

describe('useMobilePairingQrInvalidation', () => {
  afterEach(cleanup)

  it('drops and re-mints the QR when switching between two ready Relay backends', () => {
    const { hook, regenerate, setPairQrDataUrl, pairingRequestIdRef } = setup()
    expect(regenerate).not.toHaveBeenCalled()

    hook.rerender({ relayBackendKey: 'self-hosted:https://relay.example.com:1' })

    expect(setPairQrDataUrl).toHaveBeenCalledWith(null)
    expect(pairingRequestIdRef.current).toBe(2)
    expect(regenerate).toHaveBeenCalledWith('automatic', { rotate: true })
  })

  it('keeps the QR when the backend is unchanged', () => {
    const { hook, regenerate } = setup()
    hook.rerender({ relayBackendKey: 'official' })
    expect(regenerate).not.toHaveBeenCalled()
  })
})
