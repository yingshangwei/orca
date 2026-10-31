import { describe, expect, it } from 'vitest'
import { homeHostBackendLabels } from './home-host-backend-label'

const relay = (directorUrl: string) => ({
  v: 1 as const,
  directorUrl,
  cellUrl: 'https://relay-c1.onorca.dev',
  assignmentEpoch: 0,
  relayHostId: 'AbCdEf0123_-xyZ9',
  e2eeFraming: 2 as const
})

describe('homeHostBackendLabels', () => {
  it('labels only relay hosts that share a desktop key with another card', () => {
    const labels = homeHostBackendLabels([
      { id: 'official', publicKeyB64: 'key', relay: relay('https://relay.onorca.dev') },
      { id: 'self', publicKeyB64: 'key', relay: relay('https://relay.example.com:8443') },
      { id: 'direct', publicKeyB64: 'key' },
      { id: 'solo', publicKeyB64: 'other-key', relay: relay('https://relay.onorca.dev') }
    ])

    expect([...labels]).toEqual([
      ['official', 'relay.onorca.dev'],
      ['self', 'relay.example.com:8443']
    ])
  })
})
