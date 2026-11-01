// A chat keeps, for each of its options it has none saved for, what its turn ran: the provider's
// own evidence of the dispatch, else the message's explicit choice. Startup reports and host
// defaults are not execution evidence.

import type { AgentSessionOptionsResult } from '../../../shared/agent-session-wire'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session-execution-options'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-option-intent'
import { savedAgentSessionCatalogModels } from './structured-agent-session-pick-reply'
import { recordAgentSessionRanOptions } from '../../runtime/agent-session-record-options'

type RanOptionsContext = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'logger' | 'agents' | 'modelCatalog'>
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>
  now: () => number
}

type RanOptions = Partial<Record<'model' | 'effort', string>>

export type StructuredAgentSessionHandedOptions = {
  message?: AgentSessionExecutionOptions
  executed?: Readonly<Record<string, string>>
}

/** In memory per child: what it last reported running, and a handed-over turn that still owes a
 *  record because nothing had named its model yet. */
const childRuns = new WeakMap<
  StructuredAgentSessionProviderChild,
  { reported?: RanOptions; owed?: StructuredAgentSessionHandedOptions }
>()

function currentChild(context: RanOptionsContext, sessionId: string, fence: number) {
  const child = context.sessions.get(sessionId)?.child
  return child?.fence === fence ? child : null
}

/** What a child last reported running, which a turn handed over with no choices of its own runs. */
export function structuredAgentSessionChildRan(
  child: StructuredAgentSessionProviderChild
): RanOptions | undefined {
  return childRuns.get(child)?.reported
}

function reportedRan(reported: AgentSessionOptionsResult['current']): RanOptions | null {
  const { model, effort } = reported
  const filled = reported.defaulted ?? []
  if (!model || model === 'default' || filled.includes('model')) {
    return null
  }
  return { model, ...(effort && !filled.includes('effort') ? { effort } : {}) }
}

/** Notes what a child reports running; a turn handed over before any report records it now. */
export async function noteStructuredAgentSessionReportedOptions(
  context: RanOptionsContext,
  sessionId: string,
  fence: number,
  reported: AgentSessionOptionsResult['current']
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const ran = reportedRan(reported)
  if (!child || !ran) {
    return
  }
  const runs = childRuns.get(child)
  childRuns.set(child, { reported: ran })
  if (runs?.owed && ran.model) {
    const owed = runs.owed
    await recordStructuredAgentSessionRanOptions(context, sessionId, fence, {
      ...owed,
      executed: { ...owed.executed, model: ran.model }
    })
  }
}

/** Records, for a chat's child at `fence`, what a message handed over to it ran. */
export type StructuredAgentSessionRanRecorder = (
  sessionId: string,
  fence: number
) => ((handed: StructuredAgentSessionHandedOptions) => Promise<void>) & {
  prepareInput?: () => void
  checkpoint?: () => void
}

/** Keeps observation identity at input, so an early report is neither lost nor an old fallback. */
export function createStructuredAgentSessionRanRecorder(
  context: RanOptionsContext,
  sessionId: string,
  fence: number
): ReturnType<StructuredAgentSessionRanRecorder> {
  let checkpoint: { reported?: RanOptions } | undefined
  return Object.assign(
    (handed: StructuredAgentSessionHandedOptions) =>
      recordStructuredAgentSessionRanOptions(context, sessionId, fence, handed, checkpoint),
    {
      prepareInput: () => {
        const child = currentChild(context, sessionId, fence)
        if (child) {
          delete childRuns.get(child)?.owed
        }
      },
      checkpoint: () => {
        const child = currentChild(context, sessionId, fence)
        checkpoint = { reported: child ? childRuns.get(child)?.reported : undefined }
      }
    }
  )
}

/** After a turn was handed over; bookkeeping, so a failure is logged and never refuses the send. */
export async function recordStructuredAgentSessionRanOptions(
  context: RanOptionsContext,
  sessionId: string,
  fence: number,
  handed: StructuredAgentSessionHandedOptions,
  checkpoint?: { reported?: RanOptions }
): Promise<void> {
  const child = currentChild(context, sessionId, fence)
  const { store, logger, agents } = context.deps
  const record = store.getRecord(sessionId)
  if (!child || !record) {
    return
  }
  const { message, executed } = handed
  const reported = childRuns.get(child)?.reported
  // A report only completes an agent's own evidence of the dispatch, never stands in for it.
  const newerModel = checkpoint && reported !== checkpoint.reported ? reported?.model : undefined
  const model = executed ? (executed.model ?? message?.model ?? newerModel) : message?.model
  childRuns.set(child, {
    ...(reported ? { reported } : {}),
    ...(executed && !model ? { owed: handed } : {})
  })
  if (!model) {
    return
  }
  // Prefer dispatch proof, else the message's effort; its tier or Fast may not have run.
  const proposed: Readonly<Record<string, string | undefined>> = executed ?? {
    effort: message?.effort
  }
  const ran: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...proposed, model })) {
    // Never one every later send would carry and the agent refuse as a choice.
    if (
      value &&
      !structuredAgentSessionOptionOverridesRefusal(agents, record.provider, { [key]: value })
    ) {
      ran[key] = value
    }
  }
  if (!ran.model) {
    return
  }
  const models = await savedAgentSessionCatalogModels(context.deps, record.provider, sessionId)
  await store
    .reviseSessionOptions(recordAgentSessionRanOptions, {
      sessionId,
      fence: child.fence,
      model,
      options: ran,
      models,
      now: context.now()
    })
    .catch((error: unknown) =>
      logger.warn('recording the options a turn ran failed', {
        scope: 'ran-options',
        sessionId,
        error
      })
    )
}
