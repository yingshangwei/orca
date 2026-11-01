// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DelayedRemoteRuntimeReconnectBanner,
  REMOTE_RUNTIME_RECOVERY_BANNER_DELAY_MS,
  TerminalRemoteRuntimeReconnectBanner
} from './TerminalRemoteRuntimeReconnectBanner'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('TerminalRemoteRuntimeReconnectBanner', () => {
  it('shows quiet bounded automatic recovery without a manual action', () => {
    render(<TerminalRemoteRuntimeReconnectBanner phase="backoff" onReconnect={vi.fn()} />)

    expect(screen.getByText('Reconnecting to remote runtime')).toBeInTheDocument()
    expect(screen.getByText(/retrying automatically/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('offers one explicit reconnect action after automatic recovery stops', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(<TerminalRemoteRuntimeReconnectBanner phase="disconnected" onReconnect={onReconnect} />)

    expect(screen.getByText('Remote runtime disconnected')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('says the host refused this computer instead of spinning, even mid-recovery', async () => {
    const onReconnect = vi.fn()
    const user = userEvent.setup()
    render(
      <TerminalRemoteRuntimeReconnectBanner
        phase="backoff"
        onReconnect={onReconnect}
        pairingRefused
      />
    )

    expect(screen.getByText('This host no longer accepts this computer')).toBeInTheDocument()
    expect(screen.getByText(/couldn't pair with it again over SSH/)).toBeInTheDocument()
    expect(screen.queryByText('Reconnecting to remote runtime')).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })
})

describe('DelayedRemoteRuntimeReconnectBanner', () => {
  it('keeps a brief resubscribe from flashing the retrying banner', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <DelayedRemoteRuntimeReconnectBanner epoch={1} phase="backoff" onReconnect={vi.fn()} />
    )
    act(() => vi.advanceTimersByTime(REMOTE_RUNTIME_RECOVERY_BANNER_DELAY_MS - 1))
    rerender(
      <DelayedRemoteRuntimeReconnectBanner epoch={1} phase="recovering" onReconnect={vi.fn()} />
    )
    expect(screen.queryByRole('status')).not.toBeInTheDocument()

    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByText('Reconnecting to remote runtime')).toBeInTheDocument()
  })

  it('shows a stopped recovery at once and keeps it up through a manual reconnect', () => {
    vi.useFakeTimers()
    const { rerender } = render(
      <DelayedRemoteRuntimeReconnectBanner epoch={1} phase="disconnected" onReconnect={vi.fn()} />
    )
    expect(screen.getByText('Remote runtime disconnected')).toBeInTheDocument()

    rerender(
      <DelayedRemoteRuntimeReconnectBanner epoch={2} phase="recovering" onReconnect={vi.fn()} />
    )
    expect(screen.getByText('Reconnecting to remote runtime')).toBeInTheDocument()
  })

  it('offers Start immediately for a stopped distro, even during backoff', async () => {
    const onReconnect = vi.fn()
    render(
      <DelayedRemoteRuntimeReconnectBanner
        epoch={0}
        phase="backoff"
        wslHostStopped="Ubuntu"
        onReconnect={onReconnect}
      />
    )
    expect(screen.getByText('Ubuntu is stopped')).toBeInTheDocument()
    expect(screen.queryByText(/retrying automatically/)).not.toBeInTheDocument()
    expect(onReconnect).not.toHaveBeenCalled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Start' }))
    expect(onReconnect).toHaveBeenCalledOnce()
  })

  it('keeps the unavailable-host reason ahead of the stopped action', () => {
    render(
      <DelayedRemoteRuntimeReconnectBanner
        epoch={0}
        phase="backoff"
        wslHostStopped="Ubuntu"
        wslHostUnavailable="turned-off"
        onReconnect={vi.fn()}
      />
    )
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(screen.queryByText('Ubuntu is stopped')).not.toBeInTheDocument()
  })
})
