// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneController } from './use-terminal-pane-controller'

const { state, startHost, retry, unavailable } = vi.hoisted(() => ({
  state: {
    repos: [{ id: 'repo', executionHostId: 'runtime:wsl:ubuntu' }],
    folderWorkspaces: [],
    projectGroups: [],
    wslHostStatuses: { 'wsl:ubuntu': { state: 'distro-stopped', distro: 'Ubuntu' } }
  },
  startHost: vi.fn<(id: string) => Promise<boolean>>(),
  retry: vi.fn(),
  unavailable: { value: false }
}))
vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (current: typeof state) => T) => selector(state)
}))
vi.mock('@/lib/wsl-host-user-start', () => ({ startWslHostAndReloadProjects: startHost }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))
vi.mock('./use-wsl-host-unavailable-reason', () => ({
  useWslHostUnavailableReason: () => (unavailable.value ? 'turned-off' : null),
  selectWslHostUnavailableReason: () => (unavailable.value ? 'turned-off' : null)
}))
vi.mock('./use-managed-pairing-refused', () => ({
  useManagedPairingRefusedEnvironmentId: () => null
}))
vi.mock('../CodexRestartChip', () => ({ default: () => null }))
vi.mock('./CodexSharedServerBanner', () => ({ CodexSharedServerBanner: () => null }))
vi.mock('./ClaudeOldTerminalBanner', () => ({ ClaudeOldTerminalBanner: () => null }))
vi.mock('./ClaudeDiffPanelNoticeBanner', () => ({ ClaudeDiffPanelNoticeBanner: () => null }))
vi.mock('./NewerDaemonHoldBanner', () => ({ NewerDaemonHoldBanner: () => null }))
vi.mock('./TerminalSshReconnectOverlay', () => ({ TerminalSshReconnectOverlay: () => null }))
vi.mock('./TerminalProcessExitOverlay', () => ({ TerminalProcessExitOverlay: () => null }))
vi.mock('./MobileDriverOverlay', () => ({ MobileDriverOverlay: () => null }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({ getDriverForPty: vi.fn() }))
vi.mock('@/lib/pane-manager/mobile-fit-overrides', () => ({ getFitOverrideForPty: vi.fn() }))
vi.mock('./mobile-driver-overlay-visibility', () => ({ shouldShowMobileDriverOverlay: vi.fn() }))
vi.mock('../native-chat/native-chat-send-eligibility', () => ({
  shouldChatTakeOverMobileSurface: vi.fn()
}))

import { TerminalPaneRecoveryPortals } from './TerminalPaneRuntimePortals'
import { useWslHostStartCardReplacesPaneError } from './use-wsl-host-stopped-pane'

function mountPane(environmentId: string | null = null) {
  const container = document.createElement('div')
  document.body.append(container)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the portal reads only these supplied pane and transport fields.
  const controller = {
    worktreeId: 'repo::/srv/app',
    managedPanes: [{ id: 'pane', container }],
    paneTransportsRef: {
      current: new Map([
        ['pane', { getRuntimeEnvironmentId: () => environmentId, retryRecovery: retry }]
      ])
    },
    ptyRecoveryStatesByPaneId: {},
    showSshReconnectOverlay: false
  } as unknown as TerminalPaneController
  render(<TerminalPaneRecoveryPortals controller={controller} />)
  return container
}

beforeEach(() => {
  startHost.mockReset().mockResolvedValue(true)
  retry.mockReset()
  unavailable.value = false
})
afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('stopped WSL recovery portals', () => {
  it('offers Start before first spawn has produced any recovery state and retries only after success', async () => {
    let finish!: (started: boolean) => void
    startHost.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    mountPane()
    expect(screen.getByText('Ubuntu is stopped')).toBeInTheDocument()
    expect(startHost).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Start' }))
    expect(startHost).toHaveBeenCalledWith('wsl:ubuntu')
    expect(retry).not.toHaveBeenCalled()
    await act(async () => finish(true))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('leaves the pane parked when Start fails', async () => {
    startHost.mockResolvedValueOnce(false)
    mountPane('wsl:ubuntu')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Start' })))
    expect(retry).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument()
  })

  it('does not substitute the stopped card for a foreign pane or an unavailable host', () => {
    mountPane('other-runtime')
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(useWslHostStartCardReplacesPaneError('repo::/srv/app', 'other-runtime')).toBe(false)
    expect(useWslHostStartCardReplacesPaneError('repo::/srv/app', undefined)).toBe(false)
    unavailable.value = true
    expect(useWslHostStartCardReplacesPaneError('repo::/srv/app', 'wsl:ubuntu')).toBe(false)
  })

  it('hides the overlapping raw error only for the stopped owner or its unbound new pane', () => {
    expect(useWslHostStartCardReplacesPaneError('repo::/srv/app', 'wsl:ubuntu')).toBe(true)
    expect(useWslHostStartCardReplacesPaneError('repo::/srv/app', null)).toBe(true)
    expect(useWslHostStartCardReplacesPaneError('missing::/local', null)).toBe(false)
  })
})
