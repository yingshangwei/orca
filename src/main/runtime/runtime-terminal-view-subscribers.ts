type RuntimeTerminalViewSubscriberDependencies = {
  notifyPresenceChanged: (ptyId: string) => void
  hasMobileSubscribers: (ptyId: string) => boolean
  isUnattachedLocalCandidate: (ptyId: string) => boolean
  attachProvider: (ptyId: string) => Promise<boolean> | null
}

type SilenceableRemoteView = { isSilent: () => boolean }

export class RuntimeTerminalViewSubscribers {
  private readonly remoteCounts = new Map<string, { count: number }>()
  private readonly silenceableRemoteViews = new Map<string, Set<SilenceableRemoteView>>()
  private readonly rawCounts = new Map<string, { count: number }>()
  private readonly providerAttaches = new Map<string, Promise<boolean>>()
  private readonly attachInventoryWaiters = new Set<string>()
  private readonly spawnPublishedPtys = new Set<string>()

  constructor(private readonly deps: RuntimeTerminalViewSubscriberDependencies) {}

  markSpawnPublished(ptyId: string): void {
    this.spawnPublishedPtys.add(ptyId)
  }

  resetGeneration(ptyId: string): void {
    this.providerAttaches.delete(ptyId)
    this.attachInventoryWaiters.delete(ptyId)
    this.spawnPublishedPtys.delete(ptyId)
  }

  // Why: exit drops subscribers only; attach/publish state survives until the respawn advances the generation.
  clearSubscribers(ptyId: string): void {
    this.remoteCounts.delete(ptyId)
    this.silenceableRemoteViews.delete(ptyId)
    this.rawCounts.delete(ptyId)
  }

  registerRemote(ptyId: string, isSilent?: () => boolean): () => void {
    const record = this.remoteCounts.get(ptyId) ?? { count: 0 }
    record.count += 1
    this.remoteCounts.set(ptyId, record)
    const view = isSilent ? { isSilent } : null
    if (view) {
      const views = this.silenceableRemoteViews.get(ptyId) ?? new Set()
      views.add(view)
      this.silenceableRemoteViews.set(ptyId, views)
    }
    this.ensureProviderAttach(ptyId)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      if (this.remoteCounts.get(ptyId) !== record) {
        return
      }
      record.count -= 1
      if (record.count === 0) {
        this.remoteCounts.delete(ptyId)
      }
      const views = this.silenceableRemoteViews.get(ptyId)
      if (view && views?.delete(view) && views.size === 0) {
        this.silenceableRemoteViews.delete(ptyId)
      }
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  registerRaw(ptyId: string): () => void {
    const record = this.rawCounts.get(ptyId) ?? { count: 0 }
    record.count += 1
    this.rawCounts.set(ptyId, record)
    this.deps.notifyPresenceChanged(ptyId)
    return this.releaseOnce(() => {
      if (this.rawCounts.get(ptyId) !== record) {
        return
      }
      record.count -= 1
      if (record.count === 0) {
        this.rawCounts.delete(ptyId)
      }
      this.deps.notifyPresenceChanged(ptyId)
    })
  }

  hasRaw(ptyId: string): boolean {
    return (this.rawCounts.get(ptyId)?.count ?? 0) > 0 || this.hasRemote(ptyId)
  }

  hasRemote(ptyId: string): boolean {
    return (this.remoteCounts.get(ptyId)?.count ?? 0) > 0 || this.deps.hasMobileSubscribers(ptyId)
  }

  /** A remote view answering queries now; silent views leave them to main. */
  hasRemoteAnsweringQueries(ptyId: string): boolean {
    return this.remoteAnsweringQueriesCount(ptyId) > 0
  }

  remoteAnsweringQueriesCount(ptyId: string): number {
    let silent = 0
    for (const view of this.silenceableRemoteViews.get(ptyId) ?? []) {
      if (view.isSilent()) {
        silent += 1
      }
    }
    return Math.max(0, (this.remoteCounts.get(ptyId)?.count ?? 0) - silent)
  }

  isKnownUnattachedLocal(ptyId: string): boolean {
    return !this.spawnPublishedPtys.has(ptyId) && this.deps.isUnattachedLocalCandidate(ptyId)
  }

  hasPendingProviderAttach(ptyId: string): boolean {
    return this.providerAttaches.has(ptyId)
  }

  attachInventoryWaiterIds(): string[] {
    return [...this.attachInventoryWaiters]
  }

  reconcileProviderAttach(ptyId: string): void {
    if (!this.hasRemote(ptyId)) {
      return
    }
    const pending = this.providerAttaches.get(ptyId)
    if (!pending) {
      this.ensureProviderAttach(ptyId)
      return
    }
    if (this.attachInventoryWaiters.has(ptyId)) {
      return
    }
    this.attachInventoryWaiters.add(ptyId)
    void pending.then((attached) => {
      this.attachInventoryWaiters.delete(ptyId)
      if (attached || !this.hasRemote(ptyId)) {
        return
      }
      if (this.providerAttaches.get(ptyId) === pending) {
        this.providerAttaches.delete(ptyId)
      }
      this.ensureProviderAttach(ptyId)
    })
  }

  private ensureProviderAttach(ptyId: string): void {
    if (this.providerAttaches.has(ptyId) || !this.isKnownUnattachedLocal(ptyId)) {
      return
    }
    let attempt: Promise<boolean> | null
    try {
      attempt = this.deps.attachProvider(ptyId)
    } catch {
      attempt = Promise.resolve(false)
    }
    if (!attempt) {
      return
    }
    const guardedAttempt = Promise.resolve(attempt).catch(() => false)
    this.providerAttaches.set(ptyId, guardedAttempt)
    void guardedAttempt.then((attached) => {
      if (!attached && this.providerAttaches.get(ptyId) === guardedAttempt) {
        this.providerAttaches.delete(ptyId)
      }
    })
  }

  private releaseOnce(release: () => void): () => void {
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      release()
    }
  }
}
