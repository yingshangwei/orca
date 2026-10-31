import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { parseHerdrSnapshot, type HerdrSnapshot } from './herdr-snapshot'

export async function resolveHerdrExecutable(): Promise<string> {
  const executable =
    (await resolveCommandOnLocalPath('herdr')) ??
    (await resolveCommandOnLocalPath(join(homedir(), '.local', 'bin', 'herdr')))
  if (!executable) {
    throw new Error('Herdr was not found on this computer.')
  }
  return executable
}

export async function readHerdrSnapshot(executable: string): Promise<HerdrSnapshot> {
  const result = await runProcess({
    program: executable,
    args: ['api', 'snapshot'],
    timeoutMs: 10_000,
    maxOutputBytes: 8 * 1024 * 1024,
    killOnOutputLimit: true
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    throw new Error(result.stderr.trim() || 'Could not read Herdr. Open Herdr and try again.')
  }
  return parseHerdrSnapshot(JSON.parse(result.stdout))
}

export function herdrAttachCommand(executable: string, terminalId: string): string {
  return `${quotePosixShell(executable)} terminal attach ${quotePosixShell(terminalId)} --takeover`
}

export async function closeHerdrTerminal(executable: string, terminalId: string): Promise<void> {
  const before = await readHerdrSnapshot(executable)
  const pane = before.panes.find((entry) => entry.terminal_id === terminalId)
  if (!pane) {
    return
  }
  const result = await runProcess({
    program: executable,
    args: ['pane', 'close', pane.pane_id],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024,
    killOnOutputLimit: true
  })
  const after = await readHerdrSnapshot(executable)
  if (after.panes.some((entry) => entry.terminal_id === terminalId)) {
    throw new Error(
      result.stderr.trim() || 'Herdr did not close this terminal. Try deleting again.'
    )
  }
}

export async function openHerdrTerminal(userDataPath: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Opening Herdr in Terminal is supported on macOS.')
  }
  const executable = await resolveHerdrExecutable()
  const directory = join(userDataPath, 'herdr')
  await mkdir(directory, { recursive: true })
  const script = join(directory, 'Open Herdr.command')
  writeFileAtomically(script, `#!/bin/sh\nexec ${quotePosixShell(executable)}\n`, { mode: 0o700 })
  const result = await runProcess({
    program: '/usr/bin/open',
    args: ['-a', 'Terminal', script],
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error(result.stderr.trim() || 'Could not open Terminal.')
  }
}
