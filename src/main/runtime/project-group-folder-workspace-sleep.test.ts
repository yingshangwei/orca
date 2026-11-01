import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withDurableRuntimeStore } from './runtime-durable-store-fixture'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import { toAppSshPtyId } from '../../shared/ssh-pty-id'
import { spawnWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import { WORKTREE_TERMINALS_SLEEPING_ERROR } from './worktree-terminals-sleeping-error'
import { OrcaRuntimeService } from './orca-runtime'

// STA-12562: project-group folder workspaces have no repo row, so a repo-only selector never finds them.
const FOLDER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const WORKSPACE_ID = folderWorkspaceKey(FOLDER_ID)
const PTY_ID = `${WORKSPACE_ID}@@pty-a`

function createRuntime(
  options: {
    folderPath?: string
    repoConnectionIds?: (string | null)[]
    ptyConnectionId?: string
    foreignConnectionId?: string
    executionHostId?: string
  } = {}
) {
  const folderPath = options.folderPath ?? '/Users/me'
  const group = { id: 'group-1', name: 'Home', parentPath: folderPath, connectionId: null }
  const folder = {
    id: FOLDER_ID,
    projectGroupId: group.id,
    name: 'home',
    folderPath,
    ...(options.executionHostId === undefined ? {} : { executionHostId: options.executionHostId }),
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
  const repos = (options.repoConnectionIds ?? []).map((connectionId, index) => ({
    id: `repo-${index}`,
    path: `${folderPath}/repo-${index}`,
    displayName: `Repo ${index}`,
    badgeColor: 'blue',
    addedAt: 1,
    projectGroupId: group.id,
    connectionId
  }))
  const meta: Record<string, Record<string, unknown>> = {}
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the store methods sleep reads.
  const store = withDurableRuntimeStore({
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjectGroups: () => [group],
    getFolderWorkspaces: () => [folder],
    getAllWorktreeMeta: () => meta,
    getWorktreeMeta: (id: string) => meta[id],
    setWorktreeMeta: () => ({}),
    getWorkspaceSession: () => getDefaultWorkspaceSession(),
    setWorkspaceSession: () => {},
    flushOrThrow: () => {}
  }) as never
  const runtime = new OrcaRuntimeService(store)
  const ownPtyId = options.ptyConnectionId ? toAppSshPtyId(options.ptyConnectionId, PTY_ID) : PTY_ID
  const foreignPtyId = options.foreignConnectionId
    ? toAppSshPtyId(options.foreignConnectionId, PTY_ID)
    : null
  const processes = new Map(
    [ownPtyId, ...(foreignPtyId ? [foreignPtyId] : [])].map(
      (id) => [id, { id, worktreeId: WORKSPACE_ID, cwd: folderPath, title: 'a' }] as const
    )
  )
  const stopAndWait = vi.fn(async (ptyId: string) => {
    const existed = processes.delete(ptyId)
    if (existed) {
      runtime.onPtyExit(ptyId, -1)
    }
    return existed
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements only the controller calls sleep makes.
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    stopAndWait,
    getForegroundProcess: async () => null,
    listProcesses: async () => [...processes.values()]
  } as never)
  return { runtime, stopAndWait, processes, ownPtyId, foreignPtyId }
}

describe('sleeping a project-group folder workspace', () => {
  it('stops its terminals instead of failing to resolve the workspace', async () => {
    const { runtime } = createRuntime()

    const result = await runtime.sleepTerminalsForWorktree(`id:${WORKSPACE_ID}`)

    expect(result.stoppedPtyIds).toEqual([PTY_ID])
    expect(result.postStopVerified).toBe(true)
  })

  it('still stops its terminals when the folder path has disappeared', async () => {
    const folderPath = mkdtempSync(join(tmpdir(), 'orca-sleep-missing-folder-'))
    rmSync(folderPath, { recursive: true, force: true })
    const { runtime, processes } = createRuntime({ folderPath })

    const result = await runtime.sleepTerminalsForWorktree(`id:${WORKSPACE_ID}`)

    expect(result.stoppedPtyIds).toEqual([PTY_ID])
    expect(result.postStopVerified).toBe(true)
    expect(processes.size).toBe(0)
  })

  it('preserves a foreign host terminal with the same folder workspace id', async () => {
    const { runtime, processes, stopAndWait, foreignPtyId } = createRuntime({
      foreignConnectionId: 'ssh-foreign'
    })

    const result = await runtime.sleepTerminalsForWorktree(`id:${WORKSPACE_ID}`)

    expect(result.stoppedPtyIds).toEqual([PTY_ID])
    expect(stopAndWait.mock.calls.map(([id]) => id)).toEqual([PTY_ID])
    expect([...processes.keys()]).toEqual([foreignPtyId])
  })

  it('stops the inferred SSH host and holds the same spawn key', async () => {
    const { runtime, processes, ownPtyId } = createRuntime({
      repoConnectionIds: ['ssh-primary'],
      ptyConnectionId: 'ssh-primary'
    })

    const result = await runtime.sleepTerminalsForWorktree(`id:${WORKSPACE_ID}`)

    expect(result.stoppedPtyIds).toEqual([ownPtyId])
    expect(result.postStopVerified).toBe(true)
    expect(processes.size).toBe(0)
    await expect(
      runtime.acquireWorktreeTerminalSpawn(spawnWorktreeTarget(WORKSPACE_ID, 'ssh-primary'), {
        refuseSleptWorktree: true
      })
    ).rejects.toThrow(WORKTREE_TERMINALS_SLEEPING_ERROR)
    const releaseLocal = await runtime.acquireWorktreeTerminalSpawn(
      spawnWorktreeTarget(WORKSPACE_ID, null),
      { refuseSleptWorktree: true }
    )
    releaseLocal()
  })

  it('refuses an ambiguous folder host without stopping any terminal', async () => {
    const { runtime, processes, stopAndWait } = createRuntime({
      repoConnectionIds: ['ssh-primary', null],
      ptyConnectionId: 'ssh-primary'
    })

    await expect(runtime.sleepTerminalsForWorktree(`id:${WORKSPACE_ID}`)).rejects.toThrow(
      'folder_workspace_connection_ambiguous'
    )
    expect(stopAndWait).not.toHaveBeenCalled()
    expect(processes.size).toBe(1)
    expect(runtime.getTerminalSleepClientEventSnapshot()).toEqual([])
  })

  it('refuses an invalid explicit folder host without assuming local ownership', async () => {
    const { runtime, stopAndWait } = createRuntime({ executionHostId: 'invalid-host' })

    await expect(runtime.sleepTerminalsForWorktree(`id:${WORKSPACE_ID}`)).rejects.toThrow(
      'folder_workspace_not_found'
    )
    expect(stopAndWait).not.toHaveBeenCalled()
  })
})
