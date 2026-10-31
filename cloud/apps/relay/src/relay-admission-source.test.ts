import { describe, expect, it } from 'vitest'
import { relayAdmissionSource } from './relay-admission-source.js'

describe('relay client addresses', () => {
  it('preserves the official Google load-balancer convention', () => {
    expect(
      relayAdmissionSource({
        selfHosted: false,
        remoteAddress: '10.0.0.1',
        forwardedFor: 'spoofed, 203.0.113.7, 192.0.2.1'
      })
    ).toBe('203.0.113.7')
  })

  it('uses a Caddy client address only with explicit trust and a private socket peer', () => {
    const input = {
      selfHosted: true,
      trustPrivateProxy: true,
      remoteAddress: '::ffff:172.19.0.2',
      forwardedFor: '203.0.113.7'
    }
    expect(relayAdmissionSource(input)).toBe('203.0.113.7')
    expect(relayAdmissionSource({ ...input, forwardedFor: '198.51.100.2' })).toBe('198.51.100.2')
    expect(relayAdmissionSource({ ...input, trustPrivateProxy: false })).toBe('172.19.0.2')
    expect(relayAdmissionSource({ ...input, remoteAddress: '198.51.100.3' })).toBe('198.51.100.3')
    expect(relayAdmissionSource({ ...input, forwardedFor: 'spoofed, 203.0.113.7' })).toBe(
      '172.19.0.2'
    )
    expect(relayAdmissionSource({ ...input, forwardedFor: 'not-an-ip' })).toBe('172.19.0.2')
  })
})
