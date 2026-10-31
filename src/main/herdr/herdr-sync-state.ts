import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomically } from '../codex-accounts/fs-utils'

const SyncState = z.object({
  version: z.literal(1),
  rootGroupId: z.string().optional(),
  groups: z.record(z.string(), z.string()),
  bindings: z.record(
    z.string(),
    z.object({
      folderId: z.string(),
      tabId: z.string().optional(),
      closed: z.boolean().optional(),
      suppressed: z.boolean().optional()
    })
  )
})

export type HerdrSyncState = z.infer<typeof SyncState>

export async function loadHerdrSyncState(filePath: string): Promise<HerdrSyncState> {
  try {
    return SyncState.parse(JSON.parse(await readFile(filePath, 'utf8')))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { version: 1, groups: {}, bindings: {} }
    }
    throw error
  }
}

export function saveHerdrSyncState(filePath: string, state: HerdrSyncState): void {
  writeFileAtomically(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
}
