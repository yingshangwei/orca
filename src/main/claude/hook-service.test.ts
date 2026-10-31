// Why: locks in the remote-install contract so a refactor cannot silently
// drift the produced settings.json shape, the wrapper-quoted command path,
// or the script body that lands on the remote box. Local install behavior
// is exercised through `installer-utils.test.ts` and the per-CLI status
// audit; this file covers ONLY the SFTP-backed path added in commit #8.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, describe, expect, it } from 'vitest'
import type * as GitBashModule from '../git-bash'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/userData'
  }
}))

// Mock discovery so registration can be checked with Git Bash both present and absent.
const { gitBashAvailableMock } = vi.hoisted(() => ({ gitBashAvailableMock: { value: true } }))
vi.mock('../git-bash', async (importOriginal) => ({
  ...(await importOriginal<typeof GitBashModule>()),
  isGitBashAvailable: () => gitBashAvailableMock.value
}))

import type { SFTPWrapper } from 'ssh2'
import { createManagedCommandMatcher } from '../agent-hooks/installer-utils'
import { ClaudeHookService } from './hook-service'
import { getWindowsManagedLifecycleHook, OPENCLAUDE_HOOK_SETTINGS } from './hook-settings'

const CLAUDE_SCRIPT_FILE_NAME = process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
const isClaudeManagedCommand = createManagedCommandMatcher(CLAUDE_SCRIPT_FILE_NAME)
const OPENCLAUDE_SCRIPT_FILE_NAME =
  process.platform === 'win32' ? 'openclaude-hook.cmd' : 'openclaude-hook.sh'
const isOpenClaudeManagedCommand = createManagedCommandMatcher(OPENCLAUDE_SCRIPT_FILE_NAME)

describe('getWindowsManagedLifecycleHook', () => {
  const SAFE_SCRIPT_PATH = 'C:\\Users\\alice\\.orca\\agent-hooks\\claude-hook.cmd'
  const UNSAFE_SCRIPT_PATH = 'C:\\Users\\%name%\\a^b&c\\.orca\\agent-hooks\\claude-hook.cmd'

  it('registers the script itself, with no interpreter in front of it (#18875)', () => {
    // Why this is the whole point: the encoded launcher spent a PowerShell start-up per hook
    // event (471ms vs 201ms measured) before the .cmd could reach its ORCA_PANE_KEY guard, and
    // its orphan outlived the hook's timeout kill still holding the stdout the agent reads.
    const hook = getWindowsManagedLifecycleHook(SAFE_SCRIPT_PATH)

    expect(hook.args).toBeUndefined()
    expect(hook.command).toBe('C:/Users/alice/.orca/agent-hooks/claude-hook.cmd')
    expect(hook.command).not.toMatch(/powershell|-EncodedCommand|conhost/i)
    // Why: Git Bash/MSYS mangles backslash paths and rewrites slash-prefixed switches.
    expect(hook.command).not.toMatch(/\\/)
    expect(hook.command).not.toMatch(/ \/[a-zA-Z]+( |$)/)
  })

  it('falls back to the encoded launcher when the profile path is not cmd-safe', () => {
    const hook = getWindowsManagedLifecycleHook(UNSAFE_SCRIPT_PATH)

    expect(hook.args).toBeUndefined()
    expect(hook.command).toMatch(/\/powershell\.exe -NoProfile -EncodedCommand /)
    expect(hook.command).not.toContain(UNSAFE_SCRIPT_PATH)
    expect(hook.command.replace(/-EncodedCommand \S+$/, '')).not.toMatch(/\\| \/[a-zA-Z]+( |$)/)

    const encoded = hook.command.match(/-EncodedCommand (\S+)$/)?.[1]
    const decoded = Buffer.from(encoded ?? '', 'base64').toString('utf16le')
    expect(decoded).toContain('$env:USERPROFILE')
    expect(decoded).toContain('.orca\\agent-hooks\\claude-hook.cmd')
  })

  it('does not consult Git Bash availability', () => {
    gitBashAvailableMock.value = false
    try {
      expect(getWindowsManagedLifecycleHook(SAFE_SCRIPT_PATH).command).toBe(
        'C:/Users/alice/.orca/agent-hooks/claude-hook.cmd'
      )
    } finally {
      gitBashAvailableMock.value = true
    }
  })

  it('is still recognized as managed by createManagedCommandMatcher (#14825)', () => {
    for (const hook of [
      getWindowsManagedLifecycleHook(SAFE_SCRIPT_PATH),
      getWindowsManagedLifecycleHook(UNSAFE_SCRIPT_PATH)
    ]) {
      expect(isClaudeManagedCommand(hook.command)).toBe(true)
    }
  })
})

type FakeFs = {
  files: Map<string, string>
  dirs: Set<string>
  modes: Map<string, number>
}

function createFakeSftp(): { sftp: SFTPWrapper; fs: FakeFs } {
  const fs: FakeFs = {
    files: new Map(),
    dirs: new Set(['/']),
    modes: new Map()
  }
  const noEntryError = (path: string): { code: number; message: string } => ({
    code: 2,
    message: `ENOENT ${path}`
  })
  const fakeStats = (mode: number): { mode: number } => ({ mode })
  const sftp = {
    readFile: (path: string, _enc: string, cb: (err: unknown, data?: string) => void): void => {
      const v = fs.files.get(path)
      if (v === undefined) {
        cb(noEntryError(path))
        return
      }
      cb(null, v)
    },
    writeFile: (
      path: string,
      content: string,
      options: string | { mode?: number },
      cb: (err: unknown) => void
    ): void => {
      fs.files.set(path, content)
      if (typeof options !== 'string' && options.mode !== undefined) {
        fs.modes.set(path, options.mode)
      }
      cb(null)
    },
    rename: (src: string, dst: string, cb: (err: unknown) => void): void => {
      const v = fs.files.get(src)
      if (v === undefined) {
        cb(noEntryError(src))
        return
      }
      fs.files.set(dst, v)
      fs.files.delete(src)
      const mode = fs.modes.get(src)
      if (mode !== undefined) {
        fs.modes.set(dst, mode)
        fs.modes.delete(src)
      }
      cb(null)
    },
    unlink: (path: string, cb: (err: unknown) => void): void => {
      fs.files.delete(path)
      fs.modes.delete(path)
      cb(null)
    },
    chmod: (path: string, mode: number, cb: (err: unknown) => void): void => {
      fs.modes.set(path, mode)
      cb(null)
    },
    stat: (path: string, cb: (err: unknown, stats?: { mode: number }) => void): void => {
      if (!fs.files.has(path)) {
        cb(noEntryError(path))
        return
      }
      cb(null, fakeStats(fs.modes.get(path) ?? 0o100644))
    },
    readdir: (path: string, cb: (err: unknown, list?: { filename: string }[]) => void): void => {
      if (fs.dirs.has(path)) {
        cb(null, [])
        return
      }
      cb(noEntryError(path))
    },
    mkdir: (path: string, cb: (err: unknown) => void): void => {
      fs.dirs.add(path)
      cb(null)
    }
  } as unknown as SFTPWrapper
  return { sftp, fs }
}

describe('Claude configuration is externally managed', () => {
  it('never writes local settings or replaces user hooks and statusline', async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-claude-hook-policy-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const configDir = join(tmpHome, '.claude')
      mkdirSync(configDir)
      const path = join(configDir, 'settings.json')
      const before = JSON.stringify({
        env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425', HTTPS_PROXY: 'http://127.0.0.1:6155' },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'user-owned-hook' }] }] },
        statusLine: { type: 'command', command: 'user-owned-statusline' }
      })
      writeFileSync(path, before)
      const service = new ClaudeHookService()
      expect(service.install()).toMatchObject({ state: 'skipped', skipReason: 'hooks_disabled' })
      expect(service.remove()).toMatchObject({ state: 'skipped', skipReason: 'hooks_disabled' })
      await service.refreshManagedScripts()
      expect(readFileSync(path, 'utf8')).toBe(before)
      expect(existsSync(join(tmpHome, '.orca'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('does not read or write a remote Claude configuration', async () => {
    const { sftp, fs } = createFakeSftp()
    const read = vi.spyOn(sftp, 'readFile')
    const write = vi.spyOn(sftp, 'writeFile')
    expect(await new ClaudeHookService().installRemote(sftp, '/home/dev')).toMatchObject({
      state: 'skipped',
      skipReason: 'hooks_disabled'
    })
    expect(read).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
    expect(fs.files.size).toBe(0)
  })
})

describe('OpenClaudeHookService-compatible install', () => {
  const makeOpenClaudeService = (): ClaudeHookService =>
    new ClaudeHookService({
      agent: 'openclaude',
      displayName: 'OpenClaude',
      settings: OPENCLAUDE_HOOK_SETTINGS
    })

  it('installs managed hooks into OpenClaude settings without touching Claude settings', () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'orca-openclaude-hooks-'))
    vi.stubEnv('HOME', tmpHome)
    vi.stubEnv('USERPROFILE', tmpHome)
    try {
      const openClaudeSettings = join(tmpHome, '.openclaude', 'settings.json')
      mkdirSync(join(tmpHome, '.openclaude'), { recursive: true })
      writeFileSync(openClaudeSettings, JSON.stringify({ hooks: {} }))

      const status = makeOpenClaudeService().install()

      expect(status).toMatchObject({
        agent: 'openclaude',
        state: 'installed',
        configPath: openClaudeSettings
      })
      const parsed = JSON.parse(readFileSync(openClaudeSettings, 'utf-8'))
      for (const event of ['UserPromptSubmit', 'Stop', 'StopFailure']) {
        const command = parsed.hooks[event][0].hooks[0].command as string
        expect(isOpenClaudeManagedCommand(command)).toBe(true)
        expect(command).toContain('"${HOME-}/.orca/agent-hooks/openclaude-hook.cmd"')
        expect(command).toContain('"${HOME-}/.orca/agent-hooks/openclaude-hook.sh"')
        expect(command).not.toContain(tmpHome.replaceAll('\\', '/'))
      }
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).toContain('/hook/claude')
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).not.toContain('DEVIN_PROJECT_DIR')
      expect(
        readFileSync(join(tmpHome, '.orca', 'agent-hooks', OPENCLAUDE_SCRIPT_FILE_NAME), 'utf-8')
      ).not.toContain('GROK_HOOK_EVENT')
      // Why: the statusline usage feed is Claude-only; OpenClaude installs must not set statusLine.
      expect(parsed.statusLine).toBeUndefined()
      expect(existsSync(join(tmpHome, '.claude', 'settings.json'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it('writes remote OpenClaude settings under .openclaude', async () => {
    const { sftp, fs } = createFakeSftp()

    const status = await makeOpenClaudeService().installRemote(sftp, '/home/dev')

    expect(status).toMatchObject({
      agent: 'openclaude',
      state: 'installed',
      configPath: '/home/dev/.openclaude/settings.json'
    })
    const parsed = JSON.parse(fs.files.get('/home/dev/.openclaude/settings.json')!)
    const command = parsed.hooks.StopFailure[0].hooks[0].command as string
    expect(command).toContain('"${HOME-}/.orca/agent-hooks/openclaude-hook.sh"')
    expect(command).not.toContain('/home/dev/.orca/agent-hooks/openclaude-hook.sh')
    expect(fs.files.get('/home/dev/.orca/agent-hooks/openclaude-hook.sh')).toContain('/hook/claude')
  })
})
