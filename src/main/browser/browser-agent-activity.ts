import { isAgentRpcCaller } from '../runtime/rpc/rpc-caller-identity'
import { getActiveRpcCaller } from '../runtime/rpc/rpc-active-caller'

const ACTIVITY_IDLE_MS = 20_000

type PageActivity = {
  /** Agent commands queued or running; the tab stays marked while any remain. */
  commands: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

/** One page-targeted command, held from when it is queued until it settles. */
export type AgentCommandLease = {
  run: <T>(execute: () => Promise<T>) => Promise<T>
  end: () => void
}

const NOT_AN_AGENT: AgentCommandLease = { run: (execute) => execute(), end: () => {} }

export class BrowserAgentActivity {
  private readonly pages = new Map<string, PageActivity>()

  /** Marks the page as agent-driven for one command; people's relayed input never counts. */
  beginCommand(browserPageId: string): AgentCommandLease {
    if (!isAgentRpcCaller(getActiveRpcCaller())) {
      return NOT_AN_AGENT
    }
    let page = this.pages.get(browserPageId)
    if (!page) {
      page = { commands: 0, idleTimer: null }
      this.pages.set(browserPageId, page)
    }
    if (page.idleTimer) {
      clearTimeout(page.idleTimer)
      page.idleTimer = null
    }
    page.commands += 1
    const owned = page
    let ended = false
    const end = (): void => {
      if (ended || this.pages.get(browserPageId) !== owned) {
        return
      }
      ended = true
      owned.commands -= 1
      if (owned.commands === 0) {
        owned.idleTimer = setTimeout(() => this.end(browserPageId), ACTIVITY_IDLE_MS)
      }
    }
    return {
      run: async (execute) => {
        try {
          return await execute()
        } finally {
          end()
        }
      },
      end
    }
  }

  end(browserPageId: string): void {
    const page = this.pages.get(browserPageId)
    if (!page) {
      return
    }
    if (page.idleTimer) {
      clearTimeout(page.idleTimer)
    }
    this.pages.delete(browserPageId)
  }

  isActive(browserPageId: string): boolean {
    return this.pages.has(browserPageId)
  }
}
