/**
 * The desktop's only way into a WSL distro's orcad (design D2): a loopback listener whose every
 * accepted socket rides its own `wsl.exe` child running the stdio bridge on the distro's pinned
 * Node. WSL localhost forwarding is never used: it refuses connections for 0.2–1 s after a listen
 * and depends on the distro's networking mode.
 */
import type { OrcadHostTransport } from '../ssh/orcad-host-transport'
import {
  ORCAD_STDIO_BRIDGE_DEPENDENCIES,
  startOrcadStdioBridge,
  type OrcadStdioBridgeDependencies
} from '../managed-server/lifecycle/orcad-stdio-bridge-provider'
import type { StartedPortForward } from '../ssh/port-forwarding/ssh-port-forward-provider'
import {
  readConfirmedRunningWslDistros,
  type WslRunningDistrosRead
} from '../wsl-background-distro-gate'
import { wslDistroHolderKey } from './wsl-distro-holder-record'
import { confirmsRunning } from './wsl-orcad-liveness-evidence'

export type WslOrcadStdioBridgeOptions = {
  environmentId: string
  distro: string
  /** orcad's loopback port inside the distro. */
  remotePort: number
  /** 0 picks a free one. */
  localPort: number
  label: string
}

export function listenWslOrcadStdioBridge(
  transport: OrcadHostTransport,
  options: WslOrcadStdioBridgeOptions,
  dependencies: OrcadStdioBridgeDependencies = ORCAD_STDIO_BRIDGE_DEPENDENCIES,
  readRunning: () => Promise<WslRunningDistrosRead> = readConfirmedRunningWslDistros
): Promise<StartedPortForward> {
  return startOrcadStdioBridge(
    transport,
    {
      id: `wsl-orcad:${options.environmentId}`,
      connectionId: options.environmentId,
      localHost: '127.0.0.1',
      localPort: options.localPort,
      remoteHost: '127.0.0.1',
      remotePort: options.remotePort,
      label: options.label
    },
    dependencies,
    async () => {
      const running = await readRunning()
      if (!confirmsRunning(running, wslDistroHolderKey(options.distro))) {
        throw new Error(`WSL distro ${options.distro} is not confirmed running`)
      }
    }
  )
}

type WslOrcadStdioBridgeListen = (
  transport: OrcadHostTransport,
  options: WslOrcadStdioBridgeOptions
) => Promise<StartedPortForward>

/** A persisted local port may be taken by now; a free one beats no connection. */
export async function listenWslOrcadStdioBridgeOnPreferredPort(
  transport: OrcadHostTransport,
  options: WslOrcadStdioBridgeOptions,
  listen: WslOrcadStdioBridgeListen = listenWslOrcadStdioBridge
): Promise<StartedPortForward> {
  try {
    return await listen(transport, options)
  } catch (error) {
    if (options.localPort === 0) {
      throw error
    }
    console.warn(
      `[wsl] Could not rebind local port ${options.localPort}; picking another:`,
      error instanceof Error ? error.message : error
    )
    return listen(transport, { ...options, localPort: 0 })
  }
}
