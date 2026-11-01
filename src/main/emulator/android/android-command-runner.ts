import { runProcess } from '@orca/process-host'
import { basename } from 'node:path'
import { emulatorProbe, emulatorProbeError } from '../emulator-probe'

export type AndroidCommandResult = { stdout: string; stderr: string; code: number }

// Runs an Android SDK binary (adb/emulator) and resolves with its output. Never
// rejects — callers branch on `code` so a non-zero exit is data, not an throw.
export type AndroidCommandRunner = (
  binary: string,
  args: readonly string[],
  options?: { timeoutMs?: number }
) => Promise<AndroidCommandResult>

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_BUFFER_BYTES = 16 * 1024 * 1024

export const execFileAndroidCommandRunner: AndroidCommandRunner = async (binary, args, options) => {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let result: AndroidCommandResult
  let failure: unknown
  try {
    const output = await runProcess({
      program: binary,
      args,
      timeoutMs: timeoutMs === 0 ? null : timeoutMs,
      maxOutputBytes: MAX_BUFFER_BYTES,
      killOnOutputLimit: true
    })
    result = {
      stdout: output.stdout,
      stderr: output.stderr,
      code: output.timedOut || output.outputTruncated ? 1 : (output.code ?? 1)
    }
  } catch (error) {
    failure = error
    result = { stdout: '', stderr: '', code: 1 }
  }
  if (result.code === 0) {
    emulatorProbe('cmd', { bin: basename(binary), args })
  } else {
    emulatorProbeError('cmd.fail', failure ?? new Error(result.stderr || 'nonzero exit'), {
      bin: basename(binary),
      args,
      code: result.code,
      stderr: result.stderr.slice(0, 400)
    })
  }
  return result
}
