import { isLocalBuildVersion } from '../app-update-policy'
import { withholdSecurityCommands } from './keychain-withhold'
import { withholdSafeStorage } from './safe-storage-availability'

/**
 * Before the desktop profile loads, keep a local macOS build away from the keychain for the
 * whole run.
 *
 * Why unconditional: a local build is ad-hoc signed, so its code requirement is its cdhash and
 * changes with every rebuild. Whether the "Orca Safe Storage" item will answer without a
 * dialog depends on its ACL and lock state, which nothing can read without touching the item,
 * and `safeStorage` is synchronous, so an unanswered dialog freezes the main thread ahead of
 * the window and the daemon handshake. Not calling it is the only state that provably cannot
 * prompt. Sealed values stay on disk unchanged, and saves refuse to fall back to plaintext.
 * The same holds for Orca's `security(1)` launches, whose dialogs name `security` instead.
 */
export function withholdKeychainForLocalDesktopBuild(deps: {
  version: string
  isPackaged: boolean
  usesMockKeychain?: boolean
  platform?: NodeJS.Platform
  warn?: (message: string) => void
}): void {
  if (
    (deps.platform ?? process.platform) !== 'darwin' ||
    !deps.isPackaged ||
    deps.usesMockKeychain === true ||
    !isLocalBuildVersion(deps.version)
  ) {
    return
  }
  const reason = `local build ${deps.version} does not use the macOS keychain`
  withholdSafeStorage(reason, { refusePlaintextFallback: true })
  withholdSecurityCommands(reason)
  ;(deps.warn ?? console.warn)(
    `[secrets] Secrets are unavailable for this run: ${reason}. Sealed values stay on disk unchanged, and new secrets are not saved rather than stored unencrypted.`
  )
}
