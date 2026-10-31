import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runGenerationRequest } from './agent-generation-request'
import { discoverModelsLocal } from './commit-message-model-discovery'

const runLocal = vi.hoisted(() => vi.fn(async () => ({ success: true, rawOutput: 'A title' })))
vi.mock('./source-control-local-generation', () => ({ runLocalPlanForAgent: runLocal }))
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  vi.clearAllMocks()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-local-claude-generation-'))
  roots.push(root)
  await mkdir(join(root, '.claude'))
  await writeFile(
    join(root, '.claude', 'settings.json'),
    JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:3425',
        HTTPS_PROXY: 'http://127.0.0.1:6155'
      }
    })
  )
  return {
    params: { agentId: 'claude' as const, model: 'opus', thinkingLevel: 'high' },
    target: { kind: 'local' as const, cwd: root, env: { HOME: root } },
    prompt: 'Write a title',
    emptyResultName: 'title',
    operation: 'conversation-name' as const,
    spawnAgent: () => {
      throw new Error('No real agent may start in this test')
    }
  }
}

describe('background Claude generation uses the local connection', () => {
  it('keeps a model choice and user hooks when planning a local CLI call', async () => {
    const input = await fixture()
    await expect(runGenerationRequest(input)).resolves.toMatchObject({ success: true })
    expect(runLocal).toHaveBeenCalledOnce()
    expect(runLocal).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'claude',
        target: input.target,
        plan: expect.objectContaining({
          binary: 'claude',
          args: expect.arrayContaining(['--model', 'opus'])
        })
      })
    )
    expect(runLocal).not.toHaveBeenCalledWith(
      expect.objectContaining({
        plan: expect.objectContaining({ args: expect.arrayContaining(['--settings']) })
      })
    )
  })

  it.each(['--settings={"env":{"HTTPS_PROXY":""}}', '--setting-sources=project'])(
    'refuses %s before a helper process can run',
    async (agentArgs) => {
      const input = await fixture()
      await expect(
        runGenerationRequest({ ...input, params: { ...input.params, agentArgs } })
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('Blocked argument')
      })
      expect(runLocal).not.toHaveBeenCalled()
    }
  )

  it('refuses an alternate executable and a WSL target', async () => {
    const input = await fixture()
    await expect(
      runGenerationRequest({
        ...input,
        params: { ...input.params, agentCommandOverride: 'other-claude' }
      })
    ).resolves.toMatchObject({ success: false })
    await expect(
      runGenerationRequest({
        ...input,
        target: { ...input.target, wslDistro: 'Ubuntu' }
      })
    ).resolves.toMatchObject({ success: false })
    expect(runLocal).not.toHaveBeenCalled()
  })

  it.each([
    'HTTPS_PROXY=http://different-proxy.invalid claude',
    'claude --setting-sources=project',
    'other-claude'
  ])(
    'refuses model discovery override %s before starting a child',
    async (agentCommandOverride) => {
      const input = await fixture()
      const spawnAgent = vi.fn(input.spawnAgent)
      await expect(
        discoverModelsLocal({
          agentId: 'claude',
          env: input.target.env,
          options: { cwd: input.target.cwd },
          agentCommandOverride,
          backslash: 'escape',
          spawnAgent
        })
      ).resolves.toMatchObject({
        success: false,
        error: expect.stringContaining('cannot override the connection')
      })
      expect(spawnAgent).not.toHaveBeenCalled()
    }
  )
})
