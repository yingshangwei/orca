import { app } from 'electron'

/** Local builds are versioned `<base>-local.<n>.<sha>` (or `.local.` after a prerelease tag). */
export function isLocalBuildVersion(version: string): boolean {
  return /[-.]local\./.test(version)
}

export function isAppUpdateEnabled(): boolean {
  // Local builds carry private changes that an official update would replace.
  return !isLocalBuildVersion(app.getVersion())
}
