/** What an idle pane says about a run, judged as any agent turn sent at the run's dispatch. */
import type { AutomationRun } from '../../shared/automations-types'
import {
  isTurnDoneSince,
  judgeIdleAgentTurn,
  type AgentTurnStatusRow
} from '../agent-turn-idle-verdict'

export { AGENT_START_GRACE_MS } from '../agent-turn-idle-verdict'

export type AutomationRunAgentEvidence = {
  /** Agent status rows for a pane, from hooks, OSC and titles alike. */
  getAgentStatusRowsForPane(paneKey: string): readonly AgentTurnStatusRow[]
  /** The names the run's agent command may run under, to tell its refusal from its output. */
  agentCommandsForRun(run: AutomationRun): readonly string[]
}

export type IdleRunVerdict =
  | { kind: 'completed' }
  | { kind: 'failed'; error: string }
  /** An idle shell that may not have started the agent yet. */
  | { kind: 'wait' }

export function judgeIdleRun(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  tail: readonly string[],
  runStartedAt: number,
  now: number
): IdleRunVerdict {
  const verdict = judgeIdleAgentTurn(
    {
      rows: run.terminalPaneKey ? evidence.getAgentStatusRowsForPane(run.terminalPaneKey) : [],
      // A reused pane's earlier `done` ended before this run's prompt went in.
      sentAt: run.dispatchedAt ?? runStartedAt,
      tail,
      readAgentCommands: () => evidence.agentCommandsForRun(run)
    },
    now
  )
  return verdict.kind === 'failed'
    ? {
        kind: 'failed',
        error: `Automation agent did not start; this host could not run its command (${verdict.missingCommandLine}).`
      }
    : verdict
}

/** The agent reported this run's turn done at least `heldForMs` ago, and no row of its pane says otherwise. */
export function hasHeldRunTurnDone(
  evidence: AutomationRunAgentEvidence,
  run: AutomationRun,
  runStartedAt: number,
  now: number,
  heldForMs: number
): boolean {
  const sentAt = run.dispatchedAt ?? runStartedAt
  const rows = (
    run.terminalPaneKey ? evidence.getAgentStatusRowsForPane(run.terminalPaneKey) : []
  ).filter((row) => !row.providerSessionOnly)
  return (
    rows.every((row) => row.state === 'done') &&
    rows.some((row) => isTurnDoneSince(row, sentAt) && now - row.stateStartedAt >= heldForMs)
  )
}
