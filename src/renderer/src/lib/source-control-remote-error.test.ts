import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeGitErrorMessage } from '../../../shared/git-remote-error'

import {
  isNonFastForwardRemoteError,
  resolveRemoteOperationErrorMessage
} from './source-control-remote-error'

describe('source-control remote error formatting', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.each([
    { options: { isPush: true }, label: 'Push' },
    { options: { isForcePush: true }, label: 'Force Push' },
    { options: { publish: true }, label: 'Publish Branch' },
    { options: { isSync: true }, label: 'Sync' },
    { options: { isSync: true, isSyncPushStage: true }, label: 'Sync' },
    { options: { isFetch: true }, label: 'Fetch' },
    { options: { isFastForward: true }, label: 'Fast-forward' },
    { options: { isRebase: true }, label: 'Rebase' },
    { options: undefined, label: 'Pull' }
  ])('retains normalized authentication guidance for $label', ({ options, label }) => {
    for (const stderr of [
      "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
      "fatal: could not read Password for 'https://user@example.com': terminal prompts disabled",
      'fatal: unable to get password from user'
    ]) {
      const normalized = normalizeGitErrorMessage(new Error(stderr), 'push')
      const error = new Error(normalized)
      const wrapped = new Error(`Error invoking remote method 'git:push': Error: ${normalized}`)

      for (const failure of [error, wrapped]) {
        expect(resolveRemoteOperationErrorMessage(failure, options)).toBe(
          `${label} failed. Authentication failed. Check your remote credentials.`
        )
      }
    }
  })

  it('recognizes split colored stale lease markers from remote hosts', () => {
    const error = new Error(
      " ! [rejected] main -> main (stale\x1b[31m info\x1b[m)\nerror: failed to push some refs to 'origin'"
    )

    expect(resolveRemoteOperationErrorMessage(error, { isForcePush: true })).toBe(
      'Force push rejected — remote changed since last fetch. Fetch first, then try again.'
    )
    expect(isNonFastForwardRemoteError(error)).toBe(true)
  })

  it('prefers fatal detail over an earlier remote detail for publish failures', () => {
    const error = new Error('remote: protected branch\r\nfatal: Authentication failed\r\n')

    expect(resolveRemoteOperationErrorMessage(error, { publish: true })).toBe(
      'Publish Branch failed. Authentication failed. Check your remote access and try again.'
    )
  })

  it.each(['fatal', 'remote'])(
    'redacts ANSI-bearing credentials in %s details from older remote hosts',
    (prefix) => {
      const error = new Error(
        `git.push failed:\n${prefix}: Access denied to https://user:sec\x1b[1 qret@example.com/repo.git`
      )

      expect(resolveRemoteOperationErrorMessage(error, { isPush: true })).toBe(
        'Push failed. Access denied to https://example.com/repo.git. Check your remote access and try again.'
      )
    }
  )

  it.each([
    [{ isFetch: true }, 'Fetch failed. '],
    [{ isFastForward: true }, 'Fast-forward failed. '],
    [{ isRebase: true }, 'Rebase failed. '],
    [{}, '']
  ])('redacts ANSI-bearing credentials in fallback details for %j', (options, prefix) => {
    const error = new Error('Access denied to https://user:sec\x1b[1 qret@example.com/repo.git')

    expect(resolveRemoteOperationErrorMessage(error, options)).toBe(
      `${prefix}Access denied to https://example.com/repo.git`
    )
    expect(error.message).toContain('user:sec\x1b[1 qret@')
  })

  it.each([
    [{ publish: true }, 'Publish Branch'],
    [{ isSync: true }, 'Sync'],
    [{ isForcePush: true }, 'Force Push'],
    [{ isPush: true }, 'Push']
  ])('sanitizes and classifies older-host submodule errors for %j', (options, operation) => {
    const error = new Error(
      "Unable to push sub\x1b[1 qmodule 'https://user:sec\x1b[1 qret@example.com/repo.git'\n" +
        ' ! [rejected] main -> main (fetch\x1b[1 q first)'
    )

    expect(resolveRemoteOperationErrorMessage(error, options)).toBe(
      `${operation} failed. Submodule 'https://example.com/repo.git' has remote changes. Pull inside the submodule, then try again.`
    )
    expect(isNonFastForwardRemoteError(error)).toBe(true)
    expect(
      resolveRemoteOperationErrorMessage(
        new Error("Unable to push submodule 'https://user:sec\x1b[1 qret@example.com/repo.git'"),
        options
      )
    ).toBe(
      `${operation} failed. Submodule 'https://example.com/repo.git' could not be pushed. Resolve the submodule push error, then try again.`
    )
  })

  it('maps pre-push hook failures to a hook-specific message instead of remote access guidance', () => {
    const error = new Error(
      "git push failed: Command failed: git push origin main\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1\neslint found 2 errors"
    )

    expect(resolveRemoteOperationErrorMessage(error, { isPush: true })).toBe(
      'Push blocked — lint failed during push.'
    )
  })

  it('maps force-push, publish, and sync push-stage hook failures to blocked copy', () => {
    const error = new Error(
      "git push failed: Command failed: git push origin main\nerror: failed to push some refs to 'origin'\nhusky - pre-push hook exited with code 1"
    )

    expect(resolveRemoteOperationErrorMessage(error, { isForcePush: true })).toBe(
      'Force Push blocked — pre-push hook failed.'
    )
    expect(resolveRemoteOperationErrorMessage(error, { publish: true })).toBe(
      'Publish Branch blocked — pre-push hook failed.'
    )
    expect(resolveRemoteOperationErrorMessage(error, { isSync: true, isSyncPushStage: true })).toBe(
      'Sync blocked — pre-push hook failed.'
    )
  })

  it('does not classify sync non-push-stage hook-looking output as push blocked', () => {
    const error = new Error(
      'sync fetch failed before push\nremote: pre-push hook docs mention lint\neslint output'
    )

    const message = resolveRemoteOperationErrorMessage(error, { isSync: true })
    expect(message).toBe(
      'Sync failed. pre-push hook docs mention lint. Check your remote access and try again.'
    )
    expect(message).not.toContain('blocked')
  })

  it('keeps auth, protected-branch, pre-receive, non-fast-forward, and submodule push guidance out of blocked copy', () => {
    const protectedError = new Error(
      'git push failed: Command failed: git push origin main\nremote: error: GH006 protected branch update failed.\nremote: lint status is required'
    )
    const preReceiveError = new Error(
      'git push failed: Command failed: git push origin main\nremote: pre-receive hook declined\nremote: eslint failed'
    )
    const authError = new Error(
      'git push failed: Command failed: git push origin main\nremote: Repository not found.\nfatal: Authentication failed'
    )
    const nffError = new Error('updates were rejected because the remote contains work')
    const submoduleError = new Error(
      "Command failed: git push\nUnable to push submodule 'deps/lib'\nfatal: failed to push all needed submodules"
    )

    expect(resolveRemoteOperationErrorMessage(protectedError, { isPush: true })).toBe(
      'Push failed. error: GH006 protected branch update failed.. Check your remote access and try again.'
    )
    expect(resolveRemoteOperationErrorMessage(preReceiveError, { isPush: true })).toBe(
      'Push failed. pre-receive hook declined. Check your remote access and try again.'
    )
    expect(resolveRemoteOperationErrorMessage(authError, { isPush: true })).toBe(
      'Push failed. Authentication failed. Check your remote access and try again.'
    )
    expect(resolveRemoteOperationErrorMessage(nffError, { isPush: true })).toBe(
      'Push rejected — remote has changes. Pull first, then try again.'
    )
    expect(resolveRemoteOperationErrorMessage(submoduleError, { isPush: true })).toBe(
      "Push failed. Submodule 'deps/lib' could not be pushed. Resolve the submodule push error, then try again."
    )
  })

  it('extracts publish details from newline-heavy output without full line-array splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const progress = 'remote: Enumerating objects\r\n'.repeat(10_000)
    const error = new Error(
      `${progress}fatal: unable to access https://token:secret@example.com/repo.git\r\n`
    )

    const result = resolveRemoteOperationErrorMessage(error, { publish: true })

    expect(result).toContain('Publish Branch failed. unable to access https://example.com/repo.git')
    const usedLineSplit = splitSpy.mock.calls.some(([separator]) => {
      if (typeof separator === 'string') {
        return separator === '\n'
      }
      return separator instanceof RegExp && separator.source === '\\r?\\n'
    })
    const usedCrlfReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\r\\n'
    )
    expect(usedLineSplit).toBe(false)
    expect(usedCrlfReplace).toBe(false)
  })
})
