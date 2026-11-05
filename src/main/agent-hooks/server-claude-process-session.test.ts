import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

let dir: string
let server: AgentHookServer

beforeEach(async () => {
  _internals.resetCachesForTests()
  dir = mkdtempSync(join(tmpdir(), 'orca-claude-process-session-'))
  server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
})

afterEach(() => {
  server.stop()
  rmSync(dir, { recursive: true, force: true })
})

const CLEARED = {
  key: 'session_id' as const,
  id: 'after-clear',
  transcriptPath: '/projects/cwd/after-clear.jsonl'
}

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

describe("a Claude pane's session from its process registry", () => {
  it('names the session on an OSC-only Claude row and keeps its state', () => {
    claudeProgramStatus('working')
    expect(server.recordClaudeSessionFromProcess({ paneKey: PANE, providerSession: CLEARED })).toBe(
      true
    )
    const [row] = server.getStatusSnapshotForPane(PANE)
    expect(row).toMatchObject({ agentType: 'claude', state: 'working', providerSession: CLEARED })
  })

  it('keeps the session through later OSC repaints and a finished turn', () => {
    claudeProgramStatus('working')
    server.recordClaudeSessionFromProcess({ paneKey: PANE, providerSession: CLEARED })
    claudeProgramStatus('done')
    claudeProgramStatus('working')
    const [row] = server.getStatusSnapshotForPane(PANE)
    expect(row).toMatchObject({ agentType: 'claude', state: 'working', providerSession: CLEARED })
  })

  it('replaces an older session after a /clear', () => {
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: 'before-clear' },
      launchedAt: Date.now() - 5_000
    })
    claudeProgramStatus('working')
    expect(server.recordClaudeSessionFromProcess({ paneKey: PANE, providerSession: CLEARED })).toBe(
      true
    )
    const [row] = server.getStatusSnapshotForPane(PANE)
    expect(row?.providerSession).toEqual(CLEARED)
  })

  it("never names a Claude session on a codex pane's row", async () => {
    const response = await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'own codex',
        session_id: 'codex-1'
      }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
    expect(server.recordClaudeSessionFromProcess({ paneKey: PANE, providerSession: CLEARED })).toBe(
      false
    )
    const [row] = server.getStatusSnapshotForPane(PANE)
    expect(row).toMatchObject({ agentType: 'codex' })
    expect(row?.providerSession?.id).toBe('codex-1')
  })

  it('is a no-op when the pane already names that session', () => {
    claudeProgramStatus('working')
    server.recordClaudeSessionFromProcess({ paneKey: PANE, providerSession: CLEARED })
    expect(server.recordClaudeSessionFromProcess({ paneKey: PANE, providerSession: CLEARED })).toBe(
      false
    )
  })
})
