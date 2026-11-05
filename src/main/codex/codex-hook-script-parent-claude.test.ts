import { afterEach, describe, expect, it, vi } from 'vitest'
import { getManagedScript } from './codex-hook-script'

describe('codex hook script parent Claude stamp', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the parent Claude session from POSIX hosts', () => {
    const script = getManagedScript('posix')
    expect(script).toContain('orca_parent_claude_session="${CLAUDE_CODE_SESSION_ID:-}"')
    expect(script).toContain('-H "X-Orca-Parent-Claude-Session: ${orca_parent_claude_session:-}"')
    expect(script).toContain(
      '--data-urlencode "parentClaudeSession=${orca_parent_claude_session:-}"'
    )
  })

  it('posts the parent Claude session from native Windows hosts', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const script = getManagedScript('local')
      expect(script).toContain('set "ORCA_PARENT_CLAUDE_SESSION="')
      expect(script).toContain(
        'if defined CLAUDE_CODE_SESSION_ID set "ORCA_PARENT_CLAUDE_SESSION=%CLAUDE_CODE_SESSION_ID%"'
      )
      expect(script).toContain(
        '--data-urlencode "parentClaudeSession=%ORCA_PARENT_CLAUDE_SESSION%"'
      )
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  })
})
