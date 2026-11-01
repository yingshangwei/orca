// Mount the real composing hooks over native capture: refused starts and lost transcripts were in how the session hook and dictation hook meet, which isolated handler tests would miss.
import { createElement, useRef } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient, type FakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type * as NativeChatSendError from './use-mobile-native-chat-send-error'

const seen = vi.hoisted(() => ({
  toasts: new Array<string>(),
  errorHaptics: 0,
  setupSheetOpens: 0,
  micPermissionRequests: 0,
  clipboard: new Array<string>(),
  inputs: new Array<string>(),
  audioListeners: new Map<string, (event: { data: string }) => void>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('@orca/expo-two-way-audio', () => ({
  addExpoTwoWayAudioEventListener: (name: string, listener: (event: { data: string }) => void) => {
    seen.audioListeners.set(name, listener)
    return { remove: () => seen.audioListeners.delete(name) }
  },
  initialize: () => Promise.resolve(true),
  requestMicrophonePermissionsAsync: () => {
    seen.micPermissionRequests += 1
    return Promise.resolve({ granted: true })
  },
  tearDown: () => {},
  toggleRecording: () => true
}))
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: () => Promise.resolve(),
  deactivateKeepAwake: () => Promise.resolve()
}))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('../platform/haptics', () => ({
  triggerError: () => {
    seen.errorHaptics += 1
  }
}))
vi.mock('../platform/clipboard', () => {
  const writer = {
    writeText: async (text: string) => {
      seen.clipboard.push(text)
    }
  }
  return { useClipboardWriter: () => writer }
})

// Stub off-path native chat dependencies to keep Expo out of this mic test.
vi.mock('./use-mobile-native-chat-send-error', async (importOriginal) => ({
  ...(await importOriginal<typeof NativeChatSendError>()),
  useMobileNativeChatSendError: () => ({
    message: null,
    show: () => {},
    clear: () => {},
    keepWhile: () => {},
    bannerMountedRef: { current: false }
  })
}))
vi.mock('./use-mobile-native-chat-readability', () => ({
  useMobileNativeChatReadability: () => false
}))
vi.mock('./use-mobile-native-chat-input-lease', () => ({
  useMobileNativeChatInputLease: () => ({
    ready: true,
    readyRef: { current: true },
    lockReason: null,
    markReady: () => {},
    clear: () => {}
  })
}))
vi.mock('./use-mobile-native-chat-controller', () => ({
  useMobileNativeChatController: () => ({
    nativeChatSession: { messages: [] },
    toggleTabChatView: () => {},
    showNativeChat: false,
    showNativeChatRef: { current: false },
    setChatComposerText: () => {}
  })
}))
vi.mock('./use-mobile-send-completion-generation', () => ({
  useMobileSendCompletionGeneration: () => () => 0
}))

import { useMobileSessionNativeChatDictation } from './use-mobile-session-native-chat-dictation'

type Model = ReturnType<typeof useMobileSessionNativeChatDictation>
const renderers = new Set<ReturnType<typeof create>>()
afterEach(() => {
  act(() => {
    for (const renderer of renderers) {
      renderer.unmount()
    }
  })
  renderers.clear()
})

function mount(
  client: FakeRpcClient,
  options: { liveInput: boolean; sendLive: () => Promise<boolean> }
): { current: () => Model } {
  const held: { model: Model | null } = { model: null }

  function Probe(): null {
    const scope = {
      hostId: 'h1',
      worktreeId: 'w1',
      client,
      connState: 'connected',
      agentSessionHostSupport: { promptCancel: true, questionAnswers: false },
      setInput: (update: (current: string) => string) => {
        seen.inputs.push(update(''))
      },
      liveInputTerminalHandles: new Set<string>(options.liveInput ? ['t1'] : []),
      activeHandle: 't1',
      activeSessionTabId: 'tab1',
      activeSessionTab: { id: 'tab1', type: 'terminal', terminal: 't1' },
      diffComments: [],
      diffCommentsRef: useRef([]),
      setShowDictationSetup: (next: boolean) => {
        if (next) {
          seen.setupSheetOpens += 1
        }
      },
      setDictationMode: () => {},
      dictationEnabled: true,
      setDictationEnabled: () => {},
      deviceTokenRef: useRef('dev'),
      dictationRouteContextRef: useRef(null),
      activeHandleRef: useRef('t1'),
      flushPendingLiveInputBeforeExternalSend: async () => true,
      canSend: true,
      canCompose: true,
      liveInputEnabled: options.liveInput,
      showToast: (message: string) => {
        seen.toasts.push(message)
      },
      resetLiveInputFocus: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member this hook destructures; the rest of the session model is unreachable from the mic path.
    held.model = useMobileSessionNativeChatDictation(scope as never, options.sendLive)
    return null
  }

  act(() => {
    renderers.add(create(createElement(Probe)))
  })
  return {
    current: () => {
      if (!held.model) {
        throw new Error('Probe did not render')
      }
      return held.model
    }
  }
}

// Answer every request the hooks send, including chained ones, until none remain.
async function settle(
  rpc: FakeRpcClient,
  transcript: string,
  refuseStartWith?: string
): Promise<string[]> {
  const methods: string[] = []
  await act(async () => {
    for (let round = 0; round < 12; round += 1) {
      for (const request of rpc.requests.splice(0)) {
        methods.push(request.method)
        request.resolve(
          refuseStartWith !== undefined && request.method === 'speech.dictation.start'
            ? { id: 'desktop', ok: false, error: { code: 'refused', message: refuseStartWith } }
            : {
                id: 'desktop',
                ok: true,
                result: request.method === 'speech.dictation.finish' ? { text: transcript } : {}
              }
        )
      }
      await Promise.resolve()
      await Promise.resolve()
    }
  })
  return methods
}

async function startRecording(
  rpc: FakeRpcClient,
  options: { liveInput: boolean; sendLive?: () => Promise<boolean> }
): Promise<{ current: () => Model }> {
  const mounted = mount(rpc, {
    liveInput: options.liveInput,
    sendLive: options.sendLive ?? (async () => true)
  })
  act(() => mounted.current().handleDictationToggle())
  await settle(rpc, '')
  expect(mounted.current().dictation.isRecording).toBe(true)
  return mounted
}

beforeEach(() => {
  seen.toasts.length = 0
  seen.errorHaptics = 0
  seen.setupSheetOpens = 0
  seen.micPermissionRequests = 0
  seen.clipboard.length = 0
  seen.inputs.length = 0
  seen.audioListeners.clear()
})

describe('leaving the session while recording', () => {
  it('stops and inserts what was said instead of leaving, and lets the next leave go', async () => {
    const rpc = createFakeRpcClient()
    const mounted = await startRecording(rpc, { liveInput: false })
    const held: boolean[] = []
    act(() => {
      held.push(mounted.current().dictationLeaveHold.hold())
    })
    // Back is released while transcribing, so a swipe can leave too.
    expect(mounted.current().dictationLeaveHold.holdsLeave).toBe(false)
    act(() => {
      held.push(mounted.current().dictationLeaveHold.hold())
    })
    expect(held).toEqual([true, false])
    const methods = await settle(rpc, 'one more thing')
    expect(methods.filter((method) => method === 'speech.dictation.finish')).toHaveLength(1)
    expect(methods).not.toContain('speech.dictation.cancel')
    expect(seen.inputs).toEqual(['one more thing'])
    expect(seen.toasts).toEqual(['Dictation inserted'])
  })
})
