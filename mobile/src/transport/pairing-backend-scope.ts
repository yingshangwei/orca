import type { StoredHostProfile } from './types'

/** A pairing's relay backend: its director origin, or null for a direct-only or pre-relay pairing. */
export type PairingBackend = string | null

export function relayBackendOrigin(directorUrl: string): string {
  return new URL(directorUrl).origin
}

/**
 * The same-key row a pairing on `backend` re-pairs, if any. `readBackends` runs only when the
 * answer depends on stored relay routing, and must reject rather than guess when it is unreadable.
 */
export async function findSameBackendHost(
  candidates: readonly StoredHostProfile[],
  backend: PairingBackend,
  readBackends: () => Promise<ReadonlyMap<string, string>>
): Promise<StoredHostProfile | undefined> {
  if (candidates.length === 0) {
    return undefined
  }
  // Why: a direct-only offer reusing even a lone relay card would strip that backend's routing.
  const backends = await readBackends()
  const backendOf = (host: StoredHostProfile): PairingBackend => backends.get(host.id) ?? null
  const exact = candidates.find((host) => backendOf(host) === backend)
  if (exact || backend === null) {
    return exact
  }
  // Why: a pre-relay row upgrades in place, but never once another backend owns this desktop key.
  return candidates.every((host) => backendOf(host) === null) ? candidates[0] : undefined
}
