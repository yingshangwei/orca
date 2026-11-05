import { afterEach, describe, expect, it } from 'vitest'
import { setQueuedAgentStatusFlush } from '@/hooks/ipc-events/agent-status-queued-flush'
import {
  dispatchWindowCloseRequest,
  setWindowCloseRequestHandler
} from './window-close-request-coordinator'

describe('window close request and queued agent status', () => {
  afterEach(() => {
    setQueuedAgentStatusFlush(null)
    setWindowCloseRequestHandler(null)
  })

  it('applies queued agent status before the close handler checkpoints', async () => {
    const order: string[] = []
    setQueuedAgentStatusFlush(() => order.push('flush'))
    setWindowCloseRequestHandler(() => order.push('close'))
    await dispatchWindowCloseRequest({ isQuitting: true })
    expect(order).toEqual(['flush', 'close'])
  })
})
