import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { getDefaultHighWaterMark, setDefaultHighWaterMark, type Writable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import WebSocket, { WebSocketServer } from 'ws'
import { ProcessQueuedByteBudget, wireSplice } from './splice-forwarder.js'

it.each([true, false])(
  'backpressures real ws reads with synchronous events %s',
  async (allowSynchronousEvents) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, allowSynchronousEvents })
    const peers: WebSocket[] = []
    const originalWaterMark = getDefaultHighWaterMark(false)
    let stop: (() => void) | undefined
    try {
      await once(server, 'listening')
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
      const connect = async (): Promise<WebSocket> => {
        const connected = once(server, 'connection')
        const peer = new WebSocket(`ws://127.0.0.1:${address.port}`)
        peers.push(peer)
        await once(peer, 'open')
        const [socket] = await connected
        if (!(socket instanceof WebSocket)) throw new Error('Expected a WebSocket peer')
        return socket
      }
      // Keep drain deterministic even when TCP divides the batch into smaller reads.
      setDefaultHighWaterMark(false, 1024)
      const source = await connect()
      const target = await connect()
      setDefaultHighWaterMark(false, originalWaterMark)
      let bufferedAmount = 1024 * 1024
      vi.spyOn(target, 'bufferedAmount', 'get').mockImplementation(() => bufferedAmount)
      let forwarded = 0
      const budget = new ProcessQueuedByteBudget()
      stop = wireSplice({
        client: source,
        host: target,
        budget,
        onClose: vi.fn(),
        onForwardedBytes: () => {
          forwarded += 1
        }
      })
      // SAFETY: an open ws instance owns the Writable receiver; observing drain exercises its real listener.
      const receiver = (source as WebSocket & { _receiver: Writable })._receiver
      const drained = allowSynchronousEvents ? undefined : once(receiver, 'drain')
      for (let index = 0; index < 128; index += 1) peers[0]!.send(Buffer.alloc(1024))
      if (drained) await drained
      else await vi.waitFor(() => expect(forwarded).toBeGreaterThan(0))
      const heldCount = forwarded
      expect(heldCount).toBeGreaterThan(0)
      peers[0]!.send(Buffer.from('later read'))
      await delay(100)
      expect(forwarded).toBe(heldCount)
      if (!allowSynchronousEvents) expect(source.isPaused).toBe(true)
      expect(budget.current()).toBeGreaterThan(0)
      bufferedAmount = 0
      await vi.waitFor(() => {
        expect(forwarded).toBe(129)
        expect(budget.current()).toBe(0)
        expect(source.isPaused).toBe(false)
      })
    } finally {
      setDefaultHighWaterMark(false, originalWaterMark)
      stop?.()
      for (const peer of peers) peer.terminate()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
      vi.restoreAllMocks()
    }
  }
)
