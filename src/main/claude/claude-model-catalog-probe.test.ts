import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClaudeModelCatalogProbe, runClaudeListing } from './claude-model-catalog-probe'
import { CLAUDE_MODEL_LIST_STDIN } from '../../shared/claude-model-list-probe'
import type { runAgentModelCatalogListing } from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
const listing = `${JSON.stringify({
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'orca-model-discovery',
    response: {
      models: [
        {
          value: 'sonnet',
          displayName: 'Sonnet',
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high']
        }
      ]
    }
  }
})}\n`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-local-claude-catalog-'))
  roots.push(root)
  const configDir = join(root, '.claude')
  mkdirSync(configDir)
  writeFileSync(
    join(configDir, 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
        HTTPS_PROXY: 'http://127.0.0.1:6155'
      }
    })
  )
  const env = { HOME: root, PATH: process.env.PATH ?? '', HTTPS_PROXY: 'http://127.0.0.1:6155' }
  const runListing = vi.fn<typeof runAgentModelCatalogListing>(async () => listing)
  const deps = {
    resolveCommand: () => process.execPath,
    resolveInheritedEnv: async () => env,
    resolveEnv: () => ({}),
    resolveAuthPolicy: () => ({ account: 'system' as const }),
    runListing
  }
  const accountHome = { variable: 'CLAUDE_CONFIG_DIR', path: configDir }
  return { deps, runListing, accountHome, root, env }
}

describe('Claude model discovery through the local CLI', () => {
  it('keeps selectable models and effort levels under the local user configuration', async () => {
    const f = fixture()
    const result = await createClaudeModelCatalogProbe(f.deps)(f.accountHome, { cwd: f.root })
    expect(result.models).toMatchObject([
      { id: 'sonnet', efforts: [{ value: 'low' }, { value: 'high' }] }
    ])
    expect(f.runListing).toHaveBeenCalledOnce()
    const [launch, options] = f.runListing.mock.calls[0]!
    expect(launch.command).toBe(process.execPath)
    expect(launch.args).toEqual(expect.arrayContaining(['--setting-sources', 'user,project,local']))
    expect(launch.args).not.toContain('--settings')
    expect(options.inheritedEnv).toMatchObject({ HOME: f.env.HOME, HTTPS_PROXY: f.env.HTTPS_PROXY })
    expect(options.inheritedEnv).not.toHaveProperty('CLAUDE_CONFIG_DIR')
  })

  it('rejects an alternate account before invoking the CLI', async () => {
    const f = fixture()
    await expect(
      createClaudeModelCatalogProbe(f.deps)({
        ...f.accountHome,
        path: join(f.root, 'orca-account')
      })
    ).rejects.toThrow('Alternate Claude configuration directory')
    expect(f.runListing).not.toHaveBeenCalled()
  })

  it('rejects an Orca proxy override during catalog discovery', async () => {
    const f = fixture()
    await expect(
      createClaudeModelCatalogProbe({
        ...f.deps,
        resolveEnv: () => ({ HTTPS_PROXY: 'http://unexpected-proxy:8080' })
      })(f.accountHome)
    ).rejects.toThrow('Blocked environment key: HTTPS_PROXY')
    expect(f.runListing).not.toHaveBeenCalled()
  })

  it('uses the same local configuration for a settings read', async () => {
    const f = fixture()
    await runClaudeListing(f.deps, {
      accountHomePath: f.accountHome.path,
      cwd: f.root,
      stdin: CLAUDE_MODEL_LIST_STDIN,
      site: 'claude-local-policy-test'
    })
    expect(f.runListing.mock.calls[0]?.[1].inheritedEnv).toMatchObject({
      HOME: f.env.HOME,
      HTTPS_PROXY: f.env.HTTPS_PROXY
    })
    await expect(
      runClaudeListing(f.deps, {
        accountHomePath: join(f.root, 'other-account'),
        cwd: f.root,
        stdin: CLAUDE_MODEL_LIST_STDIN,
        site: 'claude-local-policy-test'
      })
    ).rejects.toThrow('Alternate Claude configuration directory')
    expect(f.runListing).toHaveBeenCalledOnce()
  })
})
