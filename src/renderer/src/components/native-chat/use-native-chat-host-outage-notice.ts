import { useState } from 'react'
import { startWslHostAndReloadProjects } from '@/lib/wsl-host-user-start'
import { connectRuntimeHostAndReloadProjects } from '@/components/status-bar/runtime-environment-explicit-connect'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import type { NativeChatHostOutage } from './use-native-chat-host-outage'

export function useNativeChatHostOutageNotice(
  outage: NativeChatHostOutage | null
): NativeChatComposerNotice | null {
  const [connecting, setConnecting] = useState(false)
  const mountedRef = useMountedRef()
  const reconnect = (environmentId: string, stopped: boolean): void => {
    setConnecting(true)
    const connect = stopped ? startWslHostAndReloadProjects : connectRuntimeHostAndReloadProjects
    void connect(environmentId).finally(() => {
      if (mountedRef.current) {
        setConnecting(false)
      }
    })
  }
  if (!outage) {
    return null
  }
  const stopped = outage.kind === 'stopped'
  const offline = outage.kind === 'offline' || stopped
  return {
    key: 'host-outage',
    kind: 'host',
    tone: offline ? 'warning' : 'muted',
    text: stopped
      ? translate('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
          distro: outage.hostLabel
        })
      : offline
        ? translate('components.native-chat.hostOutage.offline', '{{hostName}} is offline', {
            hostName: outage.hostLabel
          })
        : translate(
            'components.native-chat.hostOutage.reconnecting',
            '{{hostName}} is reconnecting…',
            {
              hostName: outage.hostLabel
            }
          ),
    ...(outage.canReconnect
      ? {
          action: {
            label: stopped
              ? translate('components.native-chat.hostOutage.start', 'Start')
              : translate('components.native-chat.hostOutage.reconnect', 'Reconnect'),
            onClick: () => reconnect(outage.environmentId, stopped),
            disabled: connecting
          }
        }
      : {})
  }
}
