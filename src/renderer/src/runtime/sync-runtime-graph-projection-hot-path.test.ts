import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'
import { makeAgentStatusEntry, makeState } from './sync-runtime-graph-test-harness'
import type * as EditorDraftHashModule from './sync-runtime-graph/editor-draft-hash'

// Why the mock: the draft hash is the only per-keystroke cost that scales with file size, so the
// regression this file guards is "how many characters were hashed", not "how long did it take".
// Instrumenting the real function through its own module keeps the counter out of shipped code.
const draftHashCounter = { calls: 0, chars: 0 }
vi.mock('./sync-runtime-graph/editor-draft-hash', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorDraftHashModule>()
  return {
    stableHashString: (value: string): string => {
      draftHashCounter.calls += 1
      draftHashCounter.chars += value.length
      return actual.stableHashString(value)
    }
  }
})

const { stableHashString } = await import('./sync-runtime-graph/editor-draft-hash')
const {
  AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS: AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS,
  buildRuntimeMobileAgentStatusProjectionForTests,
  resetRuntimeMobileAgentStatusProjectionCacheForTests
} = await import('./sync-runtime-graph/agent-status-projection')
const { getRuntimeMobileSessionSyncKey, runtimeMobileSessionSyncKeysEqual } =
  await import('./sync-runtime-graph/sync-key')
const {
  resetRuntimeMobileSyncProjectionCachesForTests,
  buildRuntimeMobileBrowserProjection,
  buildRuntimeMobileEditorDraftsProjection,
  getEditorDraftVersionByFileId,
  buildRuntimeMobileOpenFilesProjection
} = await import('./sync-runtime-graph/sync-projections')
const { buildMobileSessionTabSnapshots } =
  await import('./sync-runtime-graph/mobile-session-snapshots')

// ── Reference implementations: the pre-change bodies, kept verbatim ────────────────────

type MainAgentStatus = AppState['agentStatusByPaneKey'][string]['mainAgent']
function mainAgentKey(mainAgent: MainAgentStatus) {
  return mainAgent ? [mainAgent.state, mainAgent.outcome ?? null, mainAgent.stateStartedAt] : null
}

function referenceEditorDraftsProjection(editorDrafts: AppState['editorDrafts']): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(editorDrafts).map(([fileId, content]) => [fileId, stableHashString(content)])
    )
  )
}

function referenceOpenFilesProjection(openFiles: AppState['openFiles']): string {
  return JSON.stringify(
    openFiles.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: file.language,
      mode: file.mode,
      diffSource: file.diffSource,
      isDirty: file.isDirty,
      isUntitled: file.isUntitled,
      deleteUntouchedOnClose: file.deleteUntouchedOnClose,
      markdownPreviewSourceFileId: file.markdownPreviewSourceFileId
    }))
  )
}

function referenceBrowserProjection(state: AppState): string {
  return JSON.stringify({
    workspacesByWorktree: Object.fromEntries(
      Object.entries(state.browserTabsByWorktree ?? {}).map(([worktreeId, workspaces]) => [
        worktreeId,
        workspaces.map((workspace) => ({
          id: workspace.id,
          activePageId: workspace.activePageId,
          title: workspace.title,
          url: workspace.url,
          loading: workspace.loading,
          canGoBack: workspace.canGoBack,
          canGoForward: workspace.canGoForward
        }))
      ])
    ),
    pagesByWorkspace: Object.fromEntries(
      Object.entries(state.browserPagesByWorkspace ?? {}).map(([workspaceId, pages]) => [
        workspaceId,
        pages.map((page) => ({
          id: page.id,
          title: page.title,
          url: page.url,
          loading: page.loading,
          canGoBack: page.canGoBack,
          canGoForward: page.canGoForward
        }))
      ])
    )
  })
}

/** The pre-change agent-status serialization, including its `localeCompare` sort. */
function referenceAgentStatusProjection(map: AppState['agentStatusByPaneKey']): string {
  return JSON.stringify(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([paneKey, entry]) => ({
        paneKey,
        entryPaneKey: entry.paneKey,
        state: entry.state,
        workingMode: entry.workingMode ?? null,
        prompt: entry.prompt,
        updatedAtBucket: Math.floor(entry.updatedAt / AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS),
        stateStartedAt: entry.stateStartedAt,
        turnStartedAt: entry.turnStartedAt ?? null,
        turnEndedAt: entry.turnEndedAt ?? null,
        turnEndDisposition: entry.turnEndDisposition ?? null,
        agentType: entry.agentType ?? null,
        terminalTitle: entry.terminalTitle ?? null,
        stateHistory: entry.stateHistory.map((history) => ({
          state: history.state,
          prompt: history.prompt,
          startedAt: history.startedAt,
          interrupted: history.interrupted ?? null,
          mainAgent: mainAgentKey(history.mainAgent)
        })),
        toolName: entry.toolName ?? null,
        toolInput: entry.toolInput ?? null,
        interactivePrompt: entry.interactivePrompt ?? null,
        lastAssistantMessage: entry.lastAssistantMessage ?? null,
        lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput ?? null,
        interrupted: entry.interrupted ?? null,
        mainAgent: mainAgentKey(entry.mainAgent),
        programStatus: entry.programStatus
          ? [
              entry.programStatus.state,
              entry.programStatus.kind ?? null,
              entry.programStatus.progress ?? null,
              entry.programStatus.message ?? null
            ]
          : null
      }))
  )
}

/** Same entries, code-unit ordered — proves the new sort changes order only, never content. */
function sortedProjectionEntries(projection: string): unknown[] {
  return (JSON.parse(projection) as unknown[]).slice().sort((a, b) => {
    const left = JSON.stringify(a)
    const right = JSON.stringify(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

// ── Fixtures ──────────────────────────────────────────────────────────────────────────

const DRAFT_FILE_COUNT = 5
const DRAFT_CHARS_PER_FILE = 40_000

function makeDrafts(): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (let index = 0; index < DRAFT_FILE_COUNT; index += 1) {
    drafts[`file-${index}`] = 'x'.repeat(DRAFT_CHARS_PER_FILE)
  }
  return drafts
}

function makeOpenFile(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    id: `file-${index}`,
    filePath: `/repo/src/file-${index}.ts`,
    relativePath: `src/file-${index}.ts`,
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    isUntitled: false,
    ...overrides
  } as never
}

function makeBrowserWorkspace(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    id: `ws-${index}`,
    activePageId: `page-${index}`,
    title: `tab ${index}`,
    url: `https://example.test/${index}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...overrides
  } as never
}

function makeBrowserPage(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    id: `page-${index}`,
    title: `page ${index}`,
    url: `https://example.test/${index}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...overrides
  } as never
}

/**
 * Characters handed back by `JSON.stringify`, which is the allocation these projections dominate.
 * Counting bytes rather than calls keeps the comparison fair: the old code made one big call per
 * rebuild, the new code makes one small call per changed entry.
 */
function countSerializedChars(run: () => void): number {
  const original = JSON.stringify
  let chars = 0
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((...args: never[]) => {
    const serialized = (original as (...a: never[]) => string)(...args)
    chars += serialized?.length ?? 0
    return serialized
  }) as typeof JSON.stringify)
  try {
    run()
    return chars
  } finally {
    spy.mockRestore()
  }
}

beforeEach(() => {
  draftHashCounter.calls = 0
  draftHashCounter.chars = 0
  resetRuntimeMobileSyncProjectionCachesForTests()
  resetRuntimeMobileAgentStatusProjectionCacheForTests()
})

describe('editor draft projection on the typing path', () => {
  it.each([40_000, 400_000])(
    'does not hash or invalidate the mobile graph for edits to a %i-character source file',
    (fileChars) => {
      let state = makeState({
        openFiles: [makeOpenFile(0, { isDirty: true })],
        editorDrafts: { 'file-0': 'x'.repeat(fileChars) }
      })
      let key = getRuntimeMobileSessionSyncKey(state, undefined, undefined, false)
      draftHashCounter.calls = 0
      draftHashCounter.chars = 0
      let invalidations = 0
      for (let keystroke = 0; keystroke < 100; keystroke += 1) {
        const next = {
          ...state,
          editorDrafts: { ...state.editorDrafts, 'file-0': `${state.editorDrafts['file-0']}a` }
        }
        const nextKey = getRuntimeMobileSessionSyncKey(next, state, key, false)
        if (!runtimeMobileSessionSyncKeysEqual(key, nextKey)) {
          invalidations += 1
        }
        state = next
        key = nextKey
      }
      expect({ ...draftHashCounter, invalidations }).toEqual({
        calls: 0,
        chars: 0,
        invalidations: 0
      })
    }
  )

  it('versions published Markdown sources and preview aliases without hashing diff drafts', () => {
    const openFiles = [
      makeOpenFile(0, { language: 'markdown', worktreeId: 'folder:workspace-1' }),
      makeOpenFile(1),
      makeOpenFile(2, { language: 'markdown', mode: 'diff' }),
      makeOpenFile(3, { language: 'markdown', mirroredFromRuntimeSession: true }),
      makeOpenFile(4, { mode: 'markdown-preview', markdownPreviewSourceFileId: 'file-1' }),
      makeOpenFile(5, { mode: 'markdown-preview', markdownPreviewSourceFileId: 'missing' })
    ]
    const drafts = Object.fromEntries(
      openFiles.map((_file, index) => [`file-${index}`, `draft ${index}`])
    )
    const versions = getEditorDraftVersionByFileId(drafts, openFiles)
    expect([...versions.keys()]).toEqual(['file-0', 'file-3', 'file-1', 'file-5'])
    expect(draftHashCounter.calls).toBe(4)

    const snapshots = buildMobileSessionTabSnapshots(
      makeState({ openFiles, editorDrafts: drafts }),
      false
    )
    const tabs = snapshots.flatMap((snapshot) => snapshot.tabs)
    expect(tabs.find((tab) => tab.id === 'file-4')).toMatchObject({
      type: 'markdown',
      sourceFileId: 'file-1',
      documentVersion: versions.get('file-1')
    })
    expect(tabs.find((tab) => tab.id === 'file-5')).toMatchObject({
      type: 'markdown',
      sourceFileId: 'file-5',
      documentVersion: versions.get('file-5')
    })
    expect(draftHashCounter.calls).toBe(4)
  })

  it('invalidates Markdown versions on content, language, draft removal, and file closure', () => {
    let state = makeState({
      openFiles: [makeOpenFile(0)],
      editorDrafts: { 'file-0': 'draft' }
    })
    const sourceKey = getRuntimeMobileSessionSyncKey(state, undefined, undefined, false)
    expect(draftHashCounter.calls).toBe(0)
    const markdown = { ...state, openFiles: [makeOpenFile(0, { language: 'markdown' })] }
    const markdownKey = getRuntimeMobileSessionSyncKey(markdown, state, sourceKey, false)
    expect(markdownKey.editorDraftsProjection).not.toBe(sourceKey.editorDraftsProjection)
    expect(draftHashCounter.calls).toBe(1)
    state = { ...markdown, editorDrafts: { 'file-0': 'edited draft' } }
    const editedKey = getRuntimeMobileSessionSyncKey(state, markdown, markdownKey, false)
    expect(editedKey.editorDraftsProjection).not.toBe(markdownKey.editorDraftsProjection)
    expect(draftHashCounter.calls).toBe(2)
    const clean = { ...state, editorDrafts: {} }
    const cleanKey = getRuntimeMobileSessionSyncKey(clean, state, editedKey, false)
    expect(cleanKey.editorDraftsProjection).toBe('{}')
    expect(
      buildMobileSessionTabSnapshots(clean, false).flatMap((snapshot) => snapshot.tabs)
    ).toContainEqual(expect.objectContaining({ id: 'file-0', documentVersion: 'file:file-0' }))
    const closed = { ...state, openFiles: [] }
    const closedKey = getRuntimeMobileSessionSyncKey(closed, state, editedKey, false)
    expect(closedKey.editorDraftsProjection).toBe('{}')
    expect(getEditorDraftVersionByFileId(closed.editorDrafts, closed.openFiles).size).toBe(0)
    expect(draftHashCounter.calls).toBe(2)
  })

  it('hashes only the edited file per keystroke, not every open dirty file', () => {
    const typedCharacters = 100
    const totalDraftChars = DRAFT_FILE_COUNT * DRAFT_CHARS_PER_FILE

    // Baseline: the pre-change uncached projection, driven by the same counter.
    let drafts = makeDrafts()
    referenceEditorDraftsProjection(drafts)
    draftHashCounter.calls = 0
    draftHashCounter.chars = 0
    for (let keystroke = 0; keystroke < typedCharacters; keystroke += 1) {
      drafts = { ...drafts, 'file-0': `${drafts['file-0']}a` }
      referenceEditorDraftsProjection(drafts)
    }
    const before = { calls: draftHashCounter.calls, chars: draftHashCounter.chars }

    resetRuntimeMobileSyncProjectionCachesForTests()
    let memoDrafts = makeDrafts()
    const openFiles = Array.from({ length: DRAFT_FILE_COUNT }, (_, index) =>
      makeOpenFile(index, { language: 'markdown' })
    )
    buildRuntimeMobileEditorDraftsProjection(memoDrafts, openFiles)
    draftHashCounter.calls = 0
    draftHashCounter.chars = 0
    for (let keystroke = 0; keystroke < typedCharacters; keystroke += 1) {
      memoDrafts = { ...memoDrafts, 'file-0': `${memoDrafts['file-0']}a` }
      buildRuntimeMobileEditorDraftsProjection(memoDrafts, openFiles)
    }
    const after = { calls: draftHashCounter.calls, chars: draftHashCounter.chars }

    // Keystroke k has grown file-0 by k characters, so the exact totals are closed form.
    const growth = (typedCharacters * (typedCharacters + 1)) / 2
    // Before: every keystroke rehashes all five drafts.
    expect(before).toEqual({
      calls: typedCharacters * DRAFT_FILE_COUNT,
      chars: typedCharacters * totalDraftChars + growth
    })
    // After: one hash of one draft per keystroke.
    expect(after).toEqual({
      calls: typedCharacters,
      chars: typedCharacters * DRAFT_CHARS_PER_FILE + growth
    })
    expect(before.chars / after.chars).toBeGreaterThan(DRAFT_FILE_COUNT - 0.1)
  })

  it('matches the uncached projection byte for byte across draft shapes', () => {
    const draftCases: Record<string, string>[] = [
      {},
      { 'file-a': '' },
      { 'file-a': 'hello' },
      { 'file-a': 'hello', 'file-b': 'world' },
      { 'file-b': 'world', 'file-a': 'hello' },
      { '2': 'numeric-like key', 'file-a': 'hello', '1': 'other' },
      { 'quote"and\\slash': 'body with "quotes" and \\ and \u{1f389}' },
      { 'file-a': 'hello', 'file-b': 'world', 'file-c': 'third' },
      { 'file-a': 'HELLO', 'file-c': 'third' }
    ]
    for (const [index, draft] of draftCases.entries()) {
      const openFiles = Object.keys(draft).map((id, fileIndex) =>
        makeOpenFile(fileIndex, { id, language: 'markdown' })
      )
      expect({
        index,
        projection: buildRuntimeMobileEditorDraftsProjection(draft, openFiles)
      }).toEqual({
        index,
        projection: referenceEditorDraftsProjection(draft)
      })
    }
  })
})

describe('agent-status projection sort', () => {
  it('constructs no ICU collator, and keeps the same entries as the localeCompare order', () => {
    // MAX_LIVE_AGENT_STATUSES — the cap a busy session actually reaches. Real pane keys are
    // `<uuid tab id>:<uuid leaf id>`, so model them as unordered hex rather than a sorted
    // `tab-<n>` run that would let TimSort skip most comparisons.
    let seed = 0x2f6e2b1
    const nextHex = (): string => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed.toString(16).padStart(8, '0')
    }
    const paneKeys = Array.from({ length: 500 }, () => `${nextHex()}-${nextHex()}:${nextHex()}`)
    const map: AppState['agentStatusByPaneKey'] = {}
    for (const [index, paneKey] of paneKeys.entries()) {
      map[paneKey] = makeAgentStatusEntry({ paneKey, prompt: `prompt ${index}` })
    }
    // One ping replaces one entry and re-spreads the map, so the sort runs in full again.
    const pinged = { ...map, [paneKeys[0]]: makeAgentStatusEntry({ paneKey: paneKeys[0] }) }

    const localeCompareSpy = vi.spyOn(String.prototype, 'localeCompare')
    let projection = ''
    let beforeCalls = 0
    let afterCalls = 0
    try {
      referenceAgentStatusProjection(map)
      beforeCalls = localeCompareSpy.mock.calls.length
      localeCompareSpy.mockClear()
      resetRuntimeMobileAgentStatusProjectionCacheForTests()
      projection = buildRuntimeMobileAgentStatusProjectionForTests(map)
      buildRuntimeMobileAgentStatusProjectionForTests(pinged)
      afterCalls = localeCompareSpy.mock.calls.length
    } finally {
      // `mockRestore` clears the recorded calls, so read the counts first.
      localeCompareSpy.mockRestore()
    }
    // Before: thousands of ICU collator comparisons for a single ping.
    expect(beforeCalls).toBeGreaterThan(3000)
    expect(afterCalls).toBe(0)

    // The projection is identical up to ordering, and ordering is only ever `===`-compared.
    expect(sortedProjectionEntries(projection)).toEqual(
      sortedProjectionEntries(referenceAgentStatusProjection(map))
    )
  })

  it('is deterministic for keys where locale and code-unit order disagree', () => {
    const map: AppState['agentStatusByPaneKey'] = {}
    for (const paneKey of ['b:leaf', 'A:leaf', 'a:leaf', 'á:leaf', 'B:leaf']) {
      map[paneKey] = makeAgentStatusEntry({ paneKey })
    }
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    const first = buildRuntimeMobileAgentStatusProjectionForTests(map)
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    const second = buildRuntimeMobileAgentStatusProjectionForTests({ ...map })
    expect(second).toBe(first)
    expect(sortedProjectionEntries(first)).toEqual(
      sortedProjectionEntries(referenceAgentStatusProjection(map))
    )
  })
})

describe('open-files and browser projections', () => {
  it('re-serializes only the changed entry per store write', () => {
    const files = Array.from({ length: 20 }, (_value, index) => makeOpenFile(index))
    const writes = 50
    const driveWrites = (project: (openFiles: AppState['openFiles']) => string): void => {
      let openFiles = files as unknown as AppState['openFiles']
      project(openFiles)
      for (let write = 0; write < writes; write += 1) {
        const next = [...openFiles]
        next[0] = makeOpenFile(0, { isDirty: write % 2 === 0 })
        openFiles = next as unknown as AppState['openFiles']
        project(openFiles)
      }
    }

    const before = countSerializedChars(() => {
      driveWrites(referenceOpenFilesProjection)
    })
    resetRuntimeMobileSyncProjectionCachesForTests()
    const after = countSerializedChars(() => {
      driveWrites(buildRuntimeMobileOpenFilesProjection)
    })
    // Only the flipped file re-serializes; the other 19 are reused by identity.
    expect(before / after).toBeGreaterThan(14)
  })

  it('re-serializes only the changed browser bucket per store write', () => {
    const workspaces = Array.from({ length: 8 }, (_value, index) => makeBrowserWorkspace(index))
    const pagesByWorkspace: Record<string, never[]> = {}
    for (let index = 0; index < 8; index += 1) {
      pagesByWorkspace[`ws-${index}`] = [makeBrowserPage(index)] as never[]
    }
    const initial = makeState({
      browserTabsByWorktree: { 'wt-1': workspaces, 'wt-2': workspaces } as never,
      browserPagesByWorkspace: pagesByWorkspace as never
    })
    const writes = 50
    const driveWrites = (project: (state: AppState) => string): void => {
      let state = initial
      project(state)
      for (let write = 0; write < writes; write += 1) {
        const nextWorkspaces = [...(state.browserTabsByWorktree['wt-1'] ?? [])]
        nextWorkspaces[0] = makeBrowserWorkspace(0, { title: `tab 0 (${write})` })
        state = makeState({
          ...state,
          browserTabsByWorktree: {
            ...state.browserTabsByWorktree,
            'wt-1': nextWorkspaces
          } as never
        })
        project(state)
      }
    }

    const before = countSerializedChars(() => {
      driveWrites(referenceBrowserProjection)
    })
    resetRuntimeMobileSyncProjectionCachesForTests()
    const after = countSerializedChars(() => {
      driveWrites(buildRuntimeMobileBrowserProjection)
    })
    // Only the 'wt-1' bucket re-serializes; 'wt-2' and every page bucket are reused.
    expect(before / after).toBeGreaterThan(2.5)
  })

  it('matches the uncached projections byte for byte across shapes', () => {
    const openFileCases: AppState['openFiles'][] = [
      [] as unknown as AppState['openFiles'],
      [makeOpenFile(0)] as unknown as AppState['openFiles'],
      [makeOpenFile(0, { isDirty: true })] as unknown as AppState['openFiles'],
      [
        makeOpenFile(0, { isDirty: true, diffSource: 'working' }),
        makeOpenFile(1, { mode: 'diff', markdownPreviewSourceFileId: 'file-0' }),
        makeOpenFile(2, { isUntitled: true, deleteUntouchedOnClose: true, language: undefined })
      ] as unknown as AppState['openFiles']
    ]
    for (const [index, openFiles] of openFileCases.entries()) {
      expect({ index, projection: buildRuntimeMobileOpenFilesProjection(openFiles) }).toEqual({
        index,
        projection: referenceOpenFilesProjection(openFiles)
      })
    }

    const browserCases: AppState[] = [
      makeState({}),
      makeState({ browserTabsByWorktree: { 'wt-1': [makeBrowserWorkspace(0)] } as never }),
      makeState({
        browserTabsByWorktree: {
          'wt-1': [makeBrowserWorkspace(0, { title: undefined, loading: true })],
          '3': [makeBrowserWorkspace(1)]
        } as never,
        browserPagesByWorkspace: {
          'ws-0': [makeBrowserPage(0), makeBrowserPage(1, { canGoBack: true })],
          'ws-1': []
        } as never
      }),
      makeState({
        browserTabsByWorktree: {} as never,
        browserPagesByWorkspace: { 'ws-9': [makeBrowserPage(9, { url: 'a"b\\c' })] } as never
      })
    ]
    for (const [index, state] of browserCases.entries()) {
      expect({ index, projection: buildRuntimeMobileBrowserProjection(state) }).toEqual({
        index,
        projection: referenceBrowserProjection(state)
      })
    }
  })
})

describe('sync key transitions', () => {
  it('fires on exactly the transitions the uncached projections would have fired on', () => {
    const drafts = { 'file-0': 'aaa', 'file-1': 'bbb' }
    const files = [
      makeOpenFile(0, { language: 'markdown' }),
      makeOpenFile(1, { language: 'markdown' })
    ]
    const workspaces = [makeBrowserWorkspace(0)] as never
    const status = {
      'tab-0:leaf-0': makeAgentStatusEntry({ paneKey: 'tab-0:leaf-0' })
    } as AppState['agentStatusByPaneKey']

    const base = makeState({
      editorDrafts: drafts,
      openFiles: files,
      browserTabsByWorktree: { 'wt-1': workspaces } as never,
      browserPagesByWorkspace: { 'ws-0': [makeBrowserPage(0)] } as never,
      agentStatusByPaneKey: status
    })

    // Each step returns the next state; the flag is whether a mobile-visible input really moved.
    const steps: { name: string; next: (from: AppState) => AppState }[] = [
      { name: 'no-op re-spread', next: (from) => makeState({ ...from }) },
      {
        name: 'keystroke in one draft',
        next: (from) =>
          makeState({ ...from, editorDrafts: { ...from.editorDrafts, 'file-0': 'aaab' } })
      },
      {
        name: 'draft reverted to the same text',
        next: (from) =>
          makeState({ ...from, editorDrafts: { ...from.editorDrafts, 'file-0': 'aaab' } })
      },
      {
        name: 'draft removed',
        next: (from) => makeState({ ...from, editorDrafts: { 'file-1': 'bbb' } })
      },
      {
        name: 'isDirty flip',
        next: (from) =>
          makeState({
            ...from,
            openFiles: [makeOpenFile(0, { language: 'markdown', isDirty: true }), from.openFiles[1]]
          })
      },
      {
        name: 'open-files re-spread with identical content',
        next: (from) => makeState({ ...from, openFiles: [...from.openFiles] as never })
      },
      {
        name: 'browser title tick',
        next: (from) =>
          makeState({
            ...from,
            browserTabsByWorktree: {
              'wt-1': [makeBrowserWorkspace(0, { title: 'new title' })]
            } as never
          })
      },
      {
        name: 'browser page loading flip',
        next: (from) =>
          makeState({
            ...from,
            browserPagesByWorkspace: {
              'ws-0': [makeBrowserPage(0, { loading: true })]
            } as never
          })
      },
      {
        name: 'agent-status ping with an unchanged payload',
        next: (from) =>
          makeState({
            ...from,
            agentStatusByPaneKey: {
              'tab-0:leaf-0': makeAgentStatusEntry({ paneKey: 'tab-0:leaf-0' })
            } as never
          })
      },
      {
        name: 'agent-status prompt change',
        next: (from) =>
          makeState({
            ...from,
            agentStatusByPaneKey: {
              'tab-0:leaf-0': makeAgentStatusEntry({ paneKey: 'tab-0:leaf-0', prompt: 'new' })
            } as never
          })
      },
      {
        name: 'second agent added',
        next: (from) =>
          makeState({
            ...from,
            agentStatusByPaneKey: {
              ...from.agentStatusByPaneKey,
              'tab-1:leaf-0': makeAgentStatusEntry({ paneKey: 'tab-1:leaf-0' })
            } as never
          })
      }
    ]

    const referenceTuple = (state: AppState): string[] => [
      referenceEditorDraftsProjection(state.editorDrafts),
      referenceOpenFilesProjection(state.openFiles),
      referenceBrowserProjection(state),
      referenceAgentStatusProjection(state.agentStatusByPaneKey ?? {})
    ]

    resetRuntimeMobileSyncProjectionCachesForTests()
    resetRuntimeMobileAgentStatusProjectionCacheForTests()
    let previousState = base
    let previousKey = getRuntimeMobileSessionSyncKey(base, undefined, undefined, false)
    let previousReference = referenceTuple(base)

    for (const step of steps) {
      const state = step.next(previousState)
      const key = getRuntimeMobileSessionSyncKey(state, previousState, previousKey, false)
      const reference = referenceTuple(state)
      const referenceChanged = reference.some((part, index) => part !== previousReference[index])
      const keyChanged = !runtimeMobileSessionSyncKeysEqual(key, previousKey)
      expect({ step: step.name, changed: keyChanged }).toEqual({
        step: step.name,
        changed: referenceChanged
      })
      previousState = state
      previousKey = key
      previousReference = reference
    }
  })
})
