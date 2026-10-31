import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'

const FRAME = 'x'.repeat(1_024)

function ownerOverSocket(bufferedAmount: number) {
  const socket = { bufferedAmount, readyState: 1, OPEN: 1, send: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner reads only these members of the socket on the paths under test.
  const ws = socket as unknown as WebSocket
  return { owner: new MobileE2EEDesktopOutboundOwner(ws, () => true, vi.fn()), socket }
}

describe('outbound evidence for the link probe', () => {
  it('reports frames parked behind a full socket, by size and without their contents', () => {
    const { owner, socket } = ownerOverSocket(16 * 1024 * 1024)
    try {
      owner.enqueueLegacyText(FRAME)
      owner.enqueueLegacyText(FRAME)

      expect(socket.send).not.toHaveBeenCalled()
      const evidence = owner.evidence()
      expect(evidence).toEqual({
        queuedBytes: FRAME.length * 2,
        queuedFrames: 2,
        socketBufferedBytes: 16 * 1024 * 1024
      })
      expect(JSON.stringify(evidence)).not.toContain('xxx')
    } finally {
      owner.dispose()
    }
  })

  it('reads an idle socket as nothing ahead of the reply', () => {
    const { owner, socket } = ownerOverSocket(0)
    try {
      owner.enqueueLegacyText(FRAME)

      expect(socket.send).toHaveBeenCalledOnce()
      expect(owner.evidence()).toEqual({ queuedBytes: 0, queuedFrames: 0, socketBufferedBytes: 0 })
    } finally {
      owner.dispose()
    }
  })
})
