import { hostEndpointLabel } from '../transport/host-endpoint-label'
import type { HostCatalogEntry } from '../transport/types'

/** Relay hostnames by host id, only for cards that pair the same desktop through several backends. */
export function homeHostBackendLabels(
  hosts: readonly Pick<HostCatalogEntry, 'id' | 'publicKeyB64' | 'relay'>[]
): Map<string, string> {
  const keyCounts = new Map<string, number>()
  for (const host of hosts) {
    keyCounts.set(host.publicKeyB64, (keyCounts.get(host.publicKeyB64) ?? 0) + 1)
  }
  const labels = new Map<string, string>()
  for (const host of hosts) {
    if (host.relay && (keyCounts.get(host.publicKeyB64) ?? 0) > 1) {
      labels.set(host.id, hostEndpointLabel(host.relay.directorUrl))
    }
  }
  return labels
}
