import { afterEach, describe, expect, it, vi } from 'vitest'
import { getMainHttpClient, setMainHttpClient } from './http-client'
import { fetchActiveClaudeRateLimits } from '../rate-limits/claude-active-usage-fetch'
import { fetchInactiveClaudeAccountUsage } from '../rate-limits/claude-managed-account-usage'
import { fetchClaudeOAuthUsage } from '../rate-limits/claude-oauth-usage-request'

const credentials = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('Credential access forbidden')
  })
)
vi.mock('../rate-limits/claude-oauth-credentials', () => ({
  readClaudeOAuthCredentials: credentials
}))

afterEach(() => {
  setMainHttpClient(null)
  vi.clearAllMocks()
})

describe('app-owned Claude requests are disabled', () => {
  it('does not read credentials or send HTTP for active, inactive or direct quota calls', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('Network forbidden')
    })
    setMainHttpClient({ fetch, proxySession: () => null })
    const results = await Promise.all([
      fetchActiveClaudeRateLimits(),
      fetchInactiveClaudeAccountUsage({ id: 'saved-account', managedAuthRuntime: 'host' }),
      fetchInactiveClaudeAccountUsage({
        id: 'saved-account',
        managedAuthRuntime: 'wsl',
        wslDistro: 'Ubuntu'
      }),
      fetchClaudeOAuthUsage('synthetic-oauth-token')
    ])
    for (const result of results) {
      expect(result).toMatchObject({
        status: 'unavailable',
        usageMetadata: { attemptedSources: [] }
      })
    }
    expect(credentials).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    'https://api.anthropic.com/api/oauth/usage',
    'https://api.anthropic.com/v1/messages',
    'https://claude.ai/login',
    'https://CLAUDE.COM./oauth/authorize'
  ])('blocks %s before the installed HTTP transport runs', async (url) => {
    const fetch = vi.fn(async () => new Response('unexpected'))
    setMainHttpClient({ fetch, proxySession: () => null })
    await expect(getMainHttpClient().fetch(url)).rejects.toThrow(
      'Direct Claude requests are disabled'
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps other application HTTP integrations available', async () => {
    const fetch = vi.fn(async () => new Response('ok'))
    setMainHttpClient({ fetch, proxySession: () => null })
    expect(await (await getMainHttpClient().fetch('https://api.github.com/user')).text()).toBe('ok')
  })
})
