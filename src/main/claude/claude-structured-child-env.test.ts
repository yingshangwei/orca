import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { claudeChildEnv, resolveClaudeChildEnvSources } from './claude-structured-child-env'
import { resolveStructuredAgentCommand } from '../native-chat/structured-agent-command-resolution'

afterEach(() => vi.unstubAllEnvs())

it('refuses removal of an inherited proxy while preparing the child environment', () => {
  expect(() =>
    claudeChildEnv(
      {
        command: '/synthetic/claude',
        overlay: undefined,
        inheritedEnv: { HOME: '/synthetic', HTTPS_PROXY: 'http://127.0.0.1:6155' }
      },
      (env) => {
        delete env.HTTPS_PROXY
        return env
      }
    )
  ).toThrow('Blocked environment key: HTTPS_PROXY')
})

it('resolves the local Claude installation against the login shell PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-shell-only-cli-'))
  try {
    const binary = join(root, process.platform === 'win32' ? 'claude.cmd' : 'claude')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    vi.stubEnv('PATH', '')
    const settings = {}
    const inherited = vi.fn(async () => ({ PATH: root, HOME: root }))
    const sources = await resolveClaudeChildEnvSources({
      resolveCommand: (options) => resolveStructuredAgentCommand('claude', settings, options),
      resolveEnv: async () => ({}),
      resolveInheritedEnv: inherited
    })
    expect(sources.command).toBe(binary)
    expect(sources.inheritedEnv.PATH).toBe(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('rejects a saved custom Claude launcher before resolving it', async () => {
  await expect(
    resolveClaudeChildEnvSources({
      resolveCommand: (options) =>
        resolveStructuredAgentCommand(
          'claude',
          {
            agentCmdOverrides: { claude: 'custom-claude' }
          },
          options
        ),
      resolveInheritedEnv: async () => ({ PATH: '/synthetic', HOME: '/synthetic' })
    })
  ).rejects.toThrow('cannot override the connection')
})

it.each([
  'HTTPS_PROXY',
  'https_proxy',
  'NO_PROXY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CONFIG_DIR'
])('rejects an Orca %s override before resolving or spawning a CLI', async (key) => {
  const resolveCommand = vi.fn(() => '/synthetic/claude')
  await expect(
    resolveClaudeChildEnvSources({
      resolveCommand,
      resolveEnv: () => ({ [key]: 'synthetic-override' }),
      resolveInheritedEnv: async () => ({ HOME: '/synthetic' })
    })
  ).rejects.toThrow(`Blocked environment key: ${key}`)
  expect(resolveCommand).not.toHaveBeenCalled()
})
