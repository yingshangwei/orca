import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import {
  closeHerdrTerminal,
  herdrAttachCommand,
  openHerdrTerminal,
  readHerdrSnapshot
} from './herdr-cli'

vi.mock('@orca/process-host', () => ({ runProcess: vi.fn() }))
vi.mock('../ipc/command-path-resolver', () => ({ resolveCommandOnLocalPath: vi.fn() }))

type ProcessResult = Awaited<ReturnType<typeof runProcess>>
type FakePane = ReturnType<typeof fakePane>

function fakePane(pane_id: string, terminal_id: string) {
  return { pane_id, terminal_id, workspace_id: 'w1', tab_id: 'w1:t1', cwd: '/project' }
}

function processResult(code: number, stdout = '', stderr = ''): ProcessResult {
  return { code, signal: null, stdout, stderr, timedOut: false }
}

function snapshotResult(panes: FakePane[]): ProcessResult {
  return processResult(
    0,
    JSON.stringify({ result: { snapshot: { workspaces: [], tabs: [], panes } } })
  )
}

function fakeHerdr(
  initial: FakePane[],
  close: (panes: FakePane[], paneId: string) => { panes: FakePane[]; result: ProcessResult }
) {
  let panes = initial
  const closed: string[] = []
  vi.mocked(runProcess).mockImplementation(async ({ args = [] }) => {
    if (args[0] === 'api') {
      return snapshotResult(panes)
    }
    expect(args.slice(0, 2)).toEqual(['pane', 'close'])
    closed.push(args[2])
    const outcome = close(panes, args[2])
    panes = outcome.panes
    return outcome.result
  })
  return { closed, terminals: () => panes.map((pane) => pane.terminal_id) }
}

const closesOnlyThatPane = (panes: FakePane[], paneId: string) => ({
  panes: panes.filter((pane) => pane.pane_id !== paneId),
  result: processResult(0)
})

const directories: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('Herdr CLI boundary', () => {
  it.runIf(process.platform === 'darwin')(
    'opens a private command file in the independent Terminal app',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'orca-herdr-launch-'))
      directories.push(directory)
      vi.mocked(resolveCommandOnLocalPath).mockResolvedValue(
        "/Users/me/Apps with space/herdr's bin"
      )
      vi.mocked(runProcess).mockResolvedValue({
        code: 0,
        signal: null,
        stdout: '',
        stderr: '',
        timedOut: false
      })
      await openHerdrTerminal(directory)
      const script = join(directory, 'herdr', 'Open Herdr.command')
      expect(await readFile(script, 'utf8')).toBe(
        "#!/bin/sh\nexec '/Users/me/Apps with space/herdr'\\''s bin'\n"
      )
      expect((await stat(script)).mode & 0o777).toBe(0o700)
      expect(runProcess).toHaveBeenCalledWith(
        expect.objectContaining({ program: '/usr/bin/open', args: ['-a', 'Terminal', script] })
      )
    }
  )

  it('quotes shell text and places takeover after the terminal ID for the installed CLI parser', () => {
    expect(herdrAttachCommand('/tools/herdr; touch /tmp/no', 'term_one')).toBe(
      "'/tools/herdr; touch /tmp/no' terminal attach 'term_one' --takeover"
    )
  })

  it('finds a moved terminal by stable id and keeps the other panes of its split tab', async () => {
    const herdr = fakeHerdr(
      [fakePane('w2:p7', 'term_moved'), fakePane('w2:p8', 'term_sibling')],
      closesOnlyThatPane
    )
    await closeHerdrTerminal('/tools/herdr', 'term_moved')
    expect(herdr.closed).toEqual(['w2:p7'])
    expect(herdr.terminals()).toEqual(['term_sibling'])
  })

  it('treats an already closed terminal as done without closing anything', async () => {
    const herdr = fakeHerdr([fakePane('w1:p2', 'term_sibling')], closesOnlyThatPane)
    await expect(closeHerdrTerminal('/tools/herdr', 'term_gone')).resolves.toBeUndefined()
    expect(herdr.closed).toEqual([])
  })

  it.each([
    ['Herdr refused the close', 1, 'Herdr refused the close'],
    ['Herdr did not close this terminal', 0, '']
  ])('fails with "%s" while the terminal is still listed', async (message, code, stderr) => {
    const panes = [fakePane('w1:p1', 'term_stuck')]
    fakeHerdr(panes, () => ({ panes, result: processResult(code, '', stderr) }))
    await expect(closeHerdrTerminal('/tools/herdr', 'term_stuck')).rejects.toThrow(message)
  })

  it('accepts a failed close command when the read-back proves the terminal is gone', async () => {
    const herdr = fakeHerdr([fakePane('w1:p1', 'term_raced')], (panes, paneId) => ({
      panes: closesOnlyThatPane(panes, paneId).panes,
      result: processResult(1, '', 'pane not found')
    }))
    await expect(closeHerdrTerminal('/tools/herdr', 'term_raced')).resolves.toBeUndefined()
    expect(herdr.terminals()).toEqual([])
  })

  it('does not report success when the close cannot be read back', async () => {
    vi.mocked(runProcess)
      .mockResolvedValueOnce(snapshotResult([fakePane('w1:p1', 'term_unknown')]))
      .mockResolvedValueOnce(processResult(0))
      .mockResolvedValueOnce(processResult(1, '', 'server unavailable'))
    await expect(closeHerdrTerminal('/tools/herdr', 'term_unknown')).rejects.toThrow(
      'server unavailable'
    )
  })

  it('rejects malformed or duplicate snapshots before any syncing can begin', async () => {
    const pane = {
      pane_id: 'w1:p1',
      terminal_id: 'term_one',
      workspace_id: 'w1',
      tab_id: 'w1:t1',
      cwd: '/project'
    }
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stderr: '',
      timedOut: false,
      stdout: JSON.stringify({
        result: { snapshot: { workspaces: [], tabs: [], panes: [pane, pane] } }
      })
    })
    await expect(readHerdrSnapshot('/tools/herdr')).rejects.toThrow('duplicate terminal identities')
    vi.mocked(runProcess).mockResolvedValue({
      code: 0,
      signal: null,
      stderr: '',
      timedOut: false,
      stdout: '{}'
    })
    await expect(readHerdrSnapshot('/tools/herdr')).rejects.toThrow()
  })
})
