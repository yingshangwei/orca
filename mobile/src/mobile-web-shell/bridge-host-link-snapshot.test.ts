import { describe, expect, it } from 'vitest'
import { BRIDGE_MAX_UNACKED_FRAMES, BridgeHostSubscriptions } from './bridge-host-subscriptions'
import { readBridgeNativeVerbCall } from './bridge/bridge-native-verbs'
import { createFakeRpcClient } from './bridge-host-test-fakes'

function terminalStream() {
  const client = createFakeRpcClient()
  let seen = 0
  const subscriptions = new BridgeHostSubscriptions({
    client,
    post: () => {
      seen += 1
    },
    onBinaryFrameDropped: () => {}
  })
  subscriptions.start('stream', 'terminal.subscribe', {})
  const emitOutput = () => client.streams[0]?.emit({ type: 'data', streamId: 1, chunk: 'output' })
  return { emitOutput, seen: () => seen, subscriptions }
}

describe('the link snapshot', () => {
  it('reads as nothing held while the page keeps up', () => {
    const { emitOutput, subscriptions } = terminalStream()
    emitOutput()
    expect(subscriptions.heldOutputBytes).toBe(0)
  })

  it('reports the output the page has not made room for, and its release on ack', () => {
    const { emitOutput, seen, subscriptions } = terminalStream()
    for (let index = 0; index < BRIDGE_MAX_UNACKED_FRAMES + 8; index += 1) {
      emitOutput()
    }
    expect(subscriptions.heldOutputBytes).toBeGreaterThan(0)

    subscriptions.ack('stream', seen())

    expect(subscriptions.heldOutputBytes).toBe(0)
  })

  it('is refused for a page on a route that did not ask for it', () => {
    const read = readBridgeNativeVerbCall({
      method: 'native.link.snapshot',
      granted: ['navigate'],
      params: {}
    })
    expect(read).toMatchObject({ ok: false, refusal: 'ungranted' })
  })

  it('takes no params, so it cannot be asked about anything else', () => {
    const read = readBridgeNativeVerbCall({
      method: 'native.link.snapshot',
      granted: ['native.link.snapshot'],
      params: { terminal: 'terminal-1' }
    })
    expect(read).toMatchObject({ ok: false, refusal: 'invalid-params' })
  })
})
