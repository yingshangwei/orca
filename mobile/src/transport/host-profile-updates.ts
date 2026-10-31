import type { StoredHostProfile } from './types'
import { withPersonalName } from './host-name-identity'
import { mutateStoredHosts } from './host-list-mutation-queue'

// Why: single mutation pass commits name + endpoint atomically so a mid-save failure can't persist one without the other.
// `personalName: null` clears the phone's override, returning the row to the desktop-reported name.
export async function updateHostNameAndEndpoint(
  hostId: string,
  updates: { personalName?: string | null; endpoint?: string }
): Promise<void> {
  await mutateStoredHosts((hosts) => {
    const index = hosts.findIndex((host) => host.id === hostId)
    if (index === -1) {
      throw new Error('Host not found')
    }
    let updated: StoredHostProfile = {
      ...hosts[index]!,
      ...(updates.endpoint !== undefined ? { endpoint: updates.endpoint } : {})
    }
    if (updates.personalName !== undefined) {
      updated = withPersonalName(updated, updates.personalName, hosts)
    }
    const next = hosts.slice()
    next[index] = updated
    return next
  })
}

export async function updateLastConnected(hostId: string): Promise<void> {
  try {
    await mutateStoredHosts((hosts) => {
      const index = hosts.findIndex((h) => h.id === hostId)
      if (index === -1) {
        return hosts
      }
      const next = hosts.slice()
      next[index] = { ...next[index]!, lastConnected: Date.now() }
      return next
    })
  } catch {
    // Why: best-effort timestamp fired with void; swallow so unreadable storage doesn't reject.
  }
}
