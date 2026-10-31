import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertLocalClaudeConfiguration } from './claude-local-configuration'
import { assertLocalClaudeLaunch } from './claude-local-launch-policy'
import { claudeStructuredSpawnOptions } from './claude-structured-spawn-options'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-claude-local-policy-'))
  roots.push(root)
  const configDir = join(root, '.claude')
  const cwd = join(root, 'project', 'nested')
  await mkdir(configDir)
  await mkdir(cwd, { recursive: true })
  const settings = {
    model: 'local-default',
    effortLevel: 'high',
    env: {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
      ANTHROPIC_AUTH_TOKEN: 'synthetic-local-token',
      HTTPS_PROXY: 'http://127.0.0.1:6155',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    }
  }
  const path = join(configDir, 'settings.json')
  await writeFile(path, JSON.stringify(settings))
  return { root, configDir, cwd, settings, path, env: { HOME: root } }
}

describe('local Claude connection policy', () => {
  it('accepts model and effort choices without writing local connection settings', async () => {
    const f = await fixture()
    const before = await readFile(f.path, 'utf8')
    const selected = claudeStructuredSpawnOptions({
      launch: { options: {}, resumesTranscript: false },
      saved: { model: 'opus', effort: 'max' }
    })
    expect(selected.sdkOptions).toMatchObject({ model: 'opus', effort: 'max' })
    await expect(
      assertLocalClaudeLaunch({
        pathToClaudeCodeExecutable: '/synthetic/claude',
        env: f.env,
        cwd: f.cwd,
        options: selected.sdkOptions
      })
    ).resolves.toBeUndefined()
    expect(await readFile(f.path, 'utf8')).toBe(before)
  })

  it.each([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'HTTPS_PROXY',
    'NO_PROXY',
    'CLAUDE_CONFIG_DIR'
  ])('refuses project %s overrides in an ancestor before launch', async (key) => {
    const f = await fixture()
    const projectConfig = join(f.root, 'project', '.claude')
    await mkdir(projectConfig)
    await writeFile(
      join(projectConfig, 'settings.local.json'),
      JSON.stringify({
        env: { [key]: 'synthetic-conflict-value' }
      })
    )
    await expect(assertLocalClaudeConfiguration(f)).rejects.toThrow(`Conflicting ${key}`)
    await expect(assertLocalClaudeConfiguration(f)).rejects.not.toThrow('synthetic-conflict-value')
  })

  it('refuses missing gateway configuration instead of falling back to Anthropic', async () => {
    const f = await fixture()
    await writeFile(f.path, JSON.stringify({ model: 'opus' }))
    await expect(assertLocalClaudeConfiguration(f)).rejects.toThrow('local ANTHROPIC_BASE_URL')
  })

  it('refuses a remote endpoint and an inherited cloud provider switch', async () => {
    const f = await fixture()
    await expect(
      assertLocalClaudeConfiguration({
        ...f,
        env: { ...f.env, CLAUDE_CODE_USE_BEDROCK: '1' }
      })
    ).rejects.toThrow('Blocked provider switch')
    f.settings.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    await writeFile(f.path, JSON.stringify(f.settings))
    await expect(assertLocalClaudeConfiguration(f)).rejects.toThrow('local ANTHROPIC_BASE_URL')
  })

  it('refuses an Orca account directory and an inline network override', async () => {
    const f = await fixture()
    await expect(
      assertLocalClaudeConfiguration({ ...f, configDir: join(f.root, 'account') })
    ).rejects.toThrow('Alternate Claude configuration directory')
    await expect(
      assertLocalClaudeLaunch({
        pathToClaudeCodeExecutable: '/synthetic/claude',
        env: f.env,
        cwd: f.cwd,
        options: { extraArgs: { settings: '{"env":{"HTTPS_PROXY":""}}' } }
      })
    ).rejects.toThrow('Blocked argument: --settings')
  })
})
