import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSecretStore, type SecretStore } from '../../../shared/secret-store'
import { isUnreadableError, writeDurableSecureJsonFile } from '../../../shared/secure-file'
import {
  isSelfHostedRelayAccessKey,
  normalizeSelfHostedRelayOrigin,
  type MobileRelayBackendConfig,
  type MobileRelayBackendError,
  type MobileRelayBackendProvider,
  type MobileRelayBackendUpdate,
  type MobileRelayBackendUpdateResult
} from '../../../shared/mobile-relay-backend'

const CONFIG_FILENAME = 'mobile-relay-backend.json'

type PersistedSelfHosted = {
  origin: string
  // OS-keychain-protected ciphertext, base64. Never written in plaintext.
  accessKeyCiphertext: string
  savedAt: number
}

type PersistedConfig = {
  version: 1
  provider: MobileRelayBackendProvider
  selfHosted?: PersistedSelfHosted
}

type ConfigRead =
  | { status: 'found'; config: PersistedConfig }
  // Why distinct: "could not read" and "read garbage" both refuse a partial
  // update, so neither silently drops a sealed key the user still owns.
  | { status: 'unreadable' }

export type RelayBackendSelection =
  | { status: 'ok'; provider: 'official' }
  | { status: 'ok'; provider: 'self-hosted'; origin: string; savedAt: number }
  | { status: 'unreadable' }

export class SelfHostedAccessKeyUnavailableError extends Error {
  constructor() {
    super('self_hosted_access_key_unreadable')
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parsePersisted(value: unknown): PersistedConfig | null {
  if (!isObject(value) || value.version !== 1) {
    return null
  }
  if (value.provider !== 'official' && value.provider !== 'self-hosted') {
    return null
  }
  if (value.selfHosted === undefined) {
    return value.provider === 'official' ? { version: 1, provider: 'official' } : null
  }
  const selfHosted = value.selfHosted
  if (
    !isObject(selfHosted) ||
    typeof selfHosted.origin !== 'string' ||
    normalizeSelfHostedRelayOrigin(selfHosted.origin) !== selfHosted.origin ||
    typeof selfHosted.accessKeyCiphertext !== 'string' ||
    selfHosted.accessKeyCiphertext.length === 0 ||
    typeof selfHosted.savedAt !== 'number' ||
    !Number.isFinite(selfHosted.savedAt)
  ) {
    return null
  }
  return {
    version: 1,
    provider: value.provider,
    selfHosted: {
      origin: selfHosted.origin,
      accessKeyCiphertext: selfHosted.accessKeyCiphertext,
      savedAt: selfHosted.savedAt
    }
  }
}

function secretProtectionAvailable(store: SecretStore): boolean {
  return store.isEncryptionAvailable() && store.describeProtectionGap() === null
}

export class RelayBackendConfigStore {
  private readonly path: string
  private readonly now: () => number
  private readonly secretStore: SecretStore | undefined
  private decrypted: { ciphertext: string; accessKey: string } | null = null
  private accessKeyUnreadable = false

  constructor(
    userDataPath: string,
    options: { now?: () => number; secretStore?: SecretStore } = {}
  ) {
    this.path = join(userDataPath, CONFIG_FILENAME)
    this.now = options.now ?? Date.now
    this.secretStore = options.secretStore
  }

  readSelection(): RelayBackendSelection {
    const read = this.read()
    if (read.status === 'unreadable') {
      return { status: 'unreadable' }
    }
    const { provider, selfHosted } = read.config
    if (provider === 'self-hosted' && selfHosted) {
      return { status: 'ok', provider, origin: selfHosted.origin, savedAt: selfHosted.savedAt }
    }
    return { status: 'ok', provider: 'official' }
  }

  /** Decrypts the saved key for `origin` only; a key is never released for another origin. */
  readAccessKey(origin: string): string {
    const read = this.read()
    const selfHosted = read.status === 'found' ? read.config.selfHosted : undefined
    if (!selfHosted || selfHosted.origin !== origin) {
      throw new SelfHostedAccessKeyUnavailableError()
    }
    if (this.decrypted?.ciphertext === selfHosted.accessKeyCiphertext) {
      return this.decrypted.accessKey
    }
    try {
      const store = this.secretStore ?? getSecretStore()
      if (!store.isEncryptionAvailable()) {
        throw new Error('encryption_unavailable')
      }
      const accessKey = store.decryptString(Buffer.from(selfHosted.accessKeyCiphertext, 'base64'))
      if (!isSelfHostedRelayAccessKey(accessKey)) {
        throw new Error('invalid_access_key')
      }
      this.decrypted = { ciphertext: selfHosted.accessKeyCiphertext, accessKey }
      this.accessKeyUnreadable = false
      return accessKey
    } catch {
      // Why no cleanup: a locked keychain is usually temporary, and only an
      // explicit save may replace the user's sealed key.
      this.accessKeyUnreadable = true
      throw new SelfHostedAccessKeyUnavailableError()
    }
  }

  getConfig(hostPublicKeyB64: string | null): MobileRelayBackendConfig {
    const read = this.read()
    if (read.status === 'unreadable') {
      return {
        provider: 'official',
        selfHosted: { origin: null, hasAccessKey: false, configured: false, savedAt: null },
        hostPublicKeyB64,
        error: 'config_unreadable'
      }
    }
    const selfHosted = read.config.selfHosted
    return {
      provider: read.config.provider,
      selfHosted: {
        origin: selfHosted?.origin ?? null,
        hasAccessKey: selfHosted !== undefined,
        configured: selfHosted !== undefined,
        savedAt: selfHosted?.savedAt ?? null
      },
      hostPublicKeyB64,
      error:
        this.accessKeyUnreadable && read.config.provider === 'self-hosted'
          ? 'access_key_unreadable'
          : null
    }
  }

  update(
    input: MobileRelayBackendUpdate,
    hostPublicKeyB64: string | null
  ): MobileRelayBackendUpdateResult {
    const fail = (error: MobileRelayBackendError): MobileRelayBackendUpdateResult => ({
      ok: false,
      error,
      config: this.getConfig(hostPublicKeyB64)
    })
    if (input.provider !== 'official' && input.provider !== 'self-hosted') {
      return fail('self_hosted_not_configured')
    }
    const current = this.read()
    let selfHosted: PersistedSelfHosted | undefined
    if (input.selfHosted) {
      const origin = normalizeSelfHostedRelayOrigin(String(input.selfHosted.origin ?? ''))
      if (!origin) {
        return fail('invalid_origin')
      }
      const accessKey = input.selfHosted.accessKey?.trim()
      if (accessKey) {
        if (!isSelfHostedRelayAccessKey(accessKey)) {
          return fail('invalid_access_key')
        }
        // Fail closed: an access key must never land on disk unsealed.
        const store = this.secretStore ?? getSecretStore()
        if (!secretProtectionAvailable(store)) {
          return fail('secret_protection_unavailable')
        }
        let ciphertext: string
        try {
          ciphertext = store.encryptString(accessKey).toString('base64')
        } catch {
          return fail('secret_protection_unavailable')
        }
        selfHosted = { origin, accessKeyCiphertext: ciphertext, savedAt: this.now() }
      } else {
        const saved = current.status === 'found' ? current.config.selfHosted : undefined
        // Why: a key is bound to the origin it was issued by; a new origin needs its own key.
        if (!saved || saved.origin !== origin) {
          return fail('access_key_required')
        }
        selfHosted = saved
      }
    } else {
      if (
        current.status === 'unreadable' &&
        !(input.provider === 'official' && input.resetUnreadable)
      ) {
        return fail('config_unreadable')
      }
      selfHosted = current.status === 'found' ? current.config.selfHosted : undefined
    }
    if (input.provider === 'self-hosted' && !selfHosted) {
      return fail('self_hosted_not_configured')
    }
    const next: PersistedConfig = {
      version: 1,
      provider: input.provider,
      ...(selfHosted ? { selfHosted } : {})
    }
    try {
      writeDurableSecureJsonFile(this.path, next)
    } catch (error) {
      console.warn(
        '[relay] Failed to save the Relay backend configuration:',
        error instanceof Error ? error.message : String(error)
      )
      return fail('config_write_failed')
    }
    if (input.selfHosted?.accessKey) {
      this.decrypted = null
      this.accessKeyUnreadable = false
    }
    return { ok: true, config: this.getConfig(hostPublicKeyB64) }
  }

  private read(): ConfigRead {
    try {
      const parsed = parsePersisted(JSON.parse(readFileSync(this.path, 'utf8')))
      return parsed ? { status: 'found', config: parsed } : { status: 'unreadable' }
    } catch (error) {
      if (isObject(error) && error.code === 'ENOENT') {
        return { status: 'found', config: { version: 1, provider: 'official' } }
      }
      if (!isUnreadableError(error)) {
        console.warn('[relay] Saved Relay backend configuration is invalid')
      }
      return { status: 'unreadable' }
    }
  }
}
