import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import {
  useProvideSessionDiffOpenHandlers,
  useSessionDiffOpenHandlers,
  type SessionDiffOpenHandlers
} from './session-diff-open-handlers'

const mounted = new Set<ReactTestRenderer>()
type Scope = { hostId: string; worktreeId: string; executionHost?: ExecutionHostId }

function Provider(props: Scope & SessionDiffOpenHandlers): null {
  useProvideSessionDiffOpenHandlers(
    props.hostId,
    props.worktreeId,
    props.onFileOpenStart,
    props.onOpenedFileDiff
  )
  return null
}

function view(scope: Scope, handlers: SessionDiffOpenHandlers): ReturnType<typeof createElement> {
  return createElement(
    WorkspaceExecutionHostContext.Provider,
    { value: scope.executionHost },
    createElement(Provider, { ...scope, ...handlers })
  )
}

async function mount(scope: Scope, handlers: SessionDiffOpenHandlers): Promise<ReactTestRenderer> {
  const result: { current?: ReactTestRenderer } = {}
  await act(async () => {
    result.current = create(view(scope, handlers))
  })
  if (!result.current) {
    throw new Error('Session did not mount')
  }
  mounted.add(result.current)
  return result.current
}

async function unmount(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => renderer.unmount())
  mounted.delete(renderer)
}

async function read(scope: Scope): Promise<SessionDiffOpenHandlers | undefined> {
  const result: { current?: SessionDiffOpenHandlers; renderer?: ReactTestRenderer } = {}
  function Reader(): null {
    result.current = useSessionDiffOpenHandlers(scope.hostId, scope.worktreeId)
    return null
  }
  await act(async () => {
    result.renderer = create(
      createElement(
        WorkspaceExecutionHostContext.Provider,
        { value: scope.executionHost },
        createElement(Reader)
      )
    )
  })
  if (result.renderer) {
    await act(async () => result.renderer?.unmount())
  }
  return result.current
}

function handlers(): SessionDiffOpenHandlers {
  return { onFileOpenStart: vi.fn(), onOpenedFileDiff: vi.fn() }
}

afterEach(async () => {
  for (const renderer of mounted) {
    await unmount(renderer)
  }
})

describe('Source Control returns opened diffs to the visible session', () => {
  it('keeps the top session selected through lower rerenders and restores its latest callbacks', async () => {
    const scope = { hostId: 'paired', worktreeId: 'folder:src' }
    const initial = handlers()
    const latest = handlers()
    const top = handlers()
    const lower = await mount(scope, initial)
    const upper = await mount(scope, top)
    await act(async () => lower.update(view(scope, latest)))

    const active = await read(scope)
    active?.onFileOpenStart()
    active?.onOpenedFileDiff('changed.ts')
    expect(top.onFileOpenStart).toHaveBeenCalledOnce()
    expect(top.onOpenedFileDiff).toHaveBeenCalledWith('changed.ts')
    expect(latest.onOpenedFileDiff).not.toHaveBeenCalled()
    expect(initial.onOpenedFileDiff).not.toHaveBeenCalled()

    await unmount(upper)
    const restored = await read(scope)
    restored?.onFileOpenStart()
    restored?.onOpenedFileDiff('next.ts')
    expect(latest.onFileOpenStart).toHaveBeenCalledOnce()
    expect(latest.onOpenedFileDiff).toHaveBeenCalledWith('next.ts')
    expect(initial.onOpenedFileDiff).not.toHaveBeenCalled()
    await unmount(lower)
    expect(await read(scope)).toBeUndefined()
  })

  it('separates paired hosts and execution hosts and removes only the unmounted session', async () => {
    const local = { hostId: 'paired-a', worktreeId: 'same' }
    const other = { hostId: 'paired-b', worktreeId: 'same' }
    const remote = { ...local, executionHost: 'runtime:server' as const }
    const localHandlers = handlers()
    const otherHandlers = handlers()
    const remoteHandlers = handlers()
    const lower = await mount(local, localHandlers)
    const upperHandlers = handlers()
    await mount(local, upperHandlers)
    await mount(other, otherHandlers)
    await mount(remote, remoteHandlers)
    await unmount(lower)

    for (const scope of [local, other, remote]) {
      ;(await read(scope))?.onOpenedFileDiff(scope.hostId)
    }
    expect(upperHandlers.onOpenedFileDiff).toHaveBeenCalledOnce()
    expect(otherHandlers.onOpenedFileDiff).toHaveBeenCalledWith('paired-b')
    expect(remoteHandlers.onOpenedFileDiff).toHaveBeenCalledWith('paired-a')
    expect(localHandlers.onOpenedFileDiff).not.toHaveBeenCalled()
    expect(await read({ ...local, worktreeId: 'missing' })).toBeUndefined()
  })
})
