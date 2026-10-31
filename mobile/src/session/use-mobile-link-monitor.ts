import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { MOBILE_LINK_PROBE_RUNTIME_CAPABILITY } from '../../../src/shared/mobile-link-probe-contract'
import { pageTerminalOutputMeter } from '../terminal/terminal-page-output-meter'
import { requestMobileLinkProbe } from './mobile-link-probe-operations'
import {
  createMobileLinkSampler,
  MOBILE_LINK_OFF,
  type MobileLinkSampler,
  type MobileLinkSnapshot
} from './mobile-link-sampler'
import { useMobileLinkShellProbe } from './use-mobile-link-shell-probe'
import type { UnvalidatedRpcRequestPort } from '../transport/unvalidated-rpc-request-port'
import type { ConnectionState } from '../transport/types'

/**
 * The readings, kept out of React state on purpose.
 *
 * The session controller re-renders the whole route, so a sample in its state would redraw every
 * pane each five seconds to change a few characters in the header. The header and the sheet
 * subscribe to this instead, and only they redraw.
 */
export type MobileLinkMonitor = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => MobileLinkSnapshot
  setDetailed: (detailed: boolean) => void
}

function createMobileLinkMonitor() {
  const listeners = new Set<() => void>()
  let snapshot = MOBILE_LINK_OFF
  let sampler: MobileLinkSampler | null = null
  let detailed = false
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => snapshot,
    setDetailed(next: boolean) {
      detailed = next
      sampler?.setDetailed(next)
    },
    publish(next: MobileLinkSnapshot) {
      snapshot = next
      for (const listener of listeners) {
        listener()
      }
    },
    attach(next: MobileLinkSampler | null) {
      sampler = next
      sampler?.setDetailed(detailed)
    }
  }
}

type MobileLinkMonitorScope = {
  client: UnvalidatedRpcRequestPort | null
  hostId: string | undefined
  connState: ConnectionState
  hostCapabilities: readonly string[]
  activeHandle: string | null
}

export function useMobileLinkMonitor(scope: MobileLinkMonitorScope): MobileLinkMonitor {
  const { activeHandle, client, connState, hostCapabilities, hostId } = scope
  const monitor = useMemo(() => createMobileLinkMonitor(), [])
  const shell = useMobileLinkShellProbe()
  const [foreground, setForeground] = useState(AppState.currentState === 'active')
  const [focused, setFocused] = useState(true)

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      setForeground(state === 'active')
    })
    return () => subscription.remove()
  }, [])

  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )

  const supported = hostCapabilities.includes(MOBILE_LINK_PROBE_RUNTIME_CAPABILITY)
  const sampling =
    client !== null && connState === 'connected' && foreground && focused && activeHandle !== null

  // `hostId` is what makes a switch restart the loop: nothing it measured may describe the next host.
  useEffect(() => {
    if (!sampling || client === null) {
      return
    }
    const releaseFrames = pageTerminalOutputMeter.holdForeground()
    const sampler = createMobileLinkSampler({
      probeHost: supported ? (timeoutMs) => requestMobileLinkProbe(client, timeoutMs) : null,
      probeShell: shell?.granted() ? shell.read : null,
      readPage: pageTerminalOutputMeter.read,
      now: () => performance.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (timer) => clearTimeout(timer),
      onChange: monitor.publish
    })
    monitor.attach(sampler)
    sampler.start()
    return () => {
      monitor.attach(null)
      sampler.stop()
      releaseFrames()
    }
  }, [client, hostId, monitor, sampling, shell, supported])

  return monitor
}
