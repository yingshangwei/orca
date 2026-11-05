import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () =>
  (await import('./createMainWindow-test-harness')).electronModuleMock()
)
vi.mock('./macos-tahoe-release', async () =>
  (await import('./createMainWindow-test-harness')).macosTahoeReleaseMock()
)
vi.mock('../app-icon', async () => (await import('./createMainWindow-test-harness')).appIconMock())
vi.mock('../browser/browser-manager', async () =>
  (await import('./createMainWindow-test-harness')).browserManagerMock()
)

import { ipcMain } from 'electron'
import { createMainWindow, WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS } from './createMainWindow'
import { resetExpectedTeardownStateForTest } from '../crash-reporting/expected-teardown-state'
import { browserWindowMock, resetMainWindowMocks } from './createMainWindow-test-harness'
import { markUserQuitWindowClose } from './user-quit-window-close'

type Handler = (...args: any[]) => void

function setupWindow() {
  const windowHandlers: Record<string, Handler> = {}
  const ipcHandlers: Record<string, Handler> = {}
  vi.mocked(ipcMain.on).mockImplementation((channel, handler) => {
    ipcHandlers[channel] = handler
    return ipcMain
  })
  const webContents = {
    id: 42,
    on: vi.fn((event: string, handler: Handler) => {
      windowHandlers[event] = handler
    }),
    setZoomLevel: vi.fn(),
    setBackgroundThrottling: vi.fn(),
    invalidate: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    isCrashed: vi.fn(() => false)
  }
  const instance = {
    webContents,
    on: vi.fn((event: string, handler: Handler) => {
      windowHandlers[event] = handler
    }),
    isDestroyed: vi.fn(() => false),
    isMaximized: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    getSize: vi.fn(() => [1200, 800]),
    setSize: vi.fn(),
    maximize: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    destroy: vi.fn(),
    loadFile: vi.fn(() => Promise.resolve()),
    loadURL: vi.fn(() => Promise.resolve())
  }
  browserWindowMock.mockImplementation(function () {
    return instance
  })
  return { windowHandlers, ipcHandlers, webContents, instance }
}

function lastCloseRequestId(send: ReturnType<typeof vi.fn>): number {
  const requests = send.mock.calls.filter(([channel]) => channel === 'window:close-requested')
  const request: unknown = requests.at(-1)?.[1]
  return typeof request === 'object' && request !== null && 'requestId' in request
    ? Number(request.requestId)
    : -1
}

describe('serve user-Quit window close', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    resetMainWindowMocks()
    resetExpectedTeardownStateForTest()
    vi.useFakeTimers()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.useRealTimers()
  })

  it('destroys a frozen renderer after the quit ack deadline without quitting the process', async () => {
    const { windowHandlers, webContents, instance } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    markUserQuitWindowClose(instance)
    windowHandlers.close({ preventDefault: vi.fn() })

    expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
      isQuitting: false,
      requestId: expect.any(Number)
    })
    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS)
    expect(instance.destroy).toHaveBeenCalledOnce()
  })

  it('leaves a responsive renderer free to veto the close', async () => {
    const { windowHandlers, ipcHandlers, webContents, instance } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    markUserQuitWindowClose(instance)
    windowHandlers.close({ preventDefault: vi.fn() })
    ipcHandlers['window:close-request-received']?.(
      { sender: { id: 42 } },
      lastCloseRequestId(webContents.send)
    )
    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS)

    expect(instance.destroy).not.toHaveBeenCalled()
  })

  it('waits for the pre-quit reconciliation before asking the renderer to checkpoint', async () => {
    const { windowHandlers, webContents } = setupWindow()
    let settle: () => void = () => {}
    const beforeQuitCloseRequest = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    )
    createMainWindow(null, {
      getIsQuitting: () => true,
      beforeCloseRequest: beforeQuitCloseRequest
    })

    windowHandlers.close({ preventDefault: vi.fn() })
    await Promise.resolve()
    expect(beforeQuitCloseRequest).toHaveBeenCalledOnce()
    expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
    settle()
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: true,
        requestId: expect.any(Number)
      })
    )
  })

  it('drops a close the renderer vetoed while main was still reconciling', async () => {
    const { windowHandlers, webContents } = setupWindow()
    let settle: () => void = () => {}
    createMainWindow(null, {
      getIsQuitting: () => true,
      beforeCloseRequest: () =>
        new Promise<void>((resolve) => {
          settle = resolve
        })
    })

    windowHandlers.close({ preventDefault: vi.fn() })
    windowHandlers['will-prevent-unload']?.()
    settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(webContents.send).not.toHaveBeenCalledWith('window:close-requested', expect.anything())
  })

  it('reconciles before a renderer-drawn close too', async () => {
    const { ipcHandlers, webContents } = setupWindow()
    const beforeCloseRequest = vi.fn(async () => {})
    createMainWindow(null, { getIsQuitting: () => false, beforeCloseRequest })

    ipcHandlers['window:request-close']?.({ sender: { id: 42 } })
    await vi.waitFor(() =>
      expect(webContents.send).toHaveBeenCalledWith('window:close-requested', {
        isQuitting: false,
        requestId: expect.any(Number)
      })
    )
    expect(beforeCloseRequest).toHaveBeenCalledOnce()
  })

  it('keeps a quit alive when a renderer-drawn close supersedes it mid-reconciliation', async () => {
    const { windowHandlers, ipcHandlers, webContents, instance } = setupWindow()
    const settles: (() => void)[] = []
    createMainWindow(null, {
      getIsQuitting: () => true,
      beforeCloseRequest: () =>
        new Promise<void>((resolve) => {
          settles.push(resolve)
        })
    })

    windowHandlers.close({ preventDefault: vi.fn() })
    ipcHandlers['window:request-close']?.({ sender: { id: 42 } })
    settles.forEach((settle) => settle())
    await vi.advanceTimersByTimeAsync(0)
    const requests = webContents.send.mock.calls.filter(
      ([channel]) => channel === 'window:close-requested'
    )
    expect(requests).toEqual([
      ['window:close-requested', { isQuitting: true, requestId: expect.any(Number) }]
    ])
    ipcHandlers['window:close-request-received']?.(
      { sender: { id: 42 } },
      lastCloseRequestId(webContents.send)
    )
    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS)
    expect(instance.destroy).not.toHaveBeenCalled()
  })

  it('keeps a plain window close without a deadline', async () => {
    const { windowHandlers, instance } = setupWindow()
    createMainWindow(null, { getIsQuitting: () => false })

    markUserQuitWindowClose(instance)
    windowHandlers.close({ preventDefault: vi.fn() })
    windowHandlers['will-prevent-unload']?.()
    windowHandlers.close({ preventDefault: vi.fn() })
    // The first attempt's deadline is cleared by the veto; the second is a plain close.
    await vi.advanceTimersByTimeAsync(WINDOW_QUIT_RENDERER_ACK_TIMEOUT_MS * 2)

    expect(instance.destroy).not.toHaveBeenCalled()
  })

  it('closes instead of hiding to the Windows tray', () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { windowHandlers, webContents, instance } = setupWindow()
    const store = {
      getUI: vi.fn(() => ({ trayMinimizeNoticeShown: true })),
      getSettings: vi.fn(() => ({ windowBackgroundBlur: false, minimizeToTrayOnClose: true })),
      updateUI: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the close path reads only getUI/getSettings/updateUI.
    createMainWindow(store as never, { getIsQuitting: () => false })

    markUserQuitWindowClose(instance)
    windowHandlers.close({ preventDefault: vi.fn() })

    expect(instance.hide).not.toHaveBeenCalled()
    expect(webContents.send).toHaveBeenCalledWith(
      'window:close-requested',
      expect.objectContaining({ isQuitting: false })
    )
  })
})
