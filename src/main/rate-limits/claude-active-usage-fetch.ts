import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import { disabledClaudeUsageResult } from './claude-usage-result'

export async function fetchActiveClaudeRateLimits(
  _options?: ClaudeRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  return disabledClaudeUsageResult()
}
