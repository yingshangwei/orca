import { useEffect, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { BottomDrawer } from '../components/BottomDrawer'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { mobileLinkDetailRows, mobileLinkSummary } from './mobile-link-presentation'
import type { MobileLinkMonitor } from './use-mobile-link-monitor'

function LinkDetails({ monitor }: { monitor: MobileLinkMonitor }) {
  const snapshot = useSyncExternalStore(monitor.subscribe, monitor.getSnapshot)
  return (
    <View style={styles.body}>
      <Text style={styles.title}>Connection to desktop</Text>
      <Text style={styles.summary}>{mobileLinkSummary(snapshot)}</Text>
      {mobileLinkDetailRows(snapshot).map((row) => (
        <View key={row.label} style={styles.row}>
          <View style={styles.rowHeading}>
            <Text style={styles.label}>{row.label}</Text>
            <Text style={styles.value}>{row.value}</Text>
          </View>
          <Text style={styles.note}>{row.note}</Text>
        </View>
      ))}
    </View>
  )
}

export function MobileSessionLinkSheet({
  monitor,
  visible,
  onClose
}: {
  monitor: MobileLinkMonitor
  visible: boolean
  onClose: () => void
}) {
  useEffect(() => {
    monitor.setDetailed(visible)
    return () => monitor.setDetailed(false)
  }, [monitor, visible])
  return (
    <BottomDrawer visible={visible} onClose={onClose}>
      <LinkDetails monitor={monitor} />
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  body: {
    paddingHorizontal: spacing.xs,
    gap: spacing.md
  },
  title: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  summary: {
    fontSize: typography.metaSize,
    color: colors.textSecondary
  },
  row: {
    gap: 2
  },
  rowHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: spacing.md
  },
  label: {
    flexShrink: 1,
    fontSize: typography.metaSize,
    color: colors.textPrimary
  },
  value: {
    flexShrink: 1,
    textAlign: 'right',
    fontSize: typography.metaSize,
    color: colors.textPrimary
  },
  note: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
})
