import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { disabledClaudeUsageResult } from './claude-usage-result'

export async function fetchClaudeOAuthUsage(
  _token: string,
  _signal?: AbortSignal
): Promise<ProviderRateLimits> {
  return disabledClaudeUsageResult()
}
