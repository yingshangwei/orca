import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RelayAgentHookServer } from './agent-hook-server'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-relay'
import { makePaneKey } from '../shared/stable-pane-id'

const PANE = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')

it('drops a codex child of the pane Claude on the relay, and forwards the pane own codex', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-nested-claude-child-'))
  const forward = vi.fn<(event: AgentHookRelayEnvelope) => void>()
  const server = new RelayAgentHookServer({ endpointDir: dir, forward })
  try {
    await server.start()
    const { port, token } = server.getCoordinates()
    const post = async (
      source: 'claude' | 'codex',
      payload: Record<string, unknown>,
      parentClaudeSession?: string
    ) => {
      const response = await fetch(`http://127.0.0.1:${port}/hook/${source}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token,
          'X-Orca-Agent-Hook-Meta-Encoding': 'base64',
          'X-Orca-Agent-Hook-Meta': Buffer.from(
            [PANE, 'tab-1', '', 'wt-1', 'production', '1'].join('\x1f')
          ).toString('base64'),
          ...(parentClaudeSession ? { 'X-Orca-Parent-Claude-Session': parentClaudeSession } : {})
        },
        body: JSON.stringify(payload)
      })
      expect(response.status).toBe(204)
    }
    await post('claude', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-main',
      prompt: 'Parent task'
    })
    forward.mockClear()
    await post(
      'codex',
      { hook_event_name: 'UserPromptSubmit', session_id: 'child', prompt: 'Child task' },
      'claude-main'
    )
    expect(forward).not.toHaveBeenCalled()
    await post('codex', {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'own-codex',
      prompt: 'Own codex'
    })
    expect(forward.mock.lastCall?.[0]).toMatchObject({
      source: 'codex',
      payload: { prompt: 'Own codex' }
    })
    expect(forward.mock.lastCall?.[0].parentClaudeSession).toBeUndefined()
  } finally {
    server.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
