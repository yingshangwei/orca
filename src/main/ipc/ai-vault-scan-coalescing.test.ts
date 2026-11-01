import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { invalidateAiVaultHostLegCache } from './ai-vault-host-leg-cache'
import { invalidateAiVaultSessionListCache } from '../ai-vault/cached-session-list'

const mocks = vi.hoisted(() => ({
  scanAiVaultSessionsInService: vi.fn(),
  resolveAiVaultSessionTitlesInService: vi.fn(),
  scanRuntimeAiVaultSessions: vi.fn(),
  ipcHandle: vi.fn()
}))

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { handle: mocks.ipcHandle },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('../ai-vault/session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService: mocks.scanAiVaultSessionsInService,
  resolveAiVaultSessionTitlesInService: mocks.resolveAiVaultSessionTitlesInService
}))
vi.mock('../wsl', () => ({
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  hasCachedWslDistros: vi.fn(() => false)
}))
vi.mock('../wsl-running-path-filter', () => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths])
}))
const { _internals, registerAiVaultHandlers } = await import('./ai-vault')
const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-07-27T00:00:00.000Z'
}

beforeEach(() => {
  vi.clearAllMocks()
  _internals.resetAiVaultCacheForTests()
  mocks.scanAiVaultSessionsInService.mockResolvedValue(EMPTY_RESULT)
  mocks.resolveAiVaultSessionTitlesInService.mockResolvedValue({ titles: [] })
  mocks.scanRuntimeAiVaultSessions.mockResolvedValue(EMPTY_RESULT)
})

describe('Agent Session History scan coalescing', () => {
  it('never shares a compact reply with a caller missing its exact baseline', async () => {
    registerRuntimeHost()
    const fingerprint = 'a'.repeat(64)
    mocks.scanRuntimeAiVaultSessions.mockImplementation(async (_host, args) => {
      await Promise.resolve()
      return args.afterFingerprint === fingerprint
        ? { ...EMPTY_RESULT, fingerprint, unchanged: true }
        : { ...EMPTY_RESULT, scannedAt: 'full' }
    })
    const [conditional, legacy] = await Promise.all([
      _internals.listAiVaultSessions({
        executionHostScope: 'runtime:remote-server',
        afterFingerprint: fingerprint
      }),
      _internals.listAiVaultSessions({ executionHostScope: 'runtime:remote-server' })
    ])
    expect(conditional.unchanged).toBe(true)
    expect(legacy.unchanged).toBeUndefined()
    expect(legacy.scannedAt).toBe('full')
    expect(mocks.scanRuntimeAiVaultSessions).toHaveBeenCalledTimes(2)
  })

  it('does not forward conditional hints into truncated all-host merges', async () => {
    registerRuntimeHost()
    await _internals.listAiVaultSessions({
      executionHostScope: 'all',
      afterFingerprint: 'a'.repeat(64)
    })
    expect(mocks.scanRuntimeAiVaultSessions.mock.calls[0]?.[1]).not.toHaveProperty(
      'afterFingerprint'
    )
  })

  it.each([
    ['local', mocks.scanAiVaultSessionsInService],
    ['runtime:remote-server', mocks.scanRuntimeAiVaultSessions]
  ] as const)('coalesces %s scans while isolating caller cancellation', async (scope, scan) => {
    let resolveScan: ((result: AiVaultListResult) => void) | undefined
    scan.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveScan = resolve
        })
    )
    registerRuntimeHost()
    const firstController = new AbortController()
    const first = _internals.listAiVaultSessions(
      { executionHostScope: scope },
      { signal: firstController.signal }
    )
    const second = _internals.listAiVaultSessions({ executionHostScope: scope })
    await vi.waitFor(() => expect(resolveScan).toBeDefined())

    firstController.abort()

    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    expect(scan).toHaveBeenCalledTimes(1)
    resolveScan?.(EMPTY_RESULT)
    await expect(second).resolves.toMatchObject(EMPTY_RESULT)
  })

  it.each([
    ['local', 'desktop', mocks.scanAiVaultSessionsInService],
    ['local', 'remote-client', mocks.scanAiVaultSessionsInService],
    ['runtime:remote-server', 'desktop', mocks.scanRuntimeAiVaultSessions]
  ] as const)(
    'does not let a %s read after a %s delete join a scan that began before it',
    async (scope, deleter, scan) => {
      registerRuntimeHost()
      let finishBeforeDelete = (_result: AiVaultListResult): void => {}
      scan
        .mockReturnValueOnce(new Promise((resolve) => (finishBeforeDelete = resolve)))
        .mockResolvedValueOnce({ ...EMPTY_RESULT, scannedAt: '2026-07-28T00:00:00.000Z' })
      const beforeDelete = _internals.listAiVaultSessions({ executionHostScope: scope })
      await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))

      // Remote-client deletes skip the desktop host-leg cache.
      if (deleter === 'desktop') {
        invalidateAiVaultHostLegCache()
      }
      invalidateAiVaultSessionListCache()
      const afterDelete = _internals.listAiVaultSessions({ executionHostScope: scope })
      finishBeforeDelete(EMPTY_RESULT)

      await expect(afterDelete).resolves.toMatchObject({ scannedAt: '2026-07-28T00:00:00.000Z' })
      await expect(beforeDelete).resolves.toMatchObject({ scannedAt: EMPTY_RESULT.scannedAt })
    }
  )

  it('reports a failed local scan as a host issue rather than rejecting', async () => {
    mocks.scanAiVaultSessionsInService.mockRejectedValue(new Error('transcript root is unreadable'))
    registerAiVaultHandlers()
    const list = ipcHandler('aiVault:listSessions')

    // The local leg degrades like the SSH legs above: a rejection reaches the
    // renderer as a raw string painted over the list instead of an issue row.
    const result = await list(
      { sender: Object.assign(new EventEmitter(), { id: 1 }) },
      { executionHostScope: 'local', requestToken: 'scan' }
    )
    expect(result).toMatchObject({
      sessions: [],
      scanId: expect.any(String),
      issues: [expect.objectContaining({ message: 'transcript root is unreadable', kind: 'host' })]
    })
    expect(result).not.toHaveProperty('cancelled')
  })
})

function registerRuntimeHost(): void {
  registerAiVaultHandlers({
    getActiveRuntimeAiVaultHostInfos: () => [
      { environmentId: 'remote-server', executionHostId: 'runtime:remote-server' }
    ],
    scanRuntimeAiVaultSessions: mocks.scanRuntimeAiVaultSessions
  })
}

function ipcHandler(channel: string): (...args: unknown[]) => unknown {
  const registration = mocks.ipcHandle.mock.calls.find(([registered]) => registered === channel)
  if (!registration) {
    throw new Error(`${channel} was not registered`)
  }
  return registration[1]
}
