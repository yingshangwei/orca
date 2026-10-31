import { beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

// Refused team launches must never reach a child process.
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('../runtime-client', () => ({
  RuntimeClientError: class RuntimeClientError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  },
  serveOrcaApp: vi.fn()
}))

import { CORE_HANDLERS } from './core'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { CLAUDE_NATIVE_PANE_TEAMS_MESSAGE } from '../../shared/claude-local-policy'

describe('orca claude-teams CLI handler', () => {
  const callMock = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a rejected handler must not access any client member, including call.
  const client = { call: callMock } as unknown as RuntimeClient

  beforeEach(() => {
    spawnMock.mockReset()
    callMock.mockReset()
  })

  it.each<[string, string[]]>([
    ['a bare launch', []],
    ['connection settings', ['--settings', '/tmp/alternate-settings.json']],
    ['a resumed session', ['--resume', 'session-1', '--model', 'sonnet']],
    ['an in-process request through the native-pane wrapper', ['--teammate-mode', 'in-process']]
  ])('rejects %s before RPC or spawn', async (_case, rawArgs) => {
    const ctx: HandlerContext = {
      flags: new Map(),
      client,
      cwd: '/tmp/repo',
      json: false,
      rawArgs
    }

    await expect(CORE_HANDLERS['claude-teams'](ctx)).rejects.toMatchObject({
      code: 'claude_local_configuration_required',
      message: CLAUDE_NATIVE_PANE_TEAMS_MESSAGE
    })
    expect(callMock).not.toHaveBeenCalled()
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
