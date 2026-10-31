import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { isBinaryBuffer } from '../../../shared/binary-buffer'
import { isMissingGitBlobPath } from '../../../shared/git-blob-absence'
import { readGitCommandFailureStderr } from '../../../shared/git-command-failure-text'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsyncBuffer } from '../runner'
import { isMaxBufferOverflowError } from '../max-buffer-overflow'
import { MAX_GIT_SHOW_BYTES } from './git-show-max-bytes'
import { PREVIEWABLE_BINARY_MIME_TYPES } from './previewable-binary-mime-types'
import { literalPathspec } from './git-pathspec'

export type GitBlobReadResult = {
  content: string
  isBinary: boolean
  exists: boolean
  /**
   * The read did not complete: the blob is neither known-present nor proven
   * absent. Callers must not persist a diff built on one, because the empty side
   * it produces is indistinguishable from a genuinely new file.
   */
  failed?: boolean
}

export async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options)
  if (indexBlob.exists || indexBlob.failed) {
    return indexBlob
  }

  return readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
}

export async function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Why: Git's `:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(['cat-file', 'blob', '--', `:${gitPath}`], {
      ...gitReadOptionsForWorktree(worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !(await verifyMissingBlobPath(error, worktreePath, gitPath, options))
    }
  }
}

export async function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Why: Git's `<oid>:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      ['cat-file', 'blob', '--', `${oid}:${gitPath}`],
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_GIT_SHOW_BYTES
      }
    )

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return {
      content: '',
      isBinary: false,
      exists: false,
      failed: !(await verifyMissingBlobPath(error, worktreePath, gitPath, options, oid))
    }
  }
}

async function verifyMissingBlobPath(
  error: unknown,
  worktreePath: string,
  gitPath: string,
  options: GitRuntimeOptions,
  oid?: string
): Promise<boolean> {
  if (isMissingGitBlobPath(error, gitPath, oid)) {
    return true
  }
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 128 ||
    readGitCommandFailureStderr(error)?.replace(/\r?\n$/, '') !==
      `fatal: Not a valid object name ${oid ?? ''}:${gitPath}` ||
    oid?.startsWith('-') ||
    options.signal?.aborted
  ) {
    return false
  }
  // Older cat-file omits path diagnostics; only an empty successful listing proves absence.
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      oid === undefined
        ? ['ls-files', '--stage', '-z', '--', literalPathspec(gitPath, worktreePath, options)]
        : ['ls-tree', '-z', oid, '--', literalPathspec(gitPath, worktreePath, options)],
      { ...gitReadOptionsForWorktree(worktreePath, options), maxBuffer: MAX_GIT_SHOW_BYTES }
    )
    return stdout.length === 0
  } catch {
    return false
  }
}

export async function readWorkingTreeFile(filePath: string): Promise<GitBlobReadResult> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    // Why: only ENOENT is a real deletion; other stat errors are read failures, not absence.
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT'
    return { content: '', isBinary: false, exists: !missing, ...(missing ? {} : { failed: true }) }
  }
  if (!fileStat.isFile()) {
    return { content: '', isBinary: false, exists: false }
  }
  if (fileStat.size > MAX_GIT_SHOW_BYTES) {
    // Why: mirror git's maxBuffer cap for working-tree reads so readFile can't pull in huge assets.
    return { content: '', isBinary: true, exists: true }
  }
  try {
    const buffer = await readFile(filePath)
    return bufferToBlob(buffer, filePath)
  } catch {
    // Why: the file exists but could not be read — a read failure, not a deletion.
    return { content: '', isBinary: false, exists: true, failed: true }
  }
}

function bufferToBlob(buffer: Buffer, filePath?: string): GitBlobReadResult {
  const isBinary = isBinaryBuffer(buffer)
  // Return base64 for recognized image formats so the renderer can display them
  const isPreviewableBinary = filePath
    ? !!PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
    : false
  return {
    content: isBinary
      ? isPreviewableBinary
        ? buffer.toString('base64')
        : ''
      : buffer.toString('utf-8'),
    isBinary,
    exists: true
  }
}
