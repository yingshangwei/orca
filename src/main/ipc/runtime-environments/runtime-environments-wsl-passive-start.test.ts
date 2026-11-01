import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addWslHostEnvironment } from '../../../shared/runtime-environment-wsl-host-store'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

const { handle, ensure, prepareAccounts, callRuntime, getPath } = vi.hoisted(() => ({
  handle: vi.fn(),
  ensure: vi.fn<() => Promise<void>>(),
  prepareAccounts: vi.fn(async (request: { params: unknown }) => ({
    ok: true,
    params: request.params
  })),
  callRuntime: vi.fn(),
  getPath: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle, on: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() }
}))
vi.mock('../../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => ({ ensureForRuntimeCall: ensure })
}))
vi.mock('../../wsl/wsl-orcad-account-env', () => ({ withWslOrcadAccountEnv: prepareAccounts }))
vi.mock('./runtime-environment-transport-routing', () => ({ callRuntimeEnvironment: callRuntime }))

import { registerRuntimeEnvironmentPassiveHandlers } from './runtime-environment-connectivity-handlers'
import { channelHandlerLookup, pairingCode } from './runtime-environments-ipc-test-harness'

let profile: string
const handler = channelHandlerLookup(handle)
const request = (selector = 'wsl:ubuntu') =>
  handler<{ selector: string; method: string; params: unknown }, RuntimeRpcResponse<unknown>>(
    'runtimeEnvironments:call'
  )(null, {
    selector,
    method: 'terminal.create',
    params: { worktree: 'wt-1', cols: 80, rows: 24 }
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
  profile = mkdtempSync(join(tmpdir(), 'orca-wsl-passive-account-'))
  getPath.mockReturnValue(profile)
  ensure.mockReset().mockResolvedValue(undefined)
  callRuntime.mockResolvedValue({
    id: 'terminal.create',
    ok: true,
    result: { terminal: { handle: 'terminal-1' } }
  })
  addWslHostEnvironment(profile, {
    id: 'wsl:ubuntu',
    name: 'Ubuntu',
    pairingCode: pairingCode(),
    record: { kind: 'wsl', distro: 'Ubuntu', localPort: 6768, remotePort: 6768 }
  })
  registerRuntimeEnvironmentPassiveHandlers(() => profile)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(profile, { recursive: true, force: true })
})

describe('the IPC boundary before WSL account preparation', () => {
  it('returns a typed stopped refusal before account preparation or runtime dispatch', async () => {
    ensure.mockRejectedValueOnce(
      new RemoteRuntimeClientError('wsl_host_stopped', 'Ubuntu is stopped.')
    )
    await expect(request()).resolves.toMatchObject({
      ok: false,
      error: { code: 'wsl_host_stopped', message: 'Ubuntu is stopped.' }
    })
    expect(prepareAccounts).not.toHaveBeenCalled()
    expect(callRuntime).not.toHaveBeenCalled()
  })

  it('does not prepare a guest account when running status is unknown', async () => {
    ensure.mockRejectedValueOnce(new Error('WSL running status is unavailable.'))
    await expect(request()).rejects.toThrow('WSL running status is unavailable.')
    expect(prepareAccounts).not.toHaveBeenCalled()
    expect(callRuntime).not.toHaveBeenCalled()
  })

  it('awaits running confirmation before preparing the selected account and forwarding the call', async () => {
    let finish!: () => void
    ensure.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    const pending = request()
    expect(prepareAccounts).not.toHaveBeenCalled()
    expect(callRuntime).not.toHaveBeenCalled()
    finish()
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(prepareAccounts).toHaveBeenCalledOnce()
    expect(callRuntime).toHaveBeenCalledOnce()
    expect(prepareAccounts.mock.invocationCallOrder[0]).toBeLessThan(
      callRuntime.mock.invocationCallOrder[0]
    )
  })

  it('keeps non-WSL runtime calls independent of the WSL gate', async () => {
    const remote = addEnvironmentFromPairingCode(profile, {
      name: 'remote',
      pairingCode: pairingCode('ws://127.0.0.1:7777', { keyByte: 2 })
    })
    await expect(request(remote.id)).resolves.toMatchObject({ ok: true })
    expect(ensure).not.toHaveBeenCalled()
    expect(callRuntime).toHaveBeenCalledOnce()
  })
})
