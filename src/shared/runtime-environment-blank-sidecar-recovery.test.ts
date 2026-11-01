import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from './pairing'
import {
  addManagedOrcadEnvironment,
  recordManagedOrcadMigration
} from './runtime-environment-managed-orcad-store'
import {
  addEnvironmentFromPairingCode,
  getEnvironmentStorePath,
  listEnvironments
} from './runtime-environment-store'
import { getRuntimeEnvironmentSidecarPath } from './runtime-environment-sidecar'
import type * as SecureFileModule from './secure-file'

const writeFailure = vi.hoisted(() => ({ path: '' }))
vi.mock('./secure-file', async (importOriginal) => {
  const original = await importOriginal<typeof SecureFileModule>()
  return {
    ...original,
    writeSecureFile: (...args: Parameters<typeof original.writeSecureFile>) => {
      if (args[0] === writeFailure.path) {
        throw new Error('injected main-store write failure')
      }
      return original.writeSecureFile(...args)
    }
  }
})

const deployment = {
  sshTargetId: 'ssh-old',
  sshTargetGeneration: 4,
  localPort: 46_768,
  remotePort: 6_768
}
const pairingCode = encodePairingOffer({
  v: 2,
  endpoint: 'ws://127.0.0.1:46768',
  deviceToken: 'test-device-token',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64')
})

describe('blank environment store sidecar recovery', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-blank-sidecar-'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    writeFailure.path = ''
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  const addManaged = (id: string) =>
    addManagedOrcadEnvironment(userDataPath, {
      id,
      name: id,
      pairingCode,
      orcadDeployment: deployment,
      now: 100
    })

  function corruptMainStore() {
    addManaged('old')
    recordManagedOrcadMigration(userDataPath, 'old', '2026-03-01T00:00:00.000Z')
    const originalMain = readFileSync(getEnvironmentStorePath(userDataPath))
    const originalSidecar = JSON.parse(
      readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8')
    )
    writeFileSync(getEnvironmentStorePath(userDataPath), Buffer.alloc(640))
    return { originalMain, originalSidecar }
  }

  function readRecoverySidecar() {
    const mainBackups = readdirSync(userDataPath).filter((name) =>
      name.startsWith('orca-environments.json.corrupt-')
    )
    expect(mainBackups).toHaveLength(1)
    const suffix = mainBackups[0].slice('orca-environments.json'.length)
    const sidecarBackup = `${getRuntimeEnvironmentSidecarPath(userDataPath)}${suffix}`
    expect(readFileSync(join(userDataPath, mainBackups[0]))).toEqual(Buffer.alloc(640))
    if (process.platform !== 'win32') {
      expect(statSync(sidecarBackup).mode & 0o777).toBe(0o600)
    }
    return JSON.parse(readFileSync(sidecarBackup, 'utf8'))
  }

  it('keeps old deployment state in the sidecar and paired recovery backup on managed add', () => {
    const { originalMain, originalSidecar } = corruptMainStore()
    addManaged('new')
    const current = JSON.parse(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8'))
    expect(current.entries.old).toEqual(originalSidecar.entries.old)
    expect(readRecoverySidecar().entries.old).toEqual(originalSidecar.entries.old)
    writeFileSync(getEnvironmentStorePath(userDataPath), originalMain)
    expect(listEnvironments(userDataPath)[0]).toMatchObject({
      id: 'old',
      orcadDeployment: deployment,
      orcadMigratedAt: '2026-03-01T00:00:00.000Z'
    })
  })

  it('retains a recoverable sidecar after an ordinary save and later orphan cleanup', () => {
    const { originalSidecar } = corruptMainStore()
    addEnvironmentFromPairingCode(userDataPath, { name: 'paired', pairingCode })
    addManaged('new')
    expect(readRecoverySidecar().entries.old).toEqual(originalSidecar.entries.old)
  })

  it('does not discard old links when the following main-store write fails', () => {
    const { originalSidecar } = corruptMainStore()
    writeFailure.path = getEnvironmentStorePath(userDataPath)
    expect(() => addManaged('new')).toThrow('injected main-store write failure')
    expect(readFileSync(writeFailure.path)).toEqual(Buffer.alloc(640))
    const current = JSON.parse(readFileSync(getRuntimeEnvironmentSidecarPath(userDataPath), 'utf8'))
    expect(current.entries.old).toEqual(originalSidecar.entries.old)
    expect(readRecoverySidecar().entries.old).toEqual(originalSidecar.entries.old)
  })
})
