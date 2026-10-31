import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handlers, trusted } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  trusted: { value: true }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    }
  }
}))
vi.mock('./ui', () => ({ isTrustedUIRenderer: () => trusted.value }))

import {
  parseMobileRelayBackendUpdate,
  registerMobileRelayBackendHandlers
} from './mobile-relay-backend'

const config = {
  provider: 'official' as const,
  selfHosted: { origin: null, hasAccessKey: false, configured: false, savedAt: null },
  hostPublicKeyB64: 'pub',
  error: null
}

describe('mobile relay backend IPC', () => {
  beforeEach(() => {
    handlers.clear()
    trusted.value = true
  })

  it('answers only the trusted renderer', async () => {
    const update = vi.fn(() => ({ ok: true as const, config }))
    registerMobileRelayBackendHandlers({ getConfig: () => config, update })
    const event = { sender: {} }

    expect(await handlers.get('mobile:getRelayBackendConfig')?.(event)).toEqual(config)
    trusted.value = false
    expect(await handlers.get('mobile:getRelayBackendConfig')?.(event)).toBeNull()
    expect(
      await handlers.get('mobile:updateRelayBackend')?.(event, { provider: 'official' })
    ).toBeNull()
    expect(update).not.toHaveBeenCalled()
  })

  it('passes only typed fields through', () => {
    expect(
      parseMobileRelayBackendUpdate({
        provider: 'self-hosted',
        selfHosted: { origin: 'https://relay.example.com', accessKey: 'k', extra: 1 },
        extra: true
      })
    ).toEqual({
      provider: 'self-hosted',
      selfHosted: { origin: 'https://relay.example.com', accessKey: 'k' }
    })
    expect(parseMobileRelayBackendUpdate({ provider: 'other' })).toBeNull()
    expect(
      parseMobileRelayBackendUpdate({ provider: 'self-hosted', selfHosted: { origin: 1 } })
    ).toBeNull()
  })
})
