import { readdirSync, renameSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

// Why: a registry that failed to parse may still be restored from backup, and until it is,
// "this device is not listed" proves nothing — a keyed client would delete its key on that verdict.
function corruptCopyPrefix(registryPath: string): string {
  return `${basename(registryPath)}.corrupt-`
}

export function corruptRegistryCopyExists(registryPath: string): boolean {
  try {
    const prefix = corruptCopyPrefix(registryPath)
    return readdirSync(dirname(registryPath)).some((name) => name.startsWith(prefix))
  } catch {
    return false
  }
}

/** True when this call moved the file aside; false when it was already gone. */
export function quarantineCorruptRegistry(registryPath: string): boolean {
  const target = join(dirname(registryPath), `${corruptCopyPrefix(registryPath)}${Date.now()}`)
  try {
    renameSync(registryPath, target)
    return true
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error
    }
    return false
  }
}

export function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
