// agent-browser reads global options anywhere in argv and has no "--", so argv cannot carry
// user values. `batch` parses commands from stdin without that scan.
export const AGENT_BROWSER_BATCH_ARGS = ['batch', '--json'] as const

export function agentBrowserBatchInput(command: readonly string[]): string {
  // serde_json rejects lone surrogates; argv used to turn them into U+FFFD.
  return JSON.stringify([command.map((token) => token.toWellFormed())])
}

export type AgentBrowserEnvelope = { success?: boolean; data?: unknown; error?: string }

/** Parses --json output; a one-command batch reply becomes the single-command envelope. */
export function parseAgentBrowserJsonOutput(stdout: string): AgentBrowserEnvelope {
  const parsed = JSON.parse(stdout)
  // Orca batches one command; a longer array is a passthrough `exec batch` reply.
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return parsed
  }
  const [entry] = parsed
  return { success: entry?.success, data: entry?.result, error: entry?.error }
}

/** Every snapshot form answers with `snapshot`; annotated screenshots with `annotations`. */
export function agentBrowserResultMintsRefs(data: unknown): boolean {
  if (!data || typeof data !== 'object') {
    return false
  }
  return 'snapshot' in data || ('annotations' in data && Array.isArray(data.annotations))
}
