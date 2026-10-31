import { BlockList, isIP } from 'node:net'

const privateProxies = new BlockList()
privateProxies.addSubnet('10.0.0.0', 8)
privateProxies.addSubnet('172.16.0.0', 12)
privateProxies.addSubnet('192.168.0.0', 16)
privateProxies.addSubnet('127.0.0.0', 8)
privateProxies.addSubnet('fc00::', 7, 'ipv6')
privateProxies.addAddress('::1', 'ipv6')

function normalizeAddress(value: string): string {
  const mapped = value.replace(/^::ffff:/i, '')
  return isIP(mapped) === 4 ? mapped : value
}

export function relayAdmissionSource(input: {
  forwardedFor: string | string[] | undefined
  remoteAddress: string | undefined
  selfHosted: boolean
  trustPrivateProxy?: boolean
}): string {
  const chain = (
    Array.isArray(input.forwardedFor) ? input.forwardedFor.join(',') : (input.forwardedFor ?? '')
  )
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const remoteAddress = input.remoteAddress ?? 'unknown'
  if (!input.selfHosted) {
    // Google Front End appends the client and load-balancer after untrusted values.
    return chain.length >= 2 ? chain.at(-2)! : remoteAddress
  }
  const peer = normalizeAddress(remoteAddress)
  const family = isIP(peer)
  const trusted = family !== 0 && privateProxies.check(peer, family === 4 ? 'ipv4' : 'ipv6')
  const clientAddress = chain.length === 1 ? chain[0] : undefined
  // The private, single-hop proxy must replace X-Forwarded-For with the actual client IP.
  if (!input.trustPrivateProxy || !trusted || !clientAddress || !isIP(clientAddress)) {
    return peer
  }
  return normalizeAddress(clientAddress)
}
