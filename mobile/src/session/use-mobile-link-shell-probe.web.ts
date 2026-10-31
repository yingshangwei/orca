import { useMemo } from 'react'
import { linkSnapshotResultSchema } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { usePageBridgeClientIfPresent } from '../transport/client-context.web'

export type MobileLinkShellProbe = {
  granted: () => boolean
  read: () => Promise<{ heldOutputBytes: number }>
}

const LINK_SNAPSHOT_VERB = 'native.link.snapshot'

/** A shell built before this verb never grants it, and the row then says it was not measured. */
export function useMobileLinkShellProbe(): MobileLinkShellProbe | null {
  const client = usePageBridgeClientIfPresent()
  return useMemo(
    () =>
      client && {
        granted: () =>
          client.getShellSession()?.grants.native.includes(LINK_SNAPSHOT_VERB) === true,
        read: async () =>
          linkSnapshotResultSchema.parse(
            (await client.callNativeVerb(LINK_SNAPSHOT_VERB, {})).result
          )
      },
    [client]
  )
}
