import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { DaemonServer } from './daemon-server'
import { HeadlessEmulator } from './headless-emulator'
import { getHistorySessionDirName } from './history-paths'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

describe('Sleep adoption after an adapter restart', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let historyPath: string
  let server: DaemonServer
  let adapter: DaemonPtyAdapter
  let historyAdapter: DaemonPtyAdapter | undefined
  let detachedAdapters: DaemonPtyAdapter[]
  let subprocess: ReturnType<typeof createMockSubprocess>

  beforeEach(async () => {
    const harness = await startDaemonAdapterHarness(() => {
      subprocess = createMockSubprocess()
      return subprocess
    })
    ;({ dir, socketPath, tokenPath, server, adapter } = harness)
    historyPath = join(dir, 'history')
    historyAdapter = undefined
    detachedAdapters = []
  })

  afterEach(async () => {
    historyAdapter?.dispose()
    for (const detached of detachedAdapters) {
      detached.dispose()
    }
    adapter.dispose()
    await server.shutdown()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function omitLegacySeedEvidence(): void {
    const listSessions = server.host.listSessions.bind(server.host)
    vi.spyOn(server.host, 'listSessions').mockImplementation(() =>
      listSessions().map((session) => {
        const legacy = { ...session }
        Reflect.deleteProperty(legacy, 'historySeeded')
        return legacy
      })
    )
  }

  it.each(['current', 'legacy'] as const)(
    'preserves failed-seed recovery when a %s daemon session is only listed before Sleep',
    async (daemon) => {
      const sessionId = `listed-failed-seed-${daemon}`
      const sessionDir = join(historyPath, getHistorySessionDirName(sessionId))
      mkdirSync(sessionDir, { recursive: true })
      writeFileSync(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          cwd: dir,
          cols: 80,
          rows: 24,
          startedAt: '2026-07-10T08:00:00Z',
          endedAt: null,
          exitCode: null
        })
      )
      writeFileSync(join(sessionDir, 'scrollback.bin'), 'recoverable before restart\r\n')
      const writeSync = HeadlessEmulator.prototype.writeSync
      vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockImplementation(function (
        this: HeadlessEmulator,
        data
      ) {
        return data.includes('recoverable before restart') ? false : writeSync.call(this, data)
      })
      const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })
      detachedAdapters.push(first)
      await first.spawn({ cols: 80, rows: 24, sessionId })
      subprocess._simulateData('fresh-only output\r\n')
      await first.disconnectOnly()
      if (daemon === 'legacy') {
        omitLegacySeedEvidence()
      }

      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })
      expect((await historyAdapter.listProcesses()).map((entry) => entry.id)).toContain(sessionId)
      expect(historyAdapter.getActiveSessionIds()).toEqual([])
      expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(false)

      await historyAdapter.shutdown(sessionId, { immediate: true, keepHistory: true })

      expect(existsSync(join(sessionDir, 'checkpoint.json'))).toBe(false)
      expect(readFileSync(join(sessionDir, 'scrollback.bin'), 'utf8')).toBe(
        'recoverable before restart\r\n'
      )
      expect(historyAdapter.hasRestorableHistory(sessionId)).toBe(true)
    }
  )

  it('preserves an existing checkpoint when a legacy listing cannot prove its seed outcome', async () => {
    const sessionId = 'legacy-listing-existing-checkpoint'
    const sessionDir = join(historyPath, getHistorySessionDirName(sessionId))
    const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })
    detachedAdapters.push(first)
    await first.spawn({ cols: 80, rows: 24, sessionId })
    subprocess._simulateData('persisted before restart\r\n')
    await first.disconnectOnly()
    expect(JSON.parse(readFileSync(join(sessionDir, 'meta.json'), 'utf8')).endedAt).toBeNull()
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const before = readFileSync(checkpointPath)
    subprocess._simulateData('unproven live replacement\r\n')
    omitLegacySeedEvidence()
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })

    await historyAdapter.shutdown(sessionId, { immediate: true, keepHistory: true })

    expect(readFileSync(checkpointPath)).toEqual(before)
    expect(historyAdapter.hasRestorableHistory(sessionId)).toBe(true)
  })

  it('still checkpoints a legacy live session when no recovery history exists', async () => {
    const sessionId = 'legacy-listing-new-history'
    await adapter.spawn({ cols: 80, rows: 24, sessionId })
    subprocess._simulateData('first saved output\r\n')
    omitLegacySeedEvidence()
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })

    await historyAdapter.shutdown(sessionId, { immediate: true, keepHistory: true })

    const checkpointPath = join(historyPath, getHistorySessionDirName(sessionId), 'checkpoint.json')
    expect(JSON.parse(readFileSync(checkpointPath, 'utf8')).snapshotAnsi).toContain(
      'first saved output'
    )
  })

  it('does not make an exiting session restorable through Sleep adoption', async () => {
    const sessionId = 'already-exiting-before-sleep'
    await adapter.spawn({ cols: 80, rows: 24, sessionId })
    subprocess._simulateData('already closed by the user\r\n')
    vi.spyOn(subprocess, 'kill').mockImplementation(() => {})
    const closing = server.host.kill(sessionId)
    try {
      expect(server.host.listSessions().find((entry) => entry.sessionId === sessionId)?.state).toBe(
        'exiting'
      )
      historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })
      await historyAdapter.shutdown(sessionId, { immediate: true, keepHistory: true })
      await closing

      expect(historyAdapter.hasRestorableHistory(sessionId)).toBe(false)
      expect(
        existsSync(join(historyPath, getHistorySessionDirName(sessionId), 'checkpoint.json'))
      ).toBe(false)
    } finally {
      subprocess._simulateExit(0)
      await closing
    }
  })

  it('keeps recovery suspended when a replacement spawn wins the lock after Sleep lists', async () => {
    const sessionId = 'sleep-listing-replacement-seed-race'
    const sessionDir = join(historyPath, getHistorySessionDirName(sessionId))
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'meta.json'),
      JSON.stringify({
        cwd: dir,
        cols: 80,
        rows: 24,
        startedAt: '2026-07-10T08:00:00Z',
        endedAt: null,
        exitCode: null
      })
    )
    writeFileSync(join(sessionDir, 'scrollback.bin'), 'recovery surviving replacement\r\n')
    const first = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })
    detachedAdapters.push(first)
    await first.spawn({ cols: 80, rows: 24, sessionId })
    await first.disconnectOnly()
    const checkpointPath = join(sessionDir, 'checkpoint.json')
    const before = readFileSync(checkpointPath)
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the protected client is only used to delay one real reply without replacing its data.
    const { client } = historyAdapter as unknown as { client: DaemonClient }
    const request = client.request.bind(client)
    let markListed!: () => void
    const listed = new Promise<void>((resolve) => {
      markListed = resolve
    })
    let releaseListing!: () => void
    const listingRelease = new Promise<void>((resolve) => {
      releaseListing = resolve
    })
    let heldListing = false
    vi.spyOn(client, 'request').mockImplementation(async (...args) => {
      const result = await request(...args)
      if (args[0] === 'listSessions' && !heldListing) {
        heldListing = true
        markListed()
        await listingRelease
      }
      return result
    })
    const sleep = historyAdapter.shutdown(sessionId, { immediate: true, keepHistory: true })
    try {
      await listed
      await adapter.shutdown(sessionId, { immediate: true })
      const writeSync = HeadlessEmulator.prototype.writeSync
      vi.spyOn(HeadlessEmulator.prototype, 'writeSync').mockImplementation(function (
        this: HeadlessEmulator,
        data
      ) {
        return data.includes('recovery surviving replacement') ? false : writeSync.call(this, data)
      })
      const replacement = await historyAdapter.spawn({ cols: 80, rows: 24, sessionId })
      expect(replacement.coldRestore?.scrollback).toContain('recovery surviving replacement')
      expect(historyAdapter.getActiveSessionIds()).toContain(sessionId)
      expect(historyAdapter.getHistoryManager()!.hasWriter(sessionId)).toBe(false)
      subprocess._simulateData('replacement fresh-only output\r\n')
      releaseListing()
      await sleep

      expect(readFileSync(checkpointPath)).toEqual(before)
      expect(historyAdapter.hasRestorableHistory(sessionId)).toBe(true)
    } finally {
      releaseListing()
      await sleep.catch(() => {})
    }
  })

  it('registers a blocked listing as part of Sleep before disconnectOnly can drain it', async () => {
    const sessionId = 'sleep-listing-disconnect-race'
    await adapter.spawn({ cols: 80, rows: 24, sessionId })
    subprocess._simulateData('saved before disconnect\r\n')
    historyAdapter = new DaemonPtyAdapter({ socketPath, tokenPath, historyPath })
    await historyAdapter.listProcesses()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these protected fields are inspected only to control the real transport boundary.
    const internals = historyAdapter as unknown as {
      client: DaemonClient
      keepHistoryShutdowns: Set<Promise<void>>
    }
    const request = internals.client.request.bind(internals.client)
    let markListed!: () => void
    const listed = new Promise<void>((resolve) => {
      markListed = resolve
    })
    let releaseListing!: () => void
    const listingRelease = new Promise<void>((resolve) => {
      releaseListing = resolve
    })
    vi.spyOn(internals.client, 'request').mockImplementation(async (...args) => {
      const result = await request(...args)
      if (args[0] === 'listSessions') {
        markListed()
        await listingRelease
      }
      return result
    })
    const order: string[] = []
    const disconnect = internals.client.disconnect.bind(internals.client)
    vi.spyOn(internals.client, 'disconnect').mockImplementation(() => {
      order.push('disconnect')
      disconnect()
    })
    const sleep = historyAdapter
      .shutdown(sessionId, { immediate: true, keepHistory: true })
      .then(() => order.push('sleep'))
    await listed
    const admittedWhileListing = internals.keepHistoryShutdowns.size
    const quitting = historyAdapter.disconnectOnly()
    releaseListing()
    const outcomes = await Promise.allSettled([sleep, quitting])

    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(order).toEqual(['sleep', 'disconnect'])
    expect(admittedWhileListing).toBe(1)
    expect(internals.client.isConnected()).toBe(false)
    expect(server.host.listSessions().some((entry) => entry.sessionId === sessionId)).toBe(false)
    const checkpointPath = join(historyPath, getHistorySessionDirName(sessionId), 'checkpoint.json')
    expect(JSON.parse(readFileSync(checkpointPath, 'utf8')).snapshotAnsi).toContain(
      'saved before disconnect'
    )
  })
})
