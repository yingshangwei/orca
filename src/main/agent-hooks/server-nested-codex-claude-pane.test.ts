import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHookEventPayload } from '../../shared/agent-hook-listener/listener-event'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  _internals.resetCachesForTests()
  dir = mkdtempSync(join(tmpdir(), 'orca-nested-codex-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const CLAUDE_MAIN = { key: 'session_id' as const, id: 'claude-main' }

function claudeProgramStatus(state: 'working' | 'done'): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true,
    payload: { prompt: '', state, agentType: 'claude' }
  })
}

function seedClaudeResume(): void {
  server.recordLaunchResumeIdentity({
    paneKey: PANE,
    worktreeId: 'wt-1',
    agentType: 'claude',
    providerSession: CLAUDE_MAIN,
    launchedAt: Date.now() - 5_000
  })
}

async function codexHook(
  event: Record<string, unknown>,
  parentClaudeSession?: string
): Promise<void> {
  const response = await postHookEvent(
    server,
    {
      ...buildBody({ session_id: 'child-thread', turn_id: 'child-turn', ...event }),
      ...(parentClaudeSession ? { parentClaudeSession } : {})
    },
    '/hook/codex'
  )
  expect(response.status).toBe(204)
}

async function childCodexTurn(): Promise<void> {
  await codexHook({ hook_event_name: 'SessionStart' }, 'claude-main')
  await codexHook({ hook_event_name: 'UserPromptSubmit', prompt: 'review the doc' }, 'claude-main')
  await codexHook({ hook_event_name: 'Stop' }, 'claude-main')
}

/** The stored row, including the private turn record no snapshot publishes. */
function storedRow(): AgentHookEventPayload | undefined {
  return server._getStateForTests().lastStatusByPaneKey.get(PANE)
}

describe('a codex exec launched from a Claude pane (Claude hooks off)', () => {
  it('keeps the Claude row while Claude is still working', async () => {
    seedClaudeResume()
    claudeProgramStatus('working')
    await childCodexTurn()
    expect(storedRow()?.payload).toMatchObject({ agentType: 'claude', state: 'working' })
    expect(storedRow()?.providerSession).toEqual(CLAUDE_MAIN)
    expect(storedRow()?.hostTurn).toBeUndefined()
  })

  it('keeps the Claude row and session after Claude finished its turn', async () => {
    seedClaudeResume()
    claudeProgramStatus('working')
    claudeProgramStatus('done')
    await childCodexTurn()
    expect(storedRow()?.payload).toMatchObject({ agentType: 'claude', state: 'done', prompt: '' })
    expect(storedRow()?.providerSession).toEqual(CLAUDE_MAIN)
    expect(storedRow()?.hostTurn).toBeUndefined()
    claudeProgramStatus('working')
    expect(storedRow()?.payload).toMatchObject({ agentType: 'claude', state: 'working' })
    expect(storedRow()?.providerSession).toEqual(CLAUDE_MAIN)
  })

  it('keeps a resume-seeded Claude pane before Claude paints its first status', async () => {
    seedClaudeResume()
    await childCodexTurn()
    expect(storedRow()?.payload).toMatchObject({ agentType: 'claude' })
    expect(storedRow()?.providerSession).toEqual(CLAUDE_MAIN)
  })

  it('lets the next agent take a stale seed left by a different Claude session', async () => {
    seedClaudeResume()
    await codexHook({ hook_event_name: 'UserPromptSubmit', prompt: 'other' }, 'another-claude')
    expect(storedRow()?.payload).toMatchObject({ agentType: 'codex', state: 'working' })
  })

  it('still lets a codex the pane itself runs report after Claude exits', async () => {
    seedClaudeResume()
    claudeProgramStatus('done')
    await codexHook({ hook_event_name: 'SessionStart', session_id: 'pane-codex' })
    await codexHook({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'own turn',
      session_id: 'pane-codex'
    })
    expect(storedRow()?.payload).toMatchObject({
      agentType: 'codex',
      state: 'working',
      prompt: 'own turn'
    })
    expect(storedRow()?.providerSession?.id).toBe('pane-codex')
  })

  it('does not drop a child-stamped hook in a pane that does not hold Claude', async () => {
    await codexHook({ hook_event_name: 'SessionStart' }, 'claude-main')
    await codexHook(
      { hook_event_name: 'UserPromptSubmit', prompt: 'in a codex pane' },
      'claude-main'
    )
    expect(storedRow()?.payload).toMatchObject({ agentType: 'codex', state: 'working' })
  })

  it('drops a relayed child stamped by its relay', () => {
    seedClaudeResume()
    claudeProgramStatus('done')
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        hookEventName: 'UserPromptSubmit',
        hasExplicitPrompt: true,
        parentClaudeSession: 'claude-main',
        payload: { state: 'working', prompt: 'relayed child', agentType: 'codex' }
      },
      null
    )
    expect(storedRow()?.payload).toMatchObject({ agentType: 'claude', state: 'done' })
  })
})
