import { describe, expect, it, vi } from 'vitest'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'

const workspace = {
  id: 'ws-1',
  projectGroupId: 'group-1',
  folderPath: '/tmp/ws'
} as FolderWorkspace

function createController(
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null
) {
  const removeFolderWorkspace = vi.fn(() => true)
  const teardownFolderWorkspacePtys = vi.fn(async () => undefined)
  const cleanupRemovedFolderWorkspaceState = vi.fn()
  const notifyReposChanged = vi.fn()
  const controller = new RuntimeProjectGroupController({
    getStore: () => ({ getFolderWorkspaces: () => [workspace], removeFolderWorkspace }) as never,
    resolveRepo: async () => {
      throw new Error('unused')
    },
    notifyReposChanged,
    resolveFolderConnectionId,
    teardownFolderWorkspacePtys,
    cleanupRemovedFolderWorkspaceState
  })
  return {
    controller,
    removeFolderWorkspace,
    teardownFolderWorkspacePtys,
    cleanupRemovedFolderWorkspaceState,
    notifyReposChanged
  }
}

describe('RuntimeProjectGroupController.deleteFolderWorkspace', () => {
  it('retains the catalog and PTYs when the source terminal cannot be closed', async () => {
    const deps = createController(() => null)
    deps.controller.setBeforeFolderWorkspaceDelete(async () => {
      throw new Error('Herdr did not close this terminal')
    })
    await expect(deps.controller.deleteFolderWorkspace('ws-1')).rejects.toThrow(
      'Herdr did not close'
    )
    expect(deps.removeFolderWorkspace).not.toHaveBeenCalled()
    expect(deps.teardownFolderWorkspacePtys).not.toHaveBeenCalled()
    expect(deps.cleanupRemovedFolderWorkspaceState).not.toHaveBeenCalled()
    expect(deps.notifyReposChanged).not.toHaveBeenCalled()
  })

  it('closes the source terminal before tearing down its Orca attachment', async () => {
    const deps = createController(() => null)
    const beforeDelete = vi.fn(async () => undefined)
    deps.controller.setBeforeFolderWorkspaceDelete(beforeDelete)

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(beforeDelete).toHaveBeenCalledWith(workspace)
    expect(beforeDelete.mock.invocationCallOrder[0]).toBeLessThan(
      deps.teardownFolderWorkspacePtys.mock.invocationCallOrder[0]!
    )
  })

  it('tears down PTYs and runtime state before removing the catalog row', async () => {
    const deps = createController(() => 'ssh-1')

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).toHaveBeenCalledWith('folder:ws-1', 'ssh-1')
    expect(deps.cleanupRemovedFolderWorkspaceState).toHaveBeenCalledWith('folder:ws-1')
    expect(deps.teardownFolderWorkspacePtys.mock.invocationCallOrder[0]).toBeLessThan(
      deps.removeFolderWorkspace.mock.invocationCallOrder[0]!
    )
    expect(deps.notifyReposChanged).toHaveBeenCalledTimes(1)
  })

  it('still deletes when the folder host is ambiguous, skipping only the PTY sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const deps = createController(() => {
      throw new Error('folder_workspace_connection_ambiguous')
    })

    await expect(deps.controller.deleteFolderWorkspace('ws-1')).resolves.toEqual({ deleted: true })

    expect(deps.teardownFolderWorkspacePtys).not.toHaveBeenCalled()
    expect(deps.cleanupRemovedFolderWorkspaceState).toHaveBeenCalledWith('folder:ws-1')
    expect(deps.removeFolderWorkspace).toHaveBeenCalledWith('ws-1')
    warn.mockRestore()
  })
})
