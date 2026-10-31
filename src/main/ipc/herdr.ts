import { app, ipcMain } from 'electron'
import { join } from 'node:path'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  closeHerdrTerminal,
  openHerdrTerminal,
  readHerdrSnapshot,
  resolveHerdrExecutable
} from '../herdr/herdr-cli'
import { HerdrSyncService } from '../herdr/herdr-sync'
import { HerdrStatusBridge } from '../herdr/herdr-status-bridge'
import { agentHookServer } from '../agent-hooks/server'
import { loadHerdrSyncState, saveHerdrSyncState } from '../herdr/herdr-sync-state'
import { resolveSessionFilePath } from '../native-chat/session-file-resolver'
import { seedResumeLaunchIdentity } from './pty/pane/resume-launch-identity'

export function registerHerdrHandlers(runtime: OrcaRuntimeService): void {
  if (process.platform !== 'darwin') {
    return
  }
  const statePath = join(app.getPath('userData'), 'herdr-sync.json')
  const statusBridge = new HerdrStatusBridge({
    runtime,
    server: agentHookServer,
    executable: resolveHerdrExecutable,
    snapshot: readHerdrSnapshot,
    load: () => loadHerdrSyncState(statePath),
    transcript: resolveSessionFilePath,
    onError: (error) => console.warn('[herdr] Could not refresh agent status:', error)
  })
  statusBridge.start()
  app.once('will-quit', () => statusBridge.dispose())
  const service = new HerdrSyncService({
    runtime,
    executable: resolveHerdrExecutable,
    snapshot: readHerdrSnapshot,
    closeTerminal: closeHerdrTerminal,
    load: () => loadHerdrSyncState(statePath),
    save: (state) => saveHerdrSyncState(statePath, state),
    transcript: resolveSessionFilePath,
    seedIdentity: seedResumeLaunchIdentity
  })
  runtime.setBeforeFolderWorkspaceDelete(async (workspace) => {
    if (!workspace.connectionId) {
      await service.closeFolderWorkspace(workspace.id)
    }
  })
  ipcMain.handle('herdr:openTerminal', (event) => {
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Herdr actions must originate from the main frame.')
    }
    return openHerdrTerminal(app.getPath('userData'))
  })
  ipcMain.handle('herdr:sync', async (event) => {
    if (event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Herdr actions must originate from the main frame.')
    }
    const result = await service.sync()
    await statusBridge.refresh()
    return result
  })
}
