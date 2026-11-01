import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { useMobileNativeChatDrafts } from './use-mobile-native-chat-drafts'
import {
  resetMobileNativeChatDraftStoreForTests,
  useMobileNativeChatDraft
} from './mobile-native-chat-draft-store'

type DraftState = ReturnType<typeof useMobileNativeChatDrafts> & { composerText: string }

describe('mobile native-chat draft store', () => {
  let renderer: ReactTestRenderer | null = null
  let state: DraftState | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    resetMobileNativeChatDraftStoreForTests()
    renderer = null
    state = null
  })

  function Harness({ tabId }: { tabId: string }): null {
    const drafts = useMobileNativeChatDrafts({
      hostId: 'host',
      worktreeId: 'worktree',
      tabId,
      sessionId: `session-${tabId}`,
      messages: [],
      transcriptSettled: true
    })
    state = { ...drafts, composerText: useMobileNativeChatDraft(drafts.draftKey) }
    return null
  }

  async function mount(tabId: string): Promise<void> {
    await act(async () => {
      renderer = create(createElement(Harness, { tabId }))
    })
  }

  it('clears the composer at send time, before the RPC settles', async () => {
    await mount('a')
    act(() => state?.setComposerText('ping'))
    const origin = state?.captureSendOrigin('ping')
    act(() => {
      if (origin) {
        state?.clearDraftForSend(origin, 'ping')
      }
    })
    expect(state?.composerText).toBe('')
  })

  it('keeps a typed draft after the chat screen unmounts and remounts', async () => {
    await mount('a')
    act(() => state?.setComposerText('half-written prompt'))
    act(() => renderer?.unmount())

    await mount('a')
    expect(state?.composerText).toBe('half-written prompt')
  })

  it('keeps each tab its own draft across a remount', async () => {
    await mount('a')
    act(() => state?.setComposerText('for a'))
    act(() => renderer?.unmount())

    await mount('b')
    expect(state?.composerText).toBe('')
    act(() => state?.setComposerText('for b'))
    act(() => renderer?.unmount())

    await mount('a')
    expect(state?.composerText).toBe('for a')
  })

  it('lets an old send clear its unchanged scope after another tab was edited', async () => {
    await mount('a')
    act(() => state?.setComposerText('for a'))
    const origin = state?.captureSendOrigin('for a')
    const oldClear = state?.clearDraftForSend
    act(() => renderer?.unmount())
    await mount('b')
    act(() => state?.setComposerText('for b'))
    act(() => {
      if (origin) {
        oldClear?.(origin, 'for a')
      }
    })
    expect(state?.composerText).toBe('for b')
    act(() => renderer?.unmount())
    await mount('a')
    expect(state?.composerText).toBe('')
  })
  it('redraws only the draft subscriber per keystroke, not the screen that owns the drafts', async () => {
    let screenRenders = 0
    let shown = ''
    let owner: ReturnType<typeof useMobileNativeChatDrafts> | null = null
    function Composer({ draftKey }: { draftKey: string | null }): null {
      shown = useMobileNativeChatDraft(draftKey)
      return null
    }
    const messages: NativeChatMessage[] = []
    function Screen(): ReturnType<typeof createElement> {
      screenRenders += 1
      owner = useMobileNativeChatDrafts({
        hostId: 'host',
        worktreeId: 'worktree',
        tabId: 'a',
        sessionId: 'session-a',
        messages,
        transcriptSettled: true
      })
      return createElement(Composer, { draftKey: owner.draftKey })
    }
    await act(async () => {
      renderer = create(createElement(Screen))
    })
    const rendersBeforeTyping = screenRenders

    act(() => owner?.setComposerText('typed'))

    expect(shown).toBe('typed')
    expect(screenRenders).toBe(rendersBeforeTyping)
  })
})
