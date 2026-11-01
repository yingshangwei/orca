import type { TuiAgent } from '../../shared/tui-agent'
import { applyRemoteViewerClipboardEnv } from '../ipc/pty/host-env/remote-viewer-clipboard-env'
import { applyClaudeTerminalImageViewerEnv } from './terminal-image-viewer-env'

/**
 * Env an agent launch needs because of who asked for it. `terminalImageViewerSupported` is
 * undefined only for launches from this host's own window or CLI; any boolean is a remote caller.
 */
export function applyRemoteViewerLaunchEnv<
  T extends {
    launchAgent?: TuiAgent
    env?: Record<string, string>
  }
>(launch: T, terminalImageViewerSupported: boolean | undefined, agent = launch.launchAgent): T {
  const next = applyClaudeTerminalImageViewerEnv(launch, terminalImageViewerSupported, agent)
  if (terminalImageViewerSupported === undefined) {
    return next
  }
  // Why: a desktop host is not headless, so spawn-time env never marks its viewer remote (#10861).
  const env = { ...next.env }
  applyRemoteViewerClipboardEnv(env, { launchAgent: agent, viewerIsRemote: true })
  return { ...next, env }
}
