import { parseHookEnvelope } from './agent-hook-listener/hook-envelope'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import {
  isNestedClaudeChildInClaudePane,
  readHookParentClaudeSession
} from './agent-hook-nested-claude-child'
import type { AgentHookSource } from './agent-hook-relay'

/** A raw hook body from a child of the Claude that holds its pane, judged on the canonical rows. */
export function isNestedClaudeChildHookBody(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  env: string
): boolean {
  const envelope = parseHookEnvelope(state, source, body, env)
  return Boolean(
    envelope &&
    isNestedClaudeChildInClaudePane(
      readHookParentClaudeSession(source, envelope.record),
      state.lastStatusByPaneKey.get(envelope.paneKey)
    )
  )
}
