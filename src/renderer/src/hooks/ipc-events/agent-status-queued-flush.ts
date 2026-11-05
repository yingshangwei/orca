/**
 * Status updates main pushed that the renderer has queued but not applied yet. A window close
 * applies them before its unload checkpoint records what each pane resumes, so a session id main
 * learned just before the close is the one that checkpoint saves.
 */
type QueuedAgentStatusFlush = () => void

let flushQueuedAgentStatuses: QueuedAgentStatusFlush | null = null

export function setQueuedAgentStatusFlush(flush: QueuedAgentStatusFlush | null): void {
  flushQueuedAgentStatuses = flush
}

export function applyQueuedAgentStatusesNow(): void {
  flushQueuedAgentStatuses?.()
}
