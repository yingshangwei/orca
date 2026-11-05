import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../shared/agent-session-resume'
import { AgentHookServerIngestTerminal } from './server-ingest-terminal'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerClaudeProcessSession extends AgentHookServerIngestTerminal {
  /**
   * The Claude session a pane's live Claude process names in Claude's own session registry
   * (`~/.claude/sessions/<pid>.json`). Without Orca's Claude hook nothing else reports a session
   * a pane started or `/clear`ed into, so a restart had nothing to resume. Only a row Claude
   * already holds (an OSC or launch row) takes it; its state, turn and prompt stay as they are.
   */
  recordClaudeSessionFromProcess(event: {
    paneKey: string
    providerSession: AgentProviderSessionMetadata
  }): boolean {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey.trim())
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const previous = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      !previous ||
      previous.connectionId !== null ||
      previous.structuredHost ||
      previous.payload.agentType !== 'claude' ||
      agentProviderSessionsEqual('claude', previous.providerSession, event.providerSession)
    ) {
      return false
    }
    if (previous.providerSessionOnly) {
      this.recordLaunchResumeIdentity({
        paneKey,
        ...(previous.worktreeId ? { worktreeId: previous.worktreeId } : {}),
        agentType: 'claude',
        providerSession: event.providerSession,
        launchedAt: 0
      })
      return true
    }
    const next: EnrichedAgentHookEventPayload = {
      ...previous,
      providerSession: event.providerSession
    }
    if (!this.writeLegacyStatusRow(next)) {
      return false
    }
    this.commitStatusRowMutation(previous, next)
    this.scheduleStatusPersist()
    this.notifyStatusChangeListeners()
    this.emitEnrichedStatus(next)
    return true
  }
}
