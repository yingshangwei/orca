import AsyncStorage from '@react-native-async-storage/async-storage'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import {
  MobileRelayHostOverlaySchema,
  toStoredMobileRelayHostOverlay,
  type MobileRelayHostOverlay
} from './mobile-relay-host-overlay'

const OVERLAY_STORAGE_KEY = 'orca:mobile-relay:host-overlays:v2'
let overlayMutation: Promise<void> = Promise.resolve()

function parseOverlays(
  raw: string | null,
  requireValidEntries = false
): MobileRelayHostOverlay[] | null {
  if (raw === null) {
    return []
  }
  try {
    const value = JSON.parse(raw) as unknown
    if (!Array.isArray(value)) {
      return null
    }
    const overlays: MobileRelayHostOverlay[] = []
    const hostIds = new Set<string>()
    for (const item of value) {
      const result = MobileRelayHostOverlaySchema.safeParse(item)
      if (!result.success) {
        if (requireValidEntries) {
          return null
        }
        continue
      }
      if (requireValidEntries && hostIds.has(result.data.hostId)) {
        return null
      }
      hostIds.add(result.data.hostId)
      overlays.push(result.data)
    }
    return overlays
  } catch {
    return null
  }
}

async function readOverlaysForMutation(): Promise<MobileRelayHostOverlay[]> {
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY))
  if (!overlays) {
    // Why: never rewrite an unreadable v2 namespace as an empty list; doing so
    // would destroy relay recovery data during an unrelated host mutation.
    throw new Error('mobile relay host overlay storage unreadable')
  }
  return overlays
}

async function mutateOverlays(
  update: (overlays: MobileRelayHostOverlay[]) => MobileRelayHostOverlay[]
): Promise<boolean> {
  const mutation = overlayMutation.then(async () => {
    const current = await readOverlaysForMutation()
    const next = update(current)
    // Why: an update handing back the list it read changed nothing; skip the full AsyncStorage write.
    if (next === current) {
      return false
    }
    await AsyncStorage.setItem(OVERLAY_STORAGE_KEY, JSON.stringify(next))
    return true
  })
  overlayMutation = mutation.then(
    () => {},
    () => {}
  )
  return mutation
}

export async function loadMobileRelayHostRoutingState(
  existingHostIds: ReadonlySet<string>
): Promise<{ relays: Map<string, MobileRelayEndpoint>; orphanHostIds: string[] }> {
  await overlayMutation
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY)) ?? []
  const relays = new Map<string, MobileRelayEndpoint>()
  const orphanHostIds: string[] = []
  for (const overlay of overlays) {
    // Why: an older app can remove the legacy base without knowing this
    // namespace; never let the retained overlay resurrect that host later.
    if (!existingHostIds.has(overlay.hostId)) {
      orphanHostIds.push(overlay.hostId)
    } else if (overlay.relay) {
      relays.set(overlay.hostId, overlay.relay)
    }
  }
  return { relays, orphanHostIds }
}

/** Relay director URLs by host id; rejects when unreadable so callers never mistake it for none. */
export async function readMobileRelayHostDirectorUrls(): Promise<Map<string, string>> {
  await overlayMutation
  const overlays = parseOverlays(await AsyncStorage.getItem(OVERLAY_STORAGE_KEY), true)
  if (!overlays) {
    throw new Error('mobile relay host overlay storage unreadable')
  }
  return new Map(
    overlays.flatMap((overlay) =>
      overlay.relay ? [[overlay.hostId, overlay.relay.directorUrl] as const] : []
    )
  )
}

/** Resolves whether storage changed. */
export function saveMobileRelayHostRouting(
  hostId: string,
  relay: MobileRelayEndpoint
): Promise<boolean> {
  const validated = toStoredMobileRelayHostOverlay(hostId, relay)
  return mutateOverlays((overlays) => {
    const index = overlays.findIndex((overlay) => overlay.hostId === hostId)
    if (index === -1) {
      return [...overlays, validated]
    }
    // Why: a failing relay loop re-resolves the same cell every retry. Both sides are this
    // schema's output, so key order matches; an older record's direct entry fails the compare.
    if (JSON.stringify(overlays[index]) === JSON.stringify(validated)) {
      return overlays
    }
    const next = overlays.slice()
    next[index] = validated
    return next
  })
}

export function removeMobileRelayHostRouting(hostId: string): Promise<void> {
  return removeMobileRelayHostRoutings([hostId])
}

export async function removeMobileRelayHostRoutings(hostIds: readonly string[]): Promise<void> {
  const targets = new Set(hostIds)
  await mutateOverlays((overlays) => {
    const next = overlays.filter((overlay) => !targets.has(overlay.hostId))
    return next.length === overlays.length ? overlays : next
  })
}

/** Test-only: drain the module mutation chain between cases. */
export function resetMobileRelayHostOverlayStoreForTests(): void {
  overlayMutation = Promise.resolve()
}
