// Why no electron import: `security(1)` callers outside the safeStorage path share this state.
let withheldReason: string | null = null
let refusesPlaintextFallback = false
let securityWithheldReason: string | null = null

/**
 * Stop in-process `safeStorage` for the rest of this run.
 *
 * Why: `safeStorage` is synchronous, and against a keychain that needs a prompt nobody can
 * answer (headless serve with no GUI session) it blocks the main thread indefinitely. Once
 * an out-of-process probe has shown that, callers get "unavailable" instead of a frozen host.
 * The probe only covers Orca's own item, so this leaves `security(1)` reads alone; see
 * `withholdSecurityCommands`.
 *
 * `refusePlaintextFallback`: the keychain still holds the user's key and this run merely
 * declines to ask for it, so a writer's no-keyring plaintext fallback would downgrade a secret
 * that a later run could seal. Saves then fail instead.
 */
export function withholdSafeStorage(
  reason: string,
  options: { refusePlaintextFallback?: boolean } = {}
): void {
  withheldReason ??= reason
  refusesPlaintextFallback ||= options.refusePlaintextFallback === true
}

export function safeStorageWithheldReason(): string | null {
  return withheldReason
}

/** Non-null while writers must not store a secret unsealed; see `withholdSafeStorage`. */
export function safeStoragePlaintextFallbackRefusal(): string | null {
  return refusesPlaintextFallback ? withheldReason : null
}

/**
 * Stop every `security(1)` launch Orca makes for the rest of this run: reads, writes and
 * deletes of items Orca or other apps own.
 *
 * Why separate from `withholdSafeStorage`: that dialog names `security`, not Orca, so no Orca
 * signature can pre-approve it, and a poll that times out dismisses it only to raise it again
 * next cycle. Only a run that has decided never to touch the keychain sets this.
 */
export function withholdSecurityCommands(reason: string): void {
  securityWithheldReason ??= reason
}

export function securityCommandsWithheldReason(): string | null {
  return securityWithheldReason
}

export class SafeStorageWithheldError extends Error {
  constructor(reason: string) {
    super(`secrets_unavailable: ${reason}`)
    this.name = 'SafeStorageWithheldError'
  }
}

/** Call before spawning `security(1)`; see `withholdSecurityCommands`. */
export function throwIfSecurityCommandsWithheld(): void {
  if (securityWithheldReason !== null) {
    throw new SafeStorageWithheldError(securityWithheldReason)
  }
}

/** Test seam: restore the unwithheld state. */
export function resetSafeStorageWithholdForTests(): void {
  withheldReason = null
  refusesPlaintextFallback = false
  securityWithheldReason = null
}
