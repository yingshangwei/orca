import type { AgentHookSource } from './agent-hook-relay'

/** Envelope field (and spool record field) naming the Claude session that ran the hook's agent. */
export const HOOK_PARENT_CLAUDE_SESSION_FIELD = 'parentClaudeSession'

/** The Claude session a hook's agent was started from, or undefined for the pane's own agent. */
export function readHookParentClaudeSession(
  source: AgentHookSource,
  record: unknown
): string | undefined {
  if (source === 'claude' || typeof record !== 'object' || record === null) {
    return undefined
  }
  const value: unknown = Reflect.get(record, HOOK_PARENT_CLAUDE_SESSION_FIELD)
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

type PaneRow = {
  payload: { agentType?: string }
  providerSessionOnly?: boolean
  providerSession?: { id?: string }
}

/**
 * Whether a hook came from an agent a Claude session started as a child (e.g. `codex exec` from
 * Claude's Bash tool) on a pane Claude holds. Claude stamps CLAUDE_CODE_SESSION_ID into every
 * process it starts and Orca strips that stamp from each PTY it spawns, so the pane's own codex
 * never carries it. The child inherits ORCA_PANE_KEY, so it would otherwise replace the pane's
 * agent, turn owner and resume session.
 *
 * A live Claude row is held whatever its session. An identity-only row (a resume launch seed, kept
 * while Claude has not yet painted) is held only when the child names that same session: a stale
 * seed from an exited Claude must still yield to the pane's next agent.
 */
export function isNestedClaudeChildInClaudePane(
  parentClaudeSession: string | undefined,
  pane: PaneRow | undefined
): boolean {
  if (!parentClaudeSession || pane?.payload.agentType !== 'claude') {
    return false
  }
  return pane.providerSessionOnly !== true || pane.providerSession?.id === parentClaudeSession
}

/** The stamp a relay forwarded on its envelope, for a non-Claude hook. */
export function readRelayedParentClaudeSession(envelope: {
  source?: unknown
  parentClaudeSession?: unknown
}): string | undefined {
  const value = envelope.parentClaudeSession
  return envelope.source !== 'claude' && typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined
}
