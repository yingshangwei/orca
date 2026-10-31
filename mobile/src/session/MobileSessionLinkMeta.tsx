import { useSyncExternalStore } from 'react'
import { Text } from 'react-native'
import { mobileLinkHeaderText } from './mobile-link-presentation'
import { styles } from './mobile-session-styles'
import type { MobileLinkMonitor } from './use-mobile-link-monitor'

/** Its own component so a sample redraws these characters and not the header around them. */
export function MobileSessionLinkMeta({ monitor }: { monitor: MobileLinkMonitor }) {
  const snapshot = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot)
  const text = mobileLinkHeaderText(snapshot)
  return text === null ? null : (
    <Text style={styles.sessionMetaText} numberOfLines={1}>
      {`· ${text}`}
    </Text>
  )
}
