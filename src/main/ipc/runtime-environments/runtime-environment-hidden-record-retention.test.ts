import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { addEnvironmentFromPairingCode } from '../../../shared/runtime-environment-store'
import { getEnvironmentStorePath } from '../../../shared/runtime-environment-store-file'
import { getRuntimeEnvironmentSidecarPath } from '../../../shared/runtime-environment-sidecar'
import { getWslHostDeploymentStorePath } from '../../../shared/wsl-host-deployment-store'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Store } from '../../persistence'
import { deriveBrowserRoutePartitionStorageScope } from '../../browser/browser-route-identity'
import { pairingCode } from './runtime-environments-ipc-test-harness'

const state = vi.hoisted(() => ({
  userDataPath: '',
  bindings: new Map<string, { fingerprint: string; storageScope: string | null }>(),
  cleared: new Array<string>()
}))
vi.mock('electron', () => ({ app: { getPath: () => state.userDataPath } }))
vi.mock('../../browser/browser-route-partition-binding-runtime', () => ({
  activeBrowserRoutePartitionOrcaProfileId: () => 'local-default',
  currentBrowserRoutePartitionBindingFilePath: () =>
    `${state.userDataPath}/browser-route-partition-bindings.json`
}))
vi.mock('../../browser/browser-route-partition-storage-dependencies', () => ({
  browserRoutePartitionStorageDependencies: () => ({
    bindings: {
      listBindings: () => state.bindings,
      remove: (partitions: readonly string[]) => {
        for (const partition of partitions) {
          state.bindings.delete(partition)
        }
        return partitions.length
      }
    },
    partitionDataRoot: '/unused-test-partitions',
    isPartitionLive: () => false,
    clearPartitionStorage: async (partition: string) => {
      state.cleared.push(partition)
    },
    removePartitionDirectory: async () => {}
  })
}))

import { collectOrphanedBrowserRoutePartitionStorage } from '../../browser/browser-route-partition-storage-runtime'
import { wslHostSshManagedRefusal } from '../../wsl/wsl-host-ssh-orcad-conflict'
import { reconcileOrphanedRuntimeSessions } from './runtime-environment-session-reconcile'
import { readSettingsWithRuntimeEnvironmentPreference } from './runtime-environment-preference'

const PARTITION = `persist:orca-browser-v1-${'a'.repeat(64)}`
let environmentId: string

beforeEach(() => {
  state.userDataPath = mkdtempSync(join(tmpdir(), 'orca-hidden-retention-'))
  vi.stubEnv('ORCA_INTERNAL_WSL_HOSTS', '1')
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  environmentId = addEnvironmentFromPairingCode(state.userDataPath, {
    name: 'saved-loopback',
    pairingCode: pairingCode()
  }).id
  state.bindings.clear()
  state.cleared.length = 0
  state.bindings.set(PARTITION, {
    fingerprint: '1'.repeat(64),
    storageScope: deriveBrowserRoutePartitionStorageScope({
      orcaProfileId: 'local-default',
      environmentId
    })
  })
})

afterEach(() => {
  rmSync(state.userDataPath, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function hideRecord(kind: string): void {
  if (kind === 'corrupt-wsl' || kind === 'future-wsl') {
    writeFileSync(
      getWslHostDeploymentStorePath(state.userDataPath),
      kind === 'corrupt-wsl' ? '{' : '{"version":99,"deployments":[]}'
    )
  } else if (kind === 'corrupt-links') {
    writeFileSync(getRuntimeEnvironmentSidecarPath(state.userDataPath), '{')
  } else {
    writeFileSync(
      getEnvironmentStorePath(state.userDataPath),
      JSON.stringify({
        version: 1,
        environments: [{ id: environmentId, kind: 'future-server' }]
      })
    )
  }
}

function sessions() {
  const hostIds: ExecutionHostId[] = [`runtime:${environmentId}`]
  return { getWorkspaceSessionHostIds: () => hostIds, removeWorkspaceSessionHost: vi.fn() }
}

function preference() {
  let settings: ReturnType<typeof getDefaultSettings> = {
    ...getDefaultSettings(state.userDataPath),
    activeRuntimeEnvironmentId: environmentId
  }
  const updateSettings = vi.fn<Store['updateSettings']>((updates) => {
    settings = { ...settings, ...updates }
    return settings
  })
  return { getSettings: () => settings, updateSettings }
}

describe.each(['corrupt-wsl', 'future-wsl', 'corrupt-links', 'future-record'])(
  '%s retention',
  (kind) => {
    it('preserves the saved workspace session while the host is hidden', () => {
      hideRecord(kind)
      const store = sessions()
      expect(reconcileOrphanedRuntimeSessions(store, state.userDataPath)).toEqual([])
      expect(store.removeWorkspaceSessionHost).not.toHaveBeenCalled()
    })

    it('preserves the selected host while it is hidden', () => {
      hideRecord(kind)
      const store = preference()
      expect(
        readSettingsWithRuntimeEnvironmentPreference(store, state.userDataPath)
          .activeRuntimeEnvironmentId
      ).toBe(environmentId)
      expect(store.updateSettings).not.toHaveBeenCalled()
    })

    it('preserves inactive browser storage while its saved owner is hidden', async () => {
      hideRecord(kind)
      expect(await collectOrphanedBrowserRoutePartitionStorage(() => [])).toEqual([])
      expect(state.cleared).toEqual([])
      expect(state.bindings.has(PARTITION)).toBe(true)
    })
  }
)

it('still clears all three resources after the owning record is really removed', async () => {
  writeFileSync(getEnvironmentStorePath(state.userDataPath), '{"version":1,"environments":[]}')
  const sessionStore = sessions()
  const preferenceStore = preference()
  expect(reconcileOrphanedRuntimeSessions(sessionStore, state.userDataPath)).toEqual([
    `runtime:${environmentId}`
  ])
  expect(
    readSettingsWithRuntimeEnvironmentPreference(preferenceStore, state.userDataPath)
      .activeRuntimeEnvironmentId
  ).toBeNull()
  expect(await collectOrphanedBrowserRoutePartitionStorage(() => [])).toEqual([PARTITION])
})

it('refuses WSL add before probing or waking a distro when its deployment file is unreadable', async () => {
  hideRecord('corrupt-wsl')
  const deploymentPath = getWslHostDeploymentStorePath(state.userDataPath)
  const before = readFileSync(deploymentPath)
  const readPublicKey = vi.fn(async () => null)
  expect(await wslHostSshManagedRefusal('Ubuntu', state.userDataPath, readPublicKey)).toMatchObject(
    { ok: false, kind: 'failed' }
  )
  expect(readPublicKey).not.toHaveBeenCalled()
  expect(readFileSync(deploymentPath)).toEqual(before)
})

it('preserves all resources when an unreadable record has no identifiable owner', async () => {
  writeFileSync(
    getEnvironmentStorePath(state.userDataPath),
    JSON.stringify({
      version: 1,
      environments: [{ kind: 'unknown-server' }]
    })
  )
  const sessionStore = sessions()
  const preferenceStore = preference()
  expect(reconcileOrphanedRuntimeSessions(sessionStore, state.userDataPath)).toEqual([])
  expect(sessionStore.removeWorkspaceSessionHost).not.toHaveBeenCalled()
  expect(
    readSettingsWithRuntimeEnvironmentPreference(preferenceStore, state.userDataPath)
      .activeRuntimeEnvironmentId
  ).toBe(environmentId)
  expect(preferenceStore.updateSettings).not.toHaveBeenCalled()
  await expect(collectOrphanedBrowserRoutePartitionStorage(() => [])).rejects.toThrow(
    'Could not identify every saved server'
  )
  expect(state.cleared).toEqual([])
  expect(state.bindings.has(PARTITION)).toBe(true)
})

it('preserves browser storage when the main registry file is missing', async () => {
  rmSync(getEnvironmentStorePath(state.userDataPath))
  await expect(collectOrphanedBrowserRoutePartitionStorage(() => [])).rejects.toThrow(
    'Could not read Orca environments'
  )
  expect(state.cleared).toEqual([])
  expect(state.bindings.has(PARTITION)).toBe(true)
})
