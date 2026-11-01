import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  hasUnknownStructuredChat,
  type StructuredChatSleptAtByPaneKey
} from './structured-chat-slept-at'

function chatTab(entityId = 'session-1'): Tab {
  return {
    id: 'chat-1',
    entityId,
    worktreeId: 'folder:workspace-1',
    groupId: 'group-1',
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

describe('structured chat presence snapshots', () => {
  it('observes sleep, explicit wake, and unknown across independent sleep snapshots', () => {
    const tab = chatTab()
    const tabs = Object.freeze([tab])
    const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
    const slept: StructuredChatSleptAtByPaneKey = Object.freeze({ [paneKey]: 1 })
    const awake: StructuredChatSleptAtByPaneKey = Object.freeze({ [paneKey]: null })
    const unknown: StructuredChatSleptAtByPaneKey = Object.freeze({})

    for (const snapshot of [slept, awake, unknown, slept, unknown]) {
      expect(hasUnknownStructuredChat(tabs, snapshot)).toBe(snapshot === unknown)
    }
  })

  it('rechecks replaced tab buckets, including a new session under the same tab id', () => {
    const tab = chatTab()
    const tabs = Object.freeze([tab])
    const slept = Object.freeze({ [structuredAgentSessionPaneKey(tab.id, tab.entityId)]: 1 })
    expect(hasUnknownStructuredChat(tabs, slept)).toBe(false)

    const replaced = Object.freeze([chatTab('session-2')])
    expect(hasUnknownStructuredChat(replaced, slept)).toBe(true)
    const closed = Object.freeze([{ ...tab, contentType: 'terminal' as const }])
    expect(hasUnknownStructuredChat(closed, slept)).toBe(false)
  })

  it('keeps absent sleep state unknown and treats missing tab buckets as empty', () => {
    const tabs = Object.freeze([chatTab()])
    expect(hasUnknownStructuredChat(tabs)).toBe(true)
    expect(hasUnknownStructuredChat(undefined)).toBe(false)
    expect(hasUnknownStructuredChat([])).toBe(false)
  })
  it('does not reread chat identities for an unchanged tab and sleep snapshot', () => {
    let reads = 0
    const tab = chatTab()
    Object.defineProperty(tab, 'entityId', {
      get: () => {
        reads += 1
        return 'session-1'
      }
    })
    const tabs = Object.freeze([tab])
    const snapshot = Object.freeze({})
    expect(hasUnknownStructuredChat(tabs, snapshot)).toBe(true)
    const firstReads = reads
    expect(firstReads).toBeGreaterThan(0)
    for (let index = 0; index < 100; index += 1) {
      expect(hasUnknownStructuredChat(tabs, snapshot)).toBe(true)
    }
    expect(reads).toBe(firstReads)
    const slept = Object.freeze({ [structuredAgentSessionPaneKey('chat-1', 'session-1')]: 1 })
    expect(hasUnknownStructuredChat(tabs, slept)).toBe(false)
    expect(reads).toBeGreaterThan(firstReads)
  })
})
