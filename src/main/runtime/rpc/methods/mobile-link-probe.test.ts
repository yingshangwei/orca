import '../unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { MobileLinkProbeResultSchema } from '../../../../shared/mobile-link-probe-contract'
import { RUNTIME_CAPABILITIES } from '../../../../shared/protocol-version'
import { RpcDispatcher } from '../dispatcher'
import { makeRequest, stubRuntime } from '../terminal-multiplex-test-harness'
import { MOBILE_LINK_PROBE_METHODS } from './mobile-link-probe'

async function probe(
  options: Parameters<RpcDispatcher['dispatchStreaming']>[2],
  runtime = stubRuntime()
) {
  const replies: string[] = []
  const dispatcher = new RpcDispatcher({ runtime, methods: MOBILE_LINK_PROBE_METHODS })
  await dispatcher.dispatchStreaming(
    makeRequest('mobile.linkProbe'),
    (reply) => replies.push(reply),
    options
  )
  return JSON.parse(replies[0] ?? 'null')
}

describe('mobile.linkProbe', () => {
  it('reports the queues ahead of its own reply and touches no terminal', async () => {
    const touched: string[] = []
    const runtime = new Proxy(stubRuntime(), {
      get(target, member, receiver) {
        touched.push(String(member))
        return Reflect.get(target, member, receiver)
      }
    })

    const reply = await probe(
      {
        clientKind: 'mobile',
        mobileOutboundEvidence: () => ({
          queuedBytes: 512_000,
          queuedFrames: 12,
          socketBufferedBytes: 64_000
        })
      },
      runtime
    )

    expect(reply.ok).toBe(true)
    expect(MobileLinkProbeResultSchema.parse(reply.result).outbound).toEqual({
      queuedBytes: 512_000,
      queuedFrames: 12,
      socketBufferedBytes: 64_000
    })
    expect(touched.filter((member) => /terminal|pty|agent/i.test(member))).toEqual([])
  })

  it('answers null evidence on a socket without an E2EE outbound queue', async () => {
    const reply = await probe({ clientKind: 'mobile' })
    expect(reply.result.outbound).toBeNull()
  })

  it('carries numbers only, so no text, identity or credential can leave in a reply', async () => {
    const reply = await probe({
      clientKind: 'mobile',
      mobileOutboundEvidence: () => ({ queuedBytes: 1, queuedFrames: 1, socketBufferedBytes: 1 })
    })
    const leaves = (value: unknown): unknown[] =>
      value !== null && typeof value === 'object' ? Object.values(value).flatMap(leaves) : [value]
    for (const leaf of leaves(reply.result)) {
      expect(leaf === null || typeof leaf === 'number').toBe(true)
    }
  })

  it('is published, which is the only thing that lets a phone send it', () => {
    expect(RUNTIME_CAPABILITIES).toContain('mobile.link-probe.v1')
  })
})
