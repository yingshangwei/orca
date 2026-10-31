import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AgentTransitionDetector,
  type AgentPaneChange
} from '../agent-hooks/agent-transition-detector'
import { createHerdrStatusFixture } from './herdr-status-test-fixture'
import { parseHerdrSnapshot } from './herdr-snapshot'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const fixtures: ReturnType<typeof createHerdrStatusFixture>[] = []
function fixture(status = 'working') {
  const h = createHerdrStatusFixture(status)
  fixtures.push(h)
  const changes: AgentPaneChange[] = []
  const detector = new AgentTransitionDetector({
    resolveTabWorktreeId: () => undefined,
    subscribeToPtyExit: () => () => {},
    now: Date.now
  })
  detector.subscribe((change) => changes.push(change))
  detector.attach(h.server)
  const news = () =>
    changes.flatMap((change) =>
      change.kind === 'moved' && change.transition ? [change.transition] : []
    )
  return { ...h, changes, news }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
})
afterEach(() => {
  for (const h of fixtures.splice(0)) {
    h.bridge.dispose()
    h.server.stop()
  }
  vi.useRealTimers()
})

describe('Herdr live status bridge', () => {
  it.each(['claude', 'codex'])(
    'delivers %s completion once and keeps the provider session across turns',
    async (agent) => {
      const h = fixture()
      h.snapshot.panes[0].agent = agent
      const listener = vi.fn()
      h.server.setListener(listener)
      await h.bridge.refresh()
      expect(h.news()).toEqual([])
      expect(h.server.getStatusSnapshot()[0]).toMatchObject({ state: 'working', isReplay: true })
      h.snapshot.panes[0].agent_status = 'done'
      vi.setSystemTime(11_000)
      await h.bridge.refresh()
      await h.bridge.refresh()
      expect(h.news()).toEqual(['turn-finished'])
      expect(listener).toHaveBeenCalledTimes(3)
      h.snapshot.panes[0].agent_status = 'working'
      await h.bridge.refresh()
      expect(h.server.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        providerSession: { id: 'session-1', transcriptPath: '/history/session-1.jsonl' },
        observation: { origin: 'herdr' }
      })
      expect(h.server.getStatusSnapshot()[0].providerSessionOnly).not.toBe(true)
      h.snapshot.panes[0].agent_status = 'blocked'
      await h.bridge.refresh()
      await h.bridge.refresh()
      expect(h.news()).toEqual(['turn-finished', 'prompt-submitted', 'needs-input'])
    }
  )

  it.each(['done', 'idle', 'blocked'])(
    'starts with %s silently and does not turn idle into completion',
    async (status) => {
      const h = fixture(status)
      await h.bridge.refresh()
      await h.bridge.refresh()
      expect(h.news()).toEqual([])
      h.snapshot.panes[0].agent_status = 'working'
      await h.bridge.refresh()
      h.snapshot.panes[0].agent_status = 'idle'
      await h.bridge.refresh()
      expect(h.news()).not.toContain('turn-finished')
    }
  )

  it('promotes an identity-only done row into a live baseline', async () => {
    const h = fixture('done')
    h.server.recordLaunchResumeIdentity({
      paneKey: `${h.tab.parentTabId}:${h.tab.leafId}`,
      agentType: 'claude',
      worktreeId: `folder:${h.folder.id}`,
      launchedAt: 0,
      providerSession: { key: 'session_id', id: 'session-1' }
    })
    await h.bridge.refresh()
    expect(h.server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', isReplay: true })
    expect(h.server.getStatusSnapshot()[0].providerSessionOnly).not.toBe(true)
    expect(h.news()).toEqual([])
  })

  it('reconnects and changes sessions with a silent baseline', async () => {
    const h = fixture()
    await h.bridge.refresh()
    vi.mocked(h.deps.snapshot).mockRejectedValueOnce(new Error('offline'))
    await h.bridge.refresh()
    h.snapshot.panes[0].agent_status = 'done'
    await h.bridge.refresh()
    expect(h.news()).toEqual([])
    h.snapshot.panes[0].agent_session = { kind: 'id', value: 'session-2' }
    h.snapshot.panes[0].agent_status = 'blocked'
    await h.bridge.refresh()
    expect(h.server.getStatusSnapshot()[0]).toMatchObject({
      providerSession: { id: 'session-2' },
      isReplay: true
    })
    expect(h.news()).toEqual([])
  })

  it('keeps native hook authority when a linked status disagrees', async () => {
    const h = fixture('done')
    h.server.ingestTerminalStatus({
      paneKey: `${h.tab.parentTabId}:${h.tab.leafId}`,
      tabId: h.tab.parentTabId,
      worktreeId: `folder:${h.folder.id}`,
      payload: { state: 'working', agentType: 'claude', prompt: 'native task' }
    })
    h.server.ingestRemote(
      {
        paneKey: `${h.tab.parentTabId}:${h.tab.leafId}`,
        tabId: h.tab.parentTabId,
        worktreeId: `folder:${h.folder.id}`,
        payload: { state: 'working', agentType: 'claude', prompt: 'native task' }
      },
      'conn-native'
    )
    const before = h.server.getStatusSnapshot()
    await h.bridge.refresh()
    expect(h.server.getStatusSnapshot()).toEqual(before)
  })

  it('ignores removed bindings and a missing tab, then seeds a returning pane', async () => {
    const h = fixture()
    await h.bridge.refresh()
    h.snapshot.panes.splice(0)
    await h.bridge.refresh()
    h.snapshot.panes.push({
      pane_id: 'w1:p1',
      terminal_id: 'term_original',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      cwd: '/project',
      agent: 'claude',
      agent_status: 'done',
      agent_session: { kind: 'id', value: 'session-1' }
    })
    await h.bridge.refresh()
    expect(h.news()).toEqual([])
    h.state.bindings.term_original.tabId = 'closed-tab'
    h.snapshot.panes[0].agent_status = 'blocked'
    await h.bridge.refresh()
    expect(h.news()).toEqual([])
    delete h.state.bindings.term_original
    await h.bridge.refresh()
    expect(h.server.getStatusSnapshot()[0].state).toBe('done')
  })

  it('does not read a suppressed binding even when its folder is back in the catalog', async () => {
    const h = fixture()
    h.state.bindings.term_original.suppressed = true
    await h.bridge.refresh()
    expect(h.deps.snapshot).not.toHaveBeenCalled()
    expect(h.server.getStatusSnapshot()).toEqual([])
  })

  it('polls without overlap and drops an in-flight result after disposal', async () => {
    const h = fixture()
    let finish = () => {}
    vi.mocked(h.deps.snapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(h.snapshot)
        })
    )
    h.bridge.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.deps.snapshot).toHaveBeenCalledTimes(1)
    const pending = h.bridge.refresh()
    h.bridge.dispose()
    finish()
    await pending
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.server.getStatusSnapshot()).toEqual([])
    expect(h.deps.snapshot).toHaveBeenCalledTimes(1)
  })

  it('accepts nullable fields from the Herdr snapshot schema', () => {
    expect(
      parseHerdrSnapshot({
        result: {
          snapshot: {
            workspaces: [],
            tabs: [],
            panes: [
              {
                pane_id: 'w1:p1',
                terminal_id: 'term_shell',
                workspace_id: 'w1',
                tab_id: 'w1:t1',
                cwd: null,
                foreground_cwd: null,
                agent: null,
                agent_session: null,
                terminal_title_stripped: null
              }
            ]
          }
        }
      }).panes[0]
    ).toMatchObject({ cwd: '', agent: null })
  })
})
