// Saved access keys stay in main; configuration reads only expose `hasAccessKey`.

export type MobileRelayBackendProvider = 'official' | 'self-hosted'

export type MobileRelayBackendError =
  | 'config_unreadable'
  | 'access_key_unreadable'
  | 'secret_protection_unavailable'
  | 'invalid_origin'
  | 'invalid_access_key'
  | 'access_key_required'
  | 'self_hosted_not_configured'
  | 'config_write_failed'

export type MobileRelayBackendConfig = {
  provider: MobileRelayBackendProvider
  selfHosted: {
    origin: string | null
    hasAccessKey: boolean
    /** Origin and key are both saved, so the self-hosted backend can be selected. */
    configured: boolean
    /** Changes whenever the saved origin or key changes; pairing keys off it. */
    savedAt: number | null
  }
  /** Desktop X25519 public key (base64) for enrolling this host on a self-hosted relay. */
  hostPublicKeyB64: string | null
  /** Persistent problem with the saved configuration (never contains the key). */
  error: MobileRelayBackendError | null
}

export type MobileRelayBackendUpdate = {
  provider: MobileRelayBackendProvider
  /** Explicit recovery action; discard unreadable settings and select the official backend. */
  resetUnreadable?: true
  /** Present to save self-hosted settings; omitted to only switch provider. */
  selfHosted?: {
    origin: string
    /** Required when the origin changes; omitted keeps the saved key for the same origin. */
    accessKey?: string
  }
}

export type MobileRelayBackendUpdateResult =
  | { ok: true; config: MobileRelayBackendConfig }
  | { ok: false; error: MobileRelayBackendError; config: MobileRelayBackendConfig }

// 32 random bytes, base64url without padding.
const ACCESS_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function isSelfHostedRelayAccessKey(value: string): boolean {
  return ACCESS_KEY_PATTERN.test(value)
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Canonical relay origin: HTTPS, or HTTP on loopback for local development.
 * Returns the origin string, or null when the input is not exactly an origin.
 */
export function normalizeSelfHostedRelayOrigin(value: string): string | null {
  const trimmed = value.trim().replace(/\/$/, '')
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return null
  }
  const loopback = LOOPBACK_HOSTNAMES.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return null
  }
  return url.origin
}

/** Distinguishes pairings across backends even when readiness does not change. */
export function mobileRelayBackendKey(config: MobileRelayBackendConfig | null): string {
  if (!config || config.provider === 'official') {
    return 'official'
  }
  return `self-hosted:${config.selfHosted.origin ?? ''}:${config.selfHosted.savedAt ?? 0}`
}
