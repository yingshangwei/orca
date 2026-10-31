import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadHerdrSyncState, saveHerdrSyncState } from './herdr-sync-state'

it('loads existing bindings and retains closed and suppressed flags after reloading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-herdr-sync-'))
  try {
    const path = join(directory, 'herdr-sync.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        groups: {},
        bindings: {
          term_old: { folderId: 'folder-1', tabId: 'tab-1' },
          term_lost: { folderId: 'folder-2' }
        }
      })
    )
    const state = await loadHerdrSyncState(path)
    state.bindings.term_old.closed = true
    state.bindings.term_lost.suppressed = true
    saveHerdrSyncState(path, state)
    expect((await loadHerdrSyncState(path)).bindings).toEqual({
      term_old: { folderId: 'folder-1', tabId: 'tab-1', closed: true },
      term_lost: { folderId: 'folder-2', suppressed: true }
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
