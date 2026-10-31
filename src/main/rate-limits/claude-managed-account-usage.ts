import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { ClaudeManagedAccountUsageOptions } from './claude-usage-fetch-options'
import { disabledClaudeUsageResult } from './claude-usage-result'

export type InactiveClaudeAccount = {
  id: string
  managedAuthRuntime?: 'host' | 'wsl'
  wslDistro?: string | null
  wslLinuxAuthPath?: string | null
}

export async function fetchInactiveClaudeAccountUsage(
  _account: InactiveClaudeAccount,
  _options: ClaudeManagedAccountUsageOptions = {}
): Promise<ProviderRateLimits> {
  return disabledClaudeUsageResult()
}
