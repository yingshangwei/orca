import { app } from 'electron'
import { listRegisteredEnvironmentIds } from '../../shared/runtime-environment-store-file'
import {
  deriveBrowserRoutePartitionStorageScope,
  deriveLocalSshBrowserRoutePartitionStorageScope
} from './browser-route-identity'
import { isBrowserRoutePartitionRetainedByAnyOwner } from './browser-route-partition-retention'
import {
  findBrowserRoutePartitionsForStorageScope,
  findOrphanedBrowserRoutePartitions,
  partitionDirectory,
  releaseBrowserRoutePartitionStorage,
  type BrowserRoutePartitionStorageDependencies
} from './browser-route-partition-storage-lifecycle'
import {
  browserRoutePartitionDirectoryKey,
  browserRoutePartitionPendingDeletesPath,
  deletePendingBrowserRoutePartitionDirectories
} from './browser-route-partition-pending-deletes'
import {
  activeBrowserRoutePartitionOrcaProfileId,
  currentBrowserRoutePartitionBindingFilePath
} from './browser-route-partition-binding-runtime'
import { browserRoutePartitionStorageDependencies } from './browser-route-partition-storage-dependencies'

export type BrowserRoutePartitionStorageClear = {
  clearedPartitions: string[]
  livePartitions: string[]
}

/**
 * Sweeps route partitions whose owning record is gone.
 *
 * Runs at startup only, and never treats a disconnected host as removed: an
 * environment or SSH target that still exists in the store keeps every
 * partition it owns. `listLocalSshTargetIds` comes from the caller because the
 * SSH store singleton may not be registered yet at sweep time — and a missing
 * target list must skip the sweep, never mistake live jars for orphans.
 */
export async function collectOrphanedBrowserRoutePartitionStorage(
  listLocalSshTargetIds?: () => string[]
): Promise<string[]> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return []
  }
  const dependencies = browserRoutePartitionStorageDependencies(
    isBrowserRoutePartitionRetainedByAnyOwner,
    'cold'
  )
  reportStorageFailures(
    'deferred folder deletion',
    await deletePendingBrowserRoutePartitionDirectories({
      filePath: browserRoutePartitionPendingDeletesPath(
        currentBrowserRoutePartitionBindingFilePath()
      ),
      partitionDataRoot: dependencies.partitionDataRoot,
      // Re-read per entry: a partition bound while an earlier delete awaited must survive.
      isBound: (directory) => {
        const key = browserRoutePartitionDirectoryKey(directory)
        return [...dependencies.bindings.listBindings().keys()].some(
          (partition) =>
            browserRoutePartitionDirectoryKey(partitionDirectory(dependencies, partition)) === key
        )
      },
      removeDirectory: dependencies.removePartitionDirectory
    })
  )
  const liveStorageScopes = new Set(
    [...listRegisteredEnvironmentIds(app.getPath('userData'), { requireStoreFile: true })].map(
      (environmentId) => deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId })
    )
  )
  if (!listLocalSshTargetIds) {
    return []
  }
  for (const targetId of listLocalSshTargetIds()) {
    liveStorageScopes.add(
      deriveLocalSshBrowserRoutePartitionStorageScope({ orcaProfileId, targetId })
    )
  }
  const orphans = findOrphanedBrowserRoutePartitions(dependencies, liveStorageScopes)
  if (orphans.length === 0) {
    return []
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, orphans)
  reportStorageFailures('orphan collection', released.failures)
  return released.clearedPartitions
}

/**
 * Destroys the storage of every route partition owned by a removed environment.
 *
 * Reports the partitions that still had prepared pages separately: they were left intact on
 * purpose, and the caller decides whether a retry after teardown can reach them.
 */
export async function clearBrowserRoutePartitionStorageForEnvironment(
  environmentId: string
): Promise<BrowserRoutePartitionStorageClear> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const dependencies = storageDependencies()
  const partitions = findBrowserRoutePartitionsForStorageScope(
    dependencies,
    deriveBrowserRoutePartitionStorageScope({ orcaProfileId, environmentId })
  )
  if (partitions.length === 0) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, partitions)
  reportStorageFailures('environment removal', released.failures)
  return { clearedPartitions: released.clearedPartitions, livePartitions: released.livePartitions }
}

/** Destroys the storage of every route partition owned by a removed SSH target. */
export async function clearBrowserRoutePartitionStorageForLocalSshTarget(
  targetId: string
): Promise<BrowserRoutePartitionStorageClear> {
  const orcaProfileId = activeBrowserRoutePartitionOrcaProfileId()
  if (!orcaProfileId) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const dependencies = storageDependencies()
  const partitions = findBrowserRoutePartitionsForStorageScope(
    dependencies,
    deriveLocalSshBrowserRoutePartitionStorageScope({ orcaProfileId, targetId })
  )
  if (partitions.length === 0) {
    return { clearedPartitions: [], livePartitions: [] }
  }
  const released = await releaseBrowserRoutePartitionStorage(dependencies, partitions)
  reportStorageFailures('ssh target removal', released.failures)
  return { clearedPartitions: released.clearedPartitions, livePartitions: released.livePartitions }
}

function storageDependencies(): BrowserRoutePartitionStorageDependencies {
  return browserRoutePartitionStorageDependencies(isBrowserRoutePartitionRetainedByAnyOwner)
}

function reportStorageFailures(stage: string, failures: readonly unknown[]): void {
  for (const failure of failures) {
    console.warn(
      `[browser-route-partition] ${stage} failed:`,
      failure instanceof Error ? failure.message : String(failure)
    )
  }
}
